import { CueIndex, type CueState } from '../core/lyrics/cues';
import type { LyricDocument } from '../core/lyrics/model';
import type { SyncEngine } from '../core/sync/SyncEngine';
import { beatAt } from './motion';
import type { Scene } from './scene';

export interface FrameInfo {
  now: number;
  mediaMs: number;
  lyricMs: number;
  playing: boolean;
  cue: CueState | null;
}

/**
 * Draw every Nth display frame. Fast displays (90 Hz and up) aim for about 60 fps,
 * battery saving for about 30 fps; whole divisors keep frames evenly spaced, so
 * 60/75 Hz displays draw every frame unless saving battery. 0 Hz = not measured yet.
 */
export function frameDivisorFor(refreshHz: number, batterySaving: boolean): number {
  if (!refreshHz) return 1;
  if (!batterySaving && refreshHz < 90) return 1;
  return Math.max(1, Math.round(refreshHz / (batterySaving ? 30 : 60)));
}

const EMPTY_CUE: CueState ={ t: 0, lineIndex: -1, inLine: false, lineProgress: 0, wordIndex: -1, arrivedCount: 0, nextIndex: -1, gap: null };

/**
 * Single requestAnimationFrame loop for the whole app. It runs only while playing or
 * while something needs to settle (seek, resize, theme change); when paused, the
 * scene is a pure function of the frozen position, so the loop stops entirely.
 * UI listeners (seek bar, clock, diagnostics) write to the DOM directly — React is
 * never re-rendered per frame.
 */
export class StageRuntime {
  private raf = 0;
  private running = false;
  private scene: Scene | null = null;
  private cues: CueIndex | null = null;
  private doc: LyricDocument | null = null;
  private offsetMs = 0;
  private beatEnabled = false;
  private keepAliveUntil = 0;
  private readonly listeners = new Set<(f: FrameInfo) => void>();
  /** For deterministic rendering (screenshots / motion preview). */
  private frozenMediaMs: number | null = null;
  last: FrameInfo = { now: 0, mediaMs: 0, lyricMs: 0, playing: false, cue: null };
  frameCount = 0;
  /**
   * Frame pacing. Positions come from the clock, never from frame counts, so drawing
   * fewer frames changes smoothness only, not timing. On fast displays (90 Hz and up)
   * every Nth display frame is drawn (about 60 fps); on battery, about 30 fps. Only
   * whole divisors are used, so frames stay evenly spaced (75 Hz stays 75 Hz).
   */
  private batterySaving = false;
  private divisor = 1;
  private tickIndex = 0;
  private lastTick = 0;
  private intervals: number[] = [];
  /** Measured display refresh rate (Hz), 0 until measured. */
  refreshHz = 0;
  /** Main-thread cost of recent scene.frame() calls (ms), for diagnostics. */
  private costs: number[] = [];

  frameCost(): { avg: number; p95: number; max: number; n: number } {
    const c = [...this.costs].sort((a, b) => a - b);
    if (!c.length) return { avg: 0, p95: 0, max: 0, n: 0 };
    return { avg: c.reduce((s, x) => s + x, 0) / c.length, p95: c[Math.floor(c.length * 0.95)], max: c[c.length - 1], n: c.length };
  }

  constructor(
    private readonly engine: SyncEngine,
    private readonly pull: (now: number) => void,
  ) {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.wake(500);
    });
  }

  setScene(scene: Scene | null): void {
    this.scene = scene;
    this.wake(600);
  }

  setDoc(doc: LyricDocument | null): void {
    this.doc = doc;
    this.cues = doc && doc.lines.length ? new CueIndex(doc) : null;
    this.wake(600);
  }

  setOffset(ms: number): void {
    this.offsetMs = ms;
    this.wake(300);
  }

  get offset(): number {
    return this.offsetMs;
  }

  setBeatEnabled(on: boolean): void {
    this.beatEnabled = on;
    this.wake(200);
  }

  /** Render at an exact media position, ignoring the playback clock (preview/export). */
  freezeAt(mediaMs: number | null): void {
    this.frozenMediaMs = mediaMs;
    this.wake(50);
  }

  subscribe(fn: (f: FrameInfo) => void): () => void {
    this.listeners.add(fn);
    this.wake(50);
    return () => this.listeners.delete(fn);
  }

  /** Keep the loop alive for at least `ms` (e.g. after a seek or a state change). */
  wake(ms = 400): void {
    const now = performance.now();
    this.keepAliveUntil = Math.max(this.keepAliveUntil, now + ms);
    if (!this.running) {
      this.running = true;
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  /** Render one frame synchronously (used by tests and the exporter). */
  renderNow(now = performance.now()): FrameInfo {
    return this.renderFrame(now);
  }

  /** Lower the frame rate (and, via CSS, heavy effects) while on battery power. */
  setBatterySaving(on: boolean): void {
    this.batterySaving = on;
    this.updateDivisor();
    this.wake(100);
  }

  /** Draw every Nth display frame: 1 = every frame. */
  get frameDivisor(): number {
    return this.divisor;
  }

  private updateDivisor(): void {
    this.divisor = frameDivisorFor(this.refreshHz, this.batterySaving);
  }

  private measure(now: number): void {
    if (this.lastTick > 0) {
      const dt = now - this.lastTick;
      if (dt > 2 && dt < 60) {
        this.intervals.push(dt);
        if (this.intervals.length > 90) this.intervals.shift();
        if (this.intervals.length >= 30 && this.intervals.length % 15 === 0) {
          const s = [...this.intervals].sort((a, b) => a - b);
          const hz = Math.round(1000 / s[s.length >> 1]);
          if (Math.abs(hz - this.refreshHz) >= 3) {
            this.refreshHz = hz;
            this.updateDivisor();
          }
        }
      }
    }
    this.lastTick = now;
  }

  private tick = (now: number): void => {
    this.measure(now);
    // Always draw the first frame after a wake-up; then every Nth.
    const drawn = this.divisor <= 1 || this.tickIndex++ % this.divisor === 0;
    if (drawn) this.renderFrame(now);
    const playing = this.engine.isPlaying() && this.frozenMediaMs === null;
    if ((playing || now < this.keepAliveUntil) && !document.hidden) {
      this.raf = requestAnimationFrame(this.tick);
    } else {
      if (!drawn) this.renderFrame(now); // the frame left on screen is always current
      this.running = false;
      this.lastTick = 0;
      this.tickIndex = 0;
    }
  };

  private renderFrame(now: number): FrameInfo {
    this.frameCount++;
    if (this.frozenMediaMs === null) this.pull(now);
    const mediaMs = this.frozenMediaMs ?? this.engine.position(now);
    const lyricMs = mediaMs - this.offsetMs;
    const cue = this.cues ? this.cues.cue(lyricMs) : this.doc ? { ...EMPTY_CUE, t: lyricMs } : null;
    const playing = this.frozenMediaMs === null ? this.engine.isPlaying() : true;
    const meta = this.doc?.meta;
    const b = this.beatEnabled ? beatAt(lyricMs, meta?.bpm, meta?.beatOffsetMs) : null;
    if (this.scene && cue) {
      try {
        const t0 = performance.now();
        this.scene.frame({ t: lyricMs, cue, playing, beat: b ? { env: b.env, index: b.index, phase: b.phase } : null });
        this.costs.push(performance.now() - t0);
        if (this.costs.length > 240) this.costs.shift();
      } catch (e) {
        console.error('[stage] frame failed', e);
      }
    }
    const info: FrameInfo = { now, mediaMs, lyricMs, playing, cue };
    this.last = info;
    for (const l of this.listeners) l(info);
    return info;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.running = false;
  }
}
