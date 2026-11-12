import { describe, expect, it } from 'vitest';
import { ManualClock, type Observation, SyncEngine } from '../src/core/sync/SyncEngine';
import { lyricTimeOf, offsetToAlign, totalOffsetMs } from '../src/core/sync/timing';

function setup(source: Observation['source'] = 'system') {
  const clock = new ManualClock(10_000);
  const engine = new SyncEngine({ clock });
  let seq = 0;
  const obs = (o: Partial<Observation> & { positionMs: number }): Observation => ({
    source,
    pausePositionMayLag: source === 'system',
    seq: ++seq,
    trackKey: 'trk:a|song',
    sampledAt: clock.now(),
    playing: true,
    cause: 'event',
    ...o,
  });
  return { clock, engine, obs };
}

describe('SyncEngine — interpolation & pause', () => {
  it('interpolates with the monotonic clock while playing', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 5000, cause: 'track' }));
    clock.advance(1234);
    expect(engine.position()).toBeCloseTo(6234, 6);
  });

  it('honours observation latency (projects from sample time, not arrival)', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 5000, sampledAt: clock.now() - 80, cause: 'track' }));
    expect(engine.position()).toBeCloseTo(5080, 6);
    expect(engine.snapshot().lastLatencyMs).toBeCloseTo(80, 6);
  });

  it('freezes immediately on pause with a fresh position (authoritative local clock)', () => {
    const { clock, engine, obs } = setup('local');
    engine.ingest(obs({ positionMs: 0, cause: 'track' }));
    clock.advance(1000);
    engine.ingest(obs({ positionMs: 1003, playing: false, cause: 'state' }));
    expect(engine.position()).toBe(1003);
    clock.advance(5000);
    expect(engine.position()).toBe(1003);
    expect(engine.isPlaying()).toBe(false);
  });

  it('freezes at the current estimate when a pause arrives with a stale (unchanged) timeline', () => {
    const { clock, engine, obs } = setup();
    const t0 = clock.now();
    engine.ingest(obs({ positionMs: 20_000, sampledAt: t0, cause: 'track' }));
    clock.advance(30_000);
    // Same timeline sample as before, only the playback status changed.
    const r = engine.ingest(obs({ positionMs: 20_000, sampledAt: t0, playing: false, cause: 'state' }));
    expect(r.kind).toBe('pause');
    expect(engine.position()).toBeCloseTo(50_000, 6); // not 20 000
    clock.advance(2000);
    expect(engine.position()).toBeCloseTo(50_000, 6);
    // resume with stale timeline continues from the frozen point
    engine.ingest(obs({ positionMs: 20_000, sampledAt: t0, playing: true, cause: 'state' }));
    clock.advance(500);
    expect(engine.position()).toBeCloseTo(50_500, 6);
  });

  it('resumes from a fresh play observation', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 1000, playing: false, cause: 'track' }));
    clock.advance(3000);
    expect(engine.position()).toBe(1000);
    engine.ingest(obs({ positionMs: 1000, sampledAt: clock.now() - 20, playing: true, cause: 'state' }));
    expect(engine.position()).toBeCloseTo(1020, 6);
    clock.advance(100);
    expect(engine.position()).toBeCloseTo(1120, 6);
  });
});

describe('SyncEngine — seeks & drift', () => {
  it('snaps promptly on forward and backward seeks', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 10_000, cause: 'track' }));
    clock.advance(500);
    let r = engine.ingest(obs({ positionMs: 60_000, cause: 'seek' }));
    expect(r.kind).toBe('seek');
    expect(engine.position()).toBe(60_000);
    clock.advance(100);
    r = engine.ingest(obs({ positionMs: 3_000 })); // large backward jump without explicit cause
    expect(r.kind).toBe('seek');
    expect(engine.position()).toBe(3_000);
  });

  it('handles a seek while paused', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 10_000, playing: false, cause: 'track' }));
    clock.advance(200);
    const r = engine.ingest(obs({ positionMs: 42_000, playing: false }));
    expect(r.kind).toBe('seek');
    expect(engine.position()).toBe(42_000);
  });

  it('absorbs small drift smoothly, never moving backwards, and converges', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 0, cause: 'track' }));
    clock.advance(1000);
    // true position is 60 ms behind our estimate
    const r = engine.ingest(obs({ positionMs: 940 }));
    expect(r.kind).toBe('slew');
    let prev = engine.position();
    expect(prev).toBeCloseTo(1000, 6); // continuous at the correction instant
    for (let i = 0; i < 300; i++) {
      clock.advance(5);
      const p = engine.position();
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
    // after 1.5 s the residual is gone: position equals the observation timeline
    expect(engine.position()).toBeCloseTo(940 + 1500, 0);
  });

  it('snaps medium errors above the snap threshold', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 0, cause: 'track' }));
    clock.advance(1000);
    const r = engine.ingest(obs({ positionMs: 1400 }));
    expect(r.kind).toBe('snap');
    expect(engine.position()).toBe(1400);
  });

  it('records observation consistency statistics for diagnostics', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 0, cause: 'track' }));
    for (let i = 1; i <= 10; i++) {
      clock.advance(1000);
      engine.ingest(obs({ positionMs: i * 1000 + (i % 2 ? 10 : -10) }));
    }
    const s = engine.snapshot().stats;
    expect(s.samples).toBe(10);
    expect(s.meanAbsErrorMs).toBeGreaterThan(5);
    expect(s.maxAbsErrorMs).toBeLessThan(30);
  });
});

describe('SyncEngine — stale data & tracks', () => {
  it('rejects observations sampled before the last accepted one', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 5000, cause: 'track' }));
    clock.advance(1000);
    engine.ingest(obs({ positionMs: 6000 }));
    const r = engine.ingest(obs({ positionMs: 5500, sampledAt: clock.now() - 500 }));
    expect(r.accepted).toBe(false);
    expect(engine.position()).toBeCloseTo(6000, 6);
  });

  it('rejects out-of-order sequence numbers and ignores duplicates', () => {
    const { clock, engine } = setup();
    const base = { source: 'system' as const, trackKey: 'k', playing: true, cause: 'event' as const };
    engine.ingest({ ...base, seq: 5, positionMs: 0, sampledAt: clock.now(), cause: 'track' });
    clock.advance(100);
    expect(engine.ingest({ ...base, seq: 4, positionMs: 100, sampledAt: clock.now() }).accepted).toBe(false);
    const t = clock.now();
    expect(engine.ingest({ ...base, seq: 6, positionMs: 100, sampledAt: t }).accepted).toBe(true);
    const dup = engine.ingest({ ...base, seq: 7, positionMs: 100, sampledAt: t });
    expect(dup.reason).toBe('duplicate');
    expect(engine.snapshot().stats.rejected).toBe(1);
  });

  it('accepts a restarted adapter epoch with a reset sequence', () => {
    const { clock, engine } = setup();
    const base = { source: 'system' as const, trackKey: 'k', playing: true, cause: 'event' as const };
    engine.ingest({ ...base, epoch: 1, seq: 50, positionMs: 0, sampledAt: clock.now(), cause: 'track' });
    clock.advance(1000);
    expect(engine.ingest({ ...base, epoch: 2, seq: 1, positionMs: 1000, sampledAt: clock.now() }).accepted).toBe(true);
  });

  it('switches tracks, bumps the generation, and rejects stale old-track observations', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 100_000, cause: 'track' }));
    const g1 = engine.currentGeneration;
    clock.advance(1000);
    const tSwitch = clock.now();
    engine.ingest(obs({ trackKey: 'trk:b|next', positionMs: 0, cause: 'track' }));
    expect(engine.currentGeneration).toBe(g1 + 1);
    expect(engine.position()).toBe(0);
    // a late timeline update for the previous track, sampled before the switch
    const r = engine.ingest(obs({ trackKey: 'trk:a|song', positionMs: 101_000, sampledAt: tSwitch - 5 }));
    expect(r.accepted).toBe(false);
    expect(engine.currentTrack).toBe('trk:b|next');
    // going back to the previous track later is a genuine change
    clock.advance(2000);
    expect(engine.ingest(obs({ trackKey: 'trk:a|song', positionMs: 0 })).kind).toBe('track');
  });

  it('handles playback ending', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 179_000, durationMs: 180_000, cause: 'track' }));
    clock.advance(5000);
    expect(engine.position()).toBe(180_000); // clamped to duration
    engine.ingest(obs({ positionMs: 180_000, playing: false, cause: 'ended' }));
    expect(engine.isPlaying()).toBe(false);
  });

  it('clamps observations stamped in the future', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 1000, sampledAt: clock.now() + 5000, cause: 'track' }));
    expect(engine.position()).toBe(1000);
  });

  it('reports unavailable timing honestly when the source has no timeline', () => {
    const { engine, obs } = setup();
    engine.ingest(obs({ positionMs: 0, timeline: false, cause: 'track' }));
    expect(engine.snapshot().quality).toBe('unavailable');
  });

  it('marks quality as estimating after host resume until a fresh observation arrives', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 0, cause: 'track' }));
    expect(engine.snapshot().quality).toBe('tracking');
    clock.advance(10);
    engine.notifyResume();
    expect(engine.snapshot().quality).toBe('estimating');
    clock.advance(10);
    engine.ingest(obs({ positionMs: 20 }));
    expect(engine.snapshot().quality).toBe('tracking');
  });

  it('reports locked quality for sample-accurate local playback', () => {
    const { engine, obs } = setup('local');
    engine.ingest(obs({ positionMs: 0, cause: 'track' }));
    expect(engine.snapshot().quality).toBe('locked');
  });
});

describe('SyncEngine — simulated jittery source (measurement)', () => {
  it('keeps displayed error small with 250 ms cadence, ±15 ms timestamp jitter and 40 ms latency', () => {
    const clock = new ManualClock(0);
    const engine = new SyncEngine({ clock });
    let seed = 42;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let seq = 0;
    const errors: number[] = [];
    const truth = (t: number) => t - 1000; // track started at t=1000
    for (let t = 1000; t < 61_000; t += 4) {
      clock.t = t;
      if ((t - 1000) % 252 === 0) {
        const sampledAt = t - 40 + (rnd() - 0.5) * 30; // report is 40 ms old, timestamp jitter ±15
        engine.ingest({
          source: 'simulated',
          seq: ++seq,
          trackKey: 'sim',
          positionMs: truth(t - 40),
          sampledAt,
          receivedAt: t,
          playing: true,
          cause: seq === 1 ? 'track' : 'poll',
        });
      }
      if (t > 3000) errors.push(Math.abs(engine.position(t) - truth(t)));
    }
    errors.sort((a, b) => a - b);
    const p95 = errors[Math.floor(errors.length * 0.95)];
    expect(p95).toBeLessThan(15);
  });
});

describe('timing offsets', () => {
  it('combines global and per-track offsets; positive shows lyrics later', () => {
    const prefs = { globalOffsetMs: 120, rememberTrackOffsets: true, trackOffsets: { k: -40 } };
    expect(totalOffsetMs(prefs, 'k')).toBe(80);
    expect(totalOffsetMs(prefs, 'other')).toBe(120);
    expect(totalOffsetMs({ ...prefs, rememberTrackOffsets: false }, 'k')).toBe(120);
    expect(lyricTimeOf(10_000, 80)).toBe(9920);
  });
  it('computes the per-track offset that aligns a line to now', () => {
    const track = offsetToAlign(30_000, 29_500, 100);
    expect(lyricTimeOf(30_000, 100 + track)).toBe(29_500);
  });
});

describe('SyncEngine — provisional observations', () => {
  it('lets the real timeline replace a provisional track-start guess even if sampled earlier', () => {
    const { clock, engine, obs } = setup();
    engine.ingest(obs({ positionMs: 90_000, cause: 'track' }));
    clock.advance(1000);
    // track changed; the player has not published a timeline yet -> assume 0 now
    engine.ingest(obs({ trackKey: 'trk:b|x', positionMs: 0, provisional: true, cause: 'track' }));
    expect(engine.position()).toBe(0);
    clock.advance(300);
    // real timeline: the new track actually started 120 ms before our guess
    const r = engine.ingest(obs({ trackKey: 'trk:b|x', positionMs: 0, sampledAt: clock.now() - 420 }));
    expect(r.accepted).toBe(true);
    expect(engine.position()).toBeCloseTo(420, 0);
    expect(engine.snapshot().stats.samples).toBe(0);
  });
});

describe('SyncEngine — Spotify pause reports (measured behaviour)', () => {
  it('replays the sequence seen on Windows: pause, report −318 ms, resume report agrees with the frozen estimate', () => {
    const { clock, engine, obs } = setup('system');
    const t0 = clock.now();
    engine.ingest(obs({ positionMs: 15_660, sampledAt: t0, cause: 'track' }));
    clock.advance(6_440); // playing to 22 100
    const lastTl = { positionMs: 15_660, sampledAt: t0 };
    // 1. PlaybackInfoChanged: paused, timeline unchanged -> freeze at the estimate
    expect(engine.ingest(obs({ ...lastTl, playing: false, cause: 'state' })).kind).toBe('pause');
    expect(engine.position()).toBeCloseTo(22_100, 6);
    // 2. TimelinePropertiesChanged right after: Spotify says 21 782 (318 ms behind)
    clock.advance(40);
    const r = engine.ingest(obs({ positionMs: 21_782, sampledAt: clock.now() - 5, playing: false }));
    expect(r.kind).toBe('hold');
    expect(engine.position()).toBeCloseTo(22_100, 6); // no jump back
    // 3. three seconds later, at resume, Spotify reports 22 078 while still paused
    clock.advance(3_000);
    engine.ingest(obs({ positionMs: 22_078, sampledAt: clock.now() - 5, playing: false }));
    expect(Math.abs(engine.position() - 22_078)).toBeLessThan(1); // tiny correction applied (outside the settle window)
    // 4. playing again
    engine.ingest(obs({ positionMs: 22_078, sampledAt: clock.now() - 5, playing: true, cause: 'state' }));
    clock.advance(1_000);
    expect(engine.position()).toBeCloseTo(23_078, 0); // resume continues from the frozen point
    expect(engine.snapshot().stats.holds).toBe(1);
  });

  it('still applies real seeks while paused and never holds for local audio', () => {
    const { clock, engine, obs } = setup('system');
    engine.ingest(obs({ positionMs: 10_000, cause: 'track' }));
    clock.advance(1000);
    engine.ingest(obs({ positionMs: 11_000, playing: false, cause: 'state' }));
    clock.advance(100);
    expect(engine.ingest(obs({ positionMs: 40_000, playing: false })).kind).toBe('seek'); // large: a real seek
    const local = setup('local');
    local.engine.ingest(local.obs({ positionMs: 10_000, cause: 'track' }));
    local.clock.advance(1000);
    local.engine.ingest(local.obs({ positionMs: 11_000, playing: false, cause: 'state' }));
    local.clock.advance(50);
    expect(local.engine.ingest(local.obs({ positionMs: 10_700, playing: false })).kind).toBe('seek');
  });

  it('freezes at the estimate when the pause arrives together with a slightly-behind position', () => {
    const { clock, engine, obs } = setup('system');
    engine.ingest(obs({ positionMs: 0, cause: 'track' }));
    clock.advance(5000);
    const r = engine.ingest(obs({ positionMs: 4_650, playing: false, cause: 'state' }));
    expect(r.kind).toBe('pause');
    expect(engine.position()).toBeCloseTo(5000, 6);
  });
});


describe('measured edge case regressions', () => {
  it('does not undo a provisional seek with an old timeline', () => {
    const { clock, engine, obs } = setup(); const before = clock.now();
    engine.ingest(obs({ positionMs: 10000 })); clock.advance(100);
    engine.ingest(obs({ positionMs: 60000, cause: 'seek', provisional: true })); clock.advance(100);
    expect(engine.ingest(obs({ positionMs: 10000, sampledAt: before })).accepted).toBe(false);
    expect(engine.position()).toBe(60100);
  });
  it('applies forward paused seeks immediately, and holds a lagging pause report until resume', () => {
    const { clock, engine, obs } = setup(); engine.ingest(obs({ positionMs: 10000 })); clock.advance(100);
    engine.ingest(obs({ positionMs: 10100, playing: false })); clock.advance(100);
    engine.ingest(obs({ positionMs: 10600, playing: false })); expect(engine.position()).toBe(10600);
    // Measured 2026-11-09: Spotify's report on resume agreed with the held estimate
    // within 23-42 ms; releasing to the lagging report made lyrics jump back ~300 ms
    // and then forward again.
    const other = setup(); other.engine.ingest(other.obs({ positionMs: 10000 })); other.clock.advance(1000);
    other.engine.ingest(other.obs({ positionMs: 10700, playing: false })); other.clock.advance(1600);
    expect(other.engine.position()).toBe(11000);
    other.engine.ingest(other.obs({ positionMs: 10700, playing: false })); // the same lagging report again
    expect(other.engine.position()).toBe(11000);
    other.engine.ingest(other.obs({ positionMs: 10970, playing: true })); // resume report
    expect(other.engine.position()).toBe(10970);
  });
  it('waits briefly on a "behind" playing report, and keeps the estimate if a pause follows', () => {
    const { clock, engine, obs } = setup(); engine.ingest(obs({ positionMs: 10000 })); clock.advance(1000);
    const sampledAt = clock.now();
    engine.ingest(obs({ positionMs: 10700, sampledAt })); // 300 ms behind
    expect(engine.position()).toBe(11000);
    clock.advance(3);
    engine.ingest(obs({ positionMs: 10700, sampledAt, playing: false, cause: 'state' }));
    expect(engine.isPlaying()).toBe(false);
    expect(engine.position()).toBeCloseTo(11003, 6);
    // without a pause the correction still applies, only 200 ms later
    const b = setup(); b.engine.ingest(b.obs({ positionMs: 10000 })); b.clock.advance(1000);
    b.engine.ingest(b.obs({ positionMs: 10700 }));
    b.clock.advance(199); expect(b.engine.position()).toBe(11199);
    b.clock.advance(1); expect(b.engine.position()).toBe(10900);
    // other players are corrected at once
    const c = setup(); c.engine.ingest(c.obs({ positionMs: 10000 })); c.clock.advance(1000);
    c.engine.ingest(c.obs({ positionMs: 10700, pausePositionMayLag: false })); expect(c.engine.position()).toBe(10700);
  });
  it('does not apply the Spotify pause quirk to other players', () => {
    const { clock, engine, obs } = setup(); engine.ingest(obs({ positionMs: 10000 })); clock.advance(1000);
    engine.ingest(obs({ positionMs: 10700, playing: false, pausePositionMayLag: false }));
    expect(engine.position()).toBe(10700);
  });
  it('honours playback state even with a slightly older timeline', () => {
    const { clock, engine, obs } = setup(); engine.ingest(obs({ positionMs: 10000 })); clock.advance(1000);
    engine.ingest(obs({ positionMs: 11000, sampledAt: clock.now() - 1, playing: false, cause: 'state' }));
    clock.advance(3000); engine.ingest(obs({ positionMs: 11000, sampledAt: clock.now() - 3002, playing: true, cause: 'state' }));
    expect(engine.isPlaying()).toBe(true); expect(engine.position()).toBeCloseTo(11000, -1);
  });
  it('keeps slow-rate smoothing monotonic', () => {
    const { clock, engine, obs } = setup(); engine.ingest(obs({ positionMs: 1000, rate: 0.1 })); clock.advance(1000);
    engine.ingest(obs({ positionMs: 1000, rate: 0.1 })); let previous = engine.position();
    for (let i = 0; i < 100; i++) { clock.advance(10); const p = engine.position(); expect(p).toBeGreaterThanOrEqual(previous); previous = p; }
  });
});
