import type { Observation } from '../core/sync/SyncEngine';
import type { AdapterCapabilities, AdapterEvents, PlaybackAdapter, TrackInfo } from './adapters';

let epochCounter = 0;

/**
 * Local playback through an HTMLAudioElement (offline demo and local files).
 *
 * The element's currentTime is the authoritative clock. It is sampled once per
 * animation frame while playing (only when the value changed) and on every media
 * event. Buffering ('waiting') and seeking are reported as not-playing so the engine
 * never extrapolates through a stall.
 */
export class AudioElementAdapter implements PlaybackAdapter {
  readonly audio: HTMLAudioElement;
  private seq = 0;
  private readonly epoch = ++epochCounter;
  private lastRead = -1;
  private seeking = false;
  private stalled = false;
  private disposed = false;
  private readonly off: (() => void)[] = [];

  constructor(
    readonly kind: 'local' | 'demo',
    private readonly ev: AdapterEvents,
    private readonly track: TrackInfo,
    src: string,
    autoplay: boolean,
    audio?: HTMLAudioElement,
  ) {
    this.audio = audio ?? new Audio();
    this.audio.preload = 'auto';
    const on = (name: string, fn: () => void) => {
      this.audio.addEventListener(name, fn);
      this.off.push(() => this.audio.removeEventListener(name, fn));
    };
    on('loadedmetadata', () => {
      this.ev.status({ playing: this.isPlaying(), durationMs: this.durationMs() });
      this.emit('event');
    });
    on('playing', () => {
      this.stalled = false;
      this.emit('state');
      this.ev.status({ playing: true, durationMs: this.durationMs() });
    });
    on('pause', () => {
      this.emit('state');
      this.ev.status({ playing: false, durationMs: this.durationMs() });
    });
    on('waiting', () => {
      this.stalled = true;
      this.emit('state');
    });
    on('seeking', () => {
      this.seeking = true;
      this.emit('seek');
    });
    on('seeked', () => {
      this.seeking = false;
      this.emit('seek');
    });
    on('ratechange', () => this.emit('state'));
    on('ended', () => {
      this.emit('ended');
      this.ev.status({ playing: false, durationMs: this.durationMs() });
    });
    on('error', () => {
      const code = this.audio.error?.code;
      const msg =
        code === 4 ? 'This audio format is not supported.' : code === 2 ? 'A network or file error interrupted playback.' : 'The audio could not be played.';
      this.ev.status({ playing: false, message: msg });
    });

    this.ev.track(track);
    this.audio.src = src;
    this.emit('track');
    if (autoplay) this.play();
  }

  private durationMs(): number | undefined {
    const d = this.audio.duration;
    return Number.isFinite(d) && d > 0 ? d * 1000 : this.track.durationMs;
  }

  private isPlaying(): boolean {
    const a = this.audio;
    return !a.paused && !a.ended && !this.seeking && !this.stalled;
  }

  private emit(cause: Observation['cause'], now = performance.now()): void {
    if (this.disposed) return;
    const pos = this.audio.currentTime * 1000;
    this.lastRead = this.audio.currentTime;
    this.ev.observe({
      source: this.kind,
      epoch: this.epoch,
      seq: ++this.seq,
      trackKey: this.track.key,
      positionMs: Number.isFinite(pos) ? pos : 0,
      sampledAt: now,
      playing: cause === 'ended' ? false : this.isPlaying(),
      rate: this.audio.playbackRate || 1,
      durationMs: this.durationMs(),
      cause,
    });
  }

  pull(now: number): void {
    if (!this.isPlaying()) return;
    const ct = this.audio.currentTime;
    if (ct !== this.lastRead) this.emit('poll', now);
  }

  capabilities(): AdapterCapabilities {
    return { playPause: true, seek: true, nextPrev: false };
  }

  play(): void {
    this.audio.play().catch((e) => {
      if (String(e?.name) !== 'AbortError') this.ev.status({ playing: false, message: `Playback was blocked: ${e?.message ?? e}` });
    });
  }

  pause(): void {
    this.audio.pause();
  }

  toggle(): void {
    if (this.audio.paused || this.audio.ended) this.play();
    else this.pause();
  }

  seek(ms: number): void {
    const d = this.durationMs();
    const target = Math.max(0, d ? Math.min(ms, d - 50) : ms);
    this.audio.currentTime = target / 1000;
    // Report immediately so the stage jumps without waiting for 'seeking'.
    this.emit('seek');
  }

  dispose(): void {
    this.disposed = true;
    this.off.forEach((f) => f());
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }
}
