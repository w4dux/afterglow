import { describe, expect, it } from 'vitest';
import { parseLyricsfile } from '../src/core/lyrics/lyricsfile';
import { docFromCache, docFromLrclib, lrclibProvider } from '../src/lyrics/LyricsResolver';
const text = `version: '1.0'
metadata:
  title: Song
  artist: Artist
lines:
  - text: Hello world
    start_ms: 1000
    end_ms: 4000
    words:
      - text: 'Hello '
        start_ms: 1000
        end_ms: 1500
      - text: world
        start_ms: 2000
        end_ms: 4000
`;
const source = { kind: 'lrclib' as const, label: 'LRCLIB' };
describe('actual Lyricsfile word timing', () => {
  it('preserves authored pauses, word ends and spaces', () => {
    const d = parseLyricsfile(text, source)!;
    expect(d.timing).toBe('word');
    expect(d.lines[0].words).toEqual([
      { text: 'Hello', startMs: 1000, endMs: 1500, space: true },
      { text: 'world', startMs: 2000, endMs: 4000, space: false },
    ]);
  });
  it('rejects unknown versions, aliases, duplicate keys and oversized documents', () => {
    expect(parseLyricsfile(text.replace("'1.0'", "'9.0'"), source)).toBeNull();
    expect(parseLyricsfile(text + '\nmetadata: {}', source)).toBeNull();
    expect(parseLyricsfile(text + '\na: &a [x]\nb: *a', source)).toBeNull();
    expect(parseLyricsfile('x'.repeat(2000001), source)).toBeNull();
  });
  it('falls back to line timing when word timestamps are invalid', () => {
    expect(parseLyricsfile(text.replace('start_ms: 2000', 'start_ms: -1'), source)?.timing).toBe('line');
  });
  it('uses and caches Lyricsfile rather than discarding word data for LRC', async () => {
    const r = { id: 1, trackName: 'Song', artistName: 'Artist', duration: 200, instrumental: false,
      hasWordSync: true, lyricsfile: text, syncedLyrics: '[00:01.00]Hello world' };
    expect(docFromLrclib(r, 'probable').timing).toBe('word');
    const result = await lrclibProvider({ title: 'Song', artist: 'Artist', durationSec: 200 }, {
      lrclib: async () => ({ ok: true, exact: r, candidates: [] }), readLyricFile: async () => null,
      findLyricsInFolder: async () => null, fetchText: async () => '',
    });
    expect(result.hits[0].raw).toBe(text);
    expect(docFromCache({ savedAt: 0, provider: 'lrclib', format: 'lyricsfile', text, label: 'LRCLIB' })?.timing).toBe('word');
  });
});
