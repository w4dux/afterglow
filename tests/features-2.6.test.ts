import { describe, expect, it } from 'vitest';
import { THEME_IDS, THEME_NAMES, themeForGenre } from '../src/core/themes/matcher';

describe('2.6.0 Zine genre rules', () => {
  it.each([
    ['Riot Grrrl', 'zine'],
    ['Skate Punk', 'zine'],
    ['Crust Punk', 'zine'],
    ['Anarcho-Punk', 'zine'],
    ['Hardcore Punk', 'zine'],
    ['Garage Punk', 'zine'],
    ['Street Punk', 'zine'],
    ['Art Punk', 'zine'],
    ['Egg Punk', 'zine'],
    ['D-Beat', 'zine'],
    ['DIY', 'zine'],
    ['Noise Rock', 'zine'],
  ])('%s -> %s', (g, id) => expect(themeForGenre(g)).toBe(id));

  it.each([
    // plain punk and the neighbours keep their themes
    ['Punk', 'feedback'],
    ['Pop Punk', 'feedback'],
    ['Rock', 'feedback'],
    ['Post-Punk', 'departures'],
    ['Metalcore', 'riot'],
    ['Hardcore', 'riot'],
    ['Noise', 'feedback'],
  ])('leaves %s on %s', (g, id) => expect(themeForGenre(g)).toBe(id));

  it('names Zine', () => {
    expect(THEME_IDS).toContain('zine');
    expect(THEME_NAMES.zine).toBe('Zine');
  });
});
