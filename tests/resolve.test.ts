import { describe, expect, it } from 'vitest';
import { LatestRequest } from '../src/core/latest';
import { pickLrclib } from '../src/core/lyrics/lrclibMatch';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings/schema';
import { type LyricsDeps, resolveLyrics } from '../src/lyrics/LyricsResolver';
import type { TrackInfo } from '../src/playback/adapters';
import type { LrclibRecord } from '../src/shared/api';
import { balancedRows, fitFlow, fitStack } from '../src/stage/layout';
import { beatAt, resolveMotion, spring } from '../src/stage/motion';

const track = (p: Partial<TrackInfo> = {}): TrackInfo => ({
  key: 'trk:artist|song',
  title: 'Song',
  artist: 'Artist',
  durationMs: 200_000,
  source: 'local',
  sourceLabel: 'Local file',
  genres: [],
  ...p,
});
const settings = (p: Partial<Settings['sources']> = {}, links: Record<string, string> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  sources: { ...DEFAULT_SETTINGS.sources, ...p },
  lyricLinks: links,
});
const deps = (p: Partial<LyricsDeps> = {}): LyricsDeps => ({
  readLyricFile: async () => null,
  findLyricsInFolder: async () => null,
  lrclib: async () => ({ ok: true, candidates: [] }),
  fetchText: async () => '',
  ...p,
});
const rec = (p: Partial<LrclibRecord>): LrclibRecord => ({ id: 1, trackName: 'Song', artistName: 'Artist', duration: 200, instrumental: false, ...p });

describe('lyrics resolution', () => {
  it('reports not-found with every source tried when nothing exists (online off)', async () => {
    const r = await resolveLyrics(track({ local: { path: 'x', url: 'u', fileName: 'x.mp3', genres: [], embedded: {} } }), settings(), deps());
    expect(r.status).toBe('not-found');
    expect(r.doc).toBeNull();
    expect(r.tried.map((x) => x.source)).toEqual(['Sidecar .lrc', 'Embedded tags', 'Online sources']);
    expect(r.tried[2].outcome).toMatch(/off/);
  });

  it('prefers a file the user attached to the track over everything else', async () => {
    const r = await resolveLyrics(
      track({ local: { path: 'x', url: 'u', fileName: 'x.mp3', genres: [], embedded: { syncedLrc: '[00:01.00]embedded' } } }),
      settings({}, { 'trk:artist|song': '/l/song.lrc' }),
      deps({ readLyricFile: async (p) => ({ path: p, name: 'song.lrc', text: '[00:02.00]attached' }) }),
    );
    expect(r.doc?.lines[0].text).toBe('attached');
    expect(r.doc?.source.match).toBe('manual');
  });

  it('keeps looking for synced lyrics after finding unsynced ones, then falls back', async () => {
    const t = track({ local: { path: 'x', url: 'u', fileName: 'x.mp3', genres: [], embedded: { unsynced: 'plain words' } } });
    const online = await resolveLyrics(t, settings({ onlineLyrics: true }), deps({ lrclib: async () => ({ ok: true, exact: rec({ syncedLyrics: '[00:05.00]from lrclib' }), candidates: [] }) }));
    expect(online.status).toBe('synced');
    expect(online.doc?.source.kind).toBe('lrclib');
    expect(online.doc?.source.attribution).toMatch(/LRCLIB/);
    const offline = await resolveLyrics(t, settings({ onlineLyrics: true }), deps({ lrclib: async () => ({ ok: false, error: 'LRCLIB is unreachable', offline: true }) }));
    expect(offline.status).toBe('unsynced');
    expect(offline.doc?.plainText).toBe('plain words');
    expect(offline.tried.at(-1)).toEqual({ source: 'LRCLIB', outcome: 'LRCLIB is unreachable' });
  });

  it('reports instrumental tracks from the provider', async () => {
    const r = await resolveLyrics(track(), settings({ onlineLyrics: true }), deps({ lrclib: async () => ({ ok: true, exact: rec({ instrumental: true }), candidates: [] }) }));
    expect(r.status).toBe('instrumental');
  });

  it('uses the lyrics folder before going online', async () => {
    let online = 0;
    const r = await resolveLyrics(
      track(),
      settings({ lyricsFolder: '/lyrics', onlineLyrics: true }),
      deps({
        findLyricsInFolder: async () => ({ path: '/lyrics/Artist - Song.lrc', name: 'Artist - Song.lrc', text: '[00:01.00]folder' }),
        lrclib: async () => {
          online++;
          return { ok: true, candidates: [] };
        },
      }),
    );
    expect(r.doc?.lines[0].text).toBe('folder');
    expect(online).toBe(0);
  });

  it('stops early when cancelled', async () => {
    const token = { cancelled: true };
    const r = await resolveLyrics(track(), settings({ onlineLyrics: true }), deps(), token);
    expect(r.status).toBe('idle');
  });
});

describe('stale lyric responses', () => {
  it('only the newest request for the current track may apply', async () => {
    const latest = new LatestRequest<string>();
    const applied: string[] = [];
    const slow = (key: string, ms: number) =>
      new Promise<void>((done) => {
        const req = latest.begin(key);
        setTimeout(() => {
          if (latest.isCurrent(req)) applied.push(key);
          done();
        }, ms);
      });
    // track A's lookup is slow; the user skips to B, whose lookup is fast
    const a = slow('A', 30);
    const b = slow('B', 5);
    await Promise.all([a, b]);
    expect(applied).toEqual(['B']);
    // a manual import invalidates an in-flight lookup for the same track
    const req = latest.begin('B');
    latest.invalidate();
    expect(latest.isCurrent(req)).toBe(false);
  });
});

describe('LRCLIB matching', () => {
  const q = { artist: 'Artist', title: 'Song', durationSec: 200 };
  it('requires matching title, primary artist and duration within 3 s', () => {
    expect(pickLrclib([rec({ trackName: 'Other' })], q).match).toBe('none');
    expect(pickLrclib([rec({ duration: 260, syncedLyrics: '[00:01.00]x' })], q).match).toBe('none');
    const r = pickLrclib([rec({ trackName: 'Song (feat. Guest)', artistName: 'Artist feat. Guest', duration: 201, syncedLyrics: '[00:01.00]x' })], q);
    expect(r.match).toBe('probable');
  });
  it('prefers synced lyrics and flags genuinely different synced versions as ambiguous', () => {
    const r = pickLrclib(
      [rec({ id: 1, plainLyrics: 'p' }), rec({ id: 2, duration: 199, syncedLyrics: '[00:01.00]one' }), rec({ id: 3, duration: 202, syncedLyrics: '[00:01.00]something else' })],
      q,
    );
    expect(r.best?.id).toBe(2);
    expect(r.match).toBe('ambiguous');
    expect(r.alternatives.map((x) => x.id)).toContain(3);
  });
});

describe('motion & layout invariants', () => {
  it('never invents a beat without stated tempo and downbeat', () => {
    expect(beatAt(1000, undefined, 0)).toBeNull();
    expect(beatAt(1000, 120, undefined)).toBeNull();
    const b = beatAt(1250, 120, 0)!;
    expect(b.index).toBe(2);
    expect(b.phase).toBeCloseTo(0.5, 6);
  });
  it('reduced motion disables transforms, jiggle and pulse regardless of treatment', () => {
    const m = resolveMotion('jiggle', 1.5, 'system', true, true);
    expect(m).toMatchObject({ transforms: false, jiggle: 0, pulse: false, wordMotion: false, reduced: true });
    expect(resolveMotion('jiggle', 1, 'off', true, true).jiggle).toBe(1);
    expect(resolveMotion('highlight', 1, 'off', false, true).wordMotion).toBe(false);
  });
  it('spring settles at 1 and is deterministic', () => {
    expect(spring(0)).toBe(0);
    expect(spring(2000)).toBeCloseTo(1, 3);
    expect(spring(123.4)).toBe(spring(123.4));
  });
  it('balanced rows minimise the widest row', () => {
    const rows = balancedRows([3, 1, 1, 1, 3], 0.25, 2);
    expect(rows).toEqual([
      [0, 2],
      [2, 5],
    ]);
  });
  it('flow fit respects the box and the row limit', () => {
    const widths = Array.from({ length: 12 }, () => 2.4);
    const f = fitFlow(widths, 0.25, { w: 1000, h: 300 }, { maxRows: 3, lineHeight: 1.1, maxSize: 200, minSize: 10 });
    expect(f.rows.length).toBeLessThanOrEqual(3);
    expect(f.rows.length * f.size * 1.1).toBeLessThanOrEqual(300.0001);
    expect(Math.max(...f.rowWidthsEm) * f.size).toBeLessThanOrEqual(1000.0001);
  });
  it('stack fit keeps every row inside the box and limits size contrast', () => {
    const s = fitStack([1.2, 4.0, 2.1, 0.8, 3.3], 0.25, { w: 900, h: 500 }, { maxRows: 4, lineHeight: 0.93, maxSize: 300, maxRatio: 2.3 });
    s.rows.forEach((_, i) => expect(s.rowWidthsEm[i] * s.sizes[i]).toBeLessThanOrEqual(900.0001));
    expect(s.totalHeight).toBeLessThanOrEqual(500.0001);
    expect(Math.max(...s.sizes) / Math.min(...s.sizes)).toBeLessThanOrEqual(2.3001);
  });
});

describe('LRCLIB search robustness', () => {
  it('cleans Spotify-style title decorations but keeps meaningful version words', async () => {
    const { cleanTitle, primaryArtistName, queryVariants } = await import('../src/core/lyrics/lrclibMatch');
    expect(cleanTitle("Ballin' (with Roddy Ricch)")).toBe("Ballin'");
    expect(cleanTitle('Song - Remastered 2011')).toBe('Song');
    expect(cleanTitle('Song - Radio Edit')).toBe('Song');
    expect(cleanTitle('Song (feat. Guest) [Explicit]')).toBe('Song');
    expect(cleanTitle('Song - From "Some Film"')).toBe('Song');
    expect(cleanTitle('Song (Live)')).toBe('Song (Live)');
    expect(cleanTitle('Song (Remix)')).toBe('Song (Remix)');
    expect(primaryArtistName('Mustard, Roddy Ricch')).toBe('Mustard');
    expect(queryVariants({ artist: 'Mustard, Roddy Ricch', title: "Ballin' (with Roddy Ricch)" })).toEqual([
      { artist: 'Mustard, Roddy Ricch', title: "Ballin' (with Roddy Ricch)" },
      { artist: 'Mustard', title: "Ballin'" },
    ]);
  });

  it('matches across artist formatting and decorated titles', () => {
    const r = pickLrclib(
      [rec({ id: 9, trackName: "Ballin'", artistName: 'Mustard & Roddy Ricch', duration: 181, syncedLyrics: '[00:01.00]x' })],
      { artist: 'Mustard, Roddy Ricch', title: "Ballin' (with Roddy Ricch)", durationSec: 180 },
    );
    expect(r.best?.id).toBe(9);
    expect(r.match).toBe('probable');
  });

  it('accepts a near-duration version as "loose" and reports the difference', () => {
    const r = pickLrclib([rec({ id: 4, duration: 208, syncedLyrics: '[00:01.00]x' })], { artist: 'Artist', title: 'Song', durationSec: 200 });
    expect(r.match).toBe('loose');
    expect(r.durationDeltaSec).toBe(8);
    expect(pickLrclib([rec({ duration: 230, syncedLyrics: 'x' })], { artist: 'Artist', title: 'Song', durationSec: 200 }).match).toBe('none');
  });

  it('accepts a strong match with a different duration and says so', async () => {
    const r = await resolveLyrics(track(), settings({ onlineLyrics: true }), deps({ lrclib: async () => ({ ok: true, candidates: [rec({ duration: 194, syncedLyrics: '[00:05.00]close enough' })] }) }));
    expect(r.status).toBe('synced');
    expect(r.doc?.source.match).toBe('probable');
    expect(r.doc?.source.note).toMatch(/6 s shorter; check the recording/);
  });

  it('uses the LRCLIB version the user picked for this track', async () => {
    let searched = 0;
    const r = await resolveLyrics(
      track(),
      { ...settings({ onlineLyrics: true }), lrclibChoices: { 'trk:artist|song': 77 } },
      deps({
        lrclibById: async (id) => ({ ok: true, exact: rec({ id, syncedLyrics: '[00:03.00]picked' }), candidates: [] }),
        lrclib: async () => {
          searched++;
          return { ok: true, candidates: [] };
        },
      }),
    );
    expect(r.doc?.lines[0].text).toBe('picked');
    expect(searched).toBe(0);
  });
});

describe('estimated word sweep (labelled heuristic)', () => {
  const mk = (text: string, start: number, end: number) => {
    const words = text.split(' ').map((w, i, a) => ({ text: w, startMs: start, endMs: end, space: i < a.length - 1 }));
    return { line: { index: 0, startMs: start, endMs: end, endKnown: false, text, words, wordTiming: 'none' }, data: {} } as any;
  };
  it('is -1 outside the line, moves forward only, and reaches the last word', async () => {
    const { estimatedUnit } = await import('../src/stage/scene');
    const v = mk('we keep it moving when the lights go low', 1000, 4000);
    expect(estimatedUnit(v, 999, 3.5)).toBe(-1);
    expect(estimatedUnit(v, 4000, 3.5)).toBe(-1);
    let prev = -1;
    const seen = new Set<number>();
    for (let t = 1000; t < 4000; t += 10) {
      const i = estimatedUnit(v, t, 3.5);
      if (i >= 0) {
        expect(i).toBeGreaterThanOrEqual(prev);
        prev = i;
        seen.add(i);
      }
    }
    expect(seen.has(8)).toBe(true);
    expect(seen.size).toBe(9);
  });
  it('weights by syllables, holds the final word, and sizes the sung part from the song pace', async () => {
    const { estimatedUnit } = await import('../src/stage/scene');
    const time = (v: any, idx: number, pace?: number) => {
      let n = 0;
      for (let t = v.line.startMs; t < v.line.endMs; t++) if (estimatedUnit(v, t, pace) === idx) n++;
      return n;
    };
    const v = mk('go through beautiful go', 0, 3000);
    expect(time(v, 2, 3)).toBeGreaterThan(time(v, 1, 3) * 1.5); // 3 syllables vs 1 ("through" is long but one syllable)
    const w = mk('go go go go', 0, 4000);
    expect(time(w, 3, 3)).toBeGreaterThan(time(w, 0, 3) * 1.4); // final word held
    // a fast song finishes the sweep well before the next line; a slow one uses more of it
    const fast = mk('one two three four', 0, 4000);
    const slow = mk('one two three four', 0, 4000);
    const lastIdxTime = (v: any, pace: number) => {
      for (let t = 3999; t >= 0; t--) if (estimatedUnit(v, t, pace) === 3) return t;
      return -1;
    };
    expect(lastIdxTime(fast, 6)).toBeLessThan(lastIdxTime(slow, 1.2));
  });
  it('does not stretch across an instrumental break', async () => {
    const { estimatedUnit } = await import('../src/stage/scene');
    const v = mk('one two three', 0, 20000);
    expect(estimatedUnit(v, 100, 4)).toBe(0);
    // 3 syllables at 4/s: about 0.9 s sung, at most 1.5x that; 2.1.0 swept for at least 8 s
    expect(estimatedUnit(v, 1400, 4)).toBe(-1);
  });
});

describe('estimated line ends (line-timed lyrics)', async () => {
  const { parseLrc } = await import('../src/core/lyrics/lrc');
  const { CueIndex } = await import('../src/core/lyrics/cues');
  it('ends a line before a long break so the break shows as instrumental', () => {
    const doc = parseLrc('[00:10.00]short line here\n[00:30.00]after the break\n[00:33.00]right after', { kind: 'lrclib', label: 'LRCLIB' });
    expect(doc.lines[0].endMs).toBe(14000);
    expect(doc.lines[0].endKnown).toBe(false);
    expect(doc.lines[1].endMs).toBe(33000); // normal spacing: unchanged
    const cues = new CueIndex(doc);
    expect(cues.cue(12000).inLine).toBe(true);
    expect(cues.cue(20000).gap?.kind).toBe('instrumental');
  });
  it('leaves long sung lines and stated ends alone', () => {
    const long = parseLrc('[00:10.00]' + Array.from({ length: 30 }, () => 'beautiful').join(' ') + '\n[00:40.00]next', { kind: 'lrclib', label: 'LRCLIB' });
    expect(long.lines[0].endMs).toBe(40000); // ~90 syllables: no clear break left
    const enhanced = parseLrc('[00:10.00]<00:10.00>word <00:10.50>timed\n[00:30.00]next', { kind: 'lrclib', label: 'LRCLIB' });
    expect(enhanced.lines[0].endMs).toBe(30000); // exact word timing: unchanged
  });
});

describe('multi-source selection', async () => {
  const { scoreCandidate, chooseHit, crossCheck, consensusIndex } = await import('../src/core/lyrics/match');
  const { parseLrc } = await import('../src/core/lyrics/lrc');
  const { parseTtml } = await import('../src/core/lyrics/ttml');
  const L = (lines: [number, string][]) => parseLrc(lines.map(([t, x]) => `[00:${(t / 1000).toFixed(2).padStart(5, '0')}]${x}`).join('\n'), { kind: 'lrclib', label: 'LRCLIB' });
  const W = (lines: [number, string][]) =>
    parseTtml(
      `<tt><body><div>${lines.map(([t, x]) => `<p begin="${t / 1000}s" end="${t / 1000 + 1.5}s">${x.split(' ').map((w, i) => `<span begin="${t / 1000 + i * 0.3}s" end="${t / 1000 + i * 0.3 + 0.3}s">${w}</span>`).join(' ')}</p>`).join('')}</div></body></tt>`,
      { kind: 'amll', label: 'AMLL TTML DB' },
    );
  const song: [number, string][] = [[10000, 'first line here'], [14000, 'second line now'], [18000, 'third line goes'], [22000, 'fourth line too'], [26000, 'fifth and last']];

  it('scores title, artist, duration and IDs', () => {
    const q = { title: 'Song (feat. X)', artist: 'Artist, X', durationSec: 200 };
    expect(scoreCandidate(q, { title: 'Song', artist: 'Artist', durationSec: 201 })).toBeGreaterThanOrEqual(95);
    expect(scoreCandidate(q, { title: 'Song', artist: 'Someone Else', durationSec: 201 })).toBeLessThan(70);
    expect(scoreCandidate(q, { title: 'Completely Different', artist: 'Artist', durationSec: 200 })).toBeLessThan(30);
    expect(scoreCandidate({ ...q, isrc: 'usabc1234567' }, { title: 'x', artist: 'y', isrc: 'USABC1234567' })).toBe(100);
  });

  it('prefers word timing when the match is nearly as strong, but not a weak one', () => {
    const line = { provider: 'lrclib', doc: L(song), score: 92 };
    const word = { provider: 'amll', doc: W(song), score: 86 };
    expect(chooseHit([line, word])?.hit.provider).toBe('amll');
    expect(chooseHit([line, { ...word, score: 72 }])?.hit.provider).toBe('lrclib');
    expect(chooseHit([{ ...line, score: 60 }])?.loose).toBe(true);
    expect(chooseHit([{ ...line, score: 40 }])).toBeNull();
  });

  it('cross-checks sources and avoids a different recording', () => {
    const shifted = W(song.map(([t, x]) => [t + 3000, x]));
    expect(crossCheck(shifted, L(song)).medianDeltaMs).toBe(3000);
    const pick = chooseHit([
      { provider: 'amll', doc: shifted, score: 90, durationDeltaSec: 9 },
      { provider: 'lrclib', doc: L(song), score: 88, durationDeltaSec: 0 },
    ]);
    expect(pick?.hit.provider).toBe('lrclib');
    expect(pick?.crossCheckMs).toBe(3000);
  });

  it('picks the LRCLIB version most others agree with', () => {
    const good = L(song);
    const bad = L(song.map(([t, x]) => [t + 900, x]));
    expect(consensusIndex([bad, good, L(song), L(song.map(([t, x]) => [t + 40, x]))])).toBe(1);
  });

  it('resolves through both providers in parallel and caches the result', async () => {
    const saved: any[] = [];
    const ttml = `<tt><body dur="200s"><div><p begin="10s" end="12s"><span begin="10s" end="10.5s">hello</span> <span begin="10.5s" end="11s">world</span></p></div></body></tt>`;
    const r = await resolveLyrics(
      track(),
      settings({ onlineLyrics: true }),
      deps({
        lrclib: async () => ({ ok: true, candidates: [rec({ syncedLyrics: '[00:10.00]hello world' })] }),
        amll: async () => ({ ok: true, indexSize: 3431, stale: false, hits: [{ file: 'x.ttml', title: 'Song', artist: 'Artist', score: 95, url: 'u', ttml }] }),
        cachePut: async (_k, e) => void saved.push(e),
      }),
    );
    expect(r.doc?.source.kind).toBe('amll');
    expect(r.doc?.timing).toBe('word');
    expect(r.tried.map((t) => t.source)).toEqual(expect.arrayContaining(['LRCLIB', 'AMLL TTML DB']));
    await new Promise((res) => setTimeout(res, 0));
    expect(saved[0]).toMatchObject({ provider: 'amll', format: 'ttml' });
  });

  it('uses the saved copy first, and when every provider fails', async () => {
    const cached = { savedAt: Date.now(), provider: 'lrclib', format: 'lrc' as const, text: '[00:01.00]from cache', label: 'LRCLIB' };
    let calls = 0;
    const r = await resolveLyrics(
      track(),
      settings({ onlineLyrics: true }),
      deps({
        cacheGet: async () => cached,
        lrclib: async () => {
          calls++;
          return { ok: false, error: 'offline' };
        },
      }),
    );
    expect(r.doc?.lines[0].text).toBe('from cache');
    expect(r.doc?.source.kind).toBe('cache');
    expect(calls).toBe(0);
    const again = await resolveLyrics(track(), settings({ onlineLyrics: true }), deps({ cacheGet: async () => cached }), undefined, { refresh: true });
    expect(again.doc?.source.kind).not.toBe('cache');
  });
});


describe('progressive lyric loading', () => {
  it('publishes line timing before a slow word provider finishes, then upgrades', async () => {
    let finish!: (v: any) => void; const slow = new Promise<any>(r => finish = r); const progress: any[] = [];
    const promise = resolveLyrics(track(), settings({ onlineLyrics: true }), deps({
      lrclib: async () => ({ ok: true, exact: rec({ syncedLyrics: '[00:10.00]hello world' }), candidates: [] }),
      amll: () => slow,
    }), undefined, { onProgress: r => progress.push(r) });
    await new Promise(r => setTimeout(r, 0)); expect(progress.at(-1)?.doc?.timing).toBe('line');
    finish({ ok: true, indexSize: 1, stale: false, hits: [{ file: 'x', title: 'Song', artist: 'Artist', score: 100, url: 'u',
      ttml: '<tt><body><div><p begin="10s" end="12s"><span begin="10s" end="11s">hello</span> <span begin="11s" end="12s">world</span></p></div></body></tt>' }] });
    expect((await promise).doc?.timing).toBe('word');
  });
  it('does not publish an upgrade after cancellation', async () => {
    let finish!: (v: any) => void; const signal = { cancelled: false }; const progress: any[] = [];
    const promise = resolveLyrics(track(), settings({ onlineLyrics: true }), deps({ lrclib: () => new Promise(r => finish = r) }), signal, { onProgress: r => progress.push(r) });
    await new Promise(r => setTimeout(r, 0)); signal.cancelled = true;
    finish({ ok: true, candidates: [rec({ syncedLyrics: '[00:01.00]test' })] });
    expect((await promise).status).toBe('idle'); expect(progress).toHaveLength(0);
  });
  it('retains cached lines if online providers fail during background refresh', async () => {
    const progress: any[] = [];
    const r = await resolveLyrics(track(), settings({ onlineLyrics: true }), deps({
      cacheGet: async () => ({ savedAt: Date.now() - 8 * 24 * 3600 * 1000, provider: 'lrclib', format: 'lrc', text: '[00:01.00]cached', label: 'LRCLIB' }),
      lrclib: async () => ({ ok: false, error: 'offline' }),
    }), undefined, { onProgress: r => progress.push(r) });
    expect(progress[0].doc.lines[0].text).toBe('cached'); expect(r.doc?.lines[0].text).toBe('cached');
  });
});
