# Contributing to Afterglow

Thanks for helping! Bug reports, new themes and fixes are all welcome.

## Reporting a bug

1. In Afterglow, press **?** and click **Copy diagnostics report**. The report holds the song, where its lyrics came from and how the timing is doing; nothing is sent anywhere.
2. [Open an issue](https://github.com/w4dux/afterglow/issues/new) and paste the report. Add what you expected and what happened instead.

Lyrics that are a bit early or late? Say which song, and whether Spotify's **Settings → Playback → Crossfade songs** is on.

## Getting set up

You need Windows or Linux and Node 22 or newer.

```bash
npm install
```

```bash
npm run dev
```

Before you open a pull request, all of these should pass:

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

```bash
npm run e2e:controls
```

## Make your own theme

A theme is one TypeScript file and one CSS file. **Quiet** (`src/themes/quiet.ts`, about 100 lines) is the simplest one to copy; **Feedback** and **Zine** show richer motion.

### 1. Pick an id and a class prefix

Use a short lowercase id (say `neon`) and a two- or three-letter CSS prefix that no other theme uses (say `ne-`). Theme stylesheets are global, so a shared prefix makes two themes break each other; a test fails if that happens.

### 2. Write the scene: `src/themes/neon.ts`

Extend `Scene` from `src/stage/scene.ts` and fill in four parts:

| Part | What it does |
|---|---|
| `constructor` | Build the background and decorations once, with `el(...)`. |
| `createView(line)` | Make the elements for one lyric line with `buildLineView(...)`. |
| `layoutView(view)` | Fit the line into your box with `layoutFlowInto(...)`. |
| `frame(f)` | Called every frame with the song position `f.t`. Show, hide and move things. |

Use the helpers instead of writing your own timing:

- `stateOf(...)` tells you whether a word is `future`, `arrived`, `active` or `past`.
- `setUnitState(...)`, `setUnitTransform(...)` and `setLineStyle(...)` write to the page only when something changed.
- `estimatedUnit(...)` gives the optional estimated word for line-timed lyrics. Show the `est-tag` ("≈ estimated word timing") whenever you use it.

### 3. Style it: `src/themes/neon.css`

Style words by their state: `.ne-line .u[data-s='active'] { … }`, and the same for `future`, `arrived` and `past`.

### 4. Register it

- `src/core/themes/matcher.ts`: add the id to `THEME_IDS` and a name to `THEME_NAMES`. Optionally add a genre rule to `GENRE_RULES`.
- `src/themes/index.ts`: import the scene and the CSS, add an entry to `THEMES` (name, genre, tagline, fonts, colours, preview song), and add the id to `THEME_ORDER` and `NEW_THEMES`.
- `src/ui/panels/ThemePanel.tsx`: add the id to `GALLERY_ORDER`.

### The rules every theme follows

- **Never fake timing.** A word lights up on its own timestamp only. Lyrics with line timing only must not look word-timed, unless the labelled estimate is switched on.
- **Everything comes from the song position** (`f.t`), never from a clock or a timer, so pausing and seeking just work.
- **Respect reduced motion.** When `this.ctx.motion.transforms` is false, nothing moves; only colour and opacity change.
- **No beat effects without a stated tempo.** Use `f.beat` only when it is set; never guess BPM, mood or genre.
- **Keep it light.** Don't create elements or React renders every frame; cache values and write styles only when they change. No strobing or full-screen flashing.
- **Fit any window.** Lines must stay on screen from a 480 × 320 window up to full screen.

Include a screenshot or a short clip in your pull request. A demo song (Music & lyrics → demos) is perfect for that.

## Code style

TypeScript, two-space indentation, single quotes. Small, focused pull requests are easiest to review. By contributing, you agree that your work is released under the [MIT license](LICENSE).
