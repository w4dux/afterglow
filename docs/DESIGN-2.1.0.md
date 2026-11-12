# Afterglow 2.1.0 — The Collection

The design follows three existing favorites: Cypher's editorial weight, Velvet's warmth, and Feedback's print energy.

## New themes

- **Afterhours**: plum/espresso background, gold serif italics, a slowly turning record with album art at its center, fine orbital rules and a quiet next-line rail.
- **Riot**: dark olive ink, acid-yellow tape, condensed poster typography, outline future words and punchy active words. A separate dark, high-energy option alongside Feedback's warm paper.
- **Prism**: ultramarine/coral sleeve graphics, oversized Archivo type, a catalog number and pale-lime word highlights. Generous geometry instead of glow effects.

## Refined favorites

Cypher gets wider poster composition and clearer context labels. Velvet gets larger type, more restrained light, fine orbital lines and a small wordmark. Feedback gets revised paper/ink, an edition mark and print seal. The gallery shows these six first in larger real-scene previews. The other four themes remain selectable.

## Behavior

The new scenes use existing lyric timestamps, optional estimated sweep semantics, and the shared stage clock. Their motion is derived from lyric time and reduced motion keeps the record static as time advances. No audio genre/beat detection is invented. Narrow genre mappings use stated metadata only; previous rap/R&B/pop/alternative mappings remain.

Keyboard: 1 Cypher, 2 Nocturne, 3 Velvet, 4 Sherbet, 5 Feedback, 6 Horizon, 7 Quiet, 8 Afterhours, 9 Riot, 0 Prism. T opens the library. Settings validation and saved theme choices include all ten modes.

## Verification

123 unit tests pass; TypeScript and production builds pass. Real packaged Electron screenshots were inspected for all six highlighted themes at 1440x900. New themes were also inspected at 520x680, with compact long authored lyrics and Bengali text. Stage-bound checks found no clipped words in the showcase frames. Theme-library selection, saved preferences, and reduced motion across changing lyric time were verified. The packaged source remains the existing Electron/React engine with no playback-clock changes in this design update.

Reproduce: `npm ci`, `npm run build`, then `node scripts/preview-themes.mjs`. `AFTERGLOW_TEST_EXE` selects a packaged executable. Results and screenshots are in `docs/design-2.1.0`.
