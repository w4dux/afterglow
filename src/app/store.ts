import { create } from 'zustand';
import type { LyricAnalysis } from '../core/lyrics/analysis';
import { DEFAULT_SETTINGS, type Settings } from '../core/settings/schema';
import type { SyncQuality } from '../core/sync/SyncEngine';
import type { ThemeDecision, ThemeId } from '../core/themes/matcher';
import type { LyricsResult } from '../lyrics/LyricsResolver';
import type { AdapterCapabilities, DemoTrack, TrackInfo } from '../playback/adapters';
import type { SystemInfo } from '../playback/SystemMediaAdapter';
import type { AppInfo } from '../shared/api';
import type { ArtworkInfo } from '../stage/scene';

export type PanelId = 'themes' | 'timing' | 'motion' | 'sources' | 'help' | null;

export interface Toast {
  id: number;
  text: string;
  tone?: 'info' | 'warn' | 'error';
}

export interface AppState {
  ready: boolean;
  info: AppInfo | null;
  settings: Settings;
  demos: DemoTrack[];
  source: 'none' | 'demo' | 'local' | 'system';
  track: TrackInfo | null;
  playing: boolean;
  durationMs: number;
  caps: AdapterCapabilities;
  playbackMessage?: string;
  lyrics: LyricsResult & { trackKey?: string };
  analysis: LyricAnalysis | null;
  /** Strip word timing (preview line-synced behaviour); labelled in the UI. */
  lineOnly: boolean;
  theme: { decision: ThemeDecision | null; activeId: ThemeId; locked: boolean };
  artwork: ArtworkInfo | null;
  sync: { quality: SyncQuality; reason: string };
  system: SystemInfo | null;
  ui: {
    panel: PanelId;
    controlsVisible: boolean;
    fullscreen: boolean;
    diagnostics: boolean;
    pasteOpen: boolean;
  };
  reducedMotionSystem: boolean;
  /** The PC runs on battery (desktop app only). */
  onBattery: boolean;
  toasts: Toast[];
}

export const useApp = create<AppState>(() => ({
  ready: false,
  info: null,
  settings: DEFAULT_SETTINGS,
  demos: [],
  source: 'none',
  track: null,
  playing: false,
  durationMs: 0,
  caps: { playPause: false, seek: false, nextPrev: false },
  lyrics: { status: 'idle', doc: null, tried: [] },
  analysis: null,
  lineOnly: false,
  theme: { decision: null, activeId: 'quiet', locked: false },
  artwork: null,
  sync: { quality: 'unavailable', reason: 'no playback observed' },
  system: null,
  ui: { panel: null, controlsVisible: true, fullscreen: false, diagnostics: false, pasteOpen: false },
  reducedMotionSystem: false,
  onBattery: false,
  toasts: [],
}));

export const setApp = useApp.setState;
export const getApp = useApp.getState;

export function setUi(p: Partial<AppState['ui']>): void {
  setApp((s) => ({ ui: { ...s.ui, ...p } }));
}

let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'info', ms = 3600): void {
  const id = ++toastId;
  setApp((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
  setTimeout(() => setApp((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
