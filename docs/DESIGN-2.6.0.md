# Afterglow 2.6.0: Zine, controls that hide properly, polish

Screenshots are in `docs/design-2.6.0`. They use the demo songs, so no copyrighted lyrics are stored.

## Zine (punk · DIY · garage · riot grrrl)

Feedback's younger sibling. Feedback is a photocopied gig poster; Zine is the cut-and-paste fanzine you'd pick up at the same show.

- **Ransom-note words.** Every word is a scrap cut from a different magazine. It has its own typeface (Anton, Fraunces Black Italic, JetBrains Mono, Archivo, Instrument Serif or Big Shoulders) and its own paper (newsprint, black, grey or yellowed). No two neighbouring words share either, and each scrap has a jagged scissor-cut edge.
  - Each typeface has a size factor so mixed faces read as one line.
  - Layout measures each word in its own typeface, so lines fit exactly.
- **Slapped down when sung.** A word lands big and twisted and settles in about 110 ms on its own timestamp. Line-timed lyrics get the usual short decorative cascade at the line start, never a fake word sweep.
- **Upcoming words** wait as faint pencilled "cut here" outlines, so you can read ahead.
- **The sung word** is on fluorescent pink paper and boils at 8 fps, like Feedback. A chorus (a line the lyrics repeat) is glued on yellow highlighter paper.
- **The finished line** is ripped off the page: it lifts, twists and falls away in 170 ms.
- **The page:**
  - an AFTERGLOW masthead;
  - the title and artist typed on a taped strip;
  - staples down the spine and photocopy grain with the copier lid's shadow;
  - a page number circled in pink;
  - the artwork as a halftone cut-out-and-keep coupon.
- **Gaps:** the intro shows the song title in ransom-note letters with a countdown; a break reads "No words, just noise"; the outro reads "The end".
- **Genres:** riot grrrl, skate / crust / anarcho / hardcore / garage / street / art / egg punk, d-beat, DIY, noise rock. Plain "punk" and "pop punk" stay with Feedback, "hardcore" and "metalcore" with Riot, and "post-punk" with Departures (tests cover both lists).

## Controls that hide properly

In 2.5.0 the controls could stay on screen for a whole song:

1. **Playback started from Spotify.** The hide timer only restarted on mouse or key input. If it ran out while paused and you then pressed play in Spotify, nothing hid the controls.
2. **One click pinned them.** A clicked button keeps keyboard focus, and focus inside the controls blocked hiding. The same happened after closing a panel with Esc, which returns focus to its button.
3. **Pointer over the bar.** "Pointer is over the bar" was tracked with enter/leave events, which the window's drag area does not reliably deliver.

The fixes:

- The countdown restarts whenever playback starts or a panel closes.
- Focus only keeps the controls up while the keyboard is the input in use.
- The pointer position is read from each pointer event.

`tests/e2e/controls-autohide.mjs` (`npm run e2e:controls`) drives the built app with real mouse and keyboard input and checks nine cases. 2.5.0 failed three of them; 2.6.0 passes all nine. Following Spotify live (read-only), the controls hid on their own while a song played.

## Polish

- **Top bar:** buttons keep their size. The song title gives way first, and at narrow widths the buttons slim down. Every button stays left of the Windows minimize/maximize/close area at every width down to the 480 px minimum. Measured: the last button ends at 333 px where the controls begin at 343 px.
- **Music & lyrics panel:** the "Lyrics for this song" section has space between its status, buttons and switches.
- **Timing panel:** the seven nudges (−250 … +250) sit on one even row instead of wrapping.
- **Theme library:** the NEW badge is yellow on dark, readable on every card. It now marks the 2.5.0 and 2.6.0 themes.
- **Feedback:** the intro/break stamp shrinks for long song titles and sits left of the artwork instead of over it.
- **Welcome card:** points to "Music & lyrics (S)", the panel's current name.

## Checked

All numbers are from the built app at 1440×900 on a 75 Hz display.

- **All 17 themes:**
  - JS frame cost ≤ 0.14 ms average and ≤ 0.2 ms p95.
  - 70–75 frames/s in the first seconds after switching.
  - Nothing outside a 520×680 window.
  - Still under reduced motion.
  - No word highlight on line-timed lyrics unless the labelled estimate is on.
  - No page errors.
- **Zine:** 0.039 ms average, 0.1 ms p95, 74.7 frames/s.
- **Intro and instrumental-break screens** of all 17 themes were reviewed side by side; no overlaps or clipped titles.
- **Live, read-only with Spotify:**
  - With line-timed and word-timed songs, Zine, Feedback, Haze and Singalong showed the real lyrics with no errors.
  - Singalong showed its ball only on the word-timed song.
- **Tests:** 223 unit tests and the 9-case controls test pass; the typecheck is clean.
