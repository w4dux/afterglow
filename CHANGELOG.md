# Changelog

What changed in each version of Afterglow, newest first. Design notes with screenshots for recent versions are in `docs/DESIGN-*.md`.

## Unreleased: Linux

- **Afterglow runs on Linux (x64)** as an AppImage, a .deb and a .tar.gz (`npm run package:linux`).
- **Follow Spotify on Linux.** The media bridge has a Linux backend that follows Spotify, or any MPRIS player, over D-Bus: title, artist, album, length, artwork, play/pause, next/previous and seeking. Position is read once per second and only passed on when it really changed, so lyrics stay as steady as on Windows. See "Linux: MPRIS" in `docs/TECHNICAL.md`.
- First-run welcome, Music & lyrics, status cards and the diagnostics report name the right system ("MPRIS media session" on Linux).
- Bengali text falls back to Noto Sans/Serif Bengali where Nirmala UI isn't installed.
- **Window controls on Linux** follow the theme: dark symbols on light themes (they were cream on cream, so invisible), and they sit in line with the top bar's buttons.
- The now-playing pill keeps the song title whole; artist and source drop out when there isn't room, instead of everything being cut to "Insec… Lil… Spotify Ca".
- Battery saver no longer turns the bar's buttons dark on light themes (dark text on a dark fill), and selected buttons keep their highlight.
- The lyrics credit sits a little higher above the bottom bar and follows light themes.

## 2.6.0 Zine, controls that hide properly, polish

- **New theme, Zine** (punk · DIY · garage · riot grrrl; see `docs/DESIGN-2.6.0.md`): a cut-and-paste fanzine. Every word is a scrap in its own typeface and paper, slapped down as it's sung; upcoming words wait as pencilled cut-lines. The sung word is on fluoro pink, choruses on yellow highlighter, and the artwork is a cut-out-and-keep coupon. Plain "punk" stays with Feedback.
- **Controls auto-hide fixed.** They now hide when:
  - playback starts from Spotify itself, with no input in Afterglow;
  - you clicked a button (it kept focus);
  - a panel was closed with Esc.

  They stay up while paused, while a panel is open, while the pointer rests on them, and while you move through them with the keyboard. `npm run e2e:controls` checks all of this.
- **Polish:**
  - Top-bar buttons keep their size and stay clear of the window controls at every window width; the song title gives way first.
  - The Music & lyrics panel is spaced out, and the timing nudges sit on one row.
  - The theme library's NEW badge is readable on every card.
  - Feedback's intro stamp shrinks for long titles and stays clear of the artwork.
  - The welcome card points to "Music & lyrics".

## 2.5.0 Haze, Rave and Singalong

- **Three new themes** (see `docs/DESIGN-2.5.0.md`):
  - **Haze:** slow, hazy listening. Lava-lamp colour drifts behind soft, chunky 70s letters with double-vision trails; finished lines drift up like smoke.
  - **Rave:** a party. Laser fans over a crowd of raised hands; each sung word lifts the lights, and choruses fire confetti. No strobe or full-screen flashes.
  - **Singalong:** a karaoke screen. Two rows; with word timing each word fills as it is sung and a ball bounces on the words' own timestamps. With line timing the whole line fills at once and there is no ball.
  - Genre rules: psychedelic / stoner / reggae / dub / lo-fi hip hop / trip hop → Haze; party / club / big room / hardstyle / trance → Rave; karaoke / musicals / show tunes / schlager → Singalong.
- **Fixes:**
  - Lines on screen now re-fit when the window changes size (entering or leaving full screen). Before, seven themes could keep the old size until the next line.
  - Halo's dust motes no longer cost frames.
  - Each theme's stylesheet now owns its class names, and a test checks it (Haze's first draft clashed with Horizon's).

## 2.4.0 new themes and plain-language controls

- **Three new themes** (see `docs/DESIGN-2.4.0.md`):
  - **Halo:** melodic rap; a ring of light, words coming into focus.
  - **Monsoon:** Bangla and rainy-night ballads; rain on the glass, words clearing, Bengali rendered with Nirmala UI.
  - **Departures:** a departure board; each word flips in on its tile.
  - New genre rules map stated genres to them. Keys 1–9/0 keep the original ten; the new themes are in the library (T).
- **Theme fixes:** Afterhours and Prism no longer run the artist label over the artwork. Velvet keeps the next line clear of tall lines.
- **Plain language:**
  - The top bar shows "Spotify · In sync"; the timing buttons read "Earlier" / "Later".
  - The Music & lyrics panel leads with "Follow Spotify", says where the lyrics came from in one sentence, and keeps technical switches under Advanced.
  - Status cards dim the stage and offer the next step: Search again, Paste lyrics, Open a lyrics file, or Try the demo.

## 2.3.0 genre from Apple's catalogue, duets and translations, frame pacing

- **Genre from Apple's public iTunes catalogue.** Spotify publishes no genre to Windows. With online lookups on (switch: "Genre from Apple's catalogue"), Afterglow looks a new song up once by artist and title.
  - The match must be strong (same title and artist, plausible length; remixes and other artists are excluded). Results are saved for 30 days.
  - Apple's stated genre feeds the automatic theme as "Known genre · Hip-Hop/Rap (Apple catalogue)". Your own picks still come first.
  - If the song isn't in the results but at least 3 of the artist's own songs share one genre (≥ 75 %), that genre is used and labelled "this artist's songs".
  - The theme choice waits briefly for this lookup.
  - The same lookup gives the catalogue length from the same album. That is a second measure of the player's length gap: Orbiter 286.967 s at Apple vs 281.967 s from Spotify.
  - Artwork from Apple's image servers is used only when the player shows none.
- **Duets and translations (word-timed TTML).**
  - Singers named in the lyrics (`ttm:agent`) are numbered. Themes get `voice-1` / `voice-2` / `voice-group` classes, and the second singer is shown in italics.
  - Translations stated by the lyrics (inline `x-translation` spans or Apple-style head translations) appear as a caption under the stage; switch: "Show translations".
  - Romanizations are kept in the data. Nothing is machine-translated.
- **Frame pacing.** Lyric positions come from the clock, so frame rate changes smoothness only.
  - The display rate is measured. At 90 Hz and up, every 2nd frame (or more) is drawn, for about 60–72 fps.
  - With "Save battery" (on by default) and the PC on battery: about 30 fps, and no background blur.
  - 60 and 75 Hz displays still draw every frame when plugged in, because uneven skipping would stutter.
  - Diagnostics shows the measured rate.

## 2.2.0 first run, diagnostics, offset suggestion

- **Welcome (first run, Windows).**
  - One question with one primary button, **Follow Spotify**. It names the song currently playing, if any (one quick read of the Windows media session).
  - **Find lyrics online** is pre-ticked, with a one-line note on what is sent. "Try the demo first" is the alternative.
  - Shown once. People who already follow their player never see it.
- **Diagnostics report.**
  - **Copy diagnostics report** (Help panel, and the D overlay) copies a plain-text report to the clipboard: app version, current song, where its lyrics came from and why, song-length handling, timing quality and corrections, and the last log lines.
  - It contains no local paths or account data, and Afterglow sends it nowhere.
- **Log file.** `userData/logs/afterglow.log`, rolled over at 1 MB, with renderer lines rate-limited. It records start-up, the media connection, songs, lyric choices, timing-quality changes and errors. **Open log folder** opens it.
- **"Apply to all songs" suggestion.**
  - When at least 3 songs were corrected in the same direction by about the same amount (median ≥ 80 ms, ¾ within max(60 ms, 35 %)), the Timing panel offers to move that into the global offset. That is usually headphone or speaker delay.
  - Songs already corrected keep exactly their timing.
  - "Not now" is remembered until the evidence changes (3 more songs, or a different amount).

## 2.1.1 sync fixes (from the 2026-11-09 audit, `docs/AUDIT-2026-11-09.md`)

- **Song length from Spotify.** Measured on Windows: Spotify reports every song exactly 5.0 s short. This matches crossfade at 5 s. The short length made lyric matching prefer odd uploads, which were up to 1.8 s off, and drop real word timing.
  - System-player lengths are now treated as possibly short. Matching uses the length most uploads agree on, or a range until a per-player correction has been measured on several songs (`settings.learned.lengthOffsets`).
  - When several uploads exist, the most central timing wins.
  - Diagnostics (D) shows the `length` line.
- **Pause and resume.** Spotify's pause report lags about 300 ms. 2.0.3 applied it after 1.5 s, so lyrics jumped back and then forward on resume. The estimate is now held until resume, including when the lagging report arrives as a "playing" report just before the pause. Tested against two pause/resume traces captured on 2026-11-09.
- **Song changes.** A new song is not given the previous song's length when its title arrives before its timeline. The lyric search waits up to 1.5 s for the real length.
- **Line-timed lyrics.** A line before a long break ends after a generous estimate of its sung length, so the break shows as instrumental. The optional estimated sweep no longer stretches across breaks.
- **Saved lyrics.**
  - Reused for 7 days without going online; older copies are rechecked in the background.
  - A copy on screen is not swapped mid-song unless the new one adds real word timing.
  - Weak matches are not saved. Copies saved for a different song length are ignored.
  - "Nothing found" is remembered for 24 h ("Search again" bypasses it).
  - LRCLIB rate limits (HTTP 429) pause lookups instead of retrying.
  - Saved data moved from `userData/cache` (on Windows the same folder as Chromium's `Cache`) to `userData/library`. Existing files are moved on first start, and the folder is capped at 3,000 saved songs.
- **Version labels.** "Clean" or "Radio Edit" on only one side lowers a candidate's score instead of rejecting it. Live, remix, acoustic and similar labels still rule a candidate out.

## 2.1.0 theme collection

Three new displays: Afterhours (warm vinyl/serif listening room), Riot (acid-yellow punk poster), and Prism (cobalt/coral record-sleeve graphics). Cypher, Velvet and Feedback receive typography, light and print-detail refinements. The theme library prioritizes these six displays and shows live scene previews. Existing theme shortcuts 1-7 are preserved; 8 selects Afterhours, 9 Riot and 0 Prism.

New narrow genre mappings use stated metadata: lounge/smooth jazz/bossa nova -> Afterhours; hardcore/metalcore/industrial rock -> Riot; house/nu disco/future funk -> Prism. Existing rap, R&B, pop and rock defaults remain. All new motion follows lyric time, respects reduced motion and supports compact windows. Actual word timing and optional estimated effects retain their 2.0.3 semantics.

Run `node scripts/preview-themes.mjs` after building for real Electron screenshots and theme selection/layout checks in an isolated profile. Screenshots and results go to `docs/design-2.1.0`, or `AFTERGLOW_DESIGN_OUTPUT`. `AFTERGLOW_TEST_EXE` selects a packaged executable.

## 2.0.3 engine update (Windows)

This update fixes joining existing playback, stale updates after seeks, paused-position settling, and bridge reconnection. Recording keys preserve complete title/version, artist, album and source; broad theme preferences still use song keys. Existing ambiguous per-song lyric links/offsets from 2.0.2 are deliberately not copied to every recording: reattach/recalibrate them once if needed. Existing themes and motion preferences are preserved.

Online loading shows usable line timing while slower providers search. Cached line timing can refresh in the background. LRCLIB Lyricsfile 1.0 word timestamps are supported alongside enhanced LRC and AMLL TTML. Invalid word data falls back to line timing. Estimated word sweep remains optional and cannot promise vocal accuracy.

Development (PowerShell, Node.js and npm installed):

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm start
```

Build Windows artifacts with `npm run package:win`. The supplied native helper is reused; Rust is only required to change/rebuild it. `node scripts/verify-windows.mjs` tests demo playback in an isolated profile. Add `--live` to temporarily control the current Windows player, test synchronization/recovery and restore its initial position/state. Set `AFTERGLOW_TEST_EXE` to test a packaged executable, and `AFTERGLOW_TEST_OUTPUT` to choose a results directory.

Fully extract the portable ZIP before running `Afterglow.exe`; keep its resources alongside it. The installer and portable app are unsigned. See `docs/ENGINE-PLAN.md` for validation and remaining limits. Apple Music and acoustic word alignment have not been certified.
