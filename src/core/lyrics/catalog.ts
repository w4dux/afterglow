import type { CatalogEntry } from '../../shared/api';
import { MAX_SHORTFALL_SEC, SHORT_SLACK_SEC } from './length';
import { cleanTitle, primaryArtistName } from './lrclibMatch';
import { type TrackQuery, scoreCandidate } from './match';

export interface CatalogMatch {
  entry: CatalogEntry;
  score: number;
  /** Same album name: the same release, so its length and artwork apply. */
  albumMatch: boolean;
}

const norm = (s?: string) => (s ? cleanTitle(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '');

/**
 * The catalogue entry for this song: title and artist must match strongly (score ≥ 80
 * on the same scale as lyric matching, length included when known). An entry from the
 * same album wins over a compilation or a single.
 */
export function matchCatalog(entries: CatalogEntry[], q: TrackQuery): CatalogMatch | null {
  let best: CatalogMatch | null = null;
  for (const entry of entries) {
    const score = scoreCandidate(q, { title: entry.title, artist: entry.artist, album: entry.album, durationSec: entry.durationSec });
    if (score < 80) continue;
    const albumMatch = !!q.album && !!entry.album && norm(q.album) === norm(entry.album);
    if (!best || Number(albumMatch) > Number(best.albumMatch) || (albumMatch === best.albumMatch && score > best.score)) best = { entry, score, albumMatch };
  }
  return best;
}

/**
 * When the song itself is not in the results: the genre Apple states for this artist's
 * own songs, if at least 3 of them are listed and three quarters share one genre.
 * Labelled as the artist's genre, not the song's.
 */
export function artistGenre(entries: CatalogEntry[], artist: string): string | undefined {
  const a = norm(primaryArtistName(artist));
  if (!a) return undefined;
  const own = entries.filter((e) => e.genre && norm(primaryArtistName(e.artist)) === a);
  if (own.length < 3) return undefined;
  const counts = new Map<string, number>();
  for (const e of own) counts.set(e.genre!, (counts.get(e.genre!) ?? 0) + 1);
  const [genre, n] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
  return n * 4 >= own.length * 3 ? genre : undefined;
}

/**
 * Gap between the catalogue length and the player's reported length (s), as evidence
 * for the per-player length correction. Only from the same album, and only within the
 * plausible range (a player reports at most its crossfade short).
 */
export function catalogLengthGap(m: CatalogMatch | null, reportedSec?: number): number | undefined {
  if (!m?.albumMatch || !m.entry.durationSec || !reportedSec) return undefined;
  const gap = m.entry.durationSec - reportedSec;
  return gap >= -SHORT_SLACK_SEC && gap <= MAX_SHORTFALL_SEC ? gap : undefined;
}
