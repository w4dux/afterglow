import { describe, expect, it } from 'vitest';
import { artistKeyOf, decideTheme, type ThemePrefs, themeForGenre, trackKeyOf } from '../src/core/themes/matcher';
import { analyzeLyrics } from '../src/core/lyrics/analysis';
import { parseLrc } from '../src/core/lyrics/lrc';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings/schema';

const prefs: ThemePrefs = {
  mode: 'auto',
  manualTheme: 'velvet',
  fallbackTheme: 'quiet',
  trackThemes: {},
  artistThemes: {},
  useArtistPrefs: true,
  useSuggestions: true,
};

describe('genre mapping', () => {
  it.each([
    ['Hip-Hop', 'cypher'],
    ['hip hop/rap', 'cypher'],
    ['Pop Rap', 'cypher'],
    ['Trap', 'nocturne'],
    ['UK Drill', 'nocturne'],
    ['Electronic', 'nocturne'],
    ['R&B', 'velvet'],
    ['Neo-Soul', 'velvet'],
    ['Trap Soul', 'velvet'],
    ['K-Pop', 'sherbet'],
    ['Synthpop', 'sherbet'],
    ['Pop', 'sherbet'],
    ['Alternative Rock', 'feedback'],
    ['Pop Punk', 'feedback'],
    ['Indie Folk', 'horizon'],
    ['Ambient', 'horizon'],
    ['Acoustic', 'horizon'],
    ['Lounge', 'afterhours'],
    ['Smooth Jazz', 'afterhours'],
    ['Hardcore', 'riot'],
    ['House', 'prism'],
    ['Emo Rap', 'halo'],
    ['Melodic Rap', 'halo'],
    ['Cloud Rap', 'halo'],
    ['Bangla', 'monsoon'],
    ['Bengali Rock', 'monsoon'],
    ['Indian Pop', 'monsoon'],
    ['Bollywood', 'monsoon'],
    ['New Wave', 'departures'],
    ['Post-Punk', 'departures'],
    ['City Pop', 'departures'],
  ])('%s -> %s', (g, id) => expect(themeForGenre(g)).toBe(id));
  it('returns undefined for unknown genres', () => {
    expect(themeForGenre('Polka')).toBeUndefined();
    expect(themeForGenre('')).toBeUndefined();
  });
});

describe('theme decision', () => {
  const base = { trackKey: 't1', artistKey: 'artist:x', artistName: 'X', genres: [], timing: 'line' as const };

  it('prefers manual mode, then track choice, then artist choice, then known genre', () => {
    expect(decideTheme(base, { ...prefs, mode: 'manual' }).basis).toBe('manual');
    const withAll = {
      ...prefs,
      trackThemes: { t1: 'horizon' as const },
      artistThemes: { 'artist:x': 'feedback' as const },
    };
    const sig = { ...base, genres: [{ value: 'Hip-Hop', source: 'file-tag' as const }] };
    expect(decideTheme(sig, withAll)).toMatchObject({ themeId: 'horizon', basis: 'track-choice' });
    expect(decideTheme(sig, { ...withAll, trackThemes: {} })).toMatchObject({ themeId: 'feedback', basis: 'artist-choice' });
    expect(decideTheme(sig, { ...withAll, trackThemes: {}, useArtistPrefs: false })).toMatchObject({
      themeId: 'cypher',
      basis: 'known-genre',
      label: 'Known genre · Hip-Hop (file tag)',
    });
  });

  it('labels lyric-pace suggestions as suggestions, not genre', () => {
    const fast = parseLrc(
      Array.from({ length: 12 }, (_, i) => `[00:${String(10 + i * 2).padStart(2, '0')}.00]one two three four five six seven eight`).join('\n'),
      { kind: 'local-file', label: 'x' },
    );
    const d = decideTheme({ ...base, timing: 'line', analysis: analyzeLyrics(fast) }, prefs);
    expect(d.basis).toBe('suggested');
    expect(d.themeId).toBe('cypher');
    expect(d.label).toMatch(/^Suggested/);
    expect(d.evidence).toContain('not a genre detection');
    expect(decideTheme({ ...base, analysis: analyzeLyrics(fast) }, { ...prefs, useSuggestions: false }).basis).toBe('fallback');
  });

  it('falls back coherently without inventing a genre', () => {
    const d = decideTheme({ ...base, timing: 'none' }, prefs);
    expect(d).toMatchObject({ themeId: 'quiet', basis: 'fallback', label: 'Default · no genre information' });
    const unk = decideTheme({ ...base, genres: [{ value: 'Polka', source: 'file-tag' }] }, prefs);
    expect(unk.label).toContain('not mapped');
  });
});

describe('theme registry', () => {
  it('registers every theme id with a scene, fonts, a library position and a name', async () => {
    const { THEME_IDS, THEME_NAMES } = await import('../src/core/themes/matcher');
    const { THEMES, THEME_ORDER, NEW_THEMES } = await import('../src/themes');
    for (const id of THEME_IDS) {
      expect(THEMES[id]?.id).toBe(id);
      expect(typeof THEMES[id].create).toBe('function');
      expect(THEMES[id].fonts.length).toBeGreaterThan(0);
      expect(THEME_NAMES[id]).toBe(THEMES[id].name);
    }
    expect([...THEME_ORDER].sort()).toEqual([...THEME_IDS].sort());
    expect(NEW_THEMES.every((id) => THEME_IDS.includes(id))).toBe(true);
    // keys 1-9, 0 keep selecting the original ten
    expect(THEME_ORDER.slice(0, 10)).toEqual(['cypher', 'nocturne', 'velvet', 'sherbet', 'feedback', 'horizon', 'quiet', 'afterhours', 'riot', 'prism']);
  });
  it('lowercase fonts measure and display lowercase', async () => {
    const { displayText } = await import('../src/stage/layout');
    expect(displayText('Clocked In', { family: 'x', weight: 400, lineHeight: 1, lower: true })).toBe('clocked in');
    expect(displayText('Clocked In', { family: 'x', weight: 400, lineHeight: 1, upper: true })).toBe('CLOCKED IN');
  });
  it('keeps saved picks of the new themes through settings validation', () => {
    const s = sanitizeSettings({ theme: { trackThemes: { a: 'halo', b: 'monsoon', c: 'departures' }, manualTheme: 'monsoon', fallbackTheme: 'halo' } });
    expect(s.theme.trackThemes).toEqual({ a: 'halo', b: 'monsoon', c: 'departures' });
    expect(s.theme.manualTheme).toBe('monsoon');
    expect(s.theme.fallbackTheme).toBe('halo');
  });
});

describe('keys', () => {
  it('normalizes artist and track keys', () => {
    expect(artistKeyOf('Beyoncé feat. Jay-Z')).toBe('artist:beyonce');
    expect(trackKeyOf('A & B', 'Song (feat. C) - 2011 Remaster')).toBe(trackKeyOf('A', 'song'));
    expect(trackKeyOf(undefined, undefined, 'my file.mp3')).toBe('trk:file|my file mp3');
  });
});

describe('settings persistence schema', () => {
  it('sanitizes corrupt or partial JSON into complete settings', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const s = sanitizeSettings({
      theme: { mode: 'manual', manualTheme: 'nope', trackThemes: { a: 'velvet', b: 'bogus' } },
      motion: { intensity: 9, treatment: 'jiggle' },
      timing: { globalOffsetMs: 'x', trackOffsets: { a: 120, b: Infinity } },
      recent: [{ path: '/a.mp3', title: 'A' }, { nope: 1 }],
    });
    expect(s.theme.mode).toBe('manual');
    expect(s.theme.manualTheme).toBe('cypher');
    expect(s.theme.trackThemes).toEqual({ a: 'velvet' });
    expect(s.motion.intensity).toBe(1.5);
    expect(s.motion.treatment).toBe('jiggle');
    expect(s.timing.globalOffsetMs).toBe(0);
    expect(s.timing.trackOffsets).toEqual({ a: 120 });
    expect(s.recent).toHaveLength(1);
  });
});
