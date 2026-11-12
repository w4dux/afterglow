import type { LyricDocument, LyricLine } from './model';

/**
 * Cue lookup. Given lyric time t (ms) find the current line, the active word and
 * whether we are in a gap (intro / instrumental / outro).
 *
 * Semantics (all intervals [start, end)):
 *  - `lineIndex` is the most recently *started* line (start <= t), or -1 before the first.
 *  - `inLine` is true while t < line.end. Between line.end and next.start the line is
 *    "sustained": still current for display, but no word is active.
 *  - A gap longer than `instrumentalGapMs` becomes an explicit instrumental state.
 */

export interface GapInfo {
  kind: 'intro' | 'instrumental' | 'outro';
  startMs: number;
  endMs: number; // Infinity for outro without a known end
  /** 0..1 progress through the gap (0 for open-ended outro). */
  progress: number;
}

export interface CueState {
  t: number;
  lineIndex: number;
  inLine: boolean;
  /** Progress through [start, end) of the current line, clamped to 0..1. */
  lineProgress: number;
  /** Index into line.words of the active timed unit, -1 if none (or untimed line). */
  wordIndex: number;
  /** Number of units whose start <= t (exact timing only), for "arrived" logic. */
  arrivedCount: number;
  nextIndex: number;
  gap: GapInfo | null;
}

export const DEFAULT_INSTRUMENTAL_GAP_MS = 4500;

export class CueIndex {
  private lastLine = -1;
  constructor(
    readonly doc: LyricDocument,
    private readonly instrumentalGapMs = DEFAULT_INSTRUMENTAL_GAP_MS,
  ) {}

  /** Index of the last line with start <= t, using a cached hint for O(1) sequential playback. */
  lineAt(t: number): number {
    const lines = this.doc.lines;
    const n = lines.length;
    if (n === 0 || t < lines[0].startMs) return (this.lastLine = -1);
    let i = this.lastLine;
    if (i >= 0 && i < n && lines[i].startMs <= t && (i + 1 >= n || lines[i + 1].startMs > t)) return i;
    if (i >= 0 && i + 1 < n && lines[i + 1].startMs <= t && (i + 2 >= n || lines[i + 2].startMs > t)) {
      return (this.lastLine = i + 1);
    }
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].startMs <= t) lo = mid;
      else hi = mid - 1;
    }
    return (this.lastLine = lo);
  }

  cue(t: number): CueState {
    const lines = this.doc.lines;
    const li = this.lineAt(t);
    const nextIndex = li + 1 < lines.length ? li + 1 : -1;
    if (li < 0) {
      const first = lines[0];
      return {
        t,
        lineIndex: -1,
        inLine: false,
        lineProgress: 0,
        wordIndex: -1,
        arrivedCount: 0,
        nextIndex: lines.length ? 0 : -1,
        gap: first
          ? { kind: 'intro', startMs: 0, endMs: first.startMs, progress: clamp01(first.startMs > 0 ? t / first.startMs : 1) }
          : null,
      };
    }
    const line = lines[li];
    const inLine = t < line.endMs;
    const lineProgress = clamp01((t - line.startMs) / Math.max(1, line.endMs - line.startMs));
    let wordIndex = -1;
    let arrivedCount = 0;
    if (line.wordTiming === 'exact') {
      const r = wordAt(line, t);
      wordIndex = r.active;
      arrivedCount = r.arrived;
    }
    let gap: GapInfo | null = null;
    if (!inLine) {
      const next = nextIndex >= 0 ? lines[nextIndex] : undefined;
      if (!next) {
        gap = { kind: 'outro', startMs: line.endMs, endMs: Infinity, progress: 0 };
      } else if (next.startMs - line.endMs >= this.instrumentalGapMs) {
        gap = {
          kind: 'instrumental',
          startMs: line.endMs,
          endMs: next.startMs,
          progress: clamp01((t - line.endMs) / (next.startMs - line.endMs)),
        };
      }
    }
    return { t, lineIndex: li, inLine, lineProgress, wordIndex, arrivedCount, nextIndex, gap };
  }
}

/** Active unit (start <= t < end) and count of units that have started. Binary search. */
export function wordAt(line: LyricLine, t: number): { active: number; arrived: number } {
  const ws = line.words;
  let lo = 0;
  let hi = ws.length; // first index with start > t
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ws[mid].startMs <= t) lo = mid + 1;
    else hi = mid;
  }
  const arrived = lo;
  const cand = arrived - 1;
  const active = cand >= 0 && t < ws[cand].endMs ? cand : -1;
  return { active, arrived };
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
