import { type ThemeId, isThemeId } from '../themes/matcher';

export type MotionTreatment = 'signature' | 'highlight' | 'jiggle' | 'still';
export type ContextMode = 'full' | 'minimal' | 'off';
export type ReducedMotionPref = 'system' | 'on' | 'off';

export interface Settings {
  version: 2;
  theme: {
    mode: 'auto' | 'manual';
    manualTheme: ThemeId;
    fallbackTheme: ThemeId;
    useArtistPrefs: boolean;
    useSuggestions: boolean;
    trackThemes: Record<string, ThemeId>;
    artistThemes: Record<string, ThemeId>;
  };
  motion: {
    treatment: MotionTreatment;
    /** 0..1.5 multiplier, 1 = designed amount. */
    intensity: number;
    reduced: ReducedMotionPref;
    /** Optional, explicitly labeled estimated word sweep for line-timed lyrics. */
    estimatedSweep: boolean;
    /** Beat pulse, only ever active when the lyric source states tempo + downbeat. */
    beatPulse: boolean;
  };
  timing: {
    /** Positive = show lyrics later (e.g. Bluetooth output latency). */
    globalOffsetMs: number;
    rememberTrackOffsets: boolean;
    trackOffsets: Record<string, number>;
    /** The "apply to all songs" suggestion the user declined, so it is not repeated. */
    suggestionDismissed: { deltaMs: number; songs: number } | null;
  };
  display: {
    context: ContextMode;
    showArtwork: boolean;
    controlsHideMs: number;
    textScale: number;
    /** On battery: about 30 fps and no background blur. */
    batterySaver: boolean;
    /** Show a translation under the current line when the lyrics include one. */
    translations: boolean;
  };
  sources: {
    followSystemMedia: boolean;
    /** LRCLIB lookups are opt-in: they send artist/title to lrclib.net. */
    onlineLyrics: boolean;
    preferredApp: string;
    /** Folder searched for "Artist - Title.lrc" files. */
    lyricsFolder: string;
    /** Individual online providers (used only when onlineLyrics is on). */
    providers: { lrclib: boolean; amll: boolean; catalog: boolean };
    /** Reuse lyrics found online earlier for the same track. */
    useCache: boolean;
  };
  /** trackKey -> absolute path of a lyric file the user attached. */
  lyricLinks: Record<string, string>;
  /** trackKey -> LRCLIB record id the user picked from the alternatives. */
  lrclibChoices: Record<string, number>;
  recent: { path: string; title: string; artist?: string }[];
  /** Measured facts, kept so they need not be re-measured. Never set from guesses. */
  learned: {
    /**
     * Player app id -> recent measured gaps (s) between the real song length (what
     * several lyric uploads agree on) and the length the player reports. Spotify with
     * crossfade reports songs short by the crossfade time.
     */
    lengthOffsets: Record<string, number[]>;
  };
  diagnostics: boolean;
  firstRunDone: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 2,
  theme: {
    mode: 'auto',
    manualTheme: 'cypher',
    fallbackTheme: 'quiet',
    useArtistPrefs: true,
    useSuggestions: true,
    trackThemes: {},
    artistThemes: {},
  },
  motion: { treatment: 'signature', intensity: 1, reduced: 'system', estimatedSweep: false, beatPulse: true },
  timing: { globalOffsetMs: 0, rememberTrackOffsets: true, trackOffsets: {}, suggestionDismissed: null },
  display: { context: 'full', showArtwork: true, controlsHideMs: 2600, textScale: 1, batterySaver: true, translations: true },
  sources: { followSystemMedia: false, onlineLyrics: false, preferredApp: 'spotify', lyricsFolder: '', providers: { lrclib: true, amll: true, catalog: true }, useCache: true },
  lyricLinks: {},
  lrclibChoices: {},
  recent: [],
  learned: { lengthOffsets: {} },
  diagnostics: false,
  firstRunDone: false,
};

const clamp = (x: unknown, lo: number, hi: number, d: number) =>
  typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d);
const oneOf = <T extends string>(x: unknown, opts: readonly T[], d: T): T => (opts.includes(x as T) ? (x as T) : d);

function themeMap(x: unknown): Record<string, ThemeId> {
  const out: Record<string, ThemeId> = {};
  if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) if (isThemeId(v)) out[k] = v;
  return out;
}
function numMap(x: unknown, lo: number, hi: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (x && typeof x === 'object')
    for (const [k, v] of Object.entries(x)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v));
  return out;
}
function sampleMap(x: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!x || typeof x !== 'object') return out;
  for (const [k, v] of Object.entries(x).slice(0, 16)) {
    if (!Array.isArray(v)) continue;
    const xs = v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= -3 && n <= 15).slice(-9);
    if (xs.length) out[k.slice(0, 120)] = xs;
  }
  return out;
}
function strMap(x: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** Validate untrusted persisted JSON into a complete Settings object. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const d = DEFAULT_SETTINGS;
  const th = r.theme ?? {};
  const mo = r.motion ?? {};
  const ti = r.timing ?? {};
  const di = r.display ?? {};
  const so = r.sources ?? {};
  return {
    version: 2,
    theme: {
      mode: oneOf(th.mode, ['auto', 'manual'] as const, d.theme.mode),
      manualTheme: isThemeId(th.manualTheme) ? th.manualTheme : d.theme.manualTheme,
      fallbackTheme: isThemeId(th.fallbackTheme) ? th.fallbackTheme : d.theme.fallbackTheme,
      useArtistPrefs: bool(th.useArtistPrefs, d.theme.useArtistPrefs),
      useSuggestions: bool(th.useSuggestions, d.theme.useSuggestions),
      trackThemes: themeMap(th.trackThemes),
      artistThemes: themeMap(th.artistThemes),
    },
    motion: {
      treatment: oneOf(mo.treatment, ['signature', 'highlight', 'jiggle', 'still'] as const, d.motion.treatment),
      intensity: clamp(mo.intensity, 0, 1.5, d.motion.intensity),
      reduced: oneOf(mo.reduced, ['system', 'on', 'off'] as const, d.motion.reduced),
      estimatedSweep: bool(mo.estimatedSweep, d.motion.estimatedSweep),
      beatPulse: bool(mo.beatPulse, d.motion.beatPulse),
    },
    timing: {
      globalOffsetMs: clamp(ti.globalOffsetMs, -5000, 5000, 0),
      rememberTrackOffsets: bool(ti.rememberTrackOffsets, true),
      trackOffsets: numMap(ti.trackOffsets, -30000, 30000),
      suggestionDismissed:
        ti.suggestionDismissed && Number.isFinite(ti.suggestionDismissed.deltaMs) && Number.isFinite(ti.suggestionDismissed.songs)
          ? { deltaMs: clamp(ti.suggestionDismissed.deltaMs, -5000, 5000, 0), songs: clamp(ti.suggestionDismissed.songs, 0, 100000, 0) }
          : null,
    },
    display: {
      context: oneOf(di.context, ['full', 'minimal', 'off'] as const, d.display.context),
      showArtwork: bool(di.showArtwork, true),
      controlsHideMs: clamp(di.controlsHideMs, 1200, 10000, d.display.controlsHideMs),
      textScale: clamp(di.textScale, 0.7, 1.4, 1),
      batterySaver: bool(di.batterySaver, true),
      translations: bool(di.translations, true),
    },
    sources: {
      followSystemMedia: bool(so.followSystemMedia, false),
      onlineLyrics: bool(so.onlineLyrics, false),
      preferredApp: typeof so.preferredApp === 'string' ? so.preferredApp.slice(0, 64) : d.sources.preferredApp,
      lyricsFolder: typeof so.lyricsFolder === 'string' ? so.lyricsFolder.slice(0, 1024) : '',
      providers: { lrclib: bool(so.providers?.lrclib, true), amll: bool(so.providers?.amll, true), catalog: bool(so.providers?.catalog, true) },
      useCache: bool(so.useCache, true),
    },
    lyricLinks: strMap(r.lyricLinks),
    lrclibChoices: numMap(r.lrclibChoices, 0, Number.MAX_SAFE_INTEGER),
    recent: Array.isArray(r.recent)
      ? r.recent
          .filter((x: any) => x && typeof x.path === 'string' && typeof x.title === 'string')
          .slice(0, 12)
          .map((x: any) => ({ path: x.path, title: x.title, artist: typeof x.artist === 'string' ? x.artist : undefined }))
      : [],
    learned: { lengthOffsets: sampleMap(r.learned?.lengthOffsets) },
    diagnostics: bool(r.diagnostics, false),
    firstRunDone: bool(r.firstRunDone, false),
  };
}
