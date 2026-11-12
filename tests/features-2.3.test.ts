import { describe, expect, it } from 'vitest';
import { artistGenre, catalogLengthGap, matchCatalog } from '../src/core/lyrics/catalog';
import { lengthWindow } from '../src/core/lyrics/length';
import { parseTtml } from '../src/core/lyrics/ttml';
import { themeForGenre } from '../src/core/themes/matcher';
import type { CatalogEntry } from '../src/shared/api';
import { frameDivisorFor } from '../src/stage/runtime';

describe('frame pacing', () => {
  it('draws every frame on ordinary displays, about 60 fps on fast ones, about 30 on battery', () => {
    expect(frameDivisorFor(60, false)).toBe(1);
    expect(frameDivisorFor(75, false)).toBe(1); // 75 -> 60 would judder; keep every frame
    expect(frameDivisorFor(120, false)).toBe(2);
    expect(frameDivisorFor(144, false)).toBe(2); // 72 fps
    expect(frameDivisorFor(240, false)).toBe(4);
    expect(frameDivisorFor(60, true)).toBe(2);
    expect(frameDivisorFor(75, true)).toBe(3); // 25 fps
    expect(frameDivisorFor(144, true)).toBe(5);
    expect(frameDivisorFor(0, true)).toBe(1); // not measured yet
  });
});

const SRC = { kind: 'amll' as const, label: 'AMLL TTML DB' };

describe('TTML duets and translations', () => {
  const duet = `<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><head><metadata>
      <ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/><ttm:agent type="group" xml:id="v1000"/>
    </metadata></head><body><div>
      <p begin="1s" end="3s" ttm:agent="v1"><span begin="1s" end="2s">first</span> <span begin="2s" end="3s">singer</span><span ttm:role="x-translation" xml:lang="en">first translation</span></p>
      <p begin="4s" end="6s" ttm:agent="v2"><span begin="4s" end="5s">second</span> <span begin="5s" end="6s">singer</span><span ttm:role="x-roman">daini</span></p>
      <p begin="7s" end="9s" ttm:agent="v1000"><span begin="7s" end="9s">together</span></p>
    </div></body></tt>`;

  it('numbers singers, marks group lines, and keeps translations out of the sung words', () => {
    const doc = parseTtml(duet, SRC);
    expect(doc.lines.map((l) => l.voice)).toEqual([1, 2, 0]);
    expect(doc.lines[0].text).toBe('first singer');
    expect(doc.lines[0].translation).toBe('first translation');
    expect(doc.lines[1].romanization).toBe('daini');
    expect(doc.lines[1].translation).toBeUndefined();
    expect(doc.timing).toBe('word');
  });

  it('reads Apple-style translations from the head, matched by line key', () => {
    const apple = `<tt><head><metadata><iTunesMetadata><translations><translation xml:lang="en">
        <text for="L1">hello there</text><text for="L2"><span>second</span> line</text>
      </translation></translations></iTunesMetadata></metadata></head><body><div>
      <p begin="1s" end="2s" itunes:key="L1"><span begin="1s" end="2s">hola</span></p>
      <p begin="3s" end="4s" itunes:key="L2"><span begin="3s" end="4s">segunda</span></p>
    </div></body></tt>`;
    const doc = parseTtml(apple, SRC);
    expect(doc.lines.map((l) => l.translation)).toEqual(['hello there', 'second line']);
    expect(doc.lines[0].text).toBe('hola');
  });

  it('gives no voices when only one singer is named', () => {
    const solo = `<tt><body><div><p begin="1s" end="2s" ttm:agent="v1"><span begin="1s" end="2s">alone</span></p></div></body></tt>`;
    expect(parseTtml(solo, SRC).lines[0].voice).toBeUndefined();
  });
});

describe("Apple catalogue (genre, length)", () => {
  // Real values from Apple's iTunes Search API, 2026-11-09.
  const entries: CatalogEntry[] = [
    { title: 'Orbiter', artist: 'Noah Kahan', album: 'The Great Divide: The Last Of The Bugs', genre: 'Alternative', durationSec: 287.0 },
    { title: 'Coming Up Roses', artist: 'Harry Styles', album: 'Kiss All The Time. Disco, Occasionally.', genre: 'Pop', durationSec: 248.9 },
    { title: 'Mask Off (Marshmello Remix)', artist: 'Future', album: 'Mask Off (Marshmello Remix) - Single', genre: 'Hip-Hop/Rap', durationSec: 180.8 },
  ];
  const spotify = (title: string, artist: string, album: string, reported: number) => ({ title, artist, album, reportedDurationSec: reported, lengthWindowSec: lengthWindow(reported), lengthMayBeShort: true });

  it('matches the same song and album despite the player reporting it 5 s short', () => {
    const q = spotify('Orbiter', 'Noah Kahan', 'The Great Divide: The Last Of The Bugs', 281.967);
    const m = matchCatalog(entries, q)!;
    expect(m.entry.genre).toBe('Alternative');
    expect(m.albumMatch).toBe(true);
    expect(catalogLengthGap(m, q.reportedDurationSec)).toBeCloseTo(5.03, 2);
  });

  it('does not take a remix or another artist', () => {
    expect(matchCatalog(entries, spotify('Mask Off', 'Future', 'FUTURE', 199.6))).toBeNull();
    expect(matchCatalog(entries, spotify('Orbiter', 'Someone Else', 'X', 281.967))).toBeNull();
  });

  it('only learns a length gap from the same album and a plausible range', () => {
    const m = matchCatalog(entries, spotify('Coming Up Roses', 'Harry Styles', 'Some Compilation', 243.867))!;
    expect(m.albumMatch).toBe(false);
    expect(catalogLengthGap(m, 243.867)).toBeUndefined();
    expect(catalogLengthGap({ entry: entries[0], score: 98, albumMatch: true }, 250)).toBeUndefined(); // 37 s: not a crossfade
  });

  it("falls back to the genre of the artist's own songs, clearly separated from the song's", () => {
    // Real result for "Polo G OMG" (2026-11-09): the song itself is not returned.
    const polo: CatalogEntry[] = [
      { title: '21', artist: 'Polo G', album: 'THE GOAT', genre: 'Hip-Hop/Rap' },
      { title: 'Heartbroken', artist: 'Diplo, Jessie Murph & Polo G', genre: 'Country' },
      { title: 'Better Days', artist: 'NEIKED, Mae Muller & Polo G', genre: 'Pop' },
      { title: 'Martin & Gina', artist: 'Polo G', genre: 'Hip-Hop/Rap' },
      { title: 'RAPSTAR', artist: 'Polo G', genre: 'Hip-Hop/Rap' },
      { title: 'I Know', artist: 'Polo G', genre: 'Hip-Hop/Rap' },
    ];
    expect(matchCatalog(polo, spotify('OMG', 'Polo G', 'OMG', 173.3))).toBeNull();
    expect(artistGenre(polo, 'Polo G')).toBe('Hip-Hop/Rap');
    expect(artistGenre(polo.slice(0, 3), 'Polo G')).toBeUndefined(); // one own song is not enough
    expect(artistGenre([...polo, { title: 'x', artist: 'Polo G', genre: 'Pop' }, { title: 'y', artist: 'Polo G', genre: 'Pop' }], 'Polo G')).toBeUndefined(); // mixed
  });

  it("maps Apple's genre names to themes", () => {
    expect(themeForGenre('Hip-Hop/Rap')).toBe('cypher');
    expect(themeForGenre('R&B/Soul')).toBe('velvet');
    expect(themeForGenre('Alternative')).toBe('feedback');
    expect(themeForGenre('Pop')).toBe('sherbet');
    expect(themeForGenre('Singer/Songwriter')).toBe('horizon');
    expect(themeForGenre('Electronic')).toBe('nocturne');
  });
});
