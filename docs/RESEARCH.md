# How similar projects get lyrics and Spotify timing

Reviewed in November 2026 by reading the source code (not just READMEs) of:

- [jayfunc/BetterLyrics](https://github.com/jayfunc/BetterLyrics): WinUI 3 lyrics app on Windows media sessions (GPL-3.0)
- [WXRIW/Lyricify-Lyrics-Helper](https://github.com/WXRIW/Lyricify-Lyrics-Helper): provider and parser library behind Lyricify (Apache-2.0)
- [amll-dev/amll-ttml-db](https://github.com/amll-dev/amll-ttml-db): community word-timed TTML database (CC0)
- [moehmeni/syncedlyrics](https://github.com/moehmeni/syncedlyrics): Python multi-provider LRC fetcher (MIT)
- [spicetify/cli](https://github.com/spicetify/cli), including its `lyrics-plus` custom app
- [akashrchandran/spotify-lyrics-api](https://github.com/akashrchandran/spotify-lyrics-api): Spotify lyrics via an account cookie (AGPL-3.0)
- [tranxuanthang/lrcget](https://github.com/tranxuanthang/lrcget): LRCLIB downloader

## Playback timing from Spotify

None of these projects has a more precise clock for Spotify than Afterglow already uses.

- **BetterLyrics** reads the Windows media session (SMTC/GSMTC) through a wrapper library and relies on a manual per-player offset, with an option to reset it on song change. For a few other players it reads process memory or uses a WebSocket.
- **Spicetify's** `Player.getProgress()` is `positionAsOfTimestamp + (now - timestamp)` from Spotify's internal player state. That is the same anchor-plus-extrapolation model as Afterglow's engine, but read inside the Spotify client (which has to be modified to run it).
- Afterglow additionally rejects stale observations, slews small drift, and, from field data, holds Spotify's post-pause position reports, which are about 0.3 s behind.

**Conclusion:** keep the Windows media session as the default clock. The only clear gain on offer is Spotify's track ID (Spicetify, or the official Web API), which would improve lyric matching rather than timing.

## Lyric sources

| Source | Used by | Timing | How it is accessed | In Afterglow |
|---|---|---|---|---|
| **LRCLIB** | BetterLyrics, syncedlyrics, lrcget, lyrics-plus, Lyricify | mostly line, some word | documented public API, no key | **yes** (since 2.0) |
| **AMLL TTML DB** | BetterLyrics | **word** (syllable) | CC0 files on GitHub; ~1.7 MB index of 3,430 songs (2,159 with Spotify ID, 2,210 with ISRC), mostly Chinese/Japanese pop, ~700 Western | **yes** (2.0.2) |
| NetEase Cloud Music | BetterLyrics, syncedlyrics, lyrics-plus, Lyricify | line; word (YRC) via encrypted API | undocumented private API; word timing needs hard-coded encryption keys | no |
| Kugou | BetterLyrics, Lyricify | word (KRC) | undocumented API; KRC files must be decrypted | no |
| QQ Music | BetterLyrics, Lyricify | word (QRC) | undocumented API; QRC must be 3DES-decrypted with a hard-coded key | no |
| Musixmatch | syncedlyrics, lyrics-plus, Lyricify | line + word ("richsync") | impersonates Musixmatch's desktop app to get an anonymous token; against Musixmatch terms (their official API needs a paid plan) | no |
| Apple Music TTML | BetterLyrics, Lyricify | syllable | needs your own Apple Music subscription token | no |
| Spotify's own lyrics | spotify-lyrics-api / syrics, lyrics-plus, Lyricify | line, some syllable | private endpoint (`spclient…/color-lyrics`) with your account's `sp_dc` cookie or reverse-engineered web-player secrets; the projects themselves warn this is against Spotify's terms | no |
| Genius, Megalobiz, Lyricsify | syncedlyrics | plain / line | website scraping | no |

## Patterns adopted in 2.0.2

- **Parallel providers with one scoring scale.** BetterLyrics scores every candidate on title 30%, artist 30%, album 10% and duration 30%, then keeps the best above a threshold. Afterglow now does the same, weighted 40/35/5/20 because album names differ across editions. Matching ISRC or Spotify IDs counts as certain, and titles are cleaned of feat./remaster tags first.
- **Prefer word timing** when its match is within 8 points of the best line-timed match.
- **Cross-check sources:** compare the median line-start offset between two synced results. If they differ by more than 1.5 s, they are different recordings, and the one whose duration matches better wins.
- **Consensus across LRCLIB uploads:** when three or more versions match, pick the one whose timings agree with the most others. This guards against a single badly-timed upload.
- **Local cache** of lyrics found online: instant on replay, works offline, and covers a provider outage. A *Search again* button bypasses it.

## Not adopted, and what they would need

- **The unofficial Chinese-platform sources** (NetEase/Kugou/QQ) have the largest word-timed catalogs, including many Western songs. They rely on undocumented APIs and on decrypting the platforms' lyric files. They can be added as an opt-in "unofficial sources" switch if you accept that.
- **Spotify private lyrics (sp_dc cookie)** and **Musixmatch app-token impersonation** were excluded by the original brief. They also put your accounts at risk.
- **A Spicetify bridge** would be a small Spotify-client extension that streams the track ID and player state to Afterglow over localhost. It modifies the Spotify client (against Spotify's terms, and it breaks on Spotify updates), so it would only make sense as an optional add-on.
- **The Spotify Web API (official)** needs your own free developer app and a login. It gives the track ID and ISRC, which improves matching, but its position is no better than the Windows session's.
- **Audio alignment** is the only route to real word timing for any song without private APIs: capture what is playing (WASAPI loopback) and align the lyric text to the vocals, for example with a local speech model such as whisper.cpp. It is heavy, but legitimate.
