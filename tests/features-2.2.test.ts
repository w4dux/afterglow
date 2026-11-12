import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/app/report';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings/schema';
import { SyncEngine } from '../src/core/sync/SyncEngine';
import { applyGlobalSuggestion, suggestGlobalOffset, totalOffsetMs } from '../src/core/sync/timing';

const timing = (trackOffsets: Record<string, number>, globalOffsetMs = 0) => ({ globalOffsetMs, rememberTrackOffsets: true, trackOffsets, suggestionDismissed: null });

describe('global offset suggestion from per-song corrections', () => {
  it('suggests when several songs were moved the same way by about the same amount', () => {
    expect(suggestGlobalOffset(timing({ a: 200, b: 180, c: 230 }))).toEqual({ deltaMs: 200, songs: 3 });
    expect(suggestGlobalOffset(timing({ a: -150, b: -120, c: -170, d: -140 }))).toEqual({ deltaMs: -140, songs: 4 }); // median -145, rounded to 10
  });

  it('stays quiet for too few songs, mixed directions, tiny or scattered corrections', () => {
    expect(suggestGlobalOffset(timing({ a: 200, b: 200 }))).toBeNull();
    expect(suggestGlobalOffset(timing({ a: 200, b: -200, c: 200 }))).toBeNull();
    expect(suggestGlobalOffset(timing({ a: 50, b: 60, c: 40 }))).toBeNull();
    expect(suggestGlobalOffset(timing({ a: 100, b: 900, c: 400, d: 1500 }))).toBeNull();
    expect(suggestGlobalOffset({ ...timing({ a: 200, b: 200, c: 200 }), rememberTrackOffsets: false })).toBeNull();
  });

  it('applying keeps every corrected song exactly where it was and moves the rest', () => {
    const before = timing({ a: 200, b: 180, c: 230, odd: 900 }, 50);
    const after = applyGlobalSuggestion(before, 200);
    for (const k of Object.keys(before.trackOffsets)) expect(totalOffsetMs(after, k)).toBe(totalOffsetMs(before, k));
    expect(after.globalOffsetMs).toBe(250);
    expect(totalOffsetMs(after, 'new song')).toBe(250);
    expect(after.trackOffsets.a).toBeUndefined(); // nothing left to remember
    expect(suggestGlobalOffset(after)).toBeNull();
  });

  it('remembers a declined suggestion through settings validation', () => {
    const s = sanitizeSettings({ timing: { globalOffsetMs: 0, trackOffsets: {}, suggestionDismissed: { deltaMs: 200, songs: 3 } } });
    expect(s.timing.suggestionDismissed).toEqual({ deltaMs: 200, songs: 3 });
    expect(sanitizeSettings({ timing: { suggestionDismissed: 'x' } }).timing.suggestionDismissed).toBeNull();
    expect(sanitizeSettings(null).timing.suggestionDismissed).toBeNull();
  });
});

describe('diagnostics report', () => {
  it('describes the song, lyrics, timing and recent log in plain text', () => {
    const engine = new SyncEngine({ clock: { now: () => 1000 } });
    const report = buildReport({
      now: new Date('2026-11-09T18:00:00Z'),
      info: { version: '2.2.0', platform: 'win32', electron: '45', chrome: '140', bridgeAvailable: true, userData: 'C:/Users/x/AppData/Roaming/Afterglow' },
      settings: { ...DEFAULT_SETTINGS, learned: { lengthOffsets: { spotify: [5, 5.1, 4.9] } } },
      source: 'system',
      track: { key: 'k', title: 'Orbiter', artist: 'Noah Kahan', album: 'The Great Divide', durationMs: 281967, source: 'system', sourceLabel: 'Spotify', app: 'Spotify', genres: [] },
      lyrics: { status: 'not-found', doc: null, tried: [{ source: 'LRCLIB', outcome: 'no match' }], length: { reportedSec: 281.967, learnedOffsetSec: 5 } },
      themeId: 'afterhours',
      offsetMs: 120,
      sync: engine.snapshot(),
      corrections: [{ at: 1, kind: 'hold', errorMs: -291, positionMs: 94734, reason: 'lagging paused report' }],
      system: { bridge: 'on', app: 'Spotify', status: 'playing', counts: { timeline: 3 } } as any,
      frameCost: { avg: 0.13, p95: 0.3 },
      logTail: ['2026-11-09T17:59:00Z [main] Afterglow 2.2.0 started'],
    });
    expect(report).toMatch(/version 2\.2\.0 · win32/);
    expect(report).toMatch(/"Orbiter" by Noah Kahan/);
    expect(report).toMatch(/player length 282\.0 s/);
    expect(report).toMatch(/tried LRCLIB: no match/);
    expect(report).toMatch(/learned correction 5\.0 s/);
    expect(report).toMatch(/used a range/);
    expect(report).toMatch(/spotify: \[5, 5\.1, 4\.9\]/);
    expect(report).toMatch(/hold -291 ms at 94734 ms/);
    expect(report).toMatch(/Afterglow 2\.2\.0 started/);
    expect(report).not.toMatch(/C:\/Users/); // no local paths
    expect(report).not.toMatch(/\n\n\n/);
  });
});
