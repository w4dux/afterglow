import {
  type LyricDocument,
  type LyricLine,
  type LyricMeta,
  type LyricSource,
  type LyricWord,
  docTimingOf,
  finalizeLines,
  untimedWords,
} from './model';

/**
 * LRC / enhanced LRC parser.
 *
 * Supported:
 *  - [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx], [mm:ss:xx] line tags, minutes may exceed 59
 *  - several line tags on one line ("[00:10.00][01:20.00]Hook")
 *  - enhanced/A2 word tags: [00:12.00]<00:12.00>I <00:12.40>came <00:13.10>through<00:13.60>
 *    (a trailing empty tag gives the last word's end; syllables without whitespace
 *     between them are kept as separate timed units of the same word)
 *  - blank timed lines and "♪" lines as end/instrumental markers
 *  - metadata: ti ar al by length offset, plus Afterglow extension tags
 *    [genre:...] [bpm:...] [beat:mm:ss.xx | ms] [meter:3]
 *
 * Per the LRC convention a positive [offset:] makes lyrics appear EARLIER, i.e.
 * lyric time = tag time - offset.
 */

const LINE_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/y;
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const META_TAG = /^\[([a-zA-Z#]+)\s*:(.*)\]\s*$/;
const INSTRUMENTAL_ONLY = /^[\s♪♫♬♩·•…\-–—]*$/u;

export function parseTimeParts(min: string, sec: string, frac?: string): number {
  let ms = parseInt(min, 10) * 60000 + parseInt(sec, 10) * 1000;
  if (frac !== undefined && frac.length > 0) {
    if (frac.length === 1) ms += parseInt(frac, 10) * 100;
    else if (frac.length === 2) ms += parseInt(frac, 10) * 10;
    else ms += parseInt(frac.slice(0, 3), 10);
  }
  return ms;
}

/** Parse "mm:ss.xx", "h:mm:ss.xxx", "12.5s", "1250ms" or a bare millisecond number. */
export function parseLooseTime(value: string): number | undefined {
  const v = value.trim();
  if (!v) return undefined;
  let m = /^(-?\d+(?:\.\d+)?)ms$/i.exec(v);
  if (m) return parseFloat(m[1]);
  m = /^(-?\d+(?:\.\d+)?)s$/i.exec(v);
  if (m) return parseFloat(m[1]) * 1000;
  m = /^(?:(\d+):)?(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/.exec(v);
  if (m) {
    const h = m[1] ? parseInt(m[1], 10) : 0;
    return h * 3600000 + parseInt(m[2], 10) * 60000 + parseFloat(m[3]) * 1000;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return parseFloat(v);
  return undefined;
}

interface RawEntry {
  timeMs: number;
  text: string;
  words?: LyricWord[];
  wordsEndMs?: number;
  order: number;
}

export function looksLikeLrc(text: string): boolean {
  return /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(text);
}

export function parseLrc(input: string, source: Omit<LyricSource, 'format'>): LyricDocument {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const meta: LyricMeta = {};
  const entries: RawEntry[] = [];
  let hasWordTags = false;
  let order = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // Collect leading line time tags.
    const times: number[] = [];
    LINE_TAG.lastIndex = 0;
    let pos = 0;
    for (;;) {
      LINE_TAG.lastIndex = pos;
      const m = LINE_TAG.exec(line);
      if (!m) break;
      times.push(parseTimeParts(m[1], m[2], m[3]));
      pos = LINE_TAG.lastIndex;
    }

    if (times.length === 0) {
      const mm = META_TAG.exec(line);
      if (mm) applyMeta(meta, mm[1].toLowerCase(), mm[2].trim());
      continue;
    }

    const content = line.slice(pos);
    WORD_TAG.lastIndex = 0;
    const hasTags = WORD_TAG.test(content);
    WORD_TAG.lastIndex = 0;

    if (hasTags) {
      hasWordTags = true;
      const parsed = parseWordTags(content, times[0]);
      for (const t of times) {
        const shift = t - times[0];
        entries.push({
          timeMs: t,
          text: parsed.text,
          words: parsed.words.map((w) => ({ ...w, startMs: w.startMs + shift, endMs: w.endMs + shift })),
          wordsEndMs: parsed.endMs !== undefined ? parsed.endMs + shift : undefined,
          order: order++,
        });
      }
    } else {
      const clean = content.trim();
      for (const t of times) entries.push({ timeMs: t, text: clean, order: order++ });
    }
  }

  const offset = meta.fileOffsetMs ?? 0;
  if (offset !== 0) {
    for (const e of entries) {
      e.timeMs -= offset;
      if (e.wordsEndMs !== undefined) e.wordsEndMs -= offset;
      e.words?.forEach((w) => {
        w.startMs -= offset;
        w.endMs -= offset;
      });
    }
    if (meta.beatOffsetMs !== undefined) meta.beatOffsetMs -= offset;
  }

  entries.sort((a, b) => a.timeMs - b.timeMs || a.order - b.order);

  const lines: LyricLine[] = [];
  for (const e of entries) {
    const isMarker = e.text.length === 0 || INSTRUMENTAL_ONLY.test(e.text);
    if (isMarker) {
      const prev = lines[lines.length - 1];
      if (prev && (!prev.endKnown || prev.endMs > e.timeMs) && e.timeMs > prev.startMs) {
        prev.endMs = e.timeMs;
        prev.endKnown = true;
      }
      continue;
    }
    if (e.words && e.words.length > 0) {
      lines.push({
        index: 0,
        startMs: Math.min(e.timeMs, e.words[0].startMs),
        endMs: e.wordsEndMs ?? NaN,
        endKnown: e.wordsEndMs !== undefined,
        text: e.text,
        words: e.words,
        wordTiming: 'exact',
      });
    } else {
      lines.push({
        index: 0,
        startMs: e.timeMs,
        endMs: NaN,
        endKnown: false,
        text: e.text,
        words: untimedWords(e.text, e.timeMs, e.timeMs),
        wordTiming: 'none',
      });
    }
  }

  const finalized = finalizeLines(lines, meta.lengthMs);
  return {
    timing: docTimingOf(finalized),
    lines: finalized,
    meta,
    source: { ...source, format: hasWordTags ? 'elrc' : 'lrc' },
  };
}

function parseWordTags(content: string, lineStart: number): { text: string; words: LyricWord[]; endMs?: number } {
  // Split into segments: each segment is the text following a word tag, carrying that tag's time.
  const segments: { time: number; text: string }[] = [];
  const re = new RegExp(WORD_TAG.source, 'g');
  let cursor = 0;
  let curTime = lineStart;
  let first = true;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const before = content.slice(cursor, m.index);
    if (!first || before.trim()) segments.push({ time: curTime, text: before });
    first = false;
    curTime = parseTimeParts(m[1], m[2], m[3]);
    cursor = re.lastIndex;
  }
  segments.push({ time: curTime, text: content.slice(cursor) });

  const words: LyricWord[] = [];
  let endMs: number | undefined;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const raw = seg.text;
    const trimmed = raw.trim();
    const prev = words[words.length - 1];
    if (!trimmed) {
      // Empty / whitespace-only segment: the tag marks the end of the previous unit.
      if (prev) {
        prev.endMs = seg.time;
        if (/\s/.test(raw)) prev.space = true;
      }
      if (i === segments.length - 1) endMs = seg.time;
      continue;
    }
    if (prev && /^\s/.test(raw)) prev.space = true;
    const nextTime = i + 1 < segments.length ? segments[i + 1].time : NaN;
    words.push({ text: trimmed, startMs: seg.time, endMs: nextTime, space: /\s$/.test(raw) });
  }
  if (words.length > 0) words[words.length - 1].space = false;
  const text = words.map((w) => w.text + (w.space ? ' ' : '')).join('');
  return { text, words, endMs };
}

function applyMeta(meta: LyricMeta, key: string, value: string): void {
  switch (key) {
    case 'ti':
      meta.title = value;
      break;
    case 'ar':
      meta.artist = value;
      break;
    case 'al':
      meta.album = value;
      break;
    case 'length': {
      const t = parseLooseTime(value);
      if (t !== undefined && t > 0) meta.lengthMs = t;
      break;
    }
    case 'offset': {
      const n = parseInt(value.replace(/^\+/, ''), 10);
      if (Number.isFinite(n)) meta.fileOffsetMs = n;
      break;
    }
    case 'genre':
      if (value) meta.genre = value;
      break;
    case 'bpm':
    case 'tempo': {
      const n = parseFloat(value);
      if (Number.isFinite(n) && n >= 30 && n <= 300) meta.bpm = n;
      break;
    }
    case 'beat': {
      const t = parseLooseTime(value);
      if (t !== undefined) meta.beatOffsetMs = t;
      break;
    }
    case 'meter': {
      const n = parseInt(value, 10);
      if (n >= 2 && n <= 12) meta.beatsPerBar = n;
      break;
    }
    case 'instrumental':
      meta.instrumental = /^(1|true|yes)$/i.test(value);
      break;
    default:
      break;
  }
}

/** Serialize a document back to (enhanced) LRC. Used for "save corrected lyrics". */
export function toLrc(doc: LyricDocument, extraOffsetMs = 0): string {
  const out: string[] = [];
  const m = doc.meta;
  if (m.title) out.push(`[ti:${m.title}]`);
  if (m.artist) out.push(`[ar:${m.artist}]`);
  if (m.album) out.push(`[al:${m.album}]`);
  if (m.genre) out.push(`[genre:${m.genre}]`);
  if (m.bpm) out.push(`[bpm:${m.bpm}]`);
  if (m.beatOffsetMs !== undefined) out.push(`[beat:${fmt(m.beatOffsetMs + extraOffsetMs)}]`);
  for (const l of doc.lines) {
    let body = l.text;
    if (l.wordTiming === 'exact') {
      body = l.words.map((w) => `<${fmt(w.startMs + extraOffsetMs)}>${w.text}${w.space ? ' ' : ''}`).join('');
      body += `<${fmt(l.words[l.words.length - 1].endMs + extraOffsetMs)}>`;
    }
    out.push(`[${fmt(l.startMs + extraOffsetMs)}]${body}`);
    if (l.endKnown) out.push(`[${fmt(l.endMs + extraOffsetMs)}]`);
  }
  return out.join('\n') + '\n';
}

function fmt(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const min = Math.floor(t / 60000);
  const sec = Math.floor((t % 60000) / 1000);
  const cs = Math.floor((t % 1000) / 10);
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
