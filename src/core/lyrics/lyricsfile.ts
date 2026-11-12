import { parseDocument } from 'yaml';
import { docTimingOf, finalizeLines, untimedWords, type LyricDocument, type LyricLine, type LyricSource } from './model';

/** Lyricsfile 1.0 draft. Unsupported/malformed payloads fall back to LRC. */
export function parseLyricsfile(text: string, source: Omit<LyricSource, 'format'>): LyricDocument | null {
  if (text.length > 2_000_000) return null;
  try {
    const parsed = parseDocument(text, { uniqueKeys: true, customTags: [] });
    if (parsed.errors.length || parsed.warnings.length) return null;
    const d = parsed.toJS({ maxAliasCount: 0 });
    if (!d || d.version !== '1.0' || !d.metadata || !Array.isArray(d.lines) || d.lines.length > 10000) return null;
    const validTime = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 86_400_000;
    const lines: LyricLine[] = [];
    for (const l of d.lines) {
      if (!l || typeof l.text !== 'string' || !validTime(l.start_ms)) continue;
      const hasEnd = validTime(l.end_ms) && l.end_ms >= l.start_ms;
      const end = hasEnd ? l.end_ms : NaN;
      const ws = Array.isArray(l.words) && l.words.length <= 2000 ? l.words : [];
      const exact = ws.length > 0 && ws.every((w: any, i: number) => w && typeof w.text === 'string' && validTime(w.start_ms) &&
        w.start_ms >= l.start_ms && (!i || w.start_ms >= ws[i - 1].start_ms) &&
        (w.end_ms === undefined || (validTime(w.end_ms) && w.end_ms >= w.start_ms))) &&
        ws.map((w: any) => w.text).join('') === l.text;
      lines.push({ index: 0, text: l.text, startMs: l.start_ms, endMs: end, endKnown: hasEnd,
        wordTiming: exact ? 'exact' : 'none',
        words: exact ? ws.map((w: any) => ({ text: w.text.trimEnd(), startMs: w.start_ms,
          endMs: w.end_ms ?? NaN, space: /\s$/.test(w.text) })) : untimedWords(l.text, l.start_ms, end) });
    }
    const final = finalizeLines(lines, d.metadata.duration_ms);
    if (!final.length) return null;
    return { timing: docTimingOf(final), lines: final,
      meta: { title: d.metadata.title, artist: d.metadata.artist, album: d.metadata.album,
        lengthMs: validTime(d.metadata.duration_ms) ? d.metadata.duration_ms : undefined },
      source: { ...source, format: 'lyricsfile' } };
  } catch { return null; }
}
