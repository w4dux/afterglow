# Afterglow 2.5.0: Haze, Rave and Singalong

Screenshots are in `docs/design-2.5.0` (demo song, so no copyrighted lyrics are stored).

## New themes

All three are original designs. Every motion is a function of lyric time, and none of them guesses a tempo, mood or word timing.

- **Haze** (psychedelic · stoner · lo-fi · reggae). For slow, hazy listening.
  - Five lava-lamp blobs drift on slow paths behind the words, and the colours shift around the wheel about every two minutes.
  - Fraunces at weight 900 with its soft, wonky 70s forms. Words carry pink and teal double-vision trails.
  - Upcoming words wait blurred in the haze. Each word floats on its own slow current, and the sung word swells a little.
  - The finished line drifts up and dissolves like smoke, and is gone within about 0.6 s of the new line starting.
- **Rave** (party · club · EDM · festival).
  - Laser fans sweep over a crowd of raised hands. Every sung word gives the lights and the crowd a brief lift, taken from the word's own timestamp.
  - Big neon words in Unbounded punch in; upcoming words wait as outlines.
  - A chorus (a line the lyrics repeat) fires a confetti burst.
  - The lasers swing on the beat only when the lyric source states a tempo; otherwise they sweep slowly.
  - No strobe and no full-screen flashes; brightness changes are brief and partial.
- **Singalong** (karaoke · musicals · everyone sings).
  - Two rows alternate: the line being sung and the one after it.
  - With word timing, each word fills with colour as it is sung, and a ball bounces from word to word on the words' own timestamps.
  - With line timing, the whole line fills when it starts and there is no ball, so no word timing is implied. The optional estimated sweep fills word by word and carries the "≈ estimated word timing" label.
  - Countdown dots appear in the last three seconds before vocals return. Duet voices fill in different colours.

Genre rules use stated genres only (file tags, the media session, lyric files, Apple's catalogue):

| Genres | Theme |
|---|---|
| karaoke / sing-along / show tunes / musicals / Broadway / schlager | Singalong |
| big room / electro house / hardstyle / festival / party / club / baile funk / eurodance / trance / psytrance | Rave |
| psychedelic / stoner / neo-psychedelia / space rock / chillhop / lo-fi hip hop / trip hop / downtempo / dub / reggae | Haze |

Rave is checked before Haze, so "Psychedelic Trance" goes to Rave. Reggaeton, dubstep, plain lo-fi and house keep their earlier themes; tests cover both lists.

Keys 1–9 and 0 still select the original ten themes. The new ones are in the theme library (T), marked NEW.

## Measured in the built app

1440×900 on a 75 Hz display. JavaScript is `scene.frame()` only, over 600 frames of song time. Frames per second are real, muted playback in the first three seconds after switching to the theme, so the numbers include the warm-up.

| Theme | JS average | JS p95 | Frames/s |
|---|---|---|---|
| Haze | 0.075 ms | 0.2 ms | 71 (74–75 once warm) |
| Rave | 0.051 ms | 0.1 ms | 70 |
| Singalong | 0.038 ms | 0.1 ms | 75 |
| All 16 themes | ≤ 0.11 ms | ≤ 0.2 ms | 70–75 |

- At 520×680, no visible word falls outside the window, in any theme.
- With reduced motion, nothing moves between two moments of the same word, in any theme.
- With line-timed lyrics, no theme highlights a word unless the labelled estimate is switched on.
- Line handover: in Haze the old line is at 27% opacity 0.3 s after the new line starts and gone by 0.8 s. In Rave it is gone by 0.3 s.
- A read-only check while following Spotify (paused; nothing was played, paused or seeked) showed real LRCLIB line-timed lyrics in all three themes, with no errors.

## Fixes

- **Re-fit on resize:** `Scene.resize` recomputed each theme's text box but did not re-lay out the lines already on screen. After entering or leaving full screen, seven themes kept the old size until the next line, and in a small window words could run off the edge. Lines now re-fit immediately.
- **Halo:** the dust motes now move on their own compositor layer, which took Halo from 64 to 69–70 frames/s.
- **Class names:** Haze's first draft used Horizon's `hz-` prefix, so the two stylesheets overrode each other's lyric rows. Haze now uses `hy-`, and a test fails if two themes share a prefix.
