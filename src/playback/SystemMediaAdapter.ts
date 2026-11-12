import { recordingKey } from './identity';
import type { Observation } from '../core/sync/SyncEngine';
import { trackKeyOf } from '../core/themes/matcher';
import type { BridgeMessage, BridgeState } from '../shared/api';
import { native } from '../app/platform';
import type { AdapterCapabilities, AdapterEvents, PlaybackAdapter, TrackInfo } from './adapters';

export interface SystemInfo {
  bridge: 'starting' | 'on' | 'unavailable' | 'error' | 'off';
  message?: string;
  app?: string | null;
  sessions?: { app: string; status: string }[];
  status?: string;
  timelineAvailable?: boolean;
  lastCause?: string;
  /** Interval between the last two distinct timeline updates while playing (ms). */
  timelineIntervalMs?: number;
  /** How old LastUpdatedTime was when the last update reached the renderer. */
  lastAgeMs?: number;
  counts: Record<string, number>;
}

let epochCounter = 1000;

export function appDisplayName(app: string | null | undefined): string {
  if (!app) return 'Media app';
  const a = app.toLowerCase();
  if (a.includes('spotify')) return 'Spotify';
  if (a.includes('chrome')) return 'Chrome';
  if (a.includes('msedge') || a.includes('edge')) return 'Edge';
  if (a.includes('firefox')) return 'Firefox';
  if (a.includes('zune') || a.includes('media player')) return 'Media Player';
  if (a.includes('tidal')) return 'TIDAL';
  if (a.includes('apple') || a.includes('itunes')) return 'Apple Music';
  return app.replace(/\.exe$/i, '').split(/[!\\.]/).pop() || app;
}

/**
 * Follows a Windows media session (Spotify desktop by default) through the native
 * GSMTC bridge. Positions are converted with the session's LastUpdatedTime:
 *   sampledAt = performance.now() - (Date.now() - lastUpdatedWallMs)
 * so a timeline published long ago is extrapolated from when it was valid, and pipe
 * latency is included. If the player has not published a timeline for a new track
 * yet, a provisional "starts at 0 now" observation is used and replaced as soon as a
 * real one arrives.
 */
export class SystemMediaAdapter implements PlaybackAdapter {
  readonly kind = 'system' as const;
  private seq = 0;
  private epoch = ++epochCounter;
  private trackKey = '';
  private sampleTimes = new Map<number, number>();
  private pendingSeek: { id: number; at: number; target: number } | null = null;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;
  private commandId = 0;
  private disposed = false;
  private transitionTimeline: { position: number; wall: number } | null = null;
  private controls: BridgeState['controls'] = null;
  private artwork = new Map<string, string>();
  private lastDistinctTl: { pos: number; lu: number; recv: number } | null = null;
  private info: SystemInfo = { bridge: 'starting', counts: {} };
  private unsub: (() => void) | null = null;

  constructor(
    private readonly ev: AdapterEvents,
    private readonly onInfo: (i: SystemInfo) => void,
    private readonly preferredApp: string,
  ) {
    if (!native) {
      this.setInfo({ bridge: 'unavailable', message: 'System media sessions need the Windows desktop app.' });
      return;
    }
    this.unsub = native.onBridge((m) => this.handle(m));
    void native.bridgeStart(preferredApp).then((r) => {
      if (!this.disposed && !r.started) this.disconnect('unavailable', r.reason);
    });
  }

  private setInfo(p: Partial<SystemInfo>): void {
    this.info = { ...this.info, ...p };
    this.onInfo(this.info);
  }

  handle(msg: BridgeMessage): void {
    if (this.disposed) return;
    switch (msg.type) {
      case 'status':
        if (msg.available) this.setInfo({ bridge: 'on' });
        else this.disconnect('unavailable', msg.error);
        return;
      case 'bridge-unavailable':
        this.disconnect('unavailable', msg.reason);
        return;
      case 'bridge-exit':
        this.disconnect(msg.restarting ? 'starting' : 'error', msg.error ?? 'Media connection lost; reconnecting');
        return;
      case 'ack':
        if (this.pendingSeek?.id === msg.id && !msg.ok) {
          this.clearSeek();
          this.reconcile();
          this.ev.status({ playing: this.lastState?.status === 'playing', message: msg.error ?? 'Seek declined by player' });
        }
        return;
      case 'sessions':
        this.setInfo({ sessions: msg.sessions, app: msg.attached ?? null });
        return;
      case 'artwork': {
        if (!msg.base64 || !msg.mime) return;
        const key = JSON.stringify([msg.app, msg.artist, msg.title]);
        const url = `data:${msg.mime};base64,${msg.base64}`;
        this.artwork.set(key, url);
        if (this.artwork.size > 24) this.artwork.delete(this.artwork.keys().next().value!);
        if (key === this.artKey(this.lastState)) this.emitTrack(undefined, url);
        return;
      }
      case 'state':
        this.onState(msg);
        return;
      default:
        return;
    }
  }

  private lastState: BridgeState | null = null;

  private emittedDuration: number | undefined;

  /**
   * Song length from a state, unless that state's timeline still describes the
   * previous song (new title published first): then the length is not known yet.
   */
  private durationOf(st: BridgeState): number | undefined {
    const tt = this.transitionTimeline;
    if (tt && st.positionMs === tt.position && st.lastUpdatedWallMs === tt.wall) return undefined;
    return st.endMs !== undefined && st.endMs > (st.startMs ?? 0) ? st.endMs - (st.startMs ?? 0) : undefined;
  }

  private emitTrack(s?: BridgeState, artworkUrl?: string): void {
    const st = s ?? this.lastState;
    if (!st) return;
    const media = st.media ?? {};
    const app = appDisplayName(st.app);
    const genres = (media.genres ?? []).filter((g) => g && g.trim()).map((g) => ({ value: g, source: 'system-media' as const }));
    const dur = this.durationOf(st);
    this.emittedDuration = dur;
    const track: TrackInfo = {
      key: this.trackKey,
      themeKey: trackKeyOf(media.artist || media.albumArtist, media.title),
      title: media.title || undefined,
      artist: media.artist || media.albumArtist || undefined,
      album: media.album || undefined,
      durationMs: dur,
      source: 'system',
      sourceLabel: `${app} · Windows media session`,
      app: st.app ?? undefined,
      genres,
      artworkUrl: artworkUrl ?? this.artwork.get(this.artKey(st)),
    };
    this.ev.track(track);
  }

  private onState(s: BridgeState): void {
    const nowPerf = performance.now();
    const nowWall = Date.now();
    const previous = this.lastState;
    this.lastState = s;
    this.controls = s.controls ?? null;
    const counts = { ...this.info.counts, [s.cause]: (this.info.counts[s.cause] ?? 0) + 1 };

    if (!s.app || s.status === 'none') {
      const key = 'system:none';
      if (this.trackKey !== key) {
        this.trackKey = key;
        this.ev.track({ key, source: 'system', sourceLabel: 'Windows media session', genres: [] });
      }
      this.observe({ positionMs: 0, sampledAt: nowPerf, playing: false, cause: 'state', timeline: false });
      this.setInfo({ app: null, status: 'none', lastCause: s.cause, counts });
      this.ev.status({ playing: false, message: 'No media is playing. Start Spotify (or another player) to follow it.' });
      return;
    }

    const media = s.media ?? {};
    const key = media.title ? recordingKey(s.app, media.artist || media.albumArtist, media.title, media.album) : `system:${s.app}`;
    const playing = s.status === 'playing';
    const hasTl = !!s.timelineAvailable && s.positionMs !== undefined && s.lastUpdatedWallMs !== undefined;
    let trackChanged = false;
    if (key !== this.trackKey) {
      this.clearSeek();
      this.trackKey = key;
      this.lastDistinctTl = null;
      this.transitionTimeline = previous?.app && previous.positionMs === s.positionMs &&
        previous.lastUpdatedWallMs === s.lastUpdatedWallMs && (s.positionMs ?? 0) > 3000
        ? { position: s.positionMs!, wall: s.lastUpdatedWallMs! } : null;
      trackChanged = true;
      this.emitTrack(s);
    } else if (JSON.stringify(previous?.media) !== JSON.stringify(s.media) || this.durationOf(s) !== this.emittedDuration) this.emitTrack(s);

    let lastAgeMs: number | undefined;
    let timelineIntervalMs = this.info.timelineIntervalMs;
    if (hasTl) {
      const lu = s.lastUpdatedWallMs!;
      const pos = s.positionMs! - (s.startMs ?? 0);
      let age = nowWall - lu;
      if (age < -250 || !Number.isFinite(age)) age = 0; // clocks disagree: treat as fresh
      lastAgeMs = age;
      const staleForNewTrack = this.transitionTimeline?.position === s.positionMs && this.transitionTimeline?.wall === lu;
      if (staleForNewTrack) {
        // Timeline still describes the previous track: assume the new one starts now.
        if (trackChanged) this.observe({ positionMs: 0, sampledAt: nowPerf, playing, cause: 'track', provisional: true, durationMs: undefined });
      } else {
        this.transitionTimeline = null;
        let sampledAt = this.sampleTimes.get(lu);
        if (sampledAt === undefined) {
          sampledAt = nowPerf - Math.max(0, age);
          this.sampleTimes.set(lu, sampledAt);
          if (this.sampleTimes.size > 64) this.sampleTimes.delete(this.sampleTimes.keys().next().value!);
        }
        const distinct = !this.lastDistinctTl || this.lastDistinctTl.pos !== pos || this.lastDistinctTl.lu !== lu;
        if (distinct) {
          if (this.lastDistinctTl && playing) timelineIntervalMs = nowWall - this.lastDistinctTl.recv;
          this.lastDistinctTl = { pos, lu, recv: nowWall };
        }
        const dur = s.endMs !== undefined && s.endMs > (s.startMs ?? 0) ? s.endMs - (s.startMs ?? 0) : undefined;
        // Ignore cached reports from before the seek, even if they arrive later.
        if (this.pendingSeek) {
          const expected = this.pendingSeek.target + (playing ? (nowPerf - this.pendingSeek.at) * (s.rate ?? 1) : 0);
          const measured = pos + (playing ? Math.max(0, nowPerf - sampledAt) * (s.rate ?? 1) : 0);
          if (sampledAt < this.pendingSeek.at - 40 || Math.abs(measured - expected) > 1200) {
            // Position confirmation and playback state are independent. A pause
            // must still freeze an optimistic seek while its timeline is stale.
            if (playing !== (previous?.status === 'playing')) {
              const estimate = this.pendingSeek.target + (previous?.status === 'playing' ? nowPerf - this.pendingSeek.at : 0);
              this.observe({ positionMs: estimate, sampledAt: nowPerf, playing, cause: 'state', provisional: true });
              this.ev.status({ playing });
            }
            return;
          }
        }
        const confirmedSeek = this.pendingSeek !== null;
        if (confirmedSeek) this.clearSeek();
        this.observe({
          positionMs: pos,
          sampledAt,
          playing,
          rate: s.rate ?? 1,
          durationMs: dur,
          cause: confirmedSeek ? 'seek' : trackChanged ? 'track' : s.cause === 'playback' ? 'state' : s.cause === 'poll' ? 'poll' : 'event',
        });
      }
    } else {
      this.observe({ positionMs: 0, sampledAt: nowPerf, playing, cause: trackChanged ? 'track' : 'state', timeline: false });
    }

    this.setInfo({
      bridge: 'on',
      app: s.app,
      status: s.status,
      timelineAvailable: hasTl,
      lastCause: s.cause,
      lastAgeMs,
      timelineIntervalMs,
      counts,
    });
    this.ev.status({ playing, durationMs: this.durationOf(s) });
  }

  private observe(o: Partial<Observation> & { positionMs: number; sampledAt: number; playing: boolean; cause: Observation['cause'] }): void {
    this.ev.observe({ source: 'system', pausePositionMayLag: !!this.lastState?.app?.toLowerCase().includes('spotify'), epoch: this.epoch, seq: ++this.seq, trackKey: this.trackKey, receivedAt: performance.now(), ...o });
  }

  capabilities(): AdapterCapabilities {
    const c = this.controls;
    return {
      playPause: !!c && (c.toggle || c.play || c.pause),
      seek: !!c?.seek,
      nextPrev: !!c && (c.next || c.prev),
    };
  }

  play(): void {
    void native?.bridgeCommand({ cmd: 'play' });
  }
  pause(): void {
    void native?.bridgeCommand({ cmd: 'pause' });
  }
  toggle(): void {
    void native?.bridgeCommand({ cmd: 'toggle' });
  }
  seek(ms: number): void {
    if (!this.controls?.seek) return;
    this.clearSeek();
    const target = Math.max(0, ms);
    const id = ++this.commandId;
    this.pendingSeek = { id, at: performance.now(), target };
    void native?.bridgeCommand({ cmd: 'seek', positionMs: target, id });
    this.observe({ positionMs: target, sampledAt: performance.now(), playing: this.lastState?.status === 'playing', cause: 'seek', provisional: true });
    this.seekTimer = setTimeout(() => {
      this.clearSeek();
      this.reconcile();
      this.refresh();
      this.ev.status({ playing: this.lastState?.status === 'playing', message: 'Seek was not confirmed; using the player position' });
    }, 2500);
  }

  private artKey(s: BridgeState | null): string {
    return JSON.stringify([s?.app, s?.media?.artist, s?.media?.title]);
  }

  private clearSeek(): void {
    this.pendingSeek = null;
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.seekTimer = null;
  }

  private reconcile(): void {
    const s = this.lastState;
    if (!s || s.positionMs === undefined) return;
    const playing = s.status === 'playing';
    const age = Math.max(0, Date.now() - (s.lastUpdatedWallMs ?? Date.now()));
    this.observe({ positionMs: s.positionMs - (s.startMs ?? 0) + (playing ? age * (s.rate ?? 1) : 0), sampledAt: performance.now(), playing, cause: 'seek' });
  }

  private disconnect(bridge: SystemInfo['bridge'], message?: string): void {
    this.clearSeek();
    this.controls = null;
    this.observe({ positionMs: 0, sampledAt: performance.now(), playing: false, cause: 'state', available: false });
    this.ev.status({ playing: false, message });
    this.epoch = ++epochCounter;
    this.sampleTimes.clear();
    this.lastState = null;
    this.transitionTimeline = null;
    this.setInfo({ bridge, message });
  }

  next(): void {
    void native?.bridgeCommand({ cmd: 'next' });
  }
  prev(): void {
    void native?.bridgeCommand({ cmd: 'prev' });
  }
  refresh(): void {
    void native?.bridgeCommand({ cmd: 'refresh' });
  }
  dispose(): void {
    this.disposed = true;
    this.clearSeek();
    this.unsub?.();
    void native?.bridgeStop();
  }
}
