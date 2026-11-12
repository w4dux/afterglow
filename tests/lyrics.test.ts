import { describe, expect, it } from 'vitest';
import { parseLrc, toLrc } from '../src/core/lyrics/lrc';
import { parseLyrics } from '../src/core/lyrics/parse';
import { parseTtml } from '../src/core/lyrics/ttml';
import { CueIndex, wordAt } from '../src/core/lyrics/cues';
import { analyzeLyrics } from '../src/core/lyrics/analysis';

const SRC = { kind: 'local-file' as const, label: 'test.lrc' };

describe('LRC parser', () => {
  it('parses line timestamps of all common precisions and derives ends from the next line', () => {
    const doc = parseLrc('[ti:Song]\n[ar:Artist]\n[00:01]one\n[00:02.5]two\n[00:03.25]three\n[00:04.125]four\n', SRC);
    expect(doc.meta.title).toBe('Song');
    expect(doc.meta.artist).toBe('Artist');
    expect(doc.timing).toBe('line');
    expect(doc.source.format).toBe('lrc');
    expect(doc.lines.map((l) => l.startMs)).toEqual([1000, 2500, 3250, 4125]);
    expect(doc.lines[0].endMs).toBe(2500);
    expect(doc.lines[0].endKnown).toBe(false);
    // untimed line: words carry the line interval and are flagged as not word-timed
    expect(doc.lines[1].wordTiming).toBe('none');
    expect(doc.lines[1].words[0]).toMatchObject({ startMs: 2500, endMs: 3250 });
  });

  it('expands multiple timestamps on one line and sorts by time', () => {
    const doc = parseLrc('[00:30.00][00:10.00]hook line\n[00:20.00]verse\n', SRC);
    expect(doc.lines.map((l) => [l.startMs, l.text])).toEqual([
      [10000, 'hook line'],
      [20000, 'verse'],
      [30000, 'hook line'],
    ]);
  });

  it('applies [offset:] with the LRC sign convention (positive = earlier)', () => {
    const doc = parseLrc('[offset:+500]\n[00:10.00]a\n[00:12.00]b\n', SRC);
    expect(doc.lines[0].startMs).toBe(9500);
    expect(doc.meta.fileOffsetMs).toBe(500);
    const neg = parseLrc('[offset:-250]\n[00:10.00]a\n', SRC);
    expect(neg.lines[0].startMs).toBe(10250);
  });

  it('uses blank timestamped lines and ♪ lines as end markers', () => {
    const doc = parseLrc('[00:01.00]first\n[00:03.00]\n[00:10.00]second\n[00:12.00]♪\n[00:20.00]third', SRC);
    expect(doc.lines).toHaveLength(3);
    expect(doc.lines[0]).toMatchObject({ startMs: 1000, endMs: 3000, endKnown: true });
    expect(doc.lines[1]).toMatchObject({ startMs: 10000, endMs: 12000, endKnown: true });
  });

  it('parses enhanced LRC word timing including the trailing end tag', () => {
    const doc = parseLrc('[00:12.00]<00:12.00>I <00:12.40>came <00:12.90>through<00:13.60>\n[00:15.00]<00:15.00>next', SRC);
    expect(doc.timing).toBe('word');
    expect(doc.source.format).toBe('elrc');
    const l = doc.lines[0];
    expect(l.wordTiming).toBe('exact');
    expect(l.text).toBe('I came through');
    expect(l.words.map((w) => [w.text, w.startMs, w.endMs, w.space])).toEqual([
      ['I', 12000, 12400, true],
      ['came', 12400, 12900, true],
      ['through', 12900, 13600, false],
    ]);
    expect(l.endMs).toBe(13600);
    expect(l.endKnown).toBe(true);
    // last word without end tag ends at the line end (next line start)
    expect(doc.lines[1].words[0].endMs).toBe(doc.lines[1].endMs);
  });

  it('keeps syllables of one word as separate timed units without spaces', () => {
    const doc = parseLrc('[00:01.00]<00:01.00>beau<00:01.30>ti<00:01.50>ful <00:02.00>day<00:02.40>', SRC);
    const ws = doc.lines[0].words;
    expect(ws.map((w) => w.text)).toEqual(['beau', 'ti', 'ful', 'day']);
    expect(ws.map((w) => w.space)).toEqual([false, false, true, false]);
    expect(doc.lines[0].text).toBe('beautiful day');
  });

  it('treats a whitespace-only segment as an end marker (gap inside a line)', () => {
    const doc = parseLrc('[00:01.00]<00:01.00>word<00:01.50> <00:02.00>next<00:02.30>', SRC);
    const ws = doc.lines[0].words;
    expect(ws[0]).toMatchObject({ text: 'word', startMs: 1000, endMs: 1500, space: true });
    expect(ws[1]).toMatchObject({ text: 'next', startMs: 2000, endMs: 2300 });
  });

  it('reads Afterglow extension tags but never invents tempo', () => {
    const doc = parseLrc('[genre:Hip-Hop]\n[bpm:92]\n[beat:00:00.65]\n[00:01.00]x', SRC);
    expect(doc.meta).toMatchObject({ genre: 'Hip-Hop', bpm: 92, beatOffsetMs: 650 });
    const none = parseLrc('[00:01.00]x', SRC);
    expect(none.meta.bpm).toBeUndefined();
    expect(none.meta.genre).toBeUndefined();
  });

  it('round-trips through toLrc', () => {
    const src = '[00:12.00]<00:12.00>I <00:12.40>came<00:13.00>\n[00:14.00]plain line\n';
    const doc = parseLrc(src, SRC);
    const again = parseLrc(toLrc(doc), SRC);
    expect(again.lines.map((l) => [l.startMs, l.text, l.wordTiming])).toEqual(doc.lines.map((l) => [l.startMs, l.text, l.wordTiming]));
    const shifted = parseLrc(toLrc(doc, 1000), SRC);
    expect(shifted.lines[0].words[1].startMs).toBe(13400);
  });
});

describe('format detection & plain text', () => {
  it('keeps unsynced text without inventing timing', () => {
    const doc = parseLyrics('First line\nSecond line\n\nVerse two', SRC);
    expect(doc.timing).toBe('none');
    expect(doc.lines).toHaveLength(0);
    expect(doc.plainText).toContain('Verse two');
  });
  it('detects LRC by content', () => {
    expect(parseLyrics('﻿[00:01.00]hello\r\n[00:02.00]world', SRC).timing).toBe('line');
  });
  it('returns an empty document for empty input', () => {
    const doc = parseLyrics('   ', SRC);
    expect(doc.timing).toBe('none');
    expect(doc.plainText).toBeUndefined();
    expect(doc.source.format).toBe('none');
  });
});

describe('TTML parser', () => {
  const ttml = `<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
 <head><metadata><ttm:title>Night</ttm:title></metadata></head>
 <body><div>
  <p begin="00:00:01.000" end="00:00:02.500"><span begin="00:00:01.000" end="00:00:01.400">Hold</span> <span begin="1.4s" end="1.9s">on</span><span begin="00:01.900" end="00:02.500">,</span></p>
  <p begin="3.0s" end="4.0s">Line &amp; timed only</p>
  <p begin="5.0s" end="6.5s"><span begin="5.0s" end="5.5s">main</span> <span ttm:role="x-bg"><span begin="5.6s" end="6.0s">(echo)</span></span></p>
 </div></body></tt>`;
  it('parses word spans, line-only paragraphs, entities and background vocals', () => {
    const doc = parseTtml(ttml, SRC);
    expect(doc.lines).toHaveLength(3);
    expect(doc.lines[0].words.map((w) => [w.text, w.startMs, w.endMs])).toEqual([
      ['Hold', 1000, 1400],
      ['on', 1400, 1900],
      [',', 1900, 2500],
    ]);
    expect(doc.lines[0].endMs).toBe(2500);
    expect(doc.lines[1]).toMatchObject({ text: 'Line & timed only', wordTiming: 'none', startMs: 3000, endMs: 4000 });
    expect(doc.lines[2].words[1]).toMatchObject({ text: '(echo)', bg: true });
    expect(doc.timing).toBe('word');
    expect(parseLyrics(ttml, SRC, 'x.ttml').source.format).toBe('ttml');
  });
});

describe('cue index', () => {
  const doc = parseLrc(
    [
      '[00:02.00]<00:02.00>one <00:02.50>two <00:03.00>three<00:03.50>',
      '[00:04.00]<00:04.00>four <00:04.20>five<00:05.00>',
      '[00:12.00]after the break',
      '[00:14.00]last line',
    ].join('\n'),
    SRC,
  );

  it('uses [start, end) word boundaries exactly', () => {
    const l = doc.lines[0];
    expect(wordAt(l, 1999).active).toBe(-1);
    expect(wordAt(l, 2000).active).toBe(0);
    expect(wordAt(l, 2499).active).toBe(0);
    expect(wordAt(l, 2500).active).toBe(1);
    expect(wordAt(l, 3499).active).toBe(2);
    expect(wordAt(l, 3500).active).toBe(-1); // after the last word's end
    expect(wordAt(l, 3500).arrived).toBe(3);
  });

  it('reports intro, sustained lines, instrumental gaps and outro', () => {
    const idx = new CueIndex(doc, 4500);
    expect(idx.cue(1000)).toMatchObject({ lineIndex: -1, gap: { kind: 'intro' } });
    expect(idx.cue(3700)).toMatchObject({ lineIndex: 0, inLine: false, gap: null }); // short gap: sustain
    const c = idx.cue(8500);
    expect(c.lineIndex).toBe(1);
    expect(c.gap?.kind).toBe('instrumental');
    expect(c.gap?.progress).toBeCloseTo((8500 - 5000) / 7000, 5);
    expect(idx.cue(12000).lineIndex).toBe(2);
    expect(idx.cue(99999).gap?.kind).toBe('outro');
  });

  it('sequential lookups agree with fresh binary search for random seeks', () => {
    const idx = new CueIndex(doc);
    const brute = (t: number) => {
      let r = -1;
      doc.lines.forEach((l, i) => {
        if (l.startMs <= t) r = i;
      });
      return r;
    };
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 20000;
    for (let i = 0; i < 2000; i++) {
      const t = i % 3 === 0 ? rnd() : i * 10;
      expect(idx.lineAt(t)).toBe(brute(t));
    }
  });
});

describe('lyric analysis', () => {
  it('finds repeated hook lines and measures pace from timed lyrics only', () => {
    const doc = parseLrc('[00:01.00]we keep it moving\n[00:02.00]verse words here now\n[00:03.00]We keep it moving!\n[00:04.00]end', SRC);
    const a = analyzeLyrics(doc);
    expect([...a.hookLines]).toEqual([0, 2]);
    expect(a.medianWps).toBeGreaterThan(2);
    const plain = analyzeLyrics(parseLyrics('just text', SRC));
    expect(plain.medianWps).toBeUndefined();
  });
});

describe('TTML from AMLL TTML DB (CC0 fixture)', () => {
  it('keeps translations out of the sung words and reads duration and metadata', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('./fixtures/amll-sample.ttml', import.meta.url), 'utf8');
    const doc = parseTtml(text, SRC);
    expect(doc.timing).toBe('word');
    expect(doc.lines[0].text).toBe('Lock me up and throw away the key');
    expect(doc.lines[0].words.map((w) => w.text).join(' ')).toBe('Lock me up and throw away the key');
    expect(doc.lines.every((l) => !/[一-鿿]/.test(l.text))).toBe(true);
    expect(doc.meta.lengthMs).toBe(217850);
    expect(doc.meta.title).toBe('One Of The Girls');
    expect(doc.meta.artist).toBe('The Weeknd, JENNIE, Lily-Rose Depp');
  });
});
