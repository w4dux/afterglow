/** Types shared between the Electron main process, preload, and renderer. */

export interface EmbeddedLyrics {
  /** Synced lyrics converted to LRC text (from ID3 SYLT or an LRC-formatted lyrics tag). */
  syncedLrc?: string;
  /** Unsynced lyrics text (USLT / Vorbis LYRICS). */
  unsynced?: string;
}

export interface LocalTrackInfo {
  path: string;
  /** URL the renderer can stream (custom protocol with range support). */
  url: string;
  fileName: string;
  title?: string;
  artist?: string;
  album?: string;
  genres: string[];
  durationMs?: number;
  artworkDataUrl?: string;
  embedded: EmbeddedLyrics;
  sidecar?: { path: string; name: string; text: string };
  metadataError?: string;
}

export interface LyricFileResult {
  path: string;
  name: string;
  text: string;
}

export interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  instrumental: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  hasWordSync?: boolean;
  lyricsfile?: string | null;
}

export interface AmllHit {
  file: string;
  title: string;
  artist: string;
  album?: string;
  /** Metadata match score 0-100 (without duration; the renderer adds it after parsing). */
  score: number;
  url: string;
  ttml?: string;
  error?: string;
}

export type AmllResponse = { ok: true; hits: AmllHit[]; indexSize: number; stale: boolean } | { ok: false; error: string; offline?: boolean };

export interface LyricsCacheEntry {
  savedAt: number;
  /** Last time the online providers were asked about this track. */
  checkedAt?: number;
  /** Provider id, e.g. 'lrclib' or 'amll'. */
  provider: string;
  /** 'none' marks a recent search that found nothing. */
  format: 'lrc' | 'ttml' | 'lyricsfile' | 'plain' | 'none';
  text: string;
  label: string;
  attribution?: string;
  match?: string;
  note?: string;
  /** Song length (s) these lyrics were matched against, when known exactly. */
  lengthSec?: number;
}

export type LrclibResponse =
  | { ok: true; exact?: LrclibRecord; candidates: LrclibRecord[] }
  | { ok: false; error: string; status?: number; offline?: boolean };

/** Raw messages from the native GSMTC bridge, plus receipt time added by main. */
export interface BridgeState {
  type: 'state';
  seq: number;
  cause: 'initial' | 'playback' | 'timeline' | 'media' | 'session' | 'poll' | 'refresh';
  app: string | null;
  status: 'closed' | 'opened' | 'changing' | 'stopped' | 'playing' | 'paused' | 'unknown' | 'none';
  rate?: number;
  timelineAvailable?: boolean;
  positionMs?: number;
  startMs?: number;
  endMs?: number;
  lastUpdatedWallMs?: number;
  emitWallMs: number;
  /** Linux: why the player could not be read (e.g. D-Bus AccessDenied). */
  error?: string;
  media?: { title?: string; artist?: string; album?: string; albumArtist?: string; genres?: string[]; error?: string } | null;
  controls?: { play: boolean; pause: boolean; toggle: boolean; next: boolean; prev: boolean; seek: boolean } | null;
  /** Added by the main process: wall clock when the line was read from the pipe. */
  mainRecvWallMs?: number;
}

export type BridgeMessage =
  | { type: 'hello'; version: number; platform: string; wallMs: number }
  | { type: 'status'; available: boolean; error?: string }
  | { type: 'sessions'; sessions: { app: string; status: string }[]; systemCurrent?: string | null; attached?: string | null; preferred?: string }
  | BridgeState
  | { type: 'artwork'; app: string; title: string; artist: string; mime: string | null; base64: string | null; /** Linux: image URL, fetched by the main process. */ url?: string }
  | { type: 'ack'; id: number; ok: boolean; error?: string | null }
  | { type: 'bridge-exit'; code: number | null; signal: string | null; restarting: boolean; error?: string }
  | { type: 'bridge-unavailable'; reason: string };

export type BridgeCommand = ({ id?: number } & (
  | { cmd: 'play' | 'pause' | 'toggle' | 'next' | 'prev' | 'refresh' }
  | { cmd: 'seek'; positionMs: number }
  | { cmd: 'select'; app: string }));

export interface AppInfo {
  version: string;
  platform: string;
  electron: string;
  chrome: string;
  bridgeAvailable: boolean;
  bridgePath?: string;
  userData: string;
}

export interface AfterglowApi {
  /** Node's process.platform of the desktop app ('win32', 'linux', ...). */
  platform: string;
  info(): Promise<AppInfo>;
  loadSettings(): Promise<unknown>;
  saveSettings(settings: unknown): Promise<void>;
  openAudio(): Promise<LocalTrackInfo | null>;
  openAudioPath(path: string): Promise<LocalTrackInfo | null>;
  openLyrics(): Promise<LyricFileResult | null>;
  readLyricFile(path: string): Promise<LyricFileResult | null>;
  saveLyrics(suggestedName: string, text: string): Promise<string | null>;
  chooseLyricsFolder(): Promise<string | null>;
  findLyricsInFolder(folder: string, artist: string, title: string): Promise<LyricFileResult | null>;
  lrclib(q: { artist: string; title: string; album?: string; durationSec?: number }): Promise<LrclibResponse>;
  lrclibById(id: number): Promise<LrclibResponse>;
  amll(q: { artist: string; title: string; album?: string; durationSec?: number }): Promise<AmllResponse>;
  lyricsCacheGet(key: string): Promise<LyricsCacheEntry | null>;
  lyricsCachePut(key: string, entry: LyricsCacheEntry): Promise<void>;
  lyricsCacheRemove(key: string): Promise<void>;
  bridgeStart(preferredApp: string): Promise<{ started: boolean; reason?: string }>;
  bridgeStop(): Promise<void>;
  bridgeCommand(cmd: BridgeCommand): Promise<void>;
  onBridge(cb: (msg: BridgeMessage) => void): () => void;
  onPower(cb: (ev: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen' | 'on-battery' | 'on-ac') => void): () => void;
  /** Whether the PC is running on battery right now. */
  onBattery(): Promise<boolean>;
  setFullscreen(on: boolean): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
  /** Linux: recolour the window controls for a light or dark theme. Optional for older builds. */
  setWindowTone?(tone: 'dark' | 'light'): Promise<void>;
  onFullscreen(cb: (on: boolean) => void): () => void;
  openExternal(url: string): Promise<void>;
  /** Files dropped on the window: resolve the real path (Electron webUtils). */
  pathForFile(file: File): string;
  /** One look at what is playing, without following it (first-run welcome). */
  mediaPeek(): Promise<MediaPeek | null>;
  /** Append a line to the local log file (rate-limited, single line). */
  log(text: string): Promise<void>;
  /** Last lines of the local log file. */
  readLog(lines?: number): Promise<string[]>;
  /** Open the folder that holds the log files. */
  openLogFolder(): Promise<void>;
  copyText(text: string): Promise<boolean>;
  /** Apple's public iTunes catalogue (genre, length, artwork); online consent required. */
  catalog(q: { artist: string; title: string }): Promise<CatalogResponse>;
  catalogArtwork(url: string): Promise<string | null>;
}

/** One song in Apple's public iTunes catalogue. */
export interface CatalogEntry {
  title: string;
  artist: string;
  album?: string;
  /** Apple's stated primary genre, e.g. "Hip-Hop/Rap". */
  genre?: string;
  durationSec?: number;
  artworkUrl?: string;
  explicit?: boolean;
}

export type CatalogResponse = { ok: true; entries: CatalogEntry[]; cached?: boolean } | { ok: false; error: string };

/** What a media app is publishing to Windows right now. */
export interface MediaPeek {
  app: string | null;
  status?: string;
  title?: string;
  artist?: string;
}

declare global {
  interface Window {
    afterglow?: AfterglowApi;
  }
}
