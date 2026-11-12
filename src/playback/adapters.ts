import type { GenreSignal } from '../core/themes/matcher';
import type { Observation, PlaybackSourceKind } from '../core/sync/SyncEngine';
import type { LocalTrackInfo } from '../shared/api';

export interface DemoTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  bpm: number;
  beatOffsetMs: number;
  durationMs: number;
  audio: string;
  lyrics: string;
  artwork: string;
  palette: string[];
}

export interface TrackInfo {
  key: string;
  themeKey?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  source: PlaybackSourceKind;
  /** e.g. "Offline demo", "Local file", "Spotify · Windows media session" */
  sourceLabel: string;
  app?: string;
  genres: GenreSignal[];
  artworkUrl?: string;
  local?: LocalTrackInfo;
  demo?: DemoTrack;
}

export interface AdapterCapabilities {
  playPause: boolean;
  seek: boolean;
  nextPrev: boolean;
}

export interface AdapterEvents {
  observe(o: Observation): void;
  track(t: TrackInfo): void;
  status(s: { playing: boolean; durationMs?: number; message?: string }): void;
}

export interface PlaybackAdapter {
  readonly kind: PlaybackSourceKind;
  capabilities(): AdapterCapabilities;
  /** Called every animation frame; pull-based adapters sample their clock here. */
  pull?(now: number): void;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(ms: number): void;
  next?(): void;
  prev?(): void;
  dispose(): void;
}
