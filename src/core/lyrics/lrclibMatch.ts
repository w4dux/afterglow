import type { LrclibRecord } from '../../shared/api';

/**
 * Choosing among LRCLIB results.
 *
 * A candidate must match the cleaned title and share an artist with the track.
 *  - Tier 1: duration within 3 s → 'probable' (or 'ambiguous' when several versions
 *    with different synced lyrics qualify).
 *  - Tier 2: duration within 15 s → 'loose', shown as "duration differs by N s,
 *    timing may need an offset". Typical cause: radio edit vs album version.
 * Synced lyrics are preferred over plain ones within a tier.
 */
export interface MatchResult {
  best?: LrclibRecord;
  match: 'exact' | 'probable' | 'ambiguous' | 'loose' | 'none';
  /** Candidate duration minus track duration (s), when both are known. */
  durationDeltaSec?: number;
  alternatives: LrclibRecord[];
}

const DECORATION =
  /\s*[([](?:feat\.?|ft\.?|featuring|with|prod\.?|produced|remaster(?:ed)?|\d{4}\s*remaster(?:ed)?|explicit|clean|radio\s*edit|single\s*version|album\s*version|bonus\s*track|mono|stereo|deluxe|original\s*mix|from\s+[^)\]]*)[^)\]]*[)\]]/gi;
const DASH_SUFFIX =
  /\s+[-–—]\s+(?:feat\.?|ft\.?|with|remaster(?:ed)?|\d{4}\s*remaster(?:ed)?|radio\s*edit|single\s*version|album\s*version|bonus\s*track|mono|stereo|explicit|clean|from\s).*$/i;

/** Title without featured artists, remaster/edit/version tags or "from <film>" notes. */
export function cleanTitle(title: string): string {
  return title.replace(DECORATION, '').replace(DASH_SUFFIX, '').replace(/\s+/g, ' ').trim() || title.trim();
}

export function splitArtists(artist: string): string[] {
  return artist
    .split(/\s*(?:,|&|;|\/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|\band\b)\s*/i)
    .map((a) => a.trim())
    .filter(Boolean);
}

export function primaryArtistName(artist: string): string {
  return splitArtists(artist)[0] ?? artist.trim();
}

export function normalizeForMatch(s: string): string {
  return cleanTitle(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function artistsOverlap(a: string, b: string): boolean {
  if (!a || !b) return true; // unknown artist on one side: rely on title + duration
  const A = new Set(splitArtists(a).map(norm));
  const B = splitArtists(b).map(norm);
  if (B.some((x) => A.has(x))) return true;
  const na = norm(a);
  const nb = norm(b);
  return na.includes(norm(primaryArtistName(b))) || nb.includes(norm(primaryArtistName(a)));
}

/** Query variants to try, most specific first, without duplicates. */
export function queryVariants(q: { artist: string; title: string }): { artist: string; title: string }[] {
  const out: { artist: string; title: string }[] = [];
  const add = (artist: string, title: string) => {
    if (!title) return;
    if (!out.some((v) => v.artist === artist && v.title === title)) out.push({ artist, title });
  };
  add(q.artist, q.title);
  add(primaryArtistName(q.artist), cleanTitle(q.title));
  return out;
}

export function pickLrclib(records: LrclibRecord[], q: { artist: string; title: string; durationSec?: number }): MatchResult {
  const t = normalizeForMatch(q.title);
  const seen = new Set<number>();
  const named = records.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return normalizeForMatch(r.trackName) === t && artistsOverlap(q.artist, r.artistName);
  });
  if (named.length === 0) return { match: 'none', alternatives: [] };
  const delta = (r: LrclibRecord) => (q.durationSec && r.duration ? r.duration - q.durationSec : undefined);
  const within = (r: LrclibRecord, s: number) => {
    const d = delta(r);
    return d === undefined || Math.abs(d) <= s;
  };
  const score = (r: LrclibRecord) => (r.syncedLyrics ? 0 : 1000) + (r.instrumental ? 500 : 0) + Math.abs(delta(r) ?? 5);
  const tight = named.filter((r) => within(r, 3)).sort((x, y) => score(x) - score(y));
  if (tight.length) {
    const distinct = new Set(tight.filter((r) => r.syncedLyrics).map((r) => norm(r.syncedLyrics ?? '').slice(0, 400)));
    return { best: tight[0], match: distinct.size > 1 ? 'ambiguous' : 'probable', durationDeltaSec: delta(tight[0]), alternatives: [...tight.slice(1), ...named.filter((r) => !tight.includes(r))].slice(0, 6) };
  }
  const loose = named.filter((r) => within(r, 15)).sort((x, y) => score(x) - score(y));
  if (loose.length) return { best: loose[0], match: 'loose', durationDeltaSec: delta(loose[0]), alternatives: loose.slice(1, 6) };
  return { match: 'none', alternatives: named.slice(0, 6) };
}
