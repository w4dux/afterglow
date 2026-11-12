import { CollectionScene, COLLECTION_FONTS } from './collection';
import './collection.css';
import { DEPARTURES_FONT, DeparturesScene } from './departures';
import { HALO_FONT, HaloScene } from './halo';
import { MONSOON_FONT, MonsoonScene } from './monsoon';
import { HAZE_FONT, HazeScene } from './haze';
import { RAVE_FONT, RaveScene } from './rave';
import { SINGALONG_FONT, SingalongScene } from './singalong';
import { ZINE_CUTS, ZINE_FONT, ZineScene } from './zine';
import './zine.css';
import './haze.css';
import './rave.css';
import './singalong.css';
import './halo.css';
import './monsoon.css';
import './departures.css';
import type { ThemeId } from '../core/themes/matcher';
import type { FontSpec } from '../stage/layout';
import type { Scene, SceneContext } from '../stage/scene';
import { CypherScene } from './cypher';
import { FeedbackScene } from './feedback';
import { HorizonScene } from './horizon';
import { NocturneScene } from './nocturne';
import { QuietScene } from './quiet';
import { SherbetScene } from './sherbet';
import { VelvetScene } from './velvet';
import './nocturne.css';
import './velvet.css';
import './sherbet.css';
import './feedback.css';
import './horizon.css';
import './quiet.css';
import './refinements.css';

export interface ThemeDef {
  id: ThemeId;
  name: string;
  genre: string;
  tagline: string;
  /** Fonts to load before the scene lays out text. */
  fonts: FontSpec[];
  swatch: [string, string, string];
  /** Chrome (controls) tone over this theme. */
  tone: 'dark' | 'light';
  /** Demo used for the gallery preview and the time shown in the static thumbnail. */
  previewDemo: string;
  previewAtMs: number;
  create(host: HTMLElement, ctx: SceneContext): Scene;
}

const mono: FontSpec = { family: 'JetBrains Mono Variable', weight: 600, lineHeight: 1.3 };

export const THEMES: Record<ThemeId, ThemeDef> = {
  cypher: {
    id: 'cypher',
    name: 'Cypher',
    genre: 'Rap · Hip-hop',
    tagline: 'Poster-stacked bars that punch in on every word.',
    fonts: [{ family: 'Anton', weight: 400, lineHeight: 0.93 }, mono],
    swatch: ['#0d0d0d', '#ffd60a', '#f2efe6'],
    tone: 'dark',
    previewDemo: 'night-shift',
    previewAtMs: 6300,
    create: (h, c) => new CypherScene(h, c),
  },
  nocturne: {
    id: 'nocturne',
    name: 'Nocturne',
    genre: 'Trap · Dark electronic',
    tagline: 'Chrome type, black space, a single laser line.',
    fonts: [{ family: 'Unbounded Variable', weight: 600, lineHeight: 1.05 }, mono],
    swatch: ['#000000', '#c8d3e0', '#8a5cff'],
    tone: 'dark',
    previewDemo: 'chrome-hours',
    previewAtMs: 5200,
    create: (h, c) => new NocturneScene(h, c),
  },
  velvet: {
    id: 'velvet',
    name: 'Velvet',
    genre: 'R&B · Soul',
    tagline: 'Candlelit serif italics that flow like a slow jam.',
    fonts: [{ family: 'Fraunces Variable', weight: 380, style: 'italic', lineHeight: 1.08 }],
    swatch: ['#2a0f2e', '#c4622d', '#f6c7a1'],
    tone: 'dark',
    previewDemo: 'slow-honey',
    previewAtMs: 5200,
    create: (h, c) => new VelvetScene(h, c),
  },
  sherbet: {
    id: 'sherbet',
    name: 'Sherbet',
    genre: 'Pop',
    tagline: 'Sticker cards, colour wipes and a bouncing bubble.',
    fonts: [{ family: 'Bricolage Grotesque Variable', weight: 800, lineHeight: 1.0 }],
    swatch: ['#ff3d7f', '#2f6bff', '#ffcf00'],
    tone: 'dark',
    previewDemo: 'sugar-signal',
    previewAtMs: 5100,
    create: (h, c) => new SherbetScene(h, c),
  },
  feedback: {
    id: 'feedback',
    name: 'Feedback',
    genre: 'Rock · Alternative',
    tagline: 'Photocopied gig-poster ink with misregistered hits.',
    fonts: [{ family: 'Big Shoulders Display Variable', weight: 900, lineHeight: 0.9 }, mono],
    swatch: ['#e8e2d4', '#111111', '#d7261e'],
    tone: 'light',
    previewDemo: 'static-hearts',
    previewAtMs: 4300,
    create: (h, c) => new FeedbackScene(h, c),
  },
  horizon: {
    id: 'horizon',
    name: 'Horizon',
    genre: 'Ambient · Acoustic',
    tagline: 'Cinematic negative space and slow breathing light.',
    fonts: [{ family: 'Instrument Serif', weight: 400, lineHeight: 1.12 }, { family: 'Instrument Serif', weight: 400, style: 'italic', lineHeight: 1.12 }],
    swatch: ['#1d2b3a', '#f2c8a0', '#7f9db5'],
    tone: 'dark',
    previewDemo: 'low-tide',
    previewAtMs: 9500,
    create: (h, c) => new HorizonScene(h, c),
  },
  quiet: {
    id: 'quiet',
    name: 'Quiet',
    genre: 'Minimal fallback',
    tagline: 'Plain, calm and readable. Lowest CPU.',
    fonts: [{ family: 'Inter Variable', weight: 600, lineHeight: 1.2 }],
    swatch: ['#111214', '#ffffff', '#8b8f98'],
    tone: 'dark',
    previewDemo: 'night-shift',
    previewAtMs: 8300,
    create: (h, c) => new QuietScene(h, c),
  },
  afterhours: {
    id: 'afterhours', name: 'Afterhours', genre: 'Lounge · Jazz · Slow soul',
    tagline: 'Warm grooves, golden serif type, one more side.',
    fonts: [COLLECTION_FONTS.afterhours, mono], swatch: ['#21151d', '#c7985c', '#ecd6b3'],
    tone: 'dark', previewDemo: 'slow-honey', previewAtMs: 5200,
    create: (h, c) => new CollectionScene(h, c, 'afterhours'),
  },
  riot: {
    id: 'riot', name: 'Riot', genre: 'Punk · Hardcore · Metal',
    tagline: 'Acid-yellow ink. Basement-show energy.',
    fonts: [COLLECTION_FONTS.riot, mono], swatch: ['#101310', '#d5fa3b', '#e9edda'],
    tone: 'dark', previewDemo: 'static-hearts', previewAtMs: 4300,
    create: (h, c) => new CollectionScene(h, c, 'riot'),
  },
  prism: {
    id: 'prism', name: 'Prism', genre: 'House · Disco · Electronic pop',
    tagline: 'Cobalt type, coral geometry, full-colour sound.',
    fonts: [COLLECTION_FONTS.prism, mono], swatch: ['#1838db', '#ff745b', '#e9fa9c'],
    tone: 'dark', previewDemo: 'sugar-signal', previewAtMs: 5100,
    create: (h, c) => new CollectionScene(h, c, 'prism'),
  },
  halo: {
    id: 'halo', name: 'Halo', genre: 'Melodic rap · Emo rap · Sad trap',
    tagline: 'A ring of light; words come into focus as they’re sung.',
    fonts: [HALO_FONT, mono], swatch: ['#07081a', '#8f7bff', '#f4f2ff'],
    tone: 'dark', previewDemo: 'chrome-hours', previewAtMs: 5200,
    create: (h, c) => new HaloScene(h, c),
  },
  monsoon: {
    id: 'monsoon', name: 'Monsoon', genre: 'Bangla · Desi · Rainy-night ballads',
    tagline: 'Rain on the window; each word clears on the glass.',
    fonts: [MONSOON_FONT, mono], swatch: ['#0b1820', '#ffb35c', '#f1ece3'],
    tone: 'dark', previewDemo: 'slow-honey', previewAtMs: 5200,
    create: (h, c) => new MonsoonScene(h, c),
  },
  departures: {
    id: 'departures', name: 'Departures', genre: 'New wave · City pop · Post-punk',
    tagline: 'A station board; every word flips in on its tile.',
    fonts: [DEPARTURES_FONT, mono], swatch: ['#0d0e10', '#ffb627', '#f2efe8'],
    tone: 'dark', previewDemo: 'night-shift', previewAtMs: 6300,
    create: (h, c) => new DeparturesScene(h, c),
  },
  haze: {
    id: 'haze', name: 'Haze', genre: 'Psychedelic · Stoner · Lo-fi · Reggae',
    tagline: 'Lava-lamp colour, floating 70s letters, lines that drift off like smoke.',
    fonts: [HAZE_FONT, mono], swatch: ['#160d26', '#ff5fa2', '#43e6c3'],
    tone: 'dark', previewDemo: 'low-tide', previewAtMs: 9500,
    create: (h, c) => new HazeScene(h, c),
  },
  rave: {
    id: 'rave', name: 'Rave', genre: 'Party · Club · EDM · Festival',
    tagline: 'Lasers over the crowd; every word hits, the chorus brings confetti.',
    fonts: [RAVE_FONT, mono], swatch: ['#050309', '#ff2bd6', '#3fe0ff'],
    tone: 'dark', previewDemo: 'chrome-hours', previewAtMs: 5200,
    create: (h, c) => new RaveScene(h, c),
  },
  singalong: {
    id: 'singalong', name: 'Singalong', genre: 'Karaoke · Party · Everyone sings',
    tagline: 'Two rows, colour fill and a bouncing ball, like a karaoke night.',
    fonts: [SINGALONG_FONT, mono], swatch: ['#0b1a5c', '#ffd23f', '#ffffff'],
    tone: 'dark', previewDemo: 'sugar-signal', previewAtMs: 5100,
    create: (h, c) => new SingalongScene(h, c),
  },
  zine: {
    id: 'zine', name: 'Zine', genre: 'Punk · DIY · Garage · Riot grrrl',
    tagline: 'A cut-and-paste fanzine; every word is slapped down as it’s sung.',
    fonts: [ZINE_FONT, ...ZINE_CUTS], swatch: ['#e9e6df', '#111111', '#ff2e88'],
    tone: 'light', previewDemo: 'static-hearts', previewAtMs: 4300,
    create: (h, c) => new ZineScene(h, c),
  },
};

/** Keys 1–9 and 0 select the first ten; the rest are in the theme library (T). */
export const THEME_ORDER: ThemeId[] = ['cypher', 'nocturne', 'velvet', 'sherbet', 'feedback', 'horizon', 'quiet', 'afterhours', 'riot', 'prism', 'halo', 'monsoon', 'departures', 'haze', 'rave', 'singalong', 'zine'];
/** Themes added in the latest releases, marked "NEW" in the library. */
export const NEW_THEMES: ThemeId[] = ['haze', 'rave', 'singalong', 'zine'];
