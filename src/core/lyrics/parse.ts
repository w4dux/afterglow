import { parseLyricsfile } from './lyricsfile';
import { type LyricDocument, type LyricSource } from './model';
import { looksLikeLrc, parseLrc } from './lrc';
import { looksLikeTtml, parseTtml } from './ttml';

/** Parse any supported lyric text, choosing the format by content (then by extension). */
export function parseLyrics(text: string, source: Omit<LyricSource, 'format'>, fileName = ''): LyricDocument {
  if (/^version:\s*['"]?1\.0/m.test(text)) {
    const doc = parseLyricsfile(text, source);
    if (doc) return doc;
  }
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'ttml' || ext === 'xml' || looksLikeTtml(text)) {
    const doc = parseTtml(text, source);
    if (doc.lines.length > 0) return doc;
  }
  if (looksLikeLrc(text)) {
    const doc = parseLrc(text, source);
    if (doc.lines.length > 0) return doc;
    // LRC with only metadata / markers: fall through to plain to keep any text.
    if (doc.meta.instrumental) return doc;
  }
  return parsePlain(text, source);
}

/** Unsynced lyrics: kept as text. No timing is invented. */
export function parsePlain(text: string, source: Omit<LyricSource, 'format'>): LyricDocument {
  const clean = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    // strip stray LRC metadata tags if any
    .replace(/^\s*\[[a-zA-Z#]+:[^\]]*\]\s*$/gm, '')
    .trim();
  return {
    timing: 'none',
    lines: [],
    meta: {},
    source: { ...source, format: clean ? 'plain' : 'none' },
    plainText: clean || undefined,
  };
}
