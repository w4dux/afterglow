import { normalizeLineText } from './analysis';
import { cleanTitle, primaryArtistName, splitArtists } from './lrclibMatch';
import type { DocTiming, LyricDocument } from './model';

/**
 * Metadata scoring and multi-source selection.
 *
 * Every online provider's candidates are scored the same way (0-100) from title,
 * artist, duration and album similarity; a shared ID (ISRC / Spotify ID) is a 100.
 * Selection prefers word-timed lyrics when their match is nearly as strong, and
 * cross-checks two synced sources so a different recording's timing is not chosen.
 */

export interface TrackQuery {
  title: string;
  artist: string;
  album?: string;
  /** Best known real length (s). Undefined when only a range is known (see lengthWindowSec). */
  durationSec?: number;
  /** Length the player reported (s), which may be short (crossfade); see core/lyrics/length. */
  reportedDurationSec?: number;
  /** When the real length is only known to lie in a range, any length inside it matches fully. */
  lengthWindowSec?: [number, number];
  /** The player may report a shortened length (system media sessions); measure the gap when possible. */
  lengthMayBeShort?: boolean;
  isrc?: string;
  spotifyId?: string;
}

export interface CandidateMeta {
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  isrc?: string;
  spotifyId?: string;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(norm(s).split(' ').filter(Boolean));
}

export function titleSimilarity(a: string, b: string): number {
  const x = norm(cleanTitle(a));
  const y = norm(cleanTitle(b));
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85 * (Math.min(x.length, y.length) / Math.max(x.length, y.length)) + 0.1;
  const A = tokens(x);
  const B = tokens(y);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const jac = inter / (A.size + B.size - inter);
  return jac * 0.8;
}

export function artistSimilarity(a: string, b: string): number {
  if (!a.trim() || !b.trim()) return 0.6; // unknown on one side: neutral
  const A = splitArtists(a).map(norm);
  const B = splitArtists(b).map(norm);
  if (norm(primaryArtistName(a)) === norm(primaryArtistName(b))) return 1;
  if (A.some((x) => B.includes(x))) return 0.85;
  const na = norm(a);
  const nb = norm(b);
  if (na.includes(norm(primaryArtistName(b))) || nb.includes(norm(primaryArtistName(a)))) return 0.7;
  return 0;
}

export function durationSimilarity(a?: number, b?: number): number {
  if (!a || !b) return 0.6;
  return lengthSimilarity(Math.abs(a - b));
}

/** Similarity from an absolute length difference (s). */
export function lengthSimilarity(d: number): number {
  if (d <= 2) return 1;
  if (d <= 4) return 0.85;
  if (d <= 8) return 0.55;
  if (d <= 15) return 0.25;
  return 0;
}

/**
 * Candidate length minus the track's real length (s): against the best known length,
 * or against the plausible range when only a range is known (0 inside it).
 * Undefined when either side is unknown.
 */
export function lengthDeltaSec(q: TrackQuery, candidateSec?: number): number | undefined {
  if (!candidateSec || !Number.isFinite(candidateSec)) return undefined;
  if (q.durationSec) return candidateSec - q.durationSec;
  const w = q.lengthWindowSec;
  if (w) return candidateSec < w[0] ? candidateSec - w[0] : candidateSec > w[1] ? candidateSec - w[1] : 0;
  return undefined;
}

/** Version words that mean different audio (timing cannot carry over). */
const DIFFERENT_AUDIO = /\b(live|remix|instrumental|karaoke|acoustic|sped\s*up|slowed)\b/g;
/** Version words for the same performance (edited or censored): a small penalty only. */
const SAME_AUDIO = /\b(radio\s*edit|clean)\b/g;
const versionTags = (x: string, re: RegExp) => (x.toLowerCase().match(re) ?? []).map((v) => v.replace(/\s+/g, ' ')).sort().join('|');

export function scoreCandidate(q: TrackQuery, c: CandidateMeta): number {
  if ((q.isrc && c.isrc && q.isrc.toUpperCase() === c.isrc.toUpperCase()) || (q.spotifyId && c.spotifyId && q.spotifyId === c.spotifyId)) return 100;
  const t = titleSimilarity(q.title, c.title);
  if (t < 0.5) return Math.round(t * 40); // different song: cap low regardless of artist
  const ar = artistSimilarity(q.artist, c.artist);
  if (ar === 0 && q.artist.trim() && c.artist.trim()) return 0;
  const dd = lengthDeltaSec(q, c.durationSec);
  if (dd !== undefined && Math.abs(dd) > 15) return 0;
  if (versionTags(q.title, DIFFERENT_AUDIO) !== versionTags(c.title, DIFFERENT_AUDIO)) return 0;
  const sameAudioPenalty = versionTags(q.title, SAME_AUDIO) !== versionTags(c.title, SAME_AUDIO) ? 10 : 0;
  const du = dd === undefined ? 0.6 : lengthSimilarity(Math.abs(dd));
  const al = q.album && c.album ? (norm(cleanTitle(q.album)) === norm(cleanTitle(c.album)) ? 1 : 0.4) : 0.6;
  return Math.max(0, Math.round(100 * (0.4 * t + 0.35 * ar + 0.2 * du + 0.05 * al)) - sameAudioPenalty);
}

/** Line-start agreement between two synced documents (matched by normalized text, in order). */
export function crossCheck(a: LyricDocument, b: LyricDocument): { matched: number; medianDeltaMs: number | null } {
  const deltas: number[] = [];
  let j = 0;
  const bl = b.lines.map((l) => normalizeLineText(l.text));
  for (const la of a.lines) {
    const ka = normalizeLineText(la.text);
    if (!ka) continue;
    for (let k = j; k < Math.min(b.lines.length, j + 6); k++) {
      if (bl[k] === ka) {
        deltas.push(la.startMs - b.lines[k].startMs);
        j = k + 1;
        break;
      }
    }
  }
  if (!deltas.length) return { matched: 0, medianDeltaMs: null };
  deltas.sort((x, y) => x - y);
  return { matched: deltas.length, medianDeltaMs: deltas[Math.floor(deltas.length / 2)] };
}

/**
 * Among several synced versions of the same song (e.g. multiple LRCLIB uploads),
 * the version whose line timing is most central: the smallest median offset to all
 * the others it shares lines with. Ties go to the first (best-scored) one. Protects
 * against badly-timed uploads, including when uploads are spread out in time.
 */
export function consensusIndex(docs: LyricDocument[]): number {
  if (docs.length < 3) return 0;
  let best = 0;
  let bestSpread = Infinity;
  docs.forEach((d, i) => {
    const offsets: number[] = [];
    docs.forEach((e, k) => {
      if (k === i) return;
      const c = crossCheck(d, e);
      if (c.matched >= 4 && c.medianDeltaMs !== null) offsets.push(Math.abs(c.medianDeltaMs));
    });
    // must share lines with at least half of the others to speak for them
    if (offsets.length * 2 < docs.length - 1) return;
    offsets.sort((a, b) => a - b);
    const spread = offsets[Math.floor((offsets.length - 1) / 2)];
    if (spread < bestSpread - 1) {
      bestSpread = spread;
      best = i;
    }
  });
  return best;
}

export interface ProviderHit {
  provider: string;
  doc: LyricDocument;
  score: number;
  /** Candidate duration minus track duration (s), when both are known. */
  durationDeltaSec?: number;
  /** Original text, for caching. */
  raw?: string;
}

const timingRank = (t: DocTiming) => (t === 'word' ? 2 : t === 'line' ? 1 : 0);

export const MATCH_THRESHOLD = 70;
export const LOOSE_THRESHOLD = 55;
const WORD_BONUS = 8;

/**
 * Choose the hit to display. Strong matches (>= 70) beat weak ones; within them,
 * word timing wins if its score is within 8 points of the best line-timed hit.
 * If the chosen word-timed hit disagrees with a line-timed hit by more than 1.5 s
 * (median line offset), the one whose duration matches better is used instead.
 */
export function chooseHit(hits: ProviderHit[]): { hit: ProviderHit; loose: boolean; crossCheckMs?: number } | null {
  const synced = hits.filter((h) => h.doc.timing !== 'none' && h.doc.lines.length > 0);
  const pool = synced.filter((h) => h.score >= MATCH_THRESHOLD);
  const loose = pool.length === 0;
  const candidates = (loose ? synced.filter((h) => h.score >= LOOSE_THRESHOLD) : pool).slice();
  if (!candidates.length) return null;
  const eff = (h: ProviderHit) => h.score + (h.doc.timing === 'word' ? WORD_BONUS : 0);
  candidates.sort((a, b) => eff(b) - eff(a) || timingRank(b.doc.timing) - timingRank(a.doc.timing));
  let chosen = candidates[0];
  let crossCheckMs: number | undefined;
  const other = candidates.find((h) => h !== chosen && h.provider !== chosen.provider);
  if (other) {
    const c = crossCheck(chosen.doc, other.doc);
    if (c.matched >= 5 && c.medianDeltaMs !== null) {
      crossCheckMs = c.medianDeltaMs;
      if (Math.abs(c.medianDeltaMs) > 1500) {
        const da = Math.abs(chosen.durationDeltaSec ?? 99);
        const db = Math.abs(other.durationDeltaSec ?? 99);
        if (db < da) chosen = other;
      }
    }
  }
  return { hit: chosen, loose, crossCheckMs };
}
