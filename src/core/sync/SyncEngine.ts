/**
 * Playback synchronization engine.
 *
 * Inputs are *observations* from a playback adapter: "at monotonic time S the
 * player's position was P, and it is playing/paused at rate R". The engine keeps an
 * anchor (P, S, R) and extrapolates with the monotonic clock between observations.
 *
 *  - Pause freezes immediately: no extrapolation while paused.
 *  - Small disagreements between a new observation and the current estimate are
 *    absorbed smoothly with an exponentially decaying residual (never backwards
 *    while playing). Large ones (> snapThresholdMs) and seeks snap at once.
 *  - Observations older than the last accepted one, duplicates, out-of-order
 *    sequence numbers and observations for a previous track are rejected.
 *  - Observation latency is honoured: the observation is projected from its own
 *    sample time, not from when it arrived.
 *  - A state-only update (e.g. "paused" with an unchanged, old timeline) freezes at
 *    the current estimate instead of jumping back to the stale timeline position.
 *
 * Positions are media positions in ms; the user's lyric offset is applied elsewhere.
 */

export type PlaybackSourceKind = 'local' | 'demo' | 'system' | 'simulated';

export interface Observation {
  source: PlaybackSourceKind;
  /** Adapter instance epoch (bumps when an adapter restarts and resets seq). */
  epoch?: number;
  seq: number;
  trackKey: string;
  positionMs: number;
  /** Monotonic ms at which positionMs was valid. */
  sampledAt: number;
  /** Monotonic ms at which the observation reached us (defaults to clock.now()). */
  receivedAt?: number;
  playing: boolean;
  rate?: number;
  durationMs?: number;
  cause: 'poll' | 'event' | 'seek' | 'state' | 'track' | 'ended' | 'resume';
  /** False when the source exposes playback state but no usable position. */
  timeline?: boolean;
  /**
   * A best guess made by an adapter (e.g. "a new track starts at 0" before the player
   * publishes its timeline). The next real observation is never rejected as older.
   */
  provisional?: boolean;
  /** Adapter health; disconnected sources freeze without losing the last position. */
  available?: boolean;
  /** Opt-in workaround for Spotify's delayed pause position reports. */
  pausePositionMayLag?: boolean;
}

export type CorrectionKind =
  | 'track'
  | 'seek'
  | 'snap'
  | 'slew'
  | 'pause'
  | 'play'
  | 'ended'
  | 'reject'
  | 'resume'
  | 'no-timeline'
  | 'hold';

export interface CorrectionEvent {
  at: number;
  kind: CorrectionKind;
  /** Observation minus prediction at the observation's sample time. */
  errorMs?: number;
  positionMs: number;
  reason?: string;
}

export type SyncQuality = 'locked' | 'tracking' | 'estimating' | 'unavailable';

export interface SyncStats {
  accepted: number;
  rejected: number;
  duplicates: number;
  snaps: number;
  slews: number;
  seeks: number;
  /** Paused-position reports that were held back (see pauseSettleMs). */
  holds: number;
  /** Consistency of successive observations vs. extrapolation while playing (no seeks). */
  meanAbsErrorMs: number | null;
  p95AbsErrorMs: number | null;
  maxAbsErrorMs: number | null;
  samples: number;
}

export interface SyncSnapshot {
  trackKey: string | null;
  generation: number;
  source: PlaybackSourceKind | null;
  playing: boolean;
  rate: number;
  positionMs: number;
  rawPositionMs: number;
  residualMs: number;
  lastObservedPositionMs: number | null;
  observationAgeMs: number | null;
  lastLatencyMs: number | null;
  durationMs?: number;
  quality: SyncQuality;
  qualityReason: string;
  stats: SyncStats;
}

export interface Clock {
  now(): number;
}

export interface SyncEngineOptions {
  clock: Clock;
  snapThresholdMs?: number;
  seekThresholdMs?: number;
  deadbandMs?: number;
  minTauMs?: number;
  /** Observations stamped further than this in the future are clamped to now. */
  futureToleranceMs?: number;
  /** For 'system' sources: age after which quality degrades to 'estimating'. */
  systemFreshMs?: number;
  /** Max number of correction events retained. */
  historySize?: number;
  /**
   * System players only: for this long after a pause, a paused-position report that
   * differs from the frozen estimate by at most pauseSettleMaxMs is not applied.
   * Measured with Spotify (Windows media session): the report sent at pause was
   * 318-363 ms behind, while the report sent at resume agreed with the frozen
   * estimate within 22 ms, so applying it only made the lyrics jump back and forth.
   */
  pauseSettleMs?: number;
  pauseSettleMaxMs?: number;
}

interface Anchor {
  positionMs: number;
  at: number;
  rate: number;
  playing: boolean;
}

const ERR_WINDOW = 120;
/** How long a lagging "playing" report waits for a pause before it is applied. */
const DEFER_MS = 200;
/** Backward errors smaller than this are ordinary jitter and are never deferred. */
const LAG_MIN_MS = 60;

export class SyncEngine {
  private readonly clock: Clock;
  private readonly snapThreshold: number;
  private readonly seekThreshold: number;
  private readonly deadband: number;
  private readonly minTau: number;
  private readonly futureTolerance: number;
  private readonly systemFresh: number;
  private readonly historySize: number;
  private readonly pauseSettle: number;
  private readonly pauseSettleMax: number;
  private pausedAt = -Infinity;
  private available = true;
  private pendingSeekAt = -Infinity;
  /** The lagging paused position a player reported, kept for diagnostics while the estimate is held. */
  private heldPause: { positionMs: number; rate: number } | null = null;
  /**
   * A "behind" report from a player whose pause reports lag (Spotify) is held back
   * briefly: on Windows the lagging position can arrive as a playing report a few ms
   * before the pause itself. If the pause follows, the estimate is kept; otherwise the
   * correction is applied after DEFER_MS.
   */
  private deferred: { positionMs: number; sampledAt: number; rate: number; at: number; err: number } | null = null;

  private trackKey: string | null = null;
  private generation = 0;
  private source: PlaybackSourceKind | null = null;
  private epoch = 0;
  private lastSeq = -Infinity;
  private trackStartedAt = -Infinity;
  private durationMs: number | undefined;
  private timelineAvailable = true;

  private anchor: Anchor = { positionMs: 0, at: 0, rate: 1, playing: false };
  private residual = 0;
  private residualAt = 0;
  private tau = 250;

  private last: { positionMs: number; sampledAt: number; receivedAt: number; provisional?: boolean } | null = null;
  private resumedAt = -Infinity;
  private consistentAt = -Infinity;

  private errors: number[] = [];
  private stats = { accepted: 0, rejected: 0, duplicates: 0, snaps: 0, slews: 0, seeks: 0, holds: 0 };
  private history: CorrectionEvent[] = [];
  private listeners = new Set<(e: CorrectionEvent) => void>();

  constructor(opts: SyncEngineOptions) {
    this.clock = opts.clock;
    this.snapThreshold = opts.snapThresholdMs ?? 250;
    this.seekThreshold = opts.seekThresholdMs ?? 1200;
    this.deadband = opts.deadbandMs ?? 4;
    this.minTau = opts.minTauMs ?? 240;
    this.futureTolerance = opts.futureToleranceMs ?? 40;
    this.systemFresh = opts.systemFreshMs ?? 6000;
    this.historySize = opts.historySize ?? 64;
    this.pauseSettle = opts.pauseSettleMs ?? 1500;
    this.pauseSettleMax = opts.pauseSettleMaxMs ?? 700;
  }

  onCorrection(cb: (e: CorrectionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get currentTrack(): string | null {
    return this.trackKey;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get corrections(): readonly CorrectionEvent[] {
    return this.history;
  }

  /** Forget everything (e.g. switching playback adapter). */
  reset(): void {
    this.trackKey = null;
    this.source = null;
    this.generation++;
    this.lastSeq = -Infinity;
    this.last = null;
    this.anchor = { positionMs: 0, at: this.clock.now(), rate: 1, playing: false };
    this.residual = 0;
    this.errors = [];
    this.timelineAvailable = true;
    this.durationMs = undefined;
    this.available = true;
    this.pendingSeekAt = -Infinity;
    this.heldPause = null;
    this.deferred = null;
    this.pausedAt = -Infinity;
    this.resumedAt = -Infinity;
    this.consistentAt = -Infinity;
  }

  /** Called when the OS resumes from sleep / the window becomes visible after a long time. */
  notifyResume(): void {
    const now = this.clock.now();
    this.resumedAt = now;
    this.residual = 0;
    this.emit({ at: now, kind: 'resume', positionMs: this.position(now), reason: 'host resumed; awaiting fresh observation' });
  }

  /** Raw extrapolation from the anchor, without smoothing. */
  private raw(now: number): number {
    const a = this.anchor;
    return a.playing ? a.positionMs + (now - a.at) * a.rate : a.positionMs;
  }

  private residualAtTime(now: number): number {
    if (this.residual === 0) return 0;
    const dt = now - this.residualAt;
    if (dt <= 0) return this.residual;
    const r = this.residual * Math.exp(-dt / this.tau);
    return Math.abs(r) < 0.05 ? 0 : r;
  }

  /** Displayed (smoothed) media position at monotonic time `now`. */
  position(now = this.clock.now()): number {
    // No pause followed the lagging report: apply it now, as it would have been.
    if (this.deferred && now - this.deferred.at >= DEFER_MS) {
      const d = this.deferred;
      this.deferred = null;
      if (this.anchor.playing) this.correct(d.positionMs, d.sampledAt, d.rate, now, d.err, false);
    }
    let p = this.raw(now) - (this.anchor.playing ? this.residualAtTime(now) : 0);
    if (p < 0) p = 0;
    if (this.durationMs !== undefined && this.durationMs > 0 && p > this.durationMs) p = this.durationMs;
    return p;
  }

  isPlaying(): boolean {
    return this.anchor.playing;
  }

  ingest(obs: Observation): { accepted: boolean; kind?: CorrectionKind; reason?: string } {
    const now = obs.receivedAt ?? this.clock.now();
    let sampledAt = obs.sampledAt;
    if (!Number.isFinite(sampledAt)) sampledAt = now;
    if (sampledAt > now + this.futureTolerance) sampledAt = now; // clock skew: never extrapolate backwards
    const rate = obs.rate && obs.rate > 0 && obs.rate < 8 ? obs.rate : 1;
    const timeline = obs.timeline !== false;
    if (obs.available === false) {
      const pos = this.position(now);
      this.heldPause = null;
      this.setAnchor(pos, now, now, rate, false);
      this.available = false;
      this.emit({ at: now, kind: 'hold', positionMs: pos, reason: 'playback connection unavailable' });
      return { accepted: true, kind: 'hold' };
    }
    const reconnecting = !this.available;
    this.available = true;

    // ---- Track identity -------------------------------------------------
    if (obs.trackKey !== this.trackKey) {
      if (this.trackKey !== null && sampledAt < this.trackStartedAt && obs.cause !== 'track') {
        return this.reject(now, obs, 'stale observation for a previous track');
      }
      this.trackKey = obs.trackKey;
      this.generation++;
      this.source = obs.source;
      this.epoch = obs.epoch ?? 0;
      this.lastSeq = obs.seq;
      this.trackStartedAt = sampledAt;
      this.durationMs = obs.durationMs;
      this.timelineAvailable = timeline;
      this.errors = [];
      this.consistentAt = -Infinity;
      this.pendingSeekAt = -Infinity;
      this.heldPause = null;
      this.setAnchor(timeline ? obs.positionMs : 0, sampledAt, now, rate, obs.playing && timeline);
      this.last = { positionMs: obs.positionMs, sampledAt, receivedAt: now, provisional: obs.provisional };
      this.stats.accepted++;
      this.emit({ at: now, kind: timeline ? 'track' : 'no-timeline', positionMs: this.position(now), reason: obs.trackKey });
      return { accepted: true, kind: 'track' };
    }

    // ---- Ordering ------------------------------------------------------
    const sameStream = obs.source === this.source && (obs.epoch ?? 0) === this.epoch;
    if (sameStream && obs.seq <= this.lastSeq) return this.reject(now, obs, `out-of-order seq ${obs.seq} <= ${this.lastSeq}`);
    if (!sameStream) {
      this.source = obs.source;
      this.epoch = obs.epoch ?? 0;
    }
    if (reconnecting || !sameStream) {
      this.last = null;
      this.pendingSeekAt = -Infinity;
      this.heldPause = null;
    }
    this.lastSeq = obs.seq;
    if (obs.durationMs !== undefined && obs.durationMs > 0) this.durationMs = obs.durationMs;

    if (!timeline) {
      this.timelineAvailable = false;
      this.anchor = { positionMs: this.position(now), at: now, rate, playing: false };
      this.residual = 0;
      this.last = null;
      this.stats.accepted++;
      return { accepted: true, kind: 'no-timeline' };
    }
    this.timelineAvailable = true;

    const last = this.last;
    // A provisional track-start estimate may accept an earlier real sample;
    // an optimistic seek must not accept the timeline from before the command.
    if (now - this.pendingSeekAt < 2500 && obs.cause !== 'seek' && sampledAt < this.pendingSeekAt - 40) {
      return this.reject(now, obs, 'pre-seek timeline while awaiting confirmation');
    }
    if (obs.cause === 'seek' && obs.provisional) this.pendingSeekAt = now;
    else if (!obs.provisional && sampledAt >= this.pendingSeekAt - 40) this.pendingSeekAt = -Infinity;
    if (last && !last.provisional && sampledAt < last.sampledAt - 0.5) {
      if (obs.playing !== this.anchor.playing && obs.cause === 'state') {
        const pos = this.position(now);
        this.heldPause = null;
        this.setAnchor(pos, now, now, rate, obs.playing);
        if (!obs.playing) this.pausedAt = now;
        return { accepted: true, kind: obs.playing ? 'play' : 'pause' };
      }
      return this.reject(now, obs, `sample time ${(last.sampledAt - sampledAt).toFixed(0)}ms older than accepted`);
    }
    const timelineFresh =
      !last || last.provisional === true || sampledAt > last.sampledAt + 0.5 || Math.abs(obs.positionMs - last.positionMs) > 0.5;
    const wasPlaying = this.anchor.playing;
    const stateChanged = wasPlaying !== obs.playing || Math.abs(rate - this.anchor.rate) > 1e-6;

    if (obs.cause === 'ended') {
      const pos = timelineFresh ? obs.positionMs : this.position(now);
      this.setAnchor(pos, now, now, rate, false);
      this.last = { positionMs: obs.positionMs, sampledAt, receivedAt: now };
      this.stats.accepted++;
      this.emit({ at: now, kind: 'ended', positionMs: pos });
      return { accepted: true, kind: 'ended' };
    }

    if (!timelineFresh) {
      if (!stateChanged) {
        this.stats.duplicates++;
        return { accepted: false, reason: 'duplicate' };
      }
      // State-only change: freeze/start at the current estimate.
      const pos = this.position(now);
      const lagging = !obs.playing ? this.deferred : null;
      this.deferred = null;
      this.setAnchor(pos, now, now, rate, obs.playing);
      if (!obs.playing) this.pausedAt = now;
      this.stats.accepted++;
      const kind: CorrectionKind = obs.playing ? 'play' : 'pause';
      if (lagging) {
        // The "behind" report just before this pause was the player's lagging pause position.
        this.heldPause = { positionMs: lagging.positionMs, rate };
        this.stats.holds++;
        this.emit({ at: now, kind, errorMs: lagging.err, positionMs: pos, reason: `kept estimate; report before pause was ${lagging.err.toFixed(0)} ms behind` });
      } else this.emit({ at: now, kind, positionMs: pos, reason: 'state change, timeline unchanged' });
      return { accepted: true, kind };
    }

    // Fresh timeline information.
    const predictedAtSample = wasPlaying ? this.anchor.positionMs + (sampledAt - this.anchor.at) * this.anchor.rate : this.anchor.positionMs;
    const err = obs.positionMs - predictedAtSample;
    const absErr = Math.abs(err);
    const wasProvisional = last?.provisional === true;
    this.last = { positionMs: obs.positionMs, sampledAt, receivedAt: now, provisional: obs.provisional };
    this.stats.accepted++;

    const isSeek = obs.cause === 'seek' || absErr >= this.seekThreshold;

    if (isSeek) {
      this.stats.seeks++;
      this.setAnchor(obs.positionMs, sampledAt, now, rate, obs.playing);
      this.emit({ at: now, kind: 'seek', errorMs: err, positionMs: this.position(now) });
      return { accepted: true, kind: 'seek' };
    }

    if (stateChanged) {
      if (wasPlaying && !obs.playing && this.settles(obs, absErr)) {
        // Pause reported together with a position slightly behind our estimate: freeze here.
        const pos = this.position(now);
        this.setAnchor(pos, now, now, rate, false);
        this.pausedAt = now;
        this.heldPause = { positionMs: obs.positionMs, rate };
        this.stats.holds++;
        this.emit({ at: now, kind: 'pause', errorMs: err, positionMs: pos, reason: `kept estimate; paused report differs by ${err.toFixed(0)} ms` });
        return { accepted: true, kind: 'pause' };
      }
      this.setAnchor(obs.positionMs, sampledAt, now, rate, obs.playing);
      if (!obs.playing) this.pausedAt = now;
      const kind: CorrectionKind = obs.playing ? 'play' : 'pause';
      this.emit({ at: now, kind, errorMs: err, positionMs: this.position(now) });
      return { accepted: true, kind };
    }

    if (!obs.playing) {
      // A lagging paused report right after the pause, or the same lagging position
      // sent again later, keeps the frozen estimate. Measured with Spotify: its report
      // on resume agrees with the estimate (23-42 ms), not with the lagging one.
      const repeatOfHeld = this.heldPause !== null && Math.abs(this.heldPause.positionMs - obs.positionMs) <= 1;
      if (err < -1 && this.settles(obs, absErr) && (repeatOfHeld || (!this.heldPause && now - this.pausedAt <= this.pauseSettle))) {
        this.heldPause = { positionMs: obs.positionMs, rate };
        this.stats.holds++;
        this.emit({ at: now, kind: 'hold', errorMs: err, positionMs: this.anchor.positionMs, reason: 'lagging paused report; keeping frozen position' });
        return { accepted: true, kind: 'hold' };
      }
      // paused -> paused with a new position: a seek while paused (or a tiny correction).
      if (absErr > 1) {
        this.stats.seeks++;
        this.setAnchor(obs.positionMs, sampledAt, now, rate, false);
        this.emit({ at: now, kind: 'seek', errorMs: err, positionMs: obs.positionMs, reason: 'while paused' });
        return { accepted: true, kind: 'seek' };
      }
      return { accepted: true };
    }

    // playing -> playing. A clearly "behind" report from a player with lagging pause
    // reports may be the first half of a pause: wait briefly before applying it.
    if (!wasProvisional && err < -LAG_MIN_MS && this.settles(obs, absErr)) {
      this.deferred = { positionMs: obs.positionMs, sampledAt, rate, at: now, err };
      return { accepted: true, kind: 'hold', reason: 'behind report deferred briefly' };
    }
    this.deferred = null;
    return this.correct(obs.positionMs, sampledAt, rate, now, err, wasProvisional || obs.provisional === true);
  }

  /** Apply a playing-state measurement: snap for large errors, otherwise slew smoothly. */
  private correct(positionMs: number, sampledAt: number, rate: number, now: number, err: number, provisional: boolean): { accepted: boolean; kind?: CorrectionKind } {
    const absErr = Math.abs(err);
    // consistency sample (a provisional guess is not a measurement)
    if (!provisional) this.recordError(absErr);
    if (absErr <= 120) this.consistentAt = now;

    if (absErr >= this.snapThreshold || provisional) {
      this.stats.snaps++;
      this.setAnchor(positionMs, sampledAt, now, rate, true);
      this.emit({ at: now, kind: 'snap', errorMs: err, positionMs: this.position(now) });
      return { accepted: true, kind: 'snap' };
    }

    // Smooth correction: move the anchor, keep the displayed value continuous.
    const displayedBefore = this.position(now);
    this.anchor = { positionMs, at: sampledAt, rate, playing: true };
    const newRaw = this.raw(now);
    const r = newRaw - displayedBefore;
    if (Math.abs(r) > this.deadband) {
      this.residual = r;
      this.residualAt = now;
      this.tau = Math.max(this.minTau, Math.abs(r) * 1.6 / rate);
      this.stats.slews++;
      this.emit({ at: now, kind: 'slew', errorMs: err, positionMs: displayedBefore });
      return { accepted: true, kind: 'slew' };
    }
    this.residual = 0;
    return { accepted: true };
  }

  /** Whether a paused report is a small post-pause discrepancy (system players only). */
  private settles(obs: Observation, absErr: number): boolean {
    return obs.source === 'system' && obs.pausePositionMayLag === true && obs.cause !== 'seek' && !obs.provisional && absErr <= this.pauseSettleMax;
  }

  private setAnchor(positionMs: number, sampledAt: number, now: number, rate: number, playing: boolean): void {
    this.heldPause = null;
    this.deferred = null;
    // Re-express the anchor at `now` so later math never mixes clocks.
    const pos = playing ? positionMs + (now - sampledAt) * rate : positionMs;
    this.anchor = { positionMs: pos, at: now, rate, playing };
    this.residual = 0;
    this.residualAt = now;
  }

  private recordError(absErr: number): void {
    this.errors.push(absErr);
    if (this.errors.length > ERR_WINDOW) this.errors.shift();
  }

  private reject(now: number, obs: Observation, reason: string) {
    this.stats.rejected++;
    this.emit({ at: now, kind: 'reject', positionMs: obs.positionMs, reason });
    return { accepted: false, kind: 'reject' as const, reason };
  }

  private emit(e: CorrectionEvent): void {
    this.history.push(e);
    if (this.history.length > this.historySize) this.history.shift();
    for (const l of this.listeners) l(e);
  }

  snapshot(now = this.clock.now()): SyncSnapshot {
    const errs = [...this.errors].sort((a, b) => a - b);
    const mean = errs.length ? errs.reduce((s, x) => s + x, 0) / errs.length : null;
    const p95 = errs.length ? errs[Math.min(errs.length - 1, Math.floor(errs.length * 0.95))] : null;
    const age = this.last ? now - this.last.sampledAt : null;
    const latency = this.last ? this.last.receivedAt - this.last.sampledAt : null;
    const { quality, reason } = this.quality(now, age);
    return {
      trackKey: this.trackKey,
      generation: this.generation,
      source: this.source,
      playing: this.anchor.playing,
      rate: this.anchor.rate,
      positionMs: this.position(now),
      rawPositionMs: this.raw(now),
      residualMs: this.anchor.playing ? this.residualAtTime(now) : 0,
      lastObservedPositionMs: this.last?.positionMs ?? null,
      observationAgeMs: age,
      lastLatencyMs: latency,
      durationMs: this.durationMs,
      quality,
      qualityReason: reason,
      stats: {
        ...this.stats,
        meanAbsErrorMs: mean,
        p95AbsErrorMs: p95,
        maxAbsErrorMs: errs.length ? errs[errs.length - 1] : null,
        samples: errs.length,
      },
    };
  }

  private quality(now: number, age: number | null): { quality: SyncQuality; reason: string } {
    if (!this.available) return { quality: 'unavailable', reason: 'playback connection lost; position frozen' };
    if (this.trackKey === null || age === null) return { quality: 'unavailable', reason: 'no playback observed' };
    if (!this.timelineAvailable) return { quality: 'unavailable', reason: 'source reports no playback position' };
    const sinceResume = now - this.resumedAt;
    if (this.last && this.last.receivedAt < this.resumedAt) {
      return { quality: 'estimating', reason: 'resumed; waiting for a fresh observation' };
    }
    if (this.durationMs && this.anchor.playing && this.raw(now) > this.durationMs + 1500) {
      return { quality: 'estimating', reason: 'extrapolated past track end' };
    }
    if (this.source === 'local' || this.source === 'demo') {
      return age < 1500 || !this.anchor.playing
        ? { quality: 'locked', reason: 'sampled from the audio element clock' }
        : { quality: 'estimating', reason: 'audio clock not sampled recently' };
    }
    if (!this.anchor.playing) return { quality: 'tracking', reason: 'paused at reported position' };
    if (age < this.systemFresh) return { quality: 'tracking', reason: 'recent observation' };
    if (now - this.consistentAt < 60000 && sinceResume > 0) {
      return { quality: 'tracking', reason: 'extrapolating; last update agreed within 120 ms' };
    }
    return { quality: 'estimating', reason: `extrapolating from a ${(age / 1000).toFixed(0)} s old observation` };
  }
}

/** Monotonic clock backed by performance.now(). */
export const performanceClock: Clock = {
  now: () => performance.now(),
};

/** Manually advanced clock for tests and deterministic rendering. */
export class ManualClock implements Clock {
  constructor(public t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }
}
