//! Afterglow media bridge.
//!
//! Observes the Windows Global System Media Transport Controls (GSMTC) session of a
//! media app (Spotify by default) through the documented WinRT API
//! `Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager` and writes
//! newline-delimited JSON to stdout. Commands arrive as JSON lines on stdin.
//!
//! It never touches Spotify's private endpoints, tokens or cookies: it only sees what
//! the app chooses to publish to Windows' media overlay.
//!
//! Usage:
//!   afterglow-media-bridge.exe [--prefer spotify]            stream NDJSON (used by Afterglow)
//!   afterglow-media-bridge.exe --probe 60 [--prefer spotify] measure update behaviour for 60 s

#[cfg(not(windows))]
use serde_json::json;
use serde_json::Value;
use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn wall_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn emit(v: &Value) {
    let out = io::stdout();
    let mut lock = out.lock();
    let _ = writeln!(lock, "{}", v);
    let _ = lock.flush();
}

#[cfg(not(windows))]
fn main() {
    emit(&json!({"type": "hello", "version": 1, "platform": std::env::consts::OS, "wallMs": wall_ms()}));
    emit(&json!({"type": "status", "available": false,
        "error": "Windows media sessions (GSMTC) are only available on Windows 10 1809 or later."}));
}

#[cfg(windows)]
mod win;

#[cfg(windows)]
fn main() {
    win::run();
}
