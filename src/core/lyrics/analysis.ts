import type { LyricDocument } from './model';

/**
 * Text/timing analysis of a lyric document. Everything here is derived from the
 * lyric data itself (repetition, measured words-per-second). Nothing is guessed
 * from audio and nothing claims to know the genre.
 */
export interface LyricAnalysis {
  /** Lines whose normalized text occurs at least twice: hooks / refrains. */
  hookLines: Set<number>;
  /** Words/second per line (NaN when the line has no usable duration). */
  lineWps: number[];
  /** Median words/second over sung lines; undefined without timing. */
  medianWps?: number;
  /** 80th percentile words/second. */
  p80Wps?: number;
  /** Lines that are fast enough to need compressed motion. */
  fastLines: Set<number>;
  /**
   * 80th-percentile syllables per second over timed lines: the song's typical singing
   * pace. Used only to size the optional, labelled estimated word sweep.
   */
  p80Sps?: number;
  /** Fraction of the song (first line → last line end) that is instrumental gap. */
  gapFraction?: number;
  wordCount: number;
}

export function normalizeLineText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rough English syllable count (vowel groups, silent trailing e), minimum 1. */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z\u00e0-\u00ff]/g, '');
  if (!w) return 1;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy\u00e0-\u00ff]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export function analyzeLyrics(doc: LyricDocument): LyricAnalysis {
  const lines = doc.lines;
  const counts = new Map<string, number>();
  const keys = lines.map((l) => normalizeLineText(l.text));
  keys.forEach((k) => counts.set(k, (counts.get(k) ?? 0) + 1));
  const hookLines = new Set<number>();
  keys.forEach((k, i) => {
    if (k.split(' ').length >= 2 && (counts.get(k) ?? 0) >= 2) hookLines.add(i);
  });

  const lineWps: number[] = [];
  const lineSps: number[] = [];
  const fastLines = new Set<number>();
  let wordCount = 0;
  for (const l of lines) {
    const words = l.text.split(/\s+/).filter(Boolean).length;
    wordCount += words;
    let durMs: number;
    if (l.wordTiming === 'exact' && l.words.length > 0) {
      durMs = l.words[l.words.length - 1].endMs - l.words[0].startMs;
    } else {
      durMs = l.endMs - l.startMs;
    }
    // Ignore implausible durations (e.g. a line held across a long instrumental).
    const wps = durMs > 250 && durMs < 15000 ? words / (durMs / 1000) : NaN;
    lineWps.push(wps);
    if (Number.isFinite(wps)) {
      const syl = l.text.split(/\s+/).filter(Boolean).reduce((a, w) => a + countSyllables(w), 0);
      lineSps.push(syl / (durMs / 1000));
    }
    if (wps >= 3.2) fastLines.add(l.index);
  }

  const valid = lineWps.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const pick = (q: number) => (valid.length ? valid[Math.min(valid.length - 1, Math.floor(q * valid.length))] : undefined);

  let gapFraction: number | undefined;
  if (lines.length >= 2) {
    const span = lines[lines.length - 1].endMs - lines[0].startMs;
    let gaps = 0;
    for (let i = 0; i + 1 < lines.length; i++) gaps += Math.max(0, lines[i + 1].startMs - lines[i].endMs);
    if (span > 0) gapFraction = gaps / span;
  }

  return {
    hookLines,
    lineWps,
    medianWps: doc.timing === 'none' ? undefined : pick(0.5),
    p80Wps: doc.timing === 'none' ? undefined : pick(0.8),
    p80Sps: (() => {
      if (doc.timing === 'none' || lineSps.length < 3) return undefined;
      const s = [...lineSps].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(0.8 * s.length))];
    })(),
    fastLines,
    gapFraction,
    wordCount,
  };
}
