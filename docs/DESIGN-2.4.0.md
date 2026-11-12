# Afterglow 2.4.0: three new themes and plain-language controls

Screenshots and check results are in `docs/design-2.4.0`.

## New themes

These were chosen for what the owner actually plays: melodic rap, R&B and Bangla bands. All three are original designs, and every motion is a function of lyric time.

- **Halo** (melodic rap · emo rap · sad trap).
  - Centred lowercase lines under a ring of light.
  - The ring takes the artwork's most vivid colour, or violet without artwork.
  - Upcoming words sit out of focus and sharpen as they are sung.
  - Each sung word sends a brief swell through the ring. The swell comes from the word's own timestamp, never a guessed beat.
  - Dust motes rise slowly.
- **Monsoon** (Bangla · desi · rainy-night ballads).
  - A window at night: rain falls down the glass, with beads of water over out-of-focus city lights in amber, rose and teal.
  - Upcoming words are fogged; sung words clear and warm to amber.
  - The previous line runs down the glass as it fades.
  - The tagline is "বৃষ্টির রাত" ("rainy night").
  - Bengali lyrics use Windows' Nirmala UI.
- **Departures** (new wave · city pop · post-punk).
  - A station departure board in which every word is a flap tile.
  - Tiles flip in when their word arrives: on the word's timestamp, or as a short decorative cascade at the start of a line-timed line.
  - The word being sung lights amber.
  - The previous line reads DEPARTED and the next line NEXT. The board clock shows the song position.

Genre rules use stated genres only (file tags, the media session, lyric files, Apple's catalogue):

| Genres | Theme |
|---|---|
| bangla / bengali / desi / bollywood / indian pop / ghazal / sufi … | Monsoon |
| emo rap / melodic rap / sad rap / cloud rap | Halo |
| new wave / city pop / post-punk / krautrock … | Departures |

Keys 1–9 and 0 still select the original ten themes; the new ones are in the theme library (T), marked NEW.

Measured in the built app (1440×900, 600 frames over 10 s of song time, JavaScript in `scene.frame()` only):

| Theme | Average | p95 |
|---|---|---|
| Halo | 0.047 ms | 0.1 ms |
| Monsoon | 0.030 ms | 0.1 ms |
| Departures | 0.025 ms | 0.1 ms |

- At 520×680, no visible word falls outside the window.
- With reduced motion, nothing moves between two moments of the same word.

## Fixes to existing themes

- **Afterhours and Prism:** the vertical artist label ran over the record and the coral disc. They now show "Title — Artist" in the title line. Riot keeps its vertical poster label, moved to the edge.
- **Velvet:** the next line kept a fixed distance from the centre and crowded tall two- and three-row lines. Neighbours now clear the current line's real height.

## Plain-language controls

- **Top bar:** shows "Spotify · In sync" instead of "SpotifyAB… · Windows media session · Locked". The technical state stays in the tooltip.
- **Bottom bar:** the timing buttons read "Earlier" / "Later" instead of "−50" / "+50"; tooltips explain them.
- **Music & lyrics panel** (was "Sources & lyrics"), in beginner order:
  1. A Spotify card: "Follow Spotify", or "Following Spotify · Playing '…'" with Stop.
  2. Lyrics for this song in one sentence ("LRCLIB (community lyrics) · line-by-line timing"), with Search again, Paste lyrics…, Open a lyrics file…, and "Not the right lyrics? Other versions".
  3. Demos and files.
  - Providers, saved copies, the lyrics folder and "where Afterglow looked" are under **Advanced**.
  - Connection state is under **Connection details**.
- **Status cards:**
  - They sit on a dimmed, slightly blurred stage, so a theme's own big text no longer clashes with them.
  - "Press play in Spotify" replaces "Waiting for music … Bridge: on".
  - "No lyrics found for '…'" explains why, and offers Search again, Paste or Open a file. The list of sources checked is one click away.
