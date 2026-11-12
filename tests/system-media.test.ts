import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ onBridge: vi.fn(() => () => {}), bridgeStart: vi.fn(async () => ({ started: true })), bridgeStop: vi.fn(), bridgeCommand: vi.fn() }));
vi.mock('../src/app/platform', () => ({ native }));
import { SystemMediaAdapter } from '../src/playback/SystemMediaAdapter';
import { SyncEngine } from '../src/core/sync/SyncEngine';
import { recordingKey } from '../src/playback/identity';
import trace from './fixtures/windows-spotify-trace.json';
import pauses from './fixtures/windows-spotify-pause-2026-11-09.json';
import type { BridgeState } from '../src/shared/api';

describe('Windows playback adapter regressions', () => {
  let adapter: SystemMediaAdapter;
  let engine: SyncEngine;
  let now: number;
  let seq: number;
  let tracks: any[];
  const wall = 1_800_000_000_000;
  const state = (p: Partial<BridgeState> = {}): BridgeState => ({
    type: 'state', seq: ++seq, cause: 'timeline', app: 'Spotify.exe', status: 'playing',
    positionMs: 27000, lastUpdatedWallMs: wall - 2000, emitWallMs: wall,
    timelineAvailable: true, startMs: 0, endMs: 200000,
    media: { title: 'Song', artist: 'Artist', album: 'Album' },
    controls: { play: true, pause: true, toggle: true, seek: true, next: true, prev: true }, ...p,
  });
  beforeEach(() => {
    vi.useFakeTimers(); now = 10000; seq = 0; tracks = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(Date, 'now').mockImplementation(() => wall + now - 10000);
    engine = new SyncEngine({ clock: { now: () => now } });
    adapter = new SystemMediaAdapter({ observe: o => engine.ingest(o), track: t => tracks.push(t), status: () => {} }, () => {}, 'spotify');
    native.bridgeCommand.mockClear();
  });
  afterEach(() => { adapter.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('replays the captured Windows pause/resume trace without adding paused time', () => {
    const first = trace[0]; const reference = first.message.emitWallMs - first.at;
    const positions: { phase: string; position: number; raw: number }[] = [];
    for (const event of trace) {
      now = event.at;
      vi.mocked(Date.now).mockReturnValue(reference + now);
      adapter.handle(event.message as BridgeState);
      positions.push({ phase: event.phase, position: engine.position(), raw: event.message.positionMs! });
    }
    expect(positions[0].position).toBeGreaterThan(27000);
    const resumed = positions.find(p => p.phase === 'resume')!;
    const paused = positions.filter(p => p.phase === 'pause').at(-1)!;
    expect(Math.abs(resumed.position - paused.position)).toBeLessThan(400);
    expect(engine.isPlaying()).toBe(true);
  });
  it('keeps lyrics steady through two real Spotify pauses (lagging pause reports, both orders)', () => {
    const events = pauses.events;
    const reference = events[0].message.emitWallMs - events[0].at;
    const samples: { t: number; p: number; playing: boolean }[] = [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      now = e.at;
      vi.mocked(Date.now).mockReturnValue(reference + now);
      adapter.handle(e.message as BridgeState);
      samples.push({ t: now, p: engine.position(), playing: engine.isPlaying() });
      // what the screen would show between reports (one frame every 20 ms)
      const next = events[i + 1]?.at ?? e.at + 1000;
      for (let t = e.at + 20; t < next; t += 20) {
        now = t;
        vi.mocked(Date.now).mockReturnValue(reference + now);
        samples.push({ t, p: engine.position(), playing: engine.isPlaying() });
      }
    }
    let worstBack = 0;
    for (let i = 1; i < samples.length; i++) worstBack = Math.min(worstBack, samples[i].p - samples[i - 1].p);
    // 2.1.0 moved back ~300 ms at each pause and forward ~280 ms at each resume
    expect(worstBack).toBeGreaterThan(-60);
    let worstForward = 0;
    for (let i = 1; i < samples.length; i++) if (!samples[i - 1].playing) worstForward = Math.max(worstForward, samples[i].p - samples[i - 1].p);
    expect(worstForward).toBeLessThan(60);
    expect(engine.isPlaying()).toBe(true);
  });
  it('joins an existing song at its real position, never a guessed zero', () => {
    adapter.handle(state({ cause: 'initial' }));
    expect(engine.position()).toBe(29000);
  });
  it('holds repeated old-track timelines until the new recording publishes a position', () => {
    const s = state(); adapter.handle(s); now += 100;
    const next = { ...s, media: { title: 'Next', artist: 'Artist', album: 'Album' } };
    adapter.handle(next); expect(engine.position()).toBe(0);
    now += 100; adapter.handle(next); expect(engine.position()).toBe(100);
    adapter.handle(state({ media: next.media, positionMs: 0, lastUpdatedWallMs: wall + 100 }));
    expect(engine.position()).toBe(100);
  });
  it('does not give a new song the previous song\'s length while its timeline is stale', () => {
    const s = state({ endMs: 290600 }); adapter.handle(s); now += 100;
    const next = { ...s, media: { title: 'Next', artist: 'Artist', album: 'Album' } };
    adapter.handle(next);
    expect(tracks.at(-1).title).toBe('Next');
    expect(tracks.at(-1).durationMs).toBeUndefined();
    now += 300;
    adapter.handle(state({ media: next.media, positionMs: 0, lastUpdatedWallMs: wall + 400, endMs: 281967 }));
    expect(tracks.at(-1).durationMs).toBe(281967);
    expect(tracks.at(-1).key).toBe(tracks.at(-2).key);
  });
  it('maps the same Windows timestamp once across play/pause and wall clock jitter', () => {
    const s = state(); adapter.handle(s); now += 100;
    vi.mocked(Date.now).mockReturnValue(wall + 102);
    adapter.handle({ ...s, status: 'paused', cause: 'playback' });
    expect(engine.position()).toBe(29100); expect(engine.isPlaying()).toBe(false);
    now += 3000; adapter.handle({ ...s, status: 'playing', cause: 'playback' });
    expect(engine.position()).toBe(29100);
  });
  it('ignores old reports after an optimistic seek and accepts confirmation', () => {
    const s = state(); adapter.handle(s); now += 100; adapter.seek(60000);
    now += 100; adapter.handle(s); expect(engine.position()).toBe(60100);
    adapter.handle(state({ positionMs: 60010, lastUpdatedWallMs: wall + 190 }));
    expect(engine.position()).toBeCloseTo(60020, 0);
  });
  it('rolls back a declined command and bounds unconfirmed seeks', () => {
    adapter.handle(state()); adapter.seek(60000);
    const command = native.bridgeCommand.mock.calls[0][0] as any;
    adapter.handle({ type: 'ack', id: command.id, ok: false, error: 'declined' });
    expect(engine.position()).toBe(29000);
    adapter.seek(60000); now += 2600; vi.advanceTimersByTime(2600);
    expect(engine.position()).toBe(31600);
  });
  it('honours pause while a seek is waiting for a new timeline', () => {
    const s = state(); adapter.handle(s); now += 100; adapter.seek(60000); now += 100;
    adapter.handle({ ...s, status: 'paused', cause: 'playback' });
    expect(engine.isPlaying()).toBe(false);
    const p = engine.position(); now += 500; expect(engine.position()).toBe(p);
  });
  it('freezes and clears controls on bridge exit, then resynchronizes', () => {
    adapter.handle(state()); now += 100;
    adapter.handle({ type: 'bridge-exit', code: 1, signal: null, restarting: true });
    const p = engine.position(); now += 5000;
    expect(engine.position()).toBe(p); expect(engine.snapshot().quality).toBe('unavailable');
    expect(adapter.capabilities().seek).toBe(false);
    adapter.handle(state({ positionMs: 34000, lastUpdatedWallMs: wall + 5000 }));
    expect(engine.isPlaying()).toBe(true); expect(engine.position()).toBeCloseTo(34100, 0);
  });
  it('separates recordings and publishes duration enrichment without restarting tracks', () => {
    adapter.handle(state()); const k = tracks.at(-1).key;
    adapter.handle(state({ endMs: 201000 })); expect(tracks.at(-1).key).toBe(k);
    adapter.handle(state({ media: { title: 'Song (Clean)', artist: 'Artist', album: 'Album' } }));
    expect(tracks.at(-1).key).not.toBe(k); expect(tracks.at(-1).themeKey).toBe(tracks[0].themeKey);
    expect(recordingKey('Spotify', 'Artist', 'Song', 'A')).not.toBe(recordingKey('Spotify', 'Artist', 'Song', 'B'));
  });
});
