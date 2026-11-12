//! Linux backend: follows an MPRIS media player (Spotify by default) on the D-Bus
//! session bus and emits the same NDJSON messages as the Windows (GSMTC) backend.
//!
//! MPRIS differs from GSMTC in two ways that matter for lyric sync:
//!  - `Position` is never announced through `PropertiesChanged`; it has to be read.
//!    The bridge reads it while playing and keeps a timeline *anchor*
//!    (position, wall time of the read). The anchor only moves when the player's
//!    position disagrees with the anchor's extrapolation by more than a small
//!    tolerance, on `Seeked`, or on a play/pause/track change, so the app sees the
//!    same "position + LastUpdatedTime" semantics as on Windows and no read jitter.
//!  - Players publish artwork as a URL (`mpris:artUrl`). `file://` images are read
//!    here; `http(s)` URLs are passed on as `url` and fetched by the Electron app.

use crate::{emit, wall_ms};
use base64::Engine as _;
use serde_json::{json, Value as Json};
use std::collections::{BTreeMap, HashMap};
use std::io::BufRead;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};
use zbus::blocking::{Connection, MessageIterator};
use zbus::message::Type as MsgType;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};
use zbus::MatchRule;

const PREFIX: &str = "org.mpris.MediaPlayer2.";
const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
const PROPS_IFACE: &str = "org.freedesktop.DBus.Properties";
/// A read that disagrees with the anchor's extrapolation by more than this moves the anchor.
const DRIFT_TOLERANCE_MS: f64 = 150.0;

enum Msg {
    /// PropertiesChanged from a unique bus name (":1.42"), with the changed property names.
    Props(String, Vec<String>),
    /// Seeked(position µs) from a unique bus name.
    Seeked(String, f64),
    /// A player appeared or went away.
    Names,
    Cmd(Json),
    StdinClosed,
}

#[derive(Clone)]
struct Player {
    /// Well-known name, e.g. org.mpris.MediaPlayer2.spotify
    bus: String,
    /// Unique owner, e.g. :1.42 (signals carry this, not the well-known name).
    owner: String,
    /// Short id shown to the app, e.g. "spotify".
    app: String,
}

#[derive(Clone, Copy, PartialEq)]
struct Anchor {
    position_ms: f64,
    wall_ms: f64,
}

struct Bridge {
    conn: Connection,
    preferred: String,
    attached: Option<Player>,
    seq: u64,
    media: Json,
    length_ms: f64,
    track_id: Option<String>,
    art_key: String,
    status: String,
    rate: f64,
    controls: Json,
    anchor: Option<Anchor>,
    last_emitted_anchor: Option<Anchor>,
    counts: BTreeMap<String, u64>,
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let mut preferred = String::from("spotify");
    let mut probe_secs: Option<u64> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--prefer" if i + 1 < args.len() => {
                preferred = args[i + 1].to_lowercase();
                i += 1;
            }
            "--probe" if i + 1 < args.len() => {
                probe_secs = args[i + 1].parse().ok();
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }

    emit(&json!({"type": "hello", "version": 1, "platform": "linux", "wallMs": wall_ms(),
                 "pid": std::process::id(), "probe": probe_secs}));

    let conn = match Connection::session() {
        Ok(c) => c,
        Err(e) => {
            emit(&json!({"type": "status", "available": false,
                         "error": format!("Could not reach the D-Bus session bus (MPRIS): {e}")}));
            return;
        }
    };
    emit(&json!({"type": "status", "available": true}));

    let (tx, rx) = mpsc::channel::<Msg>();
    if let Err(e) = subscribe(&conn, &tx) {
        emit(&json!({"type": "status", "available": false, "error": format!("Could not watch MPRIS players: {e}")}));
        return;
    }
    {
        let t = tx.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                match line {
                    Ok(l) => {
                        if let Ok(v) = serde_json::from_str::<Json>(&l) {
                            let _ = t.send(Msg::Cmd(v));
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = t.send(Msg::StdinClosed);
        });
    }

    let mut b = Bridge {
        conn,
        preferred,
        attached: None,
        seq: 0,
        media: Json::Null,
        length_ms: 0.0,
        track_id: None,
        art_key: String::new(),
        status: "none".into(),
        rate: 1.0,
        controls: Json::Null,
        anchor: None,
        last_emitted_anchor: None,
        counts: BTreeMap::new(),
    };

    let players = b.players();
    b.reattach(&players);
    b.emit_sessions(&players);
    b.reload();
    b.emit_state("initial");

    let deadline = probe_secs.map(|s| Instant::now() + Duration::from_secs(s));
    loop {
        if let Some(d) = deadline {
            if Instant::now() >= d {
                emit(&json!({"type": "probe-summary", "app": b.attached.as_ref().map(|p| p.app.clone()),
                             "eventCounts": b.counts}));
                return;
            }
        }
        // MPRIS never announces Position changes, so read it regularly while playing.
        let timeout = if b.status == "playing" { Duration::from_millis(1000) } else { Duration::from_millis(4000) };
        match rx.recv_timeout(timeout) {
            Ok(Msg::Props(sender, changed)) => {
                let ours = b.attached.as_ref().map(|p| p.owner == sender).unwrap_or(false);
                if !ours {
                    // Another player started or stopped: maybe follow it instead.
                    if changed.iter().any(|c| c == "PlaybackStatus") {
                        let players = b.players();
                        if b.reattach(&players) {
                            b.reload();
                            b.emit_state("session");
                        }
                        b.emit_sessions(&players);
                    }
                    continue;
                }
                let media = changed.iter().any(|c| c == "Metadata");
                let playback = changed.iter().any(|c| c == "PlaybackStatus" || c == "Rate");
                b.reload_player(media);
                b.emit_state(if media { "media" } else if playback { "playback" } else { "timeline" });
            }
            Ok(Msg::Seeked(sender, pos_us)) => {
                if b.attached.as_ref().map(|p| p.owner == sender).unwrap_or(false) {
                    b.anchor = Some(Anchor { position_ms: pos_us / 1000.0, wall_ms: wall_ms() });
                    b.emit_state("timeline");
                }
            }
            Ok(Msg::Names) => {
                let players = b.players();
                if b.reattach(&players) {
                    b.reload();
                    b.emit_state("session");
                }
                b.emit_sessions(&players);
            }
            Ok(Msg::Cmd(v)) => b.command(v),
            Ok(Msg::StdinClosed) => {
                if deadline.is_none() {
                    return;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if b.attached.is_some() && b.read_position(false) {
                    b.emit_state("poll");
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Forward the D-Bus signals Afterglow cares about to the main loop.
fn subscribe(conn: &Connection, tx: &Sender<Msg>) -> zbus::Result<()> {
    let props = MatchRule::builder()
        .msg_type(MsgType::Signal)
        .interface(PROPS_IFACE)?
        .member("PropertiesChanged")?
        .path(MPRIS_PATH)?
        .build();
    let seeked = MatchRule::builder()
        .msg_type(MsgType::Signal)
        .interface(PLAYER_IFACE)?
        .member("Seeked")?
        .path(MPRIS_PATH)?
        .build();
    let names = MatchRule::builder()
        .msg_type(MsgType::Signal)
        .sender("org.freedesktop.DBus")?
        .interface("org.freedesktop.DBus")?
        .member("NameOwnerChanged")?
        .arg0ns("org.mpris.MediaPlayer2")?
        .build();

    let it = MessageIterator::for_match_rule(props, conn, Some(256))?;
    let t = tx.clone();
    std::thread::spawn(move || {
        for m in it.flatten() {
            let sender = m.header().sender().map(|s| s.to_string()).unwrap_or_default();
            let body = m.body();
            let Ok((iface, changed, invalidated)) =
                body.deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>()
            else {
                continue;
            };
            if iface != PLAYER_IFACE {
                continue;
            }
            let mut names: Vec<String> = changed.into_keys().collect();
            names.extend(invalidated);
            if t.send(Msg::Props(sender, names)).is_err() {
                break;
            }
        }
    });

    let it = MessageIterator::for_match_rule(seeked, conn, Some(64))?;
    let t = tx.clone();
    std::thread::spawn(move || {
        for m in it.flatten() {
            let sender = m.header().sender().map(|s| s.to_string()).unwrap_or_default();
            let Ok(pos) = m.body().deserialize::<i64>() else { continue };
            if t.send(Msg::Seeked(sender, pos as f64)).is_err() {
                break;
            }
        }
    });

    let it = MessageIterator::for_match_rule(names, conn, Some(64))?;
    let t = tx.clone();
    std::thread::spawn(move || {
        for _ in it.flatten() {
            if t.send(Msg::Names).is_err() {
                break;
            }
        }
    });
    Ok(())
}

// ---- small helpers for loosely typed MPRIS values ----

fn v_str(v: &Value) -> Option<String> {
    match v {
        Value::Str(s) => Some(s.to_string()),
        Value::ObjectPath(p) => Some(p.to_string()),
        Value::Value(b) => v_str(b),
        _ => None,
    }
}

fn v_f64(v: &Value) -> Option<f64> {
    match v {
        Value::I64(n) => Some(*n as f64),
        Value::U64(n) => Some(*n as f64),
        Value::I32(n) => Some(*n as f64),
        Value::U32(n) => Some(*n as f64),
        Value::I16(n) => Some(*n as f64),
        Value::U16(n) => Some(*n as f64),
        Value::U8(n) => Some(*n as f64),
        Value::F64(n) => Some(*n),
        Value::Value(b) => v_f64(b),
        _ => None,
    }
}

fn v_bool(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::Value(b) => v_bool(b),
        _ => None,
    }
}

fn v_strs(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.inner().iter().filter_map(v_str).filter(|s| !s.trim().is_empty()).collect(),
        Value::Value(b) => v_strs(b),
        other => v_str(other).into_iter().filter(|s| !s.trim().is_empty()).collect(),
    }
}

fn v_dict<'a>(v: &'a Value<'a>) -> HashMap<String, &'a Value<'a>> {
    let mut out = HashMap::new();
    match v {
        Value::Dict(d) => {
            for (k, val) in d.iter() {
                if let Some(k) = v_str(k) {
                    out.insert(k, val);
                }
            }
        }
        Value::Value(b) => return v_dict(b),
        _ => {}
    }
    out
}

fn status_str(s: &str) -> &'static str {
    match s {
        "Playing" => "playing",
        "Paused" => "paused",
        "Stopped" => "stopped",
        _ => "unknown",
    }
}

/// "org.mpris.MediaPlayer2.spotify" -> "spotify";
/// "org.mpris.MediaPlayer2.firefox.instance_1_23" -> "firefox".
fn app_of(bus: &str) -> String {
    let rest = bus.strip_prefix(PREFIX).unwrap_or(bus);
    rest.split(".instance").next().unwrap_or(rest).to_string()
}

fn mime_of(path: &str) -> &'static str {
    let p = path.to_lowercase();
    if p.ends_with(".png") {
        "image/png"
    } else if p.ends_with(".webp") {
        "image/webp"
    } else if p.ends_with(".gif") {
        "image/gif"
    } else {
        "image/jpeg"
    }
}

/// Decodes %XX escapes in a file:// URL path.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(n) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(n);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl Bridge {
    fn bump(&mut self, cause: &str) {
        *self.counts.entry(cause.to_string()).or_insert(0) += 1;
    }

    fn get_all(&self, bus: &str) -> Option<HashMap<String, OwnedValue>> {
        let reply = self
            .conn
            .call_method(Some(bus), MPRIS_PATH, Some(PROPS_IFACE), "GetAll", &(PLAYER_IFACE,))
            .ok()?;
        reply.body().deserialize::<HashMap<String, OwnedValue>>().ok()
    }

    fn get(&self, bus: &str, prop: &str) -> Option<OwnedValue> {
        let reply = self
            .conn
            .call_method(Some(bus), MPRIS_PATH, Some(PROPS_IFACE), "Get", &(PLAYER_IFACE, prop))
            .ok()?;
        reply.body().deserialize::<OwnedValue>().ok()
    }

    /// All MPRIS players on the bus, with their unique owner and playback status.
    fn players(&self) -> Vec<(Player, String)> {
        let names: Vec<String> = self
            .conn
            .call_method(Some("org.freedesktop.DBus"), "/org/freedesktop/DBus", Some("org.freedesktop.DBus"), "ListNames", &())
            .ok()
            .and_then(|r| r.body().deserialize::<Vec<String>>().ok())
            .unwrap_or_default();
        let mut out = vec![];
        let mut sorted: Vec<String> = names.into_iter().filter(|n| n.starts_with(PREFIX)).collect();
        sorted.sort();
        for bus in sorted {
            let owner = self
                .conn
                .call_method(Some("org.freedesktop.DBus"), "/org/freedesktop/DBus", Some("org.freedesktop.DBus"), "GetNameOwner", &(bus.as_str(),))
                .ok()
                .and_then(|r| r.body().deserialize::<String>().ok())
                .unwrap_or_default();
            let status = self
                .get(&bus, "PlaybackStatus")
                .and_then(|v| v_str(&v))
                .map(|s| status_str(&s))
                .unwrap_or("unknown");
            let app = app_of(&bus);
            out.push((Player { bus, owner, app }, status.to_string()));
        }
        out
    }

    /// Choose a player: the preferred app if present; otherwise keep the current one
    /// while it plays, else the first playing player, else any. Returns true on change.
    fn reattach(&mut self, players: &[(Player, String)]) -> bool {
        let pref = &self.preferred;
        let chosen = players
            .iter()
            .find(|(p, _)| !pref.is_empty() && (p.app.to_lowercase().contains(pref.as_str()) || p.bus.to_lowercase().contains(pref.as_str())))
            .or_else(|| {
                self.attached
                    .as_ref()
                    .and_then(|a| players.iter().find(|(p, s)| p.bus == a.bus && s == "playing"))
            })
            .or_else(|| players.iter().find(|(_, s)| s == "playing"))
            .or_else(|| {
                self.attached.as_ref().and_then(|a| players.iter().find(|(p, _)| p.bus == a.bus))
            })
            .or_else(|| players.first())
            .map(|(p, _)| p.clone());
        let same = match (&self.attached, &chosen) {
            (Some(a), Some(c)) => a.bus == c.bus && a.owner == c.owner,
            (None, None) => true,
            _ => false,
        };
        if same {
            return false;
        }
        self.attached = chosen;
        self.anchor = None;
        self.last_emitted_anchor = None;
        self.art_key.clear();
        true
    }

    fn emit_sessions(&self, players: &[(Player, String)]) {
        let out: Vec<Json> = players.iter().map(|(p, s)| json!({"app": p.app, "status": s})).collect();
        let current = players
            .iter()
            .find(|(_, s)| s == "playing")
            .or_else(|| players.first())
            .map(|(p, _)| p.app.clone());
        emit(&json!({"type": "sessions", "sessions": out, "systemCurrent": current,
                     "attached": self.attached.as_ref().map(|a| a.app.clone()), "preferred": self.preferred}));
    }

    /// Re-read everything about the attached player.
    fn reload(&mut self) {
        self.reload_player(true);
    }

    /// Re-read the player's properties; the position is re-anchored from a fresh read.
    fn reload_player(&mut self, media: bool) {
        let Some(p) = self.attached.clone() else {
            self.media = Json::Null;
            self.status = "none".into();
            self.controls = Json::Null;
            self.anchor = None;
            return;
        };
        let Some(all) = self.get_all(&p.bus) else {
            self.status = "unknown".into();
            return;
        };
        let prop = |k: &str| all.get(k).map(|v| &**v);
        let prev_status = self.status.clone();
        self.status = prop("PlaybackStatus").and_then(v_str).map(|s| status_str(&s).to_string()).unwrap_or_else(|| "unknown".into());
        self.rate = prop("Rate").and_then(v_f64).filter(|r| *r > 0.0).unwrap_or(1.0);
        let can_control = prop("CanControl").and_then(v_bool).unwrap_or(true);
        let can = |k: &str| can_control && prop(k).and_then(v_bool).unwrap_or(false);
        self.controls = json!({
            "play": can("CanPlay"),
            "pause": can("CanPause"),
            "toggle": can("CanPlay") || can("CanPause"),
            "next": can("CanGoNext"),
            "prev": can("CanGoPrevious"),
            "seek": can("CanSeek"),
        });

        let md = prop("Metadata").map(|m| v_dict(m)).unwrap_or_default();
        let mds = |k: &str| md.get(k).and_then(|v| v_str(v)).unwrap_or_default();
        let title = mds("xesam:title");
        let artists = md.get("xesam:artist").map(|v| v_strs(v)).unwrap_or_default();
        let album_artists = md.get("xesam:albumArtist").map(|v| v_strs(v)).unwrap_or_default();
        let artist = artists.join(", ");
        let track_id = md.get("mpris:trackid").and_then(|v| v_str(v));
        let length_ms = md.get("mpris:length").and_then(|v| v_f64(v)).map(|us| us / 1000.0).unwrap_or(0.0);
        let track_changed = track_id != self.track_id || length_ms != self.length_ms || self.media.get("title").and_then(|t| t.as_str()) != Some(title.as_str());
        self.track_id = track_id;
        self.length_ms = length_ms;
        self.media = json!({
            "title": title,
            "artist": artist,
            "album": mds("xesam:album"),
            "albumArtist": album_artists.join(", "),
            "genres": md.get("xesam:genre").map(|v| v_strs(v)).unwrap_or_default(),
            "trackNumber": md.get("xesam:trackNumber").and_then(|v| v_f64(v)).unwrap_or(0.0) as i64,
        });

        if media {
            let key = format!("{}|{}|{}", p.app, artist, title);
            if key != self.art_key {
                self.art_key = key;
                emit_artwork(&p.app, &title, &artist, &mds("mpris:artUrl"));
            }
        }

        // A play/pause or track change always re-anchors from a fresh read.
        let force = track_changed || prev_status != self.status;
        let pos = prop("Position").and_then(v_f64).map(|us| us / 1000.0);
        match pos {
            Some(_) => {
                self.read_position(force);
            }
            None => self.anchor = None,
        }
    }

    /// Reads Position and moves the anchor if needed. Returns true when it moved.
    fn read_position(&mut self, force: bool) -> bool {
        let Some(p) = &self.attached else { return false };
        let before = wall_ms();
        let Some(pos_us) = self.get(&p.bus, "Position").and_then(|v| v_f64(&v)) else {
            return false;
        };
        let after = wall_ms();
        let at = (before + after) / 2.0;
        let pos = pos_us / 1000.0;
        let playing = self.status == "playing";
        let moved = match self.anchor {
            None => true,
            Some(a) => {
                let predicted = a.position_ms + if playing { (at - a.wall_ms) * self.rate } else { 0.0 };
                force || (pos - predicted).abs() > DRIFT_TOLERANCE_MS
            }
        };
        if moved {
            self.anchor = Some(Anchor { position_ms: pos, wall_ms: at });
        }
        moved && self.anchor != self.last_emitted_anchor
    }

    fn emit_state(&mut self, cause: &'static str) {
        self.seq += 1;
        self.bump(cause);
        let now = wall_ms();
        let Some(p) = &self.attached else {
            emit(&json!({"type": "state", "seq": self.seq, "cause": cause, "app": null, "status": "none", "emitWallMs": now}));
            return;
        };
        let mut v = json!({
            "type": "state",
            "seq": self.seq,
            "cause": cause,
            "app": p.app,
            "status": self.status,
            "rate": self.rate,
            "timelineAvailable": self.anchor.is_some() && self.length_ms > 0.0,
            "emitWallMs": now,
            "media": self.media,
            "controls": self.controls,
        });
        if let Some(a) = self.anchor {
            v["positionMs"] = json!(a.position_ms);
            v["startMs"] = json!(0.0);
            v["endMs"] = json!(self.length_ms);
            v["lastUpdatedWallMs"] = json!(a.wall_ms);
        }
        self.last_emitted_anchor = self.anchor;
        emit(&v);
    }

    fn command(&mut self, v: Json) {
        let id = v.get("id").cloned().unwrap_or(Json::Null);
        let cmd = v.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
        if cmd == "select" {
            self.preferred = v.get("app").and_then(|a| a.as_str()).unwrap_or("").to_lowercase();
            let players = self.players();
            if self.reattach(&players) {
                self.reload();
            }
            self.emit_sessions(&players);
            self.emit_state("session");
            emit(&json!({"type": "ack", "id": id, "ok": true}));
            return;
        }
        if cmd == "refresh" {
            let players = self.players();
            if self.reattach(&players) {
                self.art_key.clear();
            }
            self.emit_sessions(&players);
            self.reload();
            self.emit_state("refresh");
            emit(&json!({"type": "ack", "id": id, "ok": true}));
            return;
        }
        let Some(p) = self.attached.clone() else {
            emit(&json!({"type": "ack", "id": id, "ok": false, "error": "no media player"}));
            return;
        };
        let call = |method: &str| -> zbus::Result<()> {
            self.conn.call_method(Some(p.bus.as_str()), MPRIS_PATH, Some(PLAYER_IFACE), method, &()).map(|_| ())
        };
        let r = match cmd {
            "play" => call("Play"),
            "pause" => call("Pause"),
            "toggle" => call("PlayPause"),
            "next" => call("Next"),
            "prev" => call("Previous"),
            "seek" => {
                let ms = v.get("positionMs").and_then(|p| p.as_f64()).unwrap_or(0.0).max(0.0);
                let us = (ms * 1000.0) as i64;
                match self.track_id.as_deref().and_then(|t| ObjectPath::try_from(t).ok()) {
                    Some(track) => self
                        .conn
                        .call_method(Some(p.bus.as_str()), MPRIS_PATH, Some(PLAYER_IFACE), "SetPosition", &(track, us))
                        .map(|_| ()),
                    None => {
                        // No track id: fall back to a relative seek from the current anchor.
                        let cur = self
                            .get(&p.bus, "Position")
                            .and_then(|v| v_f64(&v))
                            .unwrap_or(0.0);
                        self.conn
                            .call_method(Some(p.bus.as_str()), MPRIS_PATH, Some(PLAYER_IFACE), "Seek", &(us - cur as i64,))
                            .map(|_| ())
                    }
                }
            }
            _ => {
                emit(&json!({"type": "ack", "id": id, "ok": false, "error": format!("unknown command {cmd}")}));
                return;
            }
        };
        match r {
            Ok(()) => emit(&json!({"type": "ack", "id": id, "ok": true, "error": Json::Null})),
            Err(e) => emit(&json!({"type": "ack", "id": id, "ok": false, "error": e.to_string()})),
        }
    }
}

fn emit_artwork(app: &str, title: &str, artist: &str, url: &str) {
    let none = || emit(&json!({"type": "artwork", "app": app, "title": title, "artist": artist, "mime": null, "base64": null}));
    if url.is_empty() {
        none();
    } else if let Some(path) = url.strip_prefix("file://") {
        let path = percent_decode(path);
        match std::fs::read(&path) {
            Ok(bytes) if !bytes.is_empty() && bytes.len() <= 4 * 1024 * 1024 => emit(&json!({
                "type": "artwork", "app": app, "title": title, "artist": artist, "mime": mime_of(&path),
                "base64": base64::engine::general_purpose::STANDARD.encode(bytes)})),
            _ => none(),
        }
    } else if url.starts_with("https://") || url.starts_with("http://") {
        // Fetched by the Electron main process (keeps HTTP out of the bridge).
        emit(&json!({"type": "artwork", "app": app, "title": title, "artist": artist, "mime": null, "base64": null, "url": url}));
    } else {
        none();
    }
}
