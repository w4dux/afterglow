/**
 * Normalized internal lyric model.
 *
 * Every parser (LRC, enhanced LRC, TTML, plain text, embedded tags, LRCLIB)
 * produces a LyricDocument. All times are in milliseconds of *lyric time*,
 * i.e. media position after the document's own [offset:] tag has been applied.
 * The user's timing offset is applied later, in the stage loop, never baked in.
 *
 * Interval convention everywhere: [startMs, endMs) — start inclusive, end exclusive.
 */
import { countSyllables } from './analysis';

export type DocTiming = 'word' | 'line' | 'none';

export interface LyricWord {
  /** Display text of this timed unit (a word, or a syllable of a word). */
  text: string;
  startMs: number;
  endMs: number;
  /** True when whitespace follows this unit (i.e. the next unit starts a new word). */
  space: boolean;
  /** Background / ad-lib vocal unit (TTML x-bg role). */
  bg?: boolean;
}

export interface LyricLine {
  /** Index in document.lines; stable for the document's lifetime. */
  index: number;
  startMs: number;
  endMs: number;
  /** True when the end time came from the source (word end / blank marker / TTML end). */
  endKnown: boolean;
  text: string;
  /**
   * Units for layout. When `wordTiming` is 'exact' the start/end values are real
   * timestamps from the source. When 'none', every word carries the line interval
   * and MUST NOT be presented as per-word karaoke timing.
   */
  words: LyricWord[];
  wordTiming: 'exact' | 'none';
  /**
   * Singer, when the source names one (TTML ttm:agent): 1, 2, 3… in order of first
   * appearance; 0 for a group ("everyone"). Undefined when not stated.
   */
  voice?: number;
  /** Translation of this line stated by the source (never machine-made). */
  translation?: string;
  /** Romanization / transliteration stated by the source. */
  romanization?: string;
}

export type LyricSourceKind =
  | 'demo'
  | 'local-file'
  | 'sidecar'
  | 'embedded'
  | 'lrclib'
  | 'amll'
  | 'cache'
  | 'pasted'
  | 'none';

export interface LyricSource {
  kind: LyricSourceKind;
  /** Human readable, e.g. "night-drive.lrc" or "LRCLIB". */
  label: string;
  /** Attribution text that must be displayed with the lyrics, when required. */
  attribution?: string;
  /** Format the text was parsed from. */
  format: 'lrc' | 'elrc' | 'ttml' | 'lyricsfile' | 'plain' | 'sylt' | 'none';
  /** Match confidence for searched sources. */
  match?: 'exact' | 'probable' | 'ambiguous' | 'loose' | 'manual';
  /** Extra context shown with the source, e.g. a duration mismatch. */
  note?: string;
}

export interface LyricMeta {
  title?: string;
  artist?: string;
  album?: string;
  lengthMs?: number;
  /** [offset:] tag as found in the file (already applied to all times). */
  fileOffsetMs?: number;
  /** Genre stated by the lyric file itself (Afterglow extension tag [genre:]). */
  genre?: string;
  /** Tempo stated by the file ([bpm:] extension tag). Never estimated by the parser. */
  bpm?: number;
  /** Time of a downbeat in lyric time ([beat:] extension tag), required for pulse. */
  beatOffsetMs?: number;
  /** Beats per bar, default 4. */
  beatsPerBar?: number;
  instrumental?: boolean;
}

export interface LyricDocument {
  timing: DocTiming;
  lines: LyricLine[];
  meta: LyricMeta;
  source: LyricSource;
  /** Present for unsynced documents: the raw text, preserving stanzas. */
  plainText?: string;
}

export function emptyDocument(source: LyricSource, meta: LyricMeta = {}): LyricDocument {
  return { timing: 'none', lines: [], meta, source };
}

/** Split plain line text into untimed layout units carrying the line interval. */
export function untimedWords(text: string, startMs: number, endMs: number): LyricWord[] {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return parts.map((p, i) => ({ text: p, startMs, endMs, space: i < parts.length - 1 }));
}

/** Gap length shown as an instrumental break (kept equal to cues.DEFAULT_INSTRUMENTAL_GAP_MS). */
const BREAK_MS = 4500;

/**
 * End of a line whose source states only its start (line-timed LRC). Normally the next
 * line's start. Before a long break the line is not still being sung, so it ends after
 * a generous estimate of its sung length (about 2.5 syllables per second plus a held
 * ending, at least 4 s), but only when a clear break of at least BREAK_MS remains.
 * This changes when the line counts as finished, never word timing.
 */
export function estimateLineEnd(line: LyricLine, nextStartMs: number): number {
  const syllables = line.words.reduce((s, w) => s + countSyllables(w.text), 0);
  const generous = Math.max(4000, syllables * 400 + 1500);
  return nextStartMs - line.startMs > generous + BREAK_MS ? line.startMs + generous : nextStartMs;
}

/** Best-effort default end for the very last line when the source does not state one. */
export function estimateTailEnd(startMs: number, wordCount: number, lengthMs?: number): number {
  const est = startMs + Math.min(9000, 1600 + wordCount * 420);
  if (lengthMs && lengthMs > startMs) return Math.min(est, lengthMs);
  return est;
}

/**
 * Finalize a list of lines: sort, assign indices, derive missing end times from
 * the following line, clamp word intervals so they are monotonic and inside the line.
 */
export function finalizeLines(lines: LyricLine[], lengthMs?: number): LyricLine[] {
  const sorted = lines
    .filter((l) => Number.isFinite(l.startMs))
    .sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < sorted.length; i++) {
    const line = sorted[i];
    line.index = i;
    const next = nextMainLine(sorted, i);
    if (!line.endKnown || !Number.isFinite(line.endMs) || line.endMs <= line.startMs) {
      line.endMs = !next
        ? estimateTailEnd(line.startMs, line.words.length, lengthMs)
        : line.wordTiming === 'exact' ? next.startMs : estimateLineEnd(line, next.startMs);
      line.endKnown = line.endKnown && Number.isFinite(line.endMs);
    }
    if (line.endMs <= line.startMs) line.endMs = line.startMs + 1;
    if (line.wordTiming === 'exact') {
      const ws = line.words;
      for (let j = 0; j < ws.length; j++) {
        const w = ws[j];
        if (!Number.isFinite(w.startMs)) w.startMs = j > 0 ? ws[j - 1].endMs : line.startMs;
        const nextStart = j + 1 < ws.length ? ws[j + 1].startMs : line.endMs;
        if (!Number.isFinite(w.endMs) || w.endMs <= w.startMs) w.endMs = nextStart;
        if (j > 0 && w.startMs < ws[j - 1].startMs) w.startMs = ws[j - 1].startMs;
        if (w.endMs <= w.startMs) w.endMs = w.startMs + 1;
      }
    } else {
      for (const w of line.words) {
        w.startMs = line.startMs;
        w.endMs = line.endMs;
      }
    }
  }
  return sorted;
}

function nextMainLine(lines: LyricLine[], i: number): LyricLine | undefined {
  for (let k = i + 1; k < lines.length; k++) {
    if (lines[k].startMs > lines[i].startMs) return lines[k];
  }
  return undefined;
}

export function docTimingOf(lines: LyricLine[]): DocTiming {
  if (lines.length === 0) return 'none';
  return lines.some((l) => l.wordTiming === 'exact') ? 'word' : 'line';
}
