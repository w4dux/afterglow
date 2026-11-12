//! A tiny MPRIS player for testing the Linux bridge without Spotify.
//!
//! Behaves like Spotify's Linux client: Position is readable but never announced in
//! PropertiesChanged, SetPosition emits Seeked, and Next changes Metadata.
//!
//!   cargo run --example fake_mpris_player [name]     (default name: spotify)
//!
//! Run it inside `dbus-run-session` together with the bridge, or on a desktop session.

use std::sync::{Arc, Mutex};
use std::time::Instant;
use zbus::blocking::connection;
use zbus::object_server::SignalEmitter;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};
use zbus::interface;

struct State {
    track: usize,
    playing: bool,
    /// Position (µs) at `since`.
    base_us: i64,
    since: Instant,
}

impl State {
    fn position(&self) -> i64 {
        self.base_us + if self.playing { self.since.elapsed().as_micros() as i64 } else { 0 }
    }
    fn set(&mut self, us: i64) {
        self.base_us = us;
        self.since = Instant::now();
    }
}

const TRACKS: [(&str, &str, i64); 2] = [("Orbiter", "Test Artist", 281_967_000), ("Second Song", "Other Artist", 200_000_000)];

struct Root;

#[interface(name = "org.mpris.MediaPlayer2")]
impl Root {
    #[zbus(property)]
    fn identity(&self) -> String {
        "Fake Player".into()
    }
    #[zbus(property)]
    fn can_quit(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn can_raise(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        false
    }
}

struct Player(Arc<Mutex<State>>);

fn metadata(track: usize) -> std::collections::HashMap<String, OwnedValue> {
    let (title, artist, len) = TRACKS[track];
    let mut m = std::collections::HashMap::new();
    let path = ObjectPath::try_from(format!("/com/example/track/{track}")).unwrap();
    m.insert("mpris:trackid".into(), Value::from(path).try_into().unwrap());
    m.insert("mpris:length".into(), OwnedValue::from(len));
    m.insert("xesam:title".into(), Value::from(title).try_into().unwrap());
    m.insert("xesam:artist".into(), Value::from(vec![artist]).try_into().unwrap());
    m.insert("xesam:album".into(), Value::from("Test Album").try_into().unwrap());
    m
}

#[interface(name = "org.mpris.MediaPlayer2.Player")]
impl Player {
    async fn play(&self, #[zbus(signal_emitter)] e: SignalEmitter<'_>) {
        {
            let mut s = self.0.lock().unwrap();
            let p = s.position();
            s.playing = true;
            s.set(p);
        }
        let _ = self.playback_status_changed(&e).await;
    }
    async fn pause(&self, #[zbus(signal_emitter)] e: SignalEmitter<'_>) {
        {
            let mut s = self.0.lock().unwrap();
            let p = s.position();
            s.playing = false;
            s.set(p);
        }
        let _ = self.playback_status_changed(&e).await;
    }
    async fn play_pause(&self, #[zbus(signal_emitter)] e: SignalEmitter<'_>) {
        {
            let mut s = self.0.lock().unwrap();
            let p = s.position();
            s.playing = !s.playing;
            s.set(p);
        }
        let _ = self.playback_status_changed(&e).await;
    }
    async fn next(&self, #[zbus(signal_emitter)] e: SignalEmitter<'_>) {
        {
            let mut s = self.0.lock().unwrap();
            s.track = (s.track + 1) % TRACKS.len();
            s.set(0);
        }
        let _ = self.metadata_changed(&e).await;
    }
    async fn previous(&self, #[zbus(signal_emitter)] e: SignalEmitter<'_>) {
        self.0.lock().unwrap().set(0);
        let _ = Player::seeked(&e, 0).await;
    }
    async fn set_position(&self, _track: ObjectPath<'_>, position: i64, #[zbus(signal_emitter)] e: SignalEmitter<'_>) {
        self.0.lock().unwrap().set(position);
        let _ = Player::seeked(&e, position).await;
    }
    async fn seek(&self, offset: i64, #[zbus(signal_emitter)] e: SignalEmitter<'_>) {
        let p = {
            let mut s = self.0.lock().unwrap();
            let p = (s.position() + offset).max(0);
            s.set(p);
            p
        };
        let _ = Player::seeked(&e, p).await;
    }
    #[zbus(signal)]
    async fn seeked(e: &SignalEmitter<'_>, position: i64) -> zbus::Result<()>;

    #[zbus(property)]
    fn playback_status(&self) -> String {
        if self.0.lock().unwrap().playing { "Playing" } else { "Paused" }.into()
    }
    #[zbus(property)]
    fn metadata(&self) -> std::collections::HashMap<String, OwnedValue> {
        metadata(self.0.lock().unwrap().track)
    }
    /// Like Spotify: readable, never announced.
    #[zbus(property(emits_changed_signal = "false"))]
    fn position(&self) -> i64 {
        self.0.lock().unwrap().position()
    }
    #[zbus(property)]
    fn rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn can_control(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_play(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_pause(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_seek(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        true
    }
}

fn main() -> zbus::Result<()> {
    let name = std::env::args().nth(1).unwrap_or_else(|| "spotify".into());
    let state = Arc::new(Mutex::new(State { track: 0, playing: true, base_us: 30_000_000, since: Instant::now() }));
    let _conn = connection::Builder::session()?
        .name(format!("org.mpris.MediaPlayer2.{name}"))?
        .serve_at("/org/mpris/MediaPlayer2", Root)?
        .serve_at("/org/mpris/MediaPlayer2", Player(state))?
        .build()?;
    eprintln!("fake MPRIS player 'org.mpris.MediaPlayer2.{name}' running");
    loop {
        std::thread::park();
    }
}
