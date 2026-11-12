import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEME_IDS, THEME_NAMES, themeForGenre } from '../src/core/themes/matcher';

describe('2.5.0 genre rules for the new themes', () => {
  it.each([
    ['Psychedelic', 'haze'],
    ['Psychedelic Rock', 'haze'],
    ['Stoner Rock', 'haze'],
    ['Neo-Psychedelia', 'haze'],
    ['Reggae', 'haze'],
    ['Dub', 'haze'],
    ['Lo-Fi Hip Hop', 'haze'],
    ['Chillhop', 'haze'],
    ['Trip-Hop', 'haze'],
    ['Downtempo', 'haze'],
    ['Big Room', 'rave'],
    ['Electro House', 'rave'],
    ['Hardstyle', 'rave'],
    ['Trance', 'rave'],
    ['Psychedelic Trance', 'rave'],
    ['Psytrance', 'rave'],
    ['Party', 'rave'],
    ['Baile Funk', 'rave'],
    ['Eurodance', 'rave'],
    ['Karaoke', 'singalong'],
    ['Musicals', 'singalong'],
    ['Show Tunes', 'singalong'],
    ['Sing-Along', 'singalong'],
    ['Schlager', 'singalong'],
  ])('%s -> %s', (g, id) => expect(themeForGenre(g)).toBe(id));

  it.each([
    ['Reggaeton', 'sherbet'],
    ['Dubstep', 'nocturne'],
    ['Lo-Fi', 'horizon'],
    ['Hip-Hop/Rap', 'cypher'],
    ['House', 'prism'],
    ['Dance', 'sherbet'],
    ['Electronic', 'nocturne'],
    ['Soundtrack', 'horizon'],
  ])('leaves %s on %s', (g, id) => expect(themeForGenre(g)).toBe(id));

  it('names every theme', () => {
    for (const id of THEME_IDS) expect(THEME_NAMES[id]).toBeTruthy();
    expect(THEME_IDS).toEqual(expect.arrayContaining(['haze', 'rave', 'singalong']));
  });
});

describe('theme stylesheets', () => {
  // While 2.5.0 was being built, Haze first used the "hz-" prefix Horizon already had, and
  // the two stylesheets overrode each other's lyric rows. Each theme owns its class prefix.
  it('never share a class prefix between two themes', () => {
    const dir = new URL('../src/themes/', import.meta.url);
    const shared = new Set(['is', 'has', 'in', 'est', 'voice']);
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.css') && n !== 'refinements.css')) {
      const css = readFileSync(new URL(name, dir), 'utf8');
      const prefixes = new Set([...css.matchAll(/^\.([a-z]+)-/gm)].map((m) => m[1]).filter((p) => !shared.has(p)));
      for (const p of prefixes) {
        const first = owner.get(p);
        if (first && first !== name) clashes.push(`${p}- in ${first} and ${name}`);
        else owner.set(p, name);
      }
    }
    expect(clashes).toEqual([]);
  });
});
