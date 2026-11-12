import { recordingKey } from '../playback/identity';
import { analyzeLyrics } from '../core/lyrics/analysis';
import type { LyricDocument } from '../core/lyrics/model';
import { parseLyrics } from '../core/lyrics/parse';
import { toLrc } from '../core/lyrics/lrc';
import { LatestRequest } from '../core/latest';
import { DEFAULT_SETTINGS, type Settings, sanitizeSettings } from '../core/settings/schema';
import { type Observation, SyncEngine, performanceClock } from '../core/sync/SyncEngine';
import { type OffsetSuggestion, applyGlobalSuggestion, offsetToAlign, suggestGlobalOffset, totalOffsetMs } from '../core/sync/timing';
import { type GenreSignal, type ThemeId, artistKeyOf, decideTheme, trackKeyOf } from '../core/themes/matcher';
import { artistGenre, catalogLengthGap, matchCatalog } from '../core/lyrics/catalog';
import { addLengthSample, playerKey } from '../core/lyrics/length';
import { type LyricsDeps, type LyricsResult, docFromLrclib, resolveLyrics, trackQuery } from '../lyrics/LyricsResolver';
import type { AdapterEvents, DemoTrack, PlaybackAdapter, TrackInfo } from '../playback/adapters';
import { AudioElementAdapter } from '../playback/AudioElementAdapter';
import { SystemMediaAdapter } from '../playback/SystemMediaAdapter';
import type { LocalTrackInfo, LrclibRecord } from '../shared/api';
import { StageRuntime } from '../stage/runtime';
import { extractPalette } from '../stage/textures';
import { appInfo, loadSettingsRaw, native, openAudio, openLyrics, prefersReducedMotion, saveSettingsRaw } from './platform';
import { buildReport } from './report';
import { getApp, setApp, setUi, toast } from './store';

const THEME_DECISION_WAIT_MS = 2500;
/**
 * At a song change a media session can publish the new title before the new song's
 * timeline; the lyric search waits this long for the real length before going without.
 */
const LENGTH_WAIT_MS = 1500;

class AppController {
  readonly engine = new SyncEngine({ clock: performanceClock });
  readonly runtime: StageRuntime;
  private adapter: PlaybackAdapter | null = null;
  private readonly lyricsReq = new LatestRequest<string>();
  private cancelToken = { cancelled: false };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private themeTimer: ReturnType<typeof setTimeout> | null = null;
  private lengthTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionTrackOffset = new Map<string, number>();
  private rawDoc: LyricDocument | null = null;
  private lastPlaying = false;

  constructor() {
    this.runtime = new StageRuntime(this.engine, (now) => this.adapter?.pull?.(now));
  }

  // ------------------------------------------------------------------ init
  async init(): Promise<void> {
    const [info, raw] = await Promise.all([appInfo(), loadSettingsRaw()]);
    const settings = sanitizeSettings(raw);
    let demos: DemoTrack[] = [];
    try {
      const m = await fetch('demo/manifest.json').then((r) => r.json());
      demos = m.tracks;
    } catch {
      demos = [];
    }
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    mq.addEventListener('change', () => setApp({ reducedMotionSystem: mq.matches }));
    setApp({ info, settings, demos, reducedMotionSystem: prefersReducedMotion(), ready: true, ui: { ...getApp().ui, diagnostics: settings.diagnostics } });
    this.applyTiming();
    this.runtime.setBeatEnabled(settings.motion.beatPulse);

    if (native) setApp({ onBattery: await native.onBattery().catch(() => false) });
    this.applyPowerSaving();
    native?.onPower((ev) => {
      if (ev === 'on-battery' || ev === 'on-ac') {
        setApp({ onBattery: ev === 'on-battery' });
        this.applyPowerSaving();
        this.log(`power: ${ev === 'on-battery' ? 'on battery' : 'plugged in'}`);
        return;
      }
      if (ev === 'resume' || ev === 'unlock-screen') {
        this.engine.notifyResume();
        if (this.adapter instanceof SystemMediaAdapter) this.adapter.refresh();
        this.runtime.wake(1000);
      }
    });
    native?.onFullscreen((on) => setUi({ fullscreen: on }));
    if (native) setUi({ fullscreen: await native.isFullscreen() });

    setInterval(() => this.pollSync(), 400);
    this.startLogging();
    // People who already follow their player have answered the welcome question.
    if (!settings.firstRunDone && settings.sources.followSystemMedia) this.updateSettings((s) => ({ ...s, firstRunDone: true }));

    const params = new URLSearchParams(location.search);
    const demoParam = params.get('demo');
    if (settings.sources.followSystemMedia && native && !demoParam) this.followSystem(true);
    else if (demos.length) await this.playDemo(demoParam ?? demos[0].id, params.has('autoplay'));
  }

  // ------------------------------------------------------------------ first run
  /** The welcome is shown once, on Windows, to people who have not chosen a source yet. */
  shouldWelcome(): boolean {
    const s = getApp();
    return !!native && s.ready && s.info?.platform === 'win32' && !s.settings.firstRunDone && !s.settings.sources.followSystemMedia && s.source !== 'system';
  }

  /** One click: follow Spotify (or whatever plays), with online lyrics as chosen. */
  finishWelcome(choice: 'follow' | 'demo', onlineLyrics: boolean): void {
    this.updateSettings((s) => ({
      ...s,
      firstRunDone: true,
      sources: { ...s.sources, onlineLyrics: choice === 'follow' ? onlineLyrics : s.sources.onlineLyrics },
    }));
    this.log(`welcome: ${choice}${choice === 'follow' ? `, online lyrics ${onlineLyrics ? 'on' : 'off'}` : ''}`);
    if (choice === 'follow') this.followSystem(true);
  }

  // ------------------------------------------------------------------ log & report
  /** One line in the local log file (desktop app only). */
  log(text: string): void {
    void native?.log(text).catch(() => undefined);
  }

  private startLogging(): void {
    if (!native) return;
    let lastQuality = '';
    const lastKind = new Map<string, number>();
    this.engine.onCorrection((e) => {
      if (e.kind === 'slew') return;
      const at = lastKind.get(e.kind) ?? -Infinity;
      if (e.at - at < 2000) return;
      lastKind.set(e.kind, e.at);
      this.log(`sync ${e.kind}${e.errorMs !== undefined ? ` ${e.errorMs.toFixed(0)} ms` : ''} at ${e.positionMs.toFixed(0)} ms${e.reason ? ` (${e.reason.slice(0, 160)})` : ''}`);
    });
    setInterval(() => {
      const q = getApp().sync;
      const sig = `${q.quality}|${q.reason}`;
      if (sig !== lastQuality && !/extrapolating/.test(q.reason)) {
        lastQuality = sig;
        this.log(`timing ${q.quality}: ${q.reason}`);
      }
    }, 2000);
    window.addEventListener('error', (e) => this.log(`error ${e.message} ${e.filename ?? ''}:${e.lineno ?? ''}`));
    window.addEventListener('unhandledrejection', (e) => this.log(`unhandled ${String((e as PromiseRejectionEvent).reason).slice(0, 300)}`));
  }

  private logLyrics(t: TrackInfo, res: LyricsResult): void {
    const d = res.doc;
    const len = res.length;
    this.log(
      `lyrics "${t.title ?? '-'}": ${res.status}${d ? ` · ${d.source.label} · ${d.timing} timing · ${d.source.match ?? ''}` : ''}` +
        `${d?.source.note ? ` · ${d.source.note}` : ''}` +
        `${len?.reportedSec ? ` · length player ${len.reportedSec.toFixed(1)} s used ${len.usedSec?.toFixed(1) ?? 'range'}${len.measuredGapSec !== undefined ? ` gap ${len.measuredGapSec.toFixed(1)}` : ''}` : ''}` +
        ` · ${res.tried.map((x) => `${x.source}=${x.outcome}`).join('; ').slice(0, 300)}`,
    );
  }

  async diagnosticsReport(): Promise<string> {
    const s = getApp();
    return buildReport({
      now: new Date(),
      info: s.info,
      settings: s.settings,
      source: s.source,
      track: s.track,
      lyrics: s.lyrics,
      themeId: s.theme.activeId,
      themeLabel: s.theme.decision?.label,
      offsetMs: this.currentOffset(),
      sync: this.engine.snapshot(),
      corrections: this.engine.corrections,
      system: s.system,
      frameCost: this.runtime.frameCost(),
      logTail: native ? await native.readLog(120).catch(() => []) : [],
    });
  }

  async copyDiagnostics(): Promise<void> {
    const text = await this.diagnosticsReport();
    const ok = native ? await native.copyText(text).catch(() => false) : await navigator.clipboard.writeText(text).then(() => true, () => false);
    toast(ok ? 'Diagnostics report copied. Paste it into a message to share it.' : 'Could not copy the report.', ok ? 'info' : 'warn', 4200);
  }

  openLogFolder(): void {
    void native?.openLogFolder();
  }

  // ------------------------------------------------------------------ settings
  updateSettings(fn: (s: Settings) => Settings): void {
    const next = sanitizeSettings(fn(structuredClone(getApp().settings)));
    setApp({ settings: next });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void saveSettingsRaw(next), 250);
    this.applyTiming();
    this.runtime.setBeatEnabled(next.motion.beatPulse);
    this.applyPowerSaving();
    this.runtime.wake(400);
  }

  /** Battery saver is active: on battery and not turned off by the user. */
  batterySaving(): boolean {
    const s = getApp();
    return s.onBattery && s.settings.display.batterySaver;
  }

  private applyPowerSaving(): void {
    this.runtime.setBatterySaving(this.batterySaving());
  }

  resetSettings(): void {
    this.updateSettings(() => ({ ...DEFAULT_SETTINGS, firstRunDone: true }));
    toast('Settings reset to defaults');
  }

  // ------------------------------------------------------------------ playback sources
  private events(): AdapterEvents {
    return {
      observe: (o: Observation) => {
        const r = this.engine.ingest(o);
        if (r.kind && r.kind !== 'slew') this.runtime.wake(r.kind === 'pause' || r.kind === 'hold' ? 2000 : 900);
        const playing = this.engine.isPlaying();
        if (playing !== this.lastPlaying) {
          this.lastPlaying = playing;
          this.runtime.wake(900);
        }
      },
      track: (t: TrackInfo) => this.onTrack(t),
      status: (s) => {
        setApp((st) => ({
          playing: s.playing,
          durationMs: s.durationMs ?? st.durationMs,
          playbackMessage: s.message,
          caps: this.adapter?.capabilities() ?? st.caps,
        }));
        if (s.message && this.adapter?.kind !== 'system') toast(s.message, 'warn');
      },
    };
  }

  private setAdapter(a: PlaybackAdapter | null): void {
    this.adapter?.dispose();
    this.engine.reset();
    this.adapter = a;
    setApp({ caps: a?.capabilities() ?? { playPause: false, seek: false, nextPrev: false } });
  }

  async playDemo(id: string, autoplay = true): Promise<void> {
    const demo = getApp().demos.find((d) => d.id === id) ?? getApp().demos[0];
    if (!demo) return;
    this.stopSystemIfActive();
    const track: TrackInfo = {
      key: recordingKey('demo', demo.artist, demo.title, demo.album, demo.id),
      themeKey: trackKeyOf(demo.artist, demo.title),
      title: demo.title,
      artist: demo.artist,
      album: demo.album,
      durationMs: demo.durationMs,
      source: 'demo',
      sourceLabel: 'Offline demo',
      genres: [{ value: demo.genre, source: 'demo-manifest' }],
      artworkUrl: demo.artwork,
      demo,
    };
    setApp({ source: 'demo' });
    this.setAdapter(null);
    this.setAdapter(new AudioElementAdapter('demo', this.events(), track, demo.audio, autoplay));
  }

  async openLocal(info?: LocalTrackInfo | null): Promise<void> {
    const t = info ?? (await openAudio());
    if (!t) return;
    this.stopSystemIfActive();
    const title = t.title ?? t.fileName.replace(/\.[^.]+$/, '');
    const track: TrackInfo = {
      key: recordingKey('local', t.artist, title, t.album, t.path),
      themeKey: trackKeyOf(t.artist, t.title, t.fileName),
      title,
      artist: t.artist,
      album: t.album,
      durationMs: t.durationMs,
      source: 'local',
      sourceLabel: 'Local file',
      genres: t.genres.map((g) => ({ value: g, source: 'file-tag' as const })),
      artworkUrl: t.artworkDataUrl,
      local: t,
    };
    if (t.metadataError && native) toast(`Tags could not be read: ${t.metadataError}`, 'warn');
    setApp({ source: 'local' });
    this.setAdapter(new AudioElementAdapter('local', this.events(), track, t.url, true));
    if (native && t.path) {
      this.updateSettings((s) => ({
        ...s,
        recent: [{ path: t.path, title, artist: t.artist }, ...s.recent.filter((r) => r.path !== t.path)].slice(0, 8),
      }));
    }
  }

  async openRecent(path: string): Promise<void> {
    const info = await native?.openAudioPath(path);
    if (!info) {
      toast('That file is no longer available.', 'warn');
      this.updateSettings((s) => ({ ...s, recent: s.recent.filter((r) => r.path !== path) }));
      return;
    }
    await this.openLocal(info);
  }

  followSystem(on: boolean): void {
    this.updateSettings((s) => ({ ...s, sources: { ...s.sources, followSystemMedia: on } }));
    if (on) {
      setApp({ source: 'system', system: { bridge: 'starting', counts: {} } });
      this.setAdapter(
        new SystemMediaAdapter(this.events(), (i) => setApp({ system: i, caps: this.adapter?.capabilities() ?? getApp().caps }), getApp().settings.sources.preferredApp),
      );
    } else if (this.adapter instanceof SystemMediaAdapter) {
      this.setAdapter(null);
      setApp({ source: 'none', system: null, track: null, playing: false });
      this.applyLyrics({ status: 'idle', doc: null, tried: [] }, null);
    }
  }

  private stopSystemIfActive(): void {
    if (this.adapter instanceof SystemMediaAdapter) {
      this.updateSettings((s) => ({ ...s, sources: { ...s.sources, followSystemMedia: false } }));
      setApp({ system: null });
    }
  }

  // ------------------------------------------------------------------ transport
  togglePlay(): void {
    this.adapter?.toggle();
    this.runtime.wake(600);
  }
  seek(ms: number): void {
    if (!this.adapter?.capabilities().seek) {
      toast('This player does not allow seeking from Afterglow.', 'warn');
      return;
    }
    this.adapter.seek(Math.max(0, ms));
    this.runtime.wake(900);
  }
  seekBy(delta: number): void {
    this.seek(this.engine.position() + delta);
  }
  next(): void {
    this.adapter?.next?.();
  }
  prev(): void {
    this.adapter?.prev?.();
  }

  // ------------------------------------------------------------------ track & lyrics
  private onTrack(t: TrackInfo): void {
    const prev = getApp().track;
    const sameTrack = prev?.key === t.key;
    setApp({ track: t, durationMs: t.durationMs ?? 0 });
    if (t.artworkUrl !== prev?.artworkUrl || !sameTrack) void this.loadArtwork(t.artworkUrl);
    if (sameTrack) {
      if (!prev?.durationMs && t.durationMs) {
        // The length arrived: search now (or again, keeping what is shown meanwhile).
        const waiting = this.lengthTimer !== null;
        this.clearLengthWait();
        void this.loadLyricsFor(t, { quiet: !waiting });
      }
      return;
    }
    this.applyTiming();
    if (t.key !== 'system:none') this.log(`song ${t.source}${t.app ? ` ${t.app}` : ''}: "${t.title ?? '-'}" by ${t.artist ?? '-'} · ${t.album ?? '-'} · ${t.durationMs ? `${(t.durationMs / 1000).toFixed(1)} s` : 'length not yet known'}`);
    // Theme: decide now if metadata is decisive, else after lyrics (bounded wait).
    setApp((s) => ({ theme: { ...s.theme, locked: false, decision: null } }));
    if (this.themeTimer) clearTimeout(this.themeTimer);
    const early = this.decide(t, null);
    if (early.basis !== 'fallback' && early.basis !== 'suggested') this.lockTheme(early);
    else {
      this.themeTimer = setTimeout(() => {
        const cur = getApp().track;
        if (cur?.key === t.key && !getApp().theme.locked) this.lockTheme(this.decide(cur, getApp().analysis));
      }, THEME_DECISION_WAIT_MS);
      void this.lookupCatalog(t);
    }
    this.clearLengthWait();
    if (t.source === 'system' && t.title && !t.durationMs) {
      // Length matters for choosing the right lyrics; give the player a moment to publish it.
      this.applyLyrics({ status: 'loading', doc: null, tried: [] }, t.key);
      this.lengthTimer = setTimeout(() => {
        this.lengthTimer = null;
        const cur = getApp().track;
        if (cur?.key === t.key) void this.loadLyricsFor(cur);
      }, LENGTH_WAIT_MS);
    } else void this.loadLyricsFor(t);
  }

  private clearLengthWait(): void {
    if (this.lengthTimer) clearTimeout(this.lengthTimer);
    this.lengthTimer = null;
  }

  // ------------------------------------------------------------------ Apple catalogue
  /** Track whose catalogue lookup is still running (the theme choice waits for it, briefly). */
  private catalogPending: string | null = null;
  /** Genre stated by Apple's catalogue, per track key (recent tracks only). */
  private catalogGenres = new Map<string, GenreSignal>();

  /**
   * Genre (for the theme), length (as evidence for the length correction) and, when the
   * player shows none, artwork from Apple's public catalogue. Online consent required.
   */
  private async lookupCatalog(t: TrackInfo): Promise<void> {
    const s = getApp().settings;
    if (!native || !s.sources.onlineLyrics || !s.sources.providers.catalog || !t.title || t.demo || t.key === 'system:none') return;
    if (this.catalogGenres.has(t.key)) return;
    this.catalogPending = t.key;
    const res = await native.catalog({ artist: t.artist ?? '', title: t.title }).catch(() => null);
    if (this.catalogPending === t.key) this.catalogPending = null;
    const cur = getApp().track;
    if (cur?.key !== t.key) return;
    if (!res?.ok) {
      this.log(`catalogue "${t.title}": ${res ? res.error : 'unavailable'}`);
      this.maybeLockTheme();
      return;
    }
    const { q } = trackQuery(cur, getApp().settings);
    const m = matchCatalog(res.entries, q);
    const fromArtist = !m?.entry.genre && t.artist ? artistGenre(res.entries, t.artist) : undefined;
    const genre: GenreSignal | undefined = m?.entry.genre ? { value: m.entry.genre, source: 'catalog' } : fromArtist ? { value: fromArtist, source: 'catalog-artist' } : undefined;
    if (genre) {
      this.catalogGenres.set(t.key, genre);
      if (this.catalogGenres.size > 60) this.catalogGenres.delete(this.catalogGenres.keys().next().value!);
    }
    this.log(
      `catalogue "${t.title}": ${m ? `${m.entry.genre ?? 'no genre'} · ${m.albumMatch ? 'same album' : 'other release'} · ${m.entry.durationSec?.toFixed(1) ?? '-'} s · score ${m.score}` : `song not found${fromArtist ? `; artist's songs: ${fromArtist}` : ''}`}${res.cached ? ' (saved)' : ''}`,
    );
    const gap = q.lengthMayBeShort ? catalogLengthGap(m, q.reportedDurationSec) : undefined;
    if (gap !== undefined) this.recordLengthGap(cur, gap);
    this.maybeLockTheme();
    const art = m?.entry.artworkUrl;
    if (art && (m!.albumMatch || m!.score >= 90)) setTimeout(() => void this.catalogArtwork(t.key, art), 1500);
  }

  /** Lock the theme once nothing it waits for is pending (a stated genre decides at once). */
  private maybeLockTheme(): void {
    const t = getApp().track;
    if (!t || getApp().theme.locked || this.catalogPending === t.key) return;
    const d = this.decide(t, getApp().analysis);
    if (d.basis !== 'known-genre' && getApp().lyrics.status === 'loading') return;
    if (this.themeTimer) clearTimeout(this.themeTimer);
    this.lockTheme(d);
  }

  /** Catalogue artwork, only while the player still shows none for this song. */
  private async catalogArtwork(key: string, url: string): Promise<void> {
    const t = getApp().track;
    if (!native || t?.key !== key || t.artworkUrl) return;
    const data = await native.catalogArtwork(url).catch(() => null);
    if (!data || getApp().track?.key !== key || getApp().track?.artworkUrl) return;
    const palette = await extractPalette(data);
    if (getApp().track?.key === key && !getApp().track?.artworkUrl) setApp({ artwork: { url: data, palette } });
  }

  /** Current lyric time (ms): media position minus the timing offset. */
  private lyricTimeNow(): number {
    return this.engine.position() - this.runtime.offset;
  }

  /**
   * A saved copy already on screen is not swapped for a different document once its
   * first line has started; the newer copy is saved and used from the next play.
   */
  private mayReplace(res: LyricsResult, trackKey: string): boolean {
    const cur = getApp().lyrics;
    if (cur.trackKey !== trackKey || !cur.doc || cur.doc.source.kind !== 'cache') return true;
    if (!res.doc || res.doc === this.rawDoc) return true;
    const first = cur.doc.lines[0]?.startMs ?? Infinity;
    return this.lyricTimeNow() < first - 500;
  }

  private async loadArtwork(url?: string): Promise<void> {
    if (!url) {
      setApp({ artwork: null });
      return;
    }
    const palette = await extractPalette(url);
    if (getApp().track?.artworkUrl === url) setApp({ artwork: { url, palette } });
  }

  private deps(): LyricsDeps {
    return {
      readLyricFile: async (p) => (native ? native.readLyricFile(p) : null),
      findLyricsInFolder: async (f, a, ti) => (native ? native.findLyricsInFolder(f, a, ti) : null),
      lrclib: async (q) => (native ? native.lrclib(q) : { ok: false, error: 'Online lookup needs the desktop app.' }),
      lrclibById: async (id) => (native ? native.lrclibById(id) : { ok: false, error: 'Online lookup needs the desktop app.' }),
      amll: native ? (q) => native!.amll(q) : undefined,
      cacheGet: native ? (k) => native!.lyricsCacheGet(k) : undefined,
      cachePut: native ? (k, e) => native!.lyricsCachePut(k, e) : undefined,
      fetchText: async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      },
    };
  }

  /** Ignore the saved copy and query the online providers again. */
  searchAgain(): void {
    const t = getApp().track;
    if (!t) return;
    void native?.lyricsCacheRemove(t.key);
    void this.loadLyricsFor(t, { refresh: true });
  }

  async loadLyricsFor(t: TrackInfo, opts: { refresh?: boolean; quiet?: boolean } = {}): Promise<void> {
    const req = this.lyricsReq.begin(t.key);
    this.cancelToken.cancelled = true;
    const token = { cancelled: false };
    this.cancelToken = token;
    // A quiet reload (same song, better information) keeps the current lyrics on screen.
    const keep = opts.quiet && getApp().lyrics.trackKey === t.key && !!getApp().lyrics.doc;
    if (!keep) {
      setApp({ lyrics: { status: 'loading', doc: null, tried: [], trackKey: t.key } });
      this.applyLyrics({ status: 'loading', doc: null, tried: [] }, t.key);
    }
    if (t.key === 'system:none') {
      this.applyLyrics({ status: 'idle', doc: null, tried: [] }, t.key);
      return;
    }
    const publish = (res: LyricsResult) => {
      if (this.lyricsReq.isCurrent(req) && getApp().track?.key === t.key && !token.cancelled && this.mayReplace(res, t.key)) this.applyLyrics(res, t.key);
    };
    const res = await resolveLyrics(t, getApp().settings, this.deps(), token, { refresh: opts.refresh, onProgress: publish });
    if (res.status !== 'idle') this.logLyrics(t, res);
    this.learnLength(t, res);
    // Stale response protection: a newer track (or reload) has started since.
    if (!this.lyricsReq.isCurrent(req) || getApp().track?.key !== t.key) return;
    if (!this.mayReplace(res, t.key)) {
      setApp((s) => ({ lyrics: { ...s.lyrics, tried: res.tried, length: res.length } }));
      return;
    }
    this.applyLyrics(res, t.key);
  }

  /** Keep the measured gap between the player's reported song length and the real one. */
  private learnLength(t: TrackInfo, res: LyricsResult): void {
    const gap = res.length?.measuredGapSec;
    if (gap !== undefined) this.recordLengthGap(t, gap);
  }

  private recordLengthGap(t: TrackInfo, gap: number): void {
    const key = playerKey(t.app);
    if (!key || !Number.isFinite(gap)) return;
    this.updateSettings((s) => ({
      ...s,
      learned: { ...s.learned, lengthOffsets: { ...s.learned.lengthOffsets, [key]: addLengthSample(s.learned.lengthOffsets[key], gap) } },
    }));
  }

  /** Apply a lyrics result; exported for tests through the controller instance. */
  applyLyrics(res: LyricsResult, trackKey: string | null): void {
    this.rawDoc = res.doc;
    const doc = this.effectiveDoc();
    const analysis = doc ? analyzeLyrics(doc) : null;
    setApp({ lyrics: { ...res, doc, trackKey: trackKey ?? undefined }, analysis });
    this.runtime.setDoc(doc && doc.timing !== 'none' ? doc : null);
    const t = getApp().track;
    if (t && !getApp().theme.locked && res.status !== 'loading' && this.catalogPending !== t.key) {
      if (this.themeTimer) clearTimeout(this.themeTimer);
      this.lockTheme(this.decide(t, analysis));
    }
  }

  private effectiveDoc(): LyricDocument | null {
    const d = this.rawDoc;
    if (!d || !getApp().lineOnly || d.timing !== 'word') return d;
    return {
      ...d,
      timing: 'line',
      lines: d.lines.map((l) => ({
        ...l,
        wordTiming: 'none' as const,
        words: l.words.map((w) => ({ ...w, startMs: l.startMs, endMs: l.endMs })),
      })),
    };
  }

  setLineOnly(on: boolean): void {
    setApp({ lineOnly: on });
    const st = getApp().lyrics;
    this.applyLyrics({ ...st, doc: this.rawDoc }, st.trackKey ?? null);
    toast(on ? 'Word timestamps hidden — showing line-synced behaviour' : 'Word timestamps restored');
  }

  async importLyrics(): Promise<void> {
    const f = await openLyrics();
    if (!f) return;
    this.useLyricsText(f.text, f.name, f.path);
  }

  useLyricsText(text: string, name: string, path?: string): void {
    const t = getApp().track;
    const doc = parseLyrics(text, { kind: path ? 'local-file' : 'pasted', label: name, match: 'manual' }, name);
    if (doc.timing === 'none' && !doc.plainText) {
      toast('No lyrics found in that text.', 'warn');
      return;
    }
    if (t && path && native) this.updateSettings((s) => ({ ...s, lyricLinks: { ...s.lyricLinks, [t.key]: path } }));
    this.cancelToken.cancelled = true;
    this.lyricsReq.invalidate();
    this.applyLyrics(
      { status: doc.timing === 'none' ? 'unsynced' : 'synced', doc, tried: [{ source: name, outcome: doc.timing === 'none' ? 'unsynced' : `${doc.timing}-synced` }] },
      t?.key ?? null,
    );
    toast(`Using ${name}${doc.timing === 'word' ? ' · word timing' : doc.timing === 'line' ? ' · line timing' : ' · unsynced'}`);
  }

  chooseAlternative(r: LrclibRecord): void {
    const doc = docFromLrclib(r, 'manual');
    const key = getApp().track?.key;
    if (key) this.updateSettings((s) => ({ ...s, lrclibChoices: { ...s.lrclibChoices, [key]: r.id } }));
    this.cancelToken.cancelled = true;
    this.lyricsReq.invalidate();
    this.applyLyrics({ status: doc.timing === 'none' ? 'unsynced' : 'synced', doc, tried: getApp().lyrics.tried, alternatives: getApp().lyrics.alternatives }, getApp().track?.key ?? null);
  }

  forgetLyricsLink(): void {
    const t = getApp().track;
    if (!t) return;
    this.updateSettings((s) => {
      const links = { ...s.lyricLinks };
      delete links[t.key];
      return { ...s, lyricLinks: links };
    });
    void this.loadLyricsFor(t);
  }

  async chooseLyricsFolder(): Promise<void> {
    const f = await native?.chooseLyricsFolder();
    if (!f) return;
    this.updateSettings((s) => ({ ...s, sources: { ...s.sources, lyricsFolder: f } }));
    const t = getApp().track;
    if (t) void this.loadLyricsFor(t);
  }

  setOnlineLyrics(on: boolean): void {
    this.updateSettings((s) => ({ ...s, sources: { ...s.sources, onlineLyrics: on } }));
    const t = getApp().track;
    if (on && t && (getApp().lyrics.status === 'not-found' || getApp().lyrics.status === 'unsynced')) void this.loadLyricsFor(t);
  }

  // ------------------------------------------------------------------ themes
  private decide(t: TrackInfo, analysis: ReturnType<typeof analyzeLyrics> | null) {
    const s = getApp().settings;
    const docGenre = this.rawDoc?.meta.genre;
    const genres = [...t.genres];
    if (docGenre && !genres.some((g) => g.value === docGenre)) genres.push({ value: docGenre, source: 'lyric-file' });
    const catalogGenre = this.catalogGenres.get(t.key);
    if (catalogGenre) genres.push(catalogGenre);
    return decideTheme(
      {
        trackKey: t.themeKey ?? t.key,
        artistKey: artistKeyOf(t.artist),
        artistName: t.artist,
        genres,
        timing: this.rawDoc?.timing ?? 'none',
        analysis: analysis ?? undefined,
      },
      { ...s.theme },
    );
  }

  private lockTheme(decision: ReturnType<AppController['decide']>): void {
    setApp({ theme: { decision, activeId: decision.themeId, locked: true } });
  }

  /** Explicit user choice: applies immediately and is remembered for the track (and optionally artist). */
  chooseTheme(id: ThemeId, opts: { forArtist?: boolean } = {}): void {
    const s = getApp().settings;
    const t = getApp().track;
    if (s.theme.mode === 'manual') {
      this.updateSettings((x) => ({ ...x, theme: { ...x.theme, manualTheme: id } }));
    } else if (t) {
      const ak = artistKeyOf(t.artist);
      this.updateSettings((x) => ({
        ...x,
        theme: {
          ...x.theme,
          trackThemes: { ...x.theme.trackThemes, [t.themeKey ?? t.key]: id },
          artistThemes: opts.forArtist && ak ? { ...x.theme.artistThemes, [ak]: id } : x.theme.artistThemes,
        },
      }));
    }
    if (t) this.lockTheme(this.decide(t, getApp().analysis));
    else setApp((st) => ({ theme: { ...st.theme, activeId: id } }));
  }

  clearTrackTheme(): void {
    const t = getApp().track;
    if (!t) return;
    const ak = artistKeyOf(t.artist);
    this.updateSettings((x) => {
      const tt = { ...x.theme.trackThemes };
      delete tt[t.themeKey ?? t.key];
      const at = { ...x.theme.artistThemes };
      if (ak) delete at[ak];
      return { ...x, theme: { ...x.theme, trackThemes: tt, artistThemes: at } };
    });
    this.lockTheme(this.decide(t, getApp().analysis));
  }

  setThemeMode(mode: 'auto' | 'manual'): void {
    const active = getApp().theme.activeId;
    this.updateSettings((x) => ({ ...x, theme: { ...x.theme, mode, manualTheme: mode === 'manual' ? active : x.theme.manualTheme } }));
    const t = getApp().track;
    if (t) this.lockTheme(this.decide(t, getApp().analysis));
  }

  // ------------------------------------------------------------------ timing
  currentOffset(): number {
    const s = getApp().settings;
    const key = getApp().track?.key;
    const session = key && !s.timing.rememberTrackOffsets ? this.sessionTrackOffset.get(key) ?? 0 : 0;
    return totalOffsetMs(s.timing, key) + session;
  }

  trackOffset(): number {
    const s = getApp().settings;
    const key = getApp().track?.key;
    if (!key) return 0;
    return s.timing.rememberTrackOffsets ? s.timing.trackOffsets[key] ?? 0 : this.sessionTrackOffset.get(key) ?? 0;
  }

  private applyTiming(): void {
    this.runtime.setOffset(this.currentOffset());
  }

  setTrackOffset(ms: number): void {
    const key = getApp().track?.key;
    if (!key) return;
    const v = Math.round(Math.max(-30000, Math.min(30000, ms)));
    if (getApp().settings.timing.rememberTrackOffsets) {
      this.updateSettings((s) => {
        const map = { ...s.timing.trackOffsets };
        if (v === 0) delete map[key];
        else map[key] = v;
        return { ...s, timing: { ...s.timing, trackOffsets: map } };
      });
    } else {
      this.sessionTrackOffset.set(key, v);
      this.applyTiming();
      setApp({});
    }
  }

  nudge(delta: number): void {
    this.setTrackOffset(this.trackOffset() + delta);
    const total = this.currentOffset();
    toast(`Lyrics ${total >= 0 ? '+' : ''}${total} ms ${total > 0 ? '(later)' : total < 0 ? '(earlier)' : ''}`, 'info', 1400);
    this.hintOffsetSuggestion();
  }

  /** "Apply to all songs" suggestion from the user's own per-song corrections, unless declined. */
  offsetSuggestion(): OffsetSuggestion | null {
    const t = getApp().settings.timing;
    const s = suggestGlobalOffset(t);
    if (!s) return null;
    const d = t.suggestionDismissed;
    if (d && Math.abs(d.deltaMs - s.deltaMs) < 50 && s.songs < d.songs + 3) return null;
    return s;
  }

  applyOffsetSuggestion(): void {
    const s = this.offsetSuggestion();
    if (!s) return;
    this.updateSettings((x) => ({ ...x, timing: { ...applyGlobalSuggestion(x.timing, s.deltaMs), suggestionDismissed: null } }));
    toast(`All songs now ${s.deltaMs > 0 ? 'later' : 'earlier'} by ${Math.abs(s.deltaMs)} ms; songs you corrected keep their timing`, 'info', 4200);
  }

  dismissOffsetSuggestion(): void {
    const s = suggestGlobalOffset(getApp().settings.timing);
    if (s) this.updateSettings((x) => ({ ...x, timing: { ...x.timing, suggestionDismissed: s } }));
  }

  private suggestionHinted = false;
  private hintOffsetSuggestion(): void {
    if (this.suggestionHinted || !this.offsetSuggestion()) return;
    this.suggestionHinted = true;
    setTimeout(() => toast('The same correction fits several songs. Open Timing to apply it to all songs.', 'info', 6000), 1500);
  }

  setGlobalOffset(ms: number): void {
    this.updateSettings((s) => ({ ...s, timing: { ...s.timing, globalOffsetMs: Math.round(ms) } }));
  }

  /** "This line is being sung right now" — aligns the per-track offset. */
  alignLine(index: number): void {
    const doc = getApp().lyrics.doc;
    const line = doc?.lines[index];
    if (!line) return;
    const media = this.engine.position();
    this.setTrackOffset(offsetToAlign(media, line.startMs, getApp().settings.timing.globalOffsetMs));
    toast(`Aligned: line ${index + 1} starts now`, 'info', 1600);
    this.hintOffsetSuggestion();
  }

  // ------------------------------------------------------------------ misc
  private pollSync(): void {
    const snap = this.engine.snapshot();
    const cur = getApp().sync;
    if (cur.quality !== snap.quality || cur.reason !== snap.qualityReason) setApp({ sync: { quality: snap.quality, reason: snap.qualityReason } });
    const caps = this.adapter?.capabilities();
    const old = getApp().caps;
    if (caps && (caps.seek !== old.seek || caps.playPause !== old.playPause || caps.nextPrev !== old.nextPrev)) setApp({ caps });
  }

  async setFullscreen(on: boolean): Promise<void> {
    if (native) {
      setUi({ fullscreen: await native.setFullscreen(on) });
    } else {
      try {
        if (on) await document.documentElement.requestFullscreen();
        else if (document.fullscreenElement) await document.exitFullscreen();
      } catch {
        /* ignore */
      }
      setUi({ fullscreen: !!document.fullscreenElement });
    }
    this.runtime.wake(800);
  }

  async saveCorrectedLyrics(): Promise<void> {
    const doc = getApp().lyrics.doc;
    const t = getApp().track;
    if (!doc || !native) return;
    // lyric time L is shown at media time L + offset, so the corrected file shifts by +offset
    const shift = this.currentOffset();
    const p = await native.saveLyrics(`${t?.artist ? `${t.artist} - ` : ''}${t?.title ?? 'lyrics'}.lrc`, toLrc(doc, shift));
    if (p) toast(`Saved ${p}`);
  }
}

export const controller = new AppController();
