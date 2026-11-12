use crate::{emit, wall_ms};
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::BufRead;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};
use windows::Foundation::TypedEventHandler;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

/// 100 ns ticks between 1601-01-01 and 1970-01-01.
const EPOCH_DIFF_TICKS: i64 = 116_444_736_000_000_000;

enum Msg {
    Changed(u64, &'static str),
    Sessions,
    Cmd(Value),
    StdinClosed,
}

struct Attached {
    session: Session,
    app: String,
    tokens: [i64; 3],
}

#[derive(Clone, Copy, PartialEq)]
struct Timeline {
    position_ms: f64,
    last_updated_wall_ms: f64,
    start_ms: f64,
    end_ms: f64,
}

struct Probe {
    deadline: Instant,
    started_wall: f64,
    counts: BTreeMap<String, u64>,
    last_change: Option<(Timeline, f64, bool)>, // timeline, received wall, playing
    intervals: Vec<f64>,
    consistency: Vec<f64>,
    receipt_age: Vec<f64>,
    seeks: u64,
    status_changes: u64,
}

struct Bridge {
    tx: Sender<Msg>,
    preferred: String,
    attached: Option<Attached>,
    gen: u64,
    seq: u64,
    media: Value,
    art_key: String,
    last_tl: Option<Timeline>,
    last_status: String,
    counts: BTreeMap<String, u64>,
    probe: Option<Probe>,
}

pub fn run() {
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
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

    emit(&json!({"type": "hello", "version": 1, "platform": "windows", "wallMs": wall_ms(),
                 "pid": std::process::id(), "probe": probe_secs}));

    let mgr = match Manager::RequestAsync().and_then(|op| op.join()) {
        Ok(m) => m,
        Err(e) => {
            emit(&json!({"type": "status", "available": false,
                         "error": format!("GlobalSystemMediaTransportControlsSessionManager unavailable: {e}")}));
            return;
        }
    };
    emit(&json!({"type": "status", "available": true}));

    let (tx, rx) = mpsc::channel::<Msg>();
    {
        let t1 = tx.clone();
        let _ = mgr.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
            let _ = t1.send(Msg::Sessions);
            Ok(())
        }));
        let t2 = tx.clone();
        let _ = mgr.SessionsChanged(&TypedEventHandler::new(move |_, _| {
            let _ = t2.send(Msg::Sessions);
            Ok(())
        }));
    }
    {
        let t = tx.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                match line {
                    Ok(l) => {
                        if let Ok(v) = serde_json::from_str::<Value>(&l) {
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
        tx: tx.clone(),
        preferred,
        attached: None,
        gen: 0,
        seq: 0,
        media: Value::Null,
        art_key: String::new(),
        last_tl: None,
        last_status: String::new(),
        counts: BTreeMap::new(),
        probe: probe_secs.map(|s| Probe {
            deadline: Instant::now() + Duration::from_secs(s),
            started_wall: wall_ms(),
            counts: BTreeMap::new(),
            last_change: None,
            intervals: vec![],
            consistency: vec![],
            receipt_age: vec![],
            seeks: 0,
            status_changes: 0,
        }),
    };

    b.reattach(&mgr);
    b.emit_sessions(&mgr);
    b.refresh_media();
    b.emit_state("initial");

    loop {
        // Low-rate watchdog re-read while playing, to detect timeline updates that arrive
        // without an event (and to measure how often apps actually publish them).
        let timeout = if b.last_status == "playing" { Duration::from_millis(1000) } else { Duration::from_millis(4000) };
        if let Some(p) = &b.probe {
            if Instant::now() >= p.deadline {
                b.finish_probe();
                return;
            }
        }
        match rx.recv_timeout(timeout) {
            Ok(Msg::Changed(gen, cause)) => {
                if gen != b.gen {
                    continue;
                }
                if cause == "media" {
                    b.refresh_media();
                }
                b.emit_state(cause);
            }
            Ok(Msg::Sessions) => {
                if b.reattach(&mgr) {
                    b.refresh_media();
                    b.emit_state("session");
                }
                b.emit_sessions(&mgr);
            }
            Ok(Msg::Cmd(v)) => b.command(&mgr, v),
            Ok(Msg::StdinClosed) => {
                if b.probe.is_none() {
                    return;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                let tl = b.attached.as_ref().and_then(|a| read_timeline(&a.session));
                if tl.is_some() && tl != b.last_tl {
                    b.emit_state("poll");
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn status_str(s: Status) -> &'static str {
    match s {
        Status::Closed => "closed",
        Status::Opened => "opened",
        Status::Changing => "changing",
        Status::Stopped => "stopped",
        Status::Playing => "playing",
        Status::Paused => "paused",
        _ => "unknown",
    }
}

fn app_id(s: &Session) -> String {
    s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default()
}

fn read_timeline(s: &Session) -> Option<Timeline> {
    let tl = s.GetTimelineProperties().ok()?;
    let pos = tl.Position().ok()?.Duration as f64 / 10_000.0;
    let start = tl.StartTime().map(|t| t.Duration as f64 / 10_000.0).unwrap_or(0.0);
    let end = tl.EndTime().map(|t| t.Duration as f64 / 10_000.0).unwrap_or(0.0);
    let lu = tl.LastUpdatedTime().ok()?.UniversalTime;
    let lu_ms = (lu - EPOCH_DIFF_TICKS) as f64 / 10_000.0;
    Some(Timeline { position_ms: pos, last_updated_wall_ms: lu_ms, start_ms: start, end_ms: end })
}

fn hstr<E>(r: Result<windows::core::HSTRING, E>) -> String {
    r.map(|h| h.to_string()).unwrap_or_default()
}

impl Bridge {
    fn bump(&mut self, cause: &str) {
        *self.counts.entry(cause.to_string()).or_insert(0) += 1;
        if let Some(p) = &mut self.probe {
            *p.counts.entry(cause.to_string()).or_insert(0) += 1;
        }
    }

    /// Choose the session: preferred app if present, else the system's current session.
    /// Returns true when the attached session changed.
    fn reattach(&mut self, mgr: &Manager) -> bool {
        let mut chosen: Option<Session> = None;
        if let Ok(list) = mgr.GetSessions() {
            let n = list.Size().unwrap_or(0);
            for i in 0..n {
                if let Ok(s) = list.GetAt(i) {
                    if !self.preferred.is_empty() && app_id(&s).to_lowercase().contains(&self.preferred) {
                        chosen = Some(s);
                        break;
                    }
                }
            }
        }
        if chosen.is_none() {
            chosen = mgr.GetCurrentSession().ok();
        }
        let new_app = chosen.as_ref().map(app_id);
        let same = match (&self.attached, &chosen) {
            (Some(a), Some(c)) => a.session == *c,
            (None, None) => true,
            _ => false,
        };
        if same {
            return false;
        }
        if let Some(a) = self.attached.take() {
            let _ = a.session.RemovePlaybackInfoChanged(a.tokens[0]);
            let _ = a.session.RemoveTimelinePropertiesChanged(a.tokens[1]);
            let _ = a.session.RemoveMediaPropertiesChanged(a.tokens[2]);
        }
        self.gen += 1;
        self.last_tl = None;
        self.art_key.clear();
        if let Some(s) = chosen {
            let gen = self.gen;
            let t0 = self.tx.clone();
            let t1 = self.tx.clone();
            let t2 = self.tx.clone();
            let k0 = s
                .PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
                    let _ = t0.send(Msg::Changed(gen, "playback"));
                    Ok(())
                }))
                .unwrap_or_default();
            let k1 = s
                .TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
                    let _ = t1.send(Msg::Changed(gen, "timeline"));
                    Ok(())
                }))
                .unwrap_or_default();
            let k2 = s
                .MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
                    let _ = t2.send(Msg::Changed(gen, "media"));
                    Ok(())
                }))
                .unwrap_or_default();
            self.attached = Some(Attached { session: s, app: new_app.unwrap_or_default(), tokens: [k0, k1, k2] });
        }
        true
    }

    fn emit_sessions(&self, mgr: &Manager) {
        let mut out = vec![];
        if let Ok(list) = mgr.GetSessions() {
            let n = list.Size().unwrap_or(0);
            for i in 0..n {
                if let Ok(s) = list.GetAt(i) {
                    let status = s
                        .GetPlaybackInfo()
                        .and_then(|p| p.PlaybackStatus())
                        .map(status_str)
                        .unwrap_or("unknown");
                    out.push(json!({"app": app_id(&s), "status": status}));
                }
            }
        }
        let current = mgr.GetCurrentSession().ok().map(|s| app_id(&s));
        emit(&json!({"type": "sessions", "sessions": out, "systemCurrent": current,
                     "attached": self.attached.as_ref().map(|a| a.app.clone()), "preferred": self.preferred}));
    }

    fn refresh_media(&mut self) {
        let Some(a) = &self.attached else {
            self.media = Value::Null;
            return;
        };
        let props = match a.session.TryGetMediaPropertiesAsync().and_then(|op| op.join()) {
            Ok(p) => p,
            Err(e) => {
                self.media = json!({"error": e.to_string()});
                return;
            }
        };
        let mut genres = vec![];
        if let Ok(g) = props.Genres() {
            for i in 0..g.Size().unwrap_or(0) {
                if let Ok(h) = g.GetAt(i) {
                    let s = h.to_string();
                    if !s.trim().is_empty() {
                        genres.push(s);
                    }
                }
            }
        }
        let title = hstr(props.Title());
        let artist = hstr(props.Artist());
        self.media = json!({
            "title": title,
            "artist": artist,
            "album": hstr(props.AlbumTitle()),
            "albumArtist": hstr(props.AlbumArtist()),
            "genres": genres,
            "trackNumber": props.TrackNumber().unwrap_or(0),
        });
        // Artwork, only when the track identity changes.
        let key = format!("{}|{}|{}", a.app, artist, title);
        if key != self.art_key {
            self.art_key = key;
            if let Ok(thumb) = props.Thumbnail() {
                if let Some((mime, bytes)) = read_thumbnail(&thumb) {
                    emit(&json!({"type": "artwork", "app": a.app, "title": title, "artist": artist, "mime": mime,
                                 "base64": base64::engine::general_purpose::STANDARD.encode(bytes)}));
                }
            } else {
                emit(&json!({"type": "artwork", "app": a.app, "title": title, "artist": artist, "mime": null, "base64": null}));
            }
        }
    }

    fn emit_state(&mut self, cause: &'static str) {
        self.seq += 1;
        self.bump(cause);
        let recv_wall = wall_ms();
        let Some(a) = &self.attached else {
            self.last_status = "none".into();
            emit(&json!({"type": "state", "seq": self.seq, "cause": cause, "app": null, "status": "none", "emitWallMs": recv_wall}));
            return;
        };
        let info = a.session.GetPlaybackInfo().ok();
        let status = info.as_ref().and_then(|p| p.PlaybackStatus().ok()).map(status_str).unwrap_or("unknown");
        let rate = info
            .as_ref()
            .and_then(|p| p.PlaybackRate().ok())
            .and_then(|r| r.Value().ok())
            .unwrap_or(1.0);
        let controls = info.as_ref().and_then(|p| p.Controls().ok()).map(|c| {
            json!({
                "play": c.IsPlayEnabled().unwrap_or(false),
                "pause": c.IsPauseEnabled().unwrap_or(false),
                "toggle": c.IsPlayPauseToggleEnabled().unwrap_or(false),
                "next": c.IsNextEnabled().unwrap_or(false),
                "prev": c.IsPreviousEnabled().unwrap_or(false),
                "seek": c.IsPlaybackPositionEnabled().unwrap_or(false),
            })
        });
        let tl = read_timeline(&a.session);
        let timeline_available = tl.map(|t| t.end_ms > t.start_ms).unwrap_or(false);
        let mut v = json!({
            "type": "state",
            "seq": self.seq,
            "cause": cause,
            "app": a.app,
            "status": status,
            "rate": rate,
            "timelineAvailable": timeline_available,
            "emitWallMs": recv_wall,
            "media": self.media,
            "controls": controls,
        });
        if let Some(t) = tl {
            v["positionMs"] = json!(t.position_ms);
            v["startMs"] = json!(t.start_ms);
            v["endMs"] = json!(t.end_ms);
            v["lastUpdatedWallMs"] = json!(t.last_updated_wall_ms);
        }
        emit(&v);

        // Probe measurements.
        let playing = status == "playing";
        if let Some(p) = &mut self.probe {
            if status != self.last_status {
                p.status_changes += 1;
            }
            if let Some(t) = tl {
                let changed = self.last_tl.map(|o| o != t).unwrap_or(true);
                if changed {
                    p.receipt_age.push(recv_wall - t.last_updated_wall_ms);
                    if let Some((prev, prev_recv, prev_playing)) = p.last_change {
                        if prev_playing && playing {
                            let dpos = t.position_ms - prev.position_ms;
                            let dlu = t.last_updated_wall_ms - prev.last_updated_wall_ms;
                            let err = dpos - dlu;
                            if err.abs() < 1500.0 {
                                p.consistency.push(err);
                                p.intervals.push(recv_wall - prev_recv);
                            } else {
                                p.seeks += 1;
                            }
                        }
                    }
                    p.last_change = Some((t, recv_wall, playing));
                }
            }
        }
        self.last_tl = tl;
        self.last_status = status.to_string();
    }

    fn command(&mut self, mgr: &Manager, v: Value) {
        let id = v.get("id").cloned().unwrap_or(Value::Null);
        let cmd = v.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
        if cmd == "select" {
            self.preferred = v.get("app").and_then(|a| a.as_str()).unwrap_or("").to_lowercase();
            if self.reattach(mgr) {
                self.refresh_media();
            }
            self.emit_sessions(mgr);
            self.emit_state("session");
            emit(&json!({"type": "ack", "id": id, "ok": true}));
            return;
        }
        if cmd == "refresh" {
            self.emit_sessions(mgr);
            self.refresh_media();
            self.emit_state("refresh");
            emit(&json!({"type": "ack", "id": id, "ok": true}));
            return;
        }
        let Some(a) = &self.attached else {
            emit(&json!({"type": "ack", "id": id, "ok": false, "error": "no media session"}));
            return;
        };
        let s = &a.session;
        let r = match cmd {
            "play" => s.TryPlayAsync().and_then(|o| o.join()),
            "pause" => s.TryPauseAsync().and_then(|o| o.join()),
            "toggle" => s.TryTogglePlayPauseAsync().and_then(|o| o.join()),
            "next" => s.TrySkipNextAsync().and_then(|o| o.join()),
            "prev" => s.TrySkipPreviousAsync().and_then(|o| o.join()),
            "seek" => {
                let ms = v.get("positionMs").and_then(|p| p.as_f64()).unwrap_or(0.0).max(0.0);
                s.TryChangePlaybackPositionAsync((ms * 10_000.0) as i64).and_then(|o| o.join())
            }
            _ => {
                emit(&json!({"type": "ack", "id": id, "ok": false, "error": format!("unknown command {cmd}")}));
                return;
            }
        };
        match r {
            Ok(ok) => emit(&json!({"type": "ack", "id": id, "ok": ok, "error": if ok { Value::Null } else { json!("app declined the request") }})),
            Err(e) => emit(&json!({"type": "ack", "id": id, "ok": false, "error": e.to_string()})),
        }
    }

    fn finish_probe(&mut self) {
        let Some(p) = &self.probe else { return };
        let stats = |v: &Vec<f64>| -> Value {
            if v.is_empty() {
                return Value::Null;
            }
            let mut s = v.clone();
            s.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let abs: Vec<f64> = {
                let mut a: Vec<f64> = v.iter().map(|x| x.abs()).collect();
                a.sort_by(|x, y| x.partial_cmp(y).unwrap());
                a
            };
            let n = s.len();
            json!({
                "n": n,
                "min": s[0],
                "median": s[n / 2],
                "max": s[n - 1],
                "meanAbs": abs.iter().sum::<f64>() / n as f64,
                "p95Abs": abs[((n as f64 * 0.95) as usize).min(n - 1)],
            })
        };
        let summary = json!({
            "type": "probe-summary",
            "durationS": (wall_ms() - p.started_wall) / 1000.0,
            "app": self.attached.as_ref().map(|a| a.app.clone()),
            "eventCounts": p.counts,
            "statusChanges": p.status_changes,
            "timelineUpdateIntervalMs": stats(&p.intervals),
            "consistencyErrorMs": stats(&p.consistency),
            "lastUpdatedAgeAtReceiptMs": stats(&p.receipt_age),
            "seeksOrJumps": p.seeks,
            "notes": [
                "timelineUpdateIntervalMs: time between distinct timeline updates while playing",
                "consistencyErrorMs: (position delta) - (LastUpdatedTime delta) between successive updates; 0 means the app's timestamps are self-consistent",
                "lastUpdatedAgeAtReceiptMs: how old LastUpdatedTime was when the bridge read it"
            ]
        });
        emit(&summary);
    }
}

fn read_thumbnail(thumb: &windows::Storage::Streams::IRandomAccessStreamReference) -> Option<(String, Vec<u8>)> {
    let stream = thumb.OpenReadAsync().ok()?.join().ok()?;
    let size = stream.Size().ok()? as u32;
    if size == 0 || size > 4 * 1024 * 1024 {
        return None;
    }
    let mime = stream.ContentType().map(|h| h.to_string()).unwrap_or_else(|_| "image/png".into());
    let input = stream.GetInputStreamAt(0).ok()?;
    let reader = DataReader::CreateDataReader(&input).ok()?;
    let loaded = reader.LoadAsync(size).ok()?.join().ok()?;
    let mut buf = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut buf).ok()?;
    Some((if mime.is_empty() { "image/png".into() } else { mime }, buf))
}
