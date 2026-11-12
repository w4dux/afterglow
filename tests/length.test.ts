import { describe, expect, it } from 'vitest';
import { addLengthSample, learnedOffsetSec, lengthCluster, lengthWindow } from '../src/core/lyrics/length';
import { lengthDeltaSec, scoreCandidate } from '../src/core/lyrics/match';
import { DEFAULT_SETTINGS, type Settings, sanitizeSettings } from '../src/core/settings/schema';
import { type LyricsDeps, lrclibProvider, resolveLyrics, trackQuery } from '../src/lyrics/LyricsResolver';
import type { TrackInfo } from '../src/playback/adapters';
import type { LrclibRecord, LyricsCacheEntry } from '../src/shared/api';

/**
 * Measured 2026-11-09 on the owner's PC: Spotify's Windows media session reported
 * every song exactly 5.0 s short (Mask Off 199.6 s vs 204.6 s; Coming Up Roses
 * 243.867 vs 248.9; Fade Into You 290.6 vs 295.6; Orbiter 281.967 vs 287.0).
 * LRCLIB upload lengths below are the real ones returned for those songs; lyric text
 * is placeholder.
 */
const MASK_OFF_UPLOADS = [205, 204.643265, 205, 205, 205, 205, 205, 205, 205, 201, 204, 204];
const ROSES_UPLOADS = [180, 249, 248, 250, 250, 244, 249, 249, 218, 249, 250, 250];
const APP = 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify';

const lrc = (shiftMs: number, n = 8) =>
  Array.from({ length: n }, (_, i) => {
    const t = 4000 + i * 4000 + shiftMs;
    return `[${String(Math.floor(t / 60000)).padStart(2, '0')}:${((t % 60000) / 1000).toFixed(2).padStart(5, '0')}]placeholder line number ${i + 1}`;
  }).join('\n');
const rec = (id: number, duration: number, p: Partial<LrclibRecord> = {}): LrclibRecord => ({
  id, trackName: 'Mask Off', artistName: 'Future', albumName: 'FUTURE', duration, instrumental: false, syncedLyrics: lrc(0), ...p,
});
const spotifyTrack = (p: Partial<TrackInfo> = {}): TrackInfo => ({
  key: 'rec:mask-off', title: 'Mask Off', artist: 'Future', album: 'FUTURE', durationMs: 199_600,
  source: 'system', sourceLabel: 'Spotify', app: APP, genres: [], ...p,
});
const settings = (learned: number[] = []): Settings => ({
  ...DEFAULT_SETTINGS,
  sources: { ...DEFAULT_SETTINGS.sources, onlineLyrics: true, providers: { lrclib: true, amll: false, catalog: false } },
  learned: { lengthOffsets: learned.length ? { [APP.toLowerCase()]: learned } : {} },
});
const deps = (p: Partial<LyricsDeps> = {}): LyricsDeps => ({
  readLyricFile: async () => null, findLyricsInFolder: async () => null, lrclib: async () => ({ ok: true, candidates: [] }), fetchText: async () => '', ...p,
});

describe('song length reported short by the player', () => {
  it('finds the real length from what most uploads agree on', () => {
    expect(lengthCluster(MASK_OFF_UPLOADS, 199.6)).toBeCloseTo(205, 0);
    const roses = lengthCluster(ROSES_UPLOADS, 243.867)!;
    expect(Math.abs(roses - 248.9)).toBeLessThanOrEqual(1.2);
    // too few or scattered uploads: no claim
    expect(lengthCluster([205, 210], 199.6)).toBeUndefined();
    expect(lengthCluster([200, 203, 206, 209, 212], 199.6)).toBeUndefined();
    // outside the plausible range (longer than the largest crossfade) is ignored
    expect(lengthCluster([240, 240, 240], 199.6)).toBeUndefined();
  });

  it('learns a per-player correction only when several songs agree', () => {
    expect(learnedOffsetSec([5.4])).toBeUndefined();
    expect(learnedOffsetSec([5.4, 6.1, 5.0])).toBeCloseTo(5.4, 5);
    expect(learnedOffsetSec([0, 5, 10])).toBeUndefined();
    expect(learnedOffsetSec([5.0, 5.0, 5.1, 0.1])).toBeCloseTo(5.0, 5);
    let s: number[] = [];
    for (let i = 0; i < 20; i++) s = addLengthSample(s, 5 + i / 100);
    expect(s).toHaveLength(9);
    expect(s.at(-1)).toBeCloseTo(5.19, 5);
  });

  it('treats any length in the plausible range as matching until a correction is learned', () => {
    const q = { title: 'Mask Off', artist: 'Future', lengthWindowSec: lengthWindow(199.6) };
    expect(lengthDeltaSec(q, 205)).toBe(0);
    expect(lengthDeltaSec(q, 196)).toBeCloseTo(-1.6, 5);
    expect(scoreCandidate(q, { title: 'Mask Off', artist: 'Future', durationSec: 205 })).toBeGreaterThanOrEqual(95);
    expect(scoreCandidate(q, { title: 'Mask Off', artist: 'Future', durationSec: 240 })).toBe(0);
  });

  it('builds the query from the learned correction, or a range before that', () => {
    const before = trackQuery(spotifyTrack(), settings()).q;
    expect(before.durationSec).toBeUndefined();
    expect(before.lengthWindowSec?.[0]).toBeCloseTo(197.6, 5);
    expect(before.lengthWindowSec?.[1]).toBeCloseTo(212.1, 5);
    expect(before.lengthMayBeShort).toBe(true);
    const learned = trackQuery(spotifyTrack(), settings([5, 5, 5]));
    expect(learned.learned).toBe(5);
    expect(learned.q.durationSec).toBeCloseTo(204.6, 5);
    // local files and the demo report their true length
    const local = trackQuery(spotifyTrack({ source: 'local' }), settings()).q;
    expect(local.durationSec).toBeCloseTo(199.6, 5);
    expect(local.lengthMayBeShort).toBeUndefined();
  });

  it('picks the majority upload, not the one whose length matches the shortened report', async () => {
    const records = [
      rec(1, 201, { syncedLyrics: lrc(-350) }), // the odd upload that used to win (closest to 199.6 s)
      ...MASK_OFF_UPLOADS.filter((d) => d !== 201).map((d, i) => rec(10 + i, d, { syncedLyrics: lrc(i % 3 === 0 ? 20 : 0) })),
    ];
    let asked: unknown;
    const out = await lrclibProvider(trackQuery(spotifyTrack(), settings()).q, deps({ lrclib: async (q) => ((asked = q), { ok: true, candidates: records }) }));
    // no exact-length lookup with a length that is known to be unreliable
    expect(asked).toMatchObject({ durationSec: undefined });
    expect(out.agreedLengthSec).toBeCloseTo(205, 0);
    const best = [...out.hits].sort((a, b) => b.score - a.score)[0];
    expect(best.doc.lines[0].startMs).not.toBe(3650);
    expect(Math.abs(best.durationDeltaSec ?? 99)).toBeLessThanOrEqual(1);
  });

  it('resolves, reports the measured gap for learning, and gives no false "longer version" note', async () => {
    const records = MASK_OFF_UPLOADS.map((d, i) => rec(i + 1, d));
    const r = await resolveLyrics(spotifyTrack(), settings(), deps({ lrclib: async () => ({ ok: true, candidates: records }) }));
    expect(r.status).toBe('synced');
    expect(r.length?.reportedSec).toBeCloseTo(199.6, 5);
    expect(r.length?.measuredGapSec).toBeCloseTo(5.4, 0);
    expect(r.doc?.source.note ?? '').not.toMatch(/longer/);
    // with a learned correction the exact lookup uses the corrected length
    let asked: any;
    await resolveLyrics(spotifyTrack(), settings([5, 5, 5]), deps({ lrclib: async (q) => ((asked = q), { ok: true, candidates: records }) }));
    expect(asked.durationSec).toBeCloseTo(204.6, 5);
  });

  it('keeps learned samples through settings validation', () => {
    const s = sanitizeSettings({ learned: { lengthOffsets: { [APP.toLowerCase()]: [5, 5.1, 'x', 99, 4.9] } } });
    expect(s.learned.lengthOffsets[APP.toLowerCase()]).toEqual([5, 5.1, 4.9]);
    expect(sanitizeSettings(null).learned.lengthOffsets).toEqual({});
  });
});

describe('version labels', () => {
  it('a radio edit or clean label lowers the score; live or remix rules the upload out', () => {
    const q = { title: 'Song - Radio Edit', artist: 'Artist', durationSec: 200 };
    expect(scoreCandidate(q, { title: 'Song', artist: 'Artist', durationSec: 200 })).toBeGreaterThanOrEqual(80);
    expect(scoreCandidate(q, { title: 'Song - Radio Edit', artist: 'Artist', durationSec: 200 })).toBeGreaterThan(scoreCandidate(q, { title: 'Song', artist: 'Artist', durationSec: 200 }));
    // different audio never reaches the "loose" threshold (55)
    expect(scoreCandidate({ title: 'Song (Live)', artist: 'Artist', durationSec: 200 }, { title: 'Song', artist: 'Artist', durationSec: 200 })).toBeLessThan(55);
    expect(scoreCandidate({ title: 'Song', artist: 'Artist', durationSec: 200 }, { title: 'Song (Remix)', artist: 'Artist', durationSec: 200 })).toBeLessThan(55);
    expect(scoreCandidate({ title: 'Song (Live)', artist: 'Artist', durationSec: 200 }, { title: 'Song (Live)', artist: 'Artist', durationSec: 200 })).toBeGreaterThanOrEqual(95);
  });
});

describe('saved lyrics', () => {
  const localTrack = (p: Partial<TrackInfo> = {}): TrackInfo => ({ key: 'trk:a|s', title: 'Song', artist: 'Artist', durationMs: 200_000, source: 'local', sourceLabel: 'Local', genres: [], ...p });
  const songRec = (p: Partial<LrclibRecord> = {}): LrclibRecord => ({ id: 1, trackName: 'Song', artistName: 'Artist', duration: 200, instrumental: false, syncedLyrics: lrc(0), ...p });
  const DAY = 24 * 3600 * 1000;
  const saved = (p: Partial<LyricsCacheEntry> = {}): LyricsCacheEntry => ({ savedAt: Date.now(), provider: 'lrclib', format: 'lrc', text: lrc(500), label: 'LRCLIB', ...p });

  it('uses a recent saved copy without going online', async () => {
    let calls = 0;
    const r = await resolveLyrics(localTrack(), settings(), deps({ cacheGet: async () => saved(), lrclib: async () => (calls++, { ok: true, candidates: [songRec()] }) }), undefined, { onProgress: () => {} });
    expect(r.doc?.source.kind).toBe('cache');
    expect(calls).toBe(0);
  });

  it('rechecks an old copy in the background but keeps it for this play unless word timing appears', async () => {
    const puts: LyricsCacheEntry[] = [];
    const old = saved({ savedAt: Date.now() - 8 * DAY });
    const line = await resolveLyrics(localTrack(), settings(), deps({ cacheGet: async () => old, cachePut: async (_k, e) => void puts.push(e), lrclib: async () => ({ ok: true, candidates: [songRec()] }) }), undefined, { onProgress: () => {} });
    expect(line.doc?.source.kind).toBe('cache');
    await new Promise((res) => setTimeout(res, 0));
    expect(puts[0]).toMatchObject({ format: 'lrc', lengthSec: 200 });
    expect(puts[0].checkedAt).toBeGreaterThan(Date.now() - 5000);
    const lf = ['version: "1.0"', 'metadata:', '  title: Song', '  duration_ms: 200000', 'lines:', '  - text: "placeholder words"', '    start_ms: 4000', '    end_ms: 6000', '    words:', '      - text: "placeholder "', '        start_ms: 4000', '      - text: "words"', '        start_ms: 5000'].join('\n');
    const word = await resolveLyrics(localTrack(), settings(), deps({ cacheGet: async () => old, lrclib: async () => ({ ok: true, candidates: [songRec({ hasWordSync: true, lyricsfile: lf })] }) }), undefined, { onProgress: () => {} });
    expect(word.doc?.timing).toBe('word');
  });

  it('does not save weak matches', async () => {
    const puts: LyricsCacheEntry[] = [];
    const r = await resolveLyrics(localTrack(), settings(), deps({ cachePut: async (_k, e) => void puts.push(e), lrclib: async () => ({ ok: true, candidates: [songRec({ artistName: 'Artist feat. Someone', trackName: 'Song (Extended Mix)', duration: 211 })] }) }));
    if (r.status === 'synced') expect(r.doc?.source.match).toBe('loose');
    await new Promise((res) => setTimeout(res, 0));
    expect(puts.filter((p) => p.format !== 'none')).toHaveLength(0);
  });

  it('ignores a saved copy made for a different length', async () => {
    let calls = 0;
    const r = await resolveLyrics(localTrack(), settings(), deps({ cacheGet: async () => saved({ lengthSec: 230 }), lrclib: async () => (calls++, { ok: true, candidates: [songRec()] }) }));
    expect(calls).toBe(1);
    expect(r.doc?.source.kind).toBe('lrclib');
    expect(r.tried.some((t) => /230 s version/.test(t.outcome))).toBe(true);
  });

  it('remembers "nothing found" for a day, but not after a provider failure', async () => {
    const puts: LyricsCacheEntry[] = [];
    await resolveLyrics(localTrack(), settings(), deps({ cachePut: async (_k, e) => void puts.push(e), lrclib: async () => ({ ok: true, candidates: [] }) }));
    await new Promise((res) => setTimeout(res, 0));
    expect(puts[0]).toMatchObject({ format: 'none', text: '' });
    let calls = 0;
    const marker = puts[0];
    const again = await resolveLyrics(localTrack(), settings(), deps({ cacheGet: async () => marker, lrclib: async () => (calls++, { ok: true, candidates: [] }) }));
    expect(calls).toBe(0);
    expect(again.status).toBe('not-found');
    expect(again.tried.at(-1)?.outcome).toMatch(/Search again/);
    await resolveLyrics(localTrack(), settings(), deps({ cacheGet: async () => ({ ...marker, savedAt: Date.now() - 2 * DAY }), lrclib: async () => (calls++, { ok: true, candidates: [] }) }));
    expect(calls).toBe(1);
    await resolveLyrics(localTrack(), settings(), deps({ cacheGet: async () => marker, lrclib: async () => (calls++, { ok: true, candidates: [] }) }), undefined, { refresh: true });
    expect(calls).toBe(2);
    const failPuts: LyricsCacheEntry[] = [];
    await resolveLyrics(localTrack(), settings(), deps({ cachePut: async (_k, e) => void failPuts.push(e), lrclib: async () => ({ ok: false, error: 'LRCLIB responded 429', status: 429 }) }));
    await new Promise((res) => setTimeout(res, 0));
    expect(failPuts).toHaveLength(0);
  });
});
