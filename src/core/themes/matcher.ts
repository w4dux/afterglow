import type { LyricAnalysis } from '../lyrics/analysis';
import type { DocTiming } from '../lyrics/model';

export const THEME_IDS = ['cypher', 'nocturne', 'velvet', 'sherbet', 'feedback', 'horizon', 'quiet', 'afterhours', 'riot', 'prism', 'halo', 'monsoon', 'departures', 'haze', 'rave', 'singalong', 'zine'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export function isThemeId(x: unknown): x is ThemeId {
  return typeof x === 'string' && (THEME_IDS as readonly string[]).includes(x);
}

export type GenreSource = 'file-tag' | 'system-media' | 'lyric-file' | 'demo-manifest' | 'user' | 'catalog' | 'catalog-artist';

export interface GenreSignal {
  value: string;
  source: GenreSource;
}

export interface ThemeSignals {
  trackKey: string;
  artistKey?: string;
  artistName?: string;
  genres: GenreSignal[];
  timing: DocTiming;
  analysis?: LyricAnalysis;
}

export interface ThemePrefs {
  mode: 'auto' | 'manual';
  manualTheme: ThemeId;
  fallbackTheme: ThemeId;
  trackThemes: Record<string, ThemeId>;
  artistThemes: Record<string, ThemeId>;
  useArtistPrefs: boolean;
  useSuggestions: boolean;
}

export type DecisionBasis = 'manual' | 'track-choice' | 'artist-choice' | 'known-genre' | 'suggested' | 'fallback';

export interface ThemeDecision {
  themeId: ThemeId;
  basis: DecisionBasis;
  /** Short UI label, e.g. "Known genre · Hip-Hop (file tag)". */
  label: string;
  /** What evidence was used; empty for fallback. */
  evidence: string[];
}

/**
 * Genre keyword table. Ordered: more specific phrases first. Matching is on
 * normalized tokens of the stated genre only — never on titles or artist names.
 */
const GENRE_RULES: [RegExp, ThemeId][] = [
  [/\b(karaoke|sing ?along|show ?tunes?|musicals?|broadway|schlager)\b/, 'singalong'],
  // DIY punk scenes; plain "punk" stays with Feedback
  [/\b(riot ?grrrl|skate ?punk|crust ?punk|crust|anarcho ?punk|hardcore ?punk|garage ?punk|street ?punk|art ?punk|egg ?punk|queercore|d ?beat|diy|zine|noise ?rock)\b/, 'zine'],
  // party before haze, so "Psychedelic Trance" is a festival, not a lava lamp
  [/\b(big ?room|electro ?house|hardstyle|festival|party|club|bounce|moombahton|jersey ?club|baile ?funk|eurodance|hands ?up|trance|psy ?trance|goa)\b/, 'rave'],
  [/\b(stoner|psychedelic|psych|neo ?psychedelia|acid ?rock|space ?rock|chillhop|lo ?fi ?hip ?hop|trip ?hop|downtempo|dub|reggae)\b/, 'haze'],
  [/\b(bangla|bengali|bangladeshi|baul|rabindra ?sangeet|nazrul ?geeti|desi|bollywood|filmi|indian ?pop|ghazal|sufi|qawwali)\b/, 'monsoon'],
  [/\b(emo ?rap|melodic ?rap|sad ?rap|emo ?hip ?hop|cloud ?rap)\b/, 'halo'],
  [/\b(city ?pop|krautrock|motorik|new ?wave|post ?punk|coldwave|minimal ?wave)\b/, 'departures'],
  [/\b(bossa nova|lounge|smooth jazz)\b/, 'afterhours'],
  [/\b(metalcore|hardcore|industrial rock)\b/, 'riot'],
  [/\b(house|nu disco|future funk)\b/, 'prism'],
  [/\b(trap ?soul|neo ?soul|quiet storm|slow jam)\b/, 'velvet'],
  [/\b(pop ?rap)\b/, 'cypher'],
  [/\b(indie ?folk|folk ?rock|chamber ?pop|dream ?pop)\b/, 'horizon'],
  [/\b(pop ?punk|pop ?rock|synth ?rock)\b/, 'feedback'],
  [/\b(synth ?pop|electro ?pop|dance ?pop|k ?pop|j ?pop|hyper ?pop|teen ?pop|bubblegum|disco|dance)\b/, 'sherbet'],
  [/\b(trap|drill|phonk|dark ?electronic|techno|industrial|dubstep|darkwave|synthwave|cyberpunk|witch ?house|bass ?music|drum (and|n) bass|dnb|electronic|electronica|edm)\b/, 'nocturne'],
  [/\b(hip ?hop|rap|boom ?bap|grime|g ?funk|crunk|conscious|gangsta|horrorcore)\b/, 'cypher'],
  [/\b(r ?(&|and|n) ?b|rnb|soul|funk|motown|gospel|jazz|blues|doo ?wop)\b/, 'velvet'],
  [/\b(rock|alternative|alt|indie|punk|grunge|metal|emo|hardcore|garage|post ?punk|shoegaze|noise)\b/, 'feedback'],
  [/\b(ambient|acoustic|folk|singer ?songwriter|classical|chill|lo ?fi|new ?age|post ?rock|piano|soundtrack|score|instrumental|country|bluegrass|meditation)\b/, 'horizon'],
  [/\b(pop|latin|reggaeton|afrobeats?)\b/, 'sherbet'],
];

export function normalizeGenre(g: string): string {
  return g
    .toLowerCase()
    .replace(/[_/\\,;|]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function themeForGenre(genre: string): ThemeId | undefined {
  const g = normalizeGenre(genre);
  if (!g) return undefined;
  for (const [re, id] of GENRE_RULES) if (re.test(g)) return id;
  return undefined;
}

const SOURCE_LABEL: Record<GenreSource, string> = {
  'file-tag': 'file tag',
  'system-media': 'Windows media session',
  'lyric-file': 'lyric file tag',
  'demo-manifest': 'demo metadata',
  user: 'your input',
  catalog: 'Apple catalogue',
  'catalog-artist': "Apple catalogue, this artist's songs",
};

export const THEME_NAMES: Record<ThemeId, string> = {
  cypher: 'Cypher',
  nocturne: 'Nocturne',
  velvet: 'Velvet',
  sherbet: 'Sherbet',
  feedback: 'Feedback',
  horizon: 'Horizon',
  quiet: 'Quiet',
  afterhours: 'Afterhours',
  riot: 'Riot',
  prism: 'Prism',
  halo: 'Halo',
  monsoon: 'Monsoon',
  departures: 'Departures',
  haze: 'Haze',
  rave: 'Rave',
  singalong: 'Singalong',
  zine: 'Zine',
};

/** Thresholds for the lyric-pace suggestion (measured from timed lyrics only). */
export const SUGGEST_FAST_WPS = 3.0;
export const SUGGEST_SPARSE_WPS = 1.1;

export function decideTheme(signals: ThemeSignals, prefs: ThemePrefs): ThemeDecision {
  if (prefs.mode === 'manual') {
    return { themeId: prefs.manualTheme, basis: 'manual', label: `Manual · ${THEME_NAMES[prefs.manualTheme]}`, evidence: [] };
  }
  const t = prefs.trackThemes[signals.trackKey];
  if (t) return { themeId: t, basis: 'track-choice', label: 'Your choice for this track', evidence: ['saved track preference'] };
  if (prefs.useArtistPrefs && signals.artistKey) {
    const a = prefs.artistThemes[signals.artistKey];
    if (a) {
      return {
        themeId: a,
        basis: 'artist-choice',
        label: `Your choice for ${signals.artistName ?? 'this artist'}`,
        evidence: ['saved artist preference'],
      };
    }
  }
  for (const g of signals.genres) {
    const id = themeForGenre(g.value);
    if (id) {
      return {
        themeId: id,
        basis: 'known-genre',
        label: `Known genre · ${g.value.trim()} (${SOURCE_LABEL[g.source]})`,
        evidence: [`genre "${g.value.trim()}" from ${SOURCE_LABEL[g.source]}`],
      };
    }
  }
  if (prefs.useSuggestions && signals.analysis && signals.timing !== 'none') {
    const { medianWps, p80Wps, gapFraction } = signals.analysis;
    if (medianWps !== undefined && p80Wps !== undefined) {
      if (medianWps >= SUGGEST_FAST_WPS && p80Wps >= SUGGEST_FAST_WPS + 0.4) {
        return {
          themeId: 'cypher',
          basis: 'suggested',
          label: `Suggested · fast lyric pace (${medianWps.toFixed(1)} words/s)`,
          evidence: [`median ${medianWps.toFixed(2)} words/s from timed lyrics`, 'not a genre detection'],
        };
      }
      if (medianWps <= SUGGEST_SPARSE_WPS && (gapFraction ?? 0) >= 0.25) {
        return {
          themeId: 'horizon',
          basis: 'suggested',
          label: `Suggested · sparse lyrics (${medianWps.toFixed(1)} words/s)`,
          evidence: [`median ${medianWps.toFixed(2)} words/s, ${Math.round((gapFraction ?? 0) * 100)}% instrumental gaps`, 'not a genre detection'],
        };
      }
    }
  }
  return {
    themeId: prefs.fallbackTheme,
    basis: 'fallback',
    label: signals.genres.length ? `Default · genre "${signals.genres[0].value}" not mapped` : 'Default · no genre information',
    evidence: [],
  };
}

export function artistKeyOf(artist?: string): string | undefined {
  if (!artist) return undefined;
  const primary = artist.split(/\s*(?:,|&|;|\bfeat\.?|\bft\.?|\bfeaturing\b|\bx\b|\bwith\b)\s*/i)[0];
  const k = primary.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return k ? `artist:${k}` : undefined;
}

export function trackKeyOf(artist: string | undefined, title: string | undefined, fallback?: string): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s*[([](?:feat|ft|with|prod|remaster(?:ed)?|\d{4} remaster|explicit|clean|official)[^)\]]*[)\]]/gi, '')
      .replace(/\s+-\s+(?:remaster(?:ed)?|\d{4} remaster(?:ed)?|single version|radio edit|explicit).*$/i, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  if (title && title.trim()) return `trk:${norm(artistKeyOf(artist)?.slice(7) ?? '')}|${norm(title)}`;
  return `trk:file|${norm(fallback ?? 'unknown')}`;
}
