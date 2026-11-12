/**
 * Song length as reported by a player versus the recording's real length.
 *
 * Measured on Windows (2026-11-09): Spotify's media session reported every song
 * exactly 5.0 s shorter than its catalogue length (4 of 4 songs, checked against
 * Apple's catalogue and LRCLIB), and switched songs at that shortened end, which is
 * what Spotify's crossfade setting does. Players may therefore report a length that
 * is short by up to their maximum crossfade (Spotify: 12 s).
 *
 * Nothing here is guessed per song: the real length comes from what several lyric
 * uploads agree on, and a per-player correction is only used once several songs
 * measured the same gap.
 */

/** Largest shortfall accepted: Spotify's maximum crossfade plus rounding. */
export const MAX_SHORTFALL_SEC = 12.5;
/** Uploads are allowed to be slightly shorter than the reported length (rounding). */
export const SHORT_SLACK_SEC = 2;
/** Samples kept per player. */
export const MAX_SAMPLES = 9;
/** Samples needed before a correction is used. */
export const MIN_SAMPLES = 3;
/** Samples must agree within this much of their median. */
export const AGREE_SEC = 0.75;

/** Range the real length may lie in, given a reported length that may be short. */
export function lengthWindow(reportedSec: number): [number, number] {
  return [reportedSec - SHORT_SLACK_SEC, reportedSec + MAX_SHORTFALL_SEC];
}

/**
 * The real length of a recording, from candidate lengths of the same title and artist
 * (for example LRCLIB uploads): the largest group of lengths within ±1 s of each other,
 * inside the plausible window. Needs at least 3 agreeing uploads and at least half of
 * the plausible ones; otherwise undefined (not enough evidence).
 */
export function lengthCluster(lengthsSec: number[], reportedSec: number): number | undefined {
  const [lo, hi] = lengthWindow(reportedSec);
  const xs = lengthsSec.filter((d) => Number.isFinite(d) && d >= lo && d <= hi).sort((a, b) => a - b);
  if (xs.length < 3) return undefined;
  let best: number[] = [];
  for (const center of xs) {
    const group = xs.filter((d) => Math.abs(d - center) <= 1);
    if (group.length > best.length) best = group;
  }
  if (best.length < 3 || best.length * 2 < xs.length) return undefined;
  return median(best);
}

/** Correction (s) to add to a player's reported length, once enough songs agree. */
export function learnedOffsetSec(samples: readonly number[] | undefined): number | undefined {
  const xs = (samples ?? []).filter((x) => Number.isFinite(x));
  if (xs.length < MIN_SAMPLES) return undefined;
  const m = median(xs);
  const agreeing = xs.filter((x) => Math.abs(x - m) <= AGREE_SEC).length;
  if (agreeing * 3 < xs.length * 2) return undefined;
  return Math.round(m * 10) / 10;
}

/** Append a measured gap (catalogue length minus reported length), keeping the latest few. */
export function addLengthSample(samples: readonly number[] | undefined, gapSec: number): number[] {
  const out = [...(samples ?? []), Math.round(gapSec * 100) / 100];
  return out.slice(-MAX_SAMPLES);
}

/** Key for per-player samples: the media app id, lowercased. */
export function playerKey(app: string | undefined): string | undefined {
  const k = app?.trim().toLowerCase();
  return k ? k.slice(0, 120) : undefined;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
