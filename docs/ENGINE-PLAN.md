# Engine improvement plan — 2.0.3

Baseline: Claude source 2.0.2, reviewed 2026-11-09. Preserve existing themes and local/demo playback. Pre-existing working tree changes: two shell-script mode changes and the supplied native bridge binary; do not revert these.

## Confirmed problems and implementation order

1. Playback correctness: attach at the existing position; map each Windows timestamp consistently; process state changes independently of stale timeline data; keep pre-seek observations from undoing optimistic seeks; handle seek acknowledgements and timeout; scope Spotify pause compensation and accept intentional paused seeks.
2. Recording identity: keep source, complete title, artist and album in lyric/cache/offset identity; keep broad theme identity separate. Duration updates must not cause repeated track resets. Publish metadata enrichment without reloading the same recording unnecessarily.
3. Recovery: freeze with unavailable timing on bridge loss, clear capabilities, resynchronize on reconnect, bound retries and detect a silent bridge using a low-rate refresh watchdog. Avoid changing the supplied Rust binary without a working native toolchain.
4. Lyric data: consume actual LRCLIB word timing when present, retain AMLL TTML and local imports, publish a usable online result while slower providers run, allow a better result to upgrade it, guard cancellation and manual selection, and refresh cached line timing in the background. Reject clearly incompatible recordings; a global offset cannot repair a different arrangement.
5. Verification: establish baseline tests, add deterministic regressions and replay captured Windows traces, run typecheck and production build, test the new app against live Spotify, package a separate Windows build. Record actual results and limitations here.

## Acceptance criteria

- Opening mid-song uses its real position immediately.
- Pause/resume never adds paused time or rejects valid state due to timestamp conversion jitter.
- A pending seek survives stale reports, resolves to actual player state, and reports a declined/expired command.
- A small paused seek is applied promptly; sparse but healthy playback remains smooth.
- Bridge loss stops extrapolation and reconnection accepts a fresh stream.
- Radio/clean/live/album versions cannot silently share lyrics or timing offsets.
- Fast usable lyrics appear before a slow provider completes; only a current request may upgrade the display.
- Actual word timestamps drive karaoke; line-only data remains explicitly estimated when that optional effect is enabled.
- Existing themes, manual lyrics, offsets, and offline demo remain usable.

## Boundaries

No claim of acoustic millisecond accuracy or universal word-timing coverage. Apple Music compatibility needs its own live session. Spicetify remains an optional future adapter, not a dependency of this release. No Spotify private lyric endpoint or account-cookie integration.

## Results

Implemented in 2.0.3:
- Correct attachment and stable mapping of repeated Windows timestamps; valid state updates survive stale position timestamps.
- Pending seek IDs, stale report rejection, acknowledgement failure and bounded rollback; opt-in Spotify pause settling with eventual correction; forward paused seeks are immediate.
- Strict recording identities for lyrics/cache/offsets, broad theme identities, bounded artwork cache and metadata enrichment.
- Freeze on connection loss, capability reset, clean reconnection epochs, idle refresh watchdog and bounded restart budget.
- LRCLIB Lyricsfile 1.0 word timing, validated parsing and lossless original-payload cache; progressive provider publication; stale request/manual choice protection; cached line refresh; incompatible recording rejection.

Validation:
- Original 95 tests passed before changes. Updated suite: 119 tests pass; TypeScript checking and production builds pass.
- A captured real Windows Spotify pause/resume trace is replayed in regression tests.
- Real Electron and the packaged Windows executable were tested with isolated settings. Demo word timing, live attachment, pause, three forward/backward/small seeks, resume, actual native-helper termination/restart, and both online providers passed. Spotify returned to the captured position/state. Small paused player corrections up to 25 ms are allowed in the live stability check.
- Packaged main, preload and renderer bytes match the tested production build.

Remaining limits/follow-up:
- Actual speaker/vocal alignment and Apple Music compatibility are not certified. Current live song had line timing only; real word-timing ingestion is validated with authored Lyricsfile/TTML fixtures.
- The supplied Rust helper still performs metadata/artwork retrieval on its event loop. A deeper native refactor requires rebuilding it with Rust; no Rust toolchain was installed, so this release reuses the supplied binary and improves supervision around it.
- Renderer request cancellation prevents stale display/cache results; already-started provider IPC/network requests can continue until their existing timeouts. Native request cancellation and rate-limit-aware scheduling are a later improvement.
- Legacy broad recording offsets/links are preserved in settings but not automatically applied to distinct new recording identities. Reattach/recalibrate once where needed. Theme preferences remain shared by the existing broad song key.
- This is still an Electron app. No claim of reduced memory use is made without a separate performance benchmark.

Delivery: validated Windows x64 portable ZIP and source archive, with run/build instructions. No installed app replacement was performed.
