import { net } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { scoreCandidate, type TrackQuery } from '../src/core/lyrics/match';
import { libraryDir } from './library';
import type { AmllHit, AmllResponse } from '../src/shared/api';

/**
 * AMLL TTML DB (github.com/amll-dev/amll-ttml-db): a community database of
 * word-timed TTML lyrics, released under CC0 1.0. The ~1.7 MB index is downloaded
 * once, refreshed every 3 days, and matched locally, so only the chosen song's file
 * is requested. Index and files are cached in userData for offline use.
 */
const BASE = 'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main';
const INDEX_PATH = 'metadata/raw-lyrics-index.jsonl';
const MAX_AGE_MS = 3 * 24 * 3600 * 1000;
const UA = 'Afterglow/2.0 (desktop lyrics companion)';

interface Entry {
  titles: string[];
  artists: string[];
  album?: string;
  spotifyIds: string[];
  isrcs: string[];
  file: string;
}

let entries: Entry[] | null = null;
let loadedAt = 0;
let loading: Promise<{ entries: Entry[]; stale: boolean }> | null = null;

function dir(...p: string[]): string {
  return libraryDir('amll', ...p);
}

async function getText(url: string, timeoutMs: number): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function parseAmllIndex(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      const m: Record<string, string[]> = {};
      for (const [k, v] of d.metadata ?? []) if (Array.isArray(v)) m[k] = v.map(String);
      if (!d.rawLyricFile || !m.musicName?.length) continue;
      out.push({
        titles: m.musicName,
        artists: m.artists ?? [],
        album: m.album?.[0],
        spotifyIds: m.spotifyId ?? [],
        isrcs: m.isrc ?? [],
        file: String(d.rawLyricFile),
      });
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

async function loadIndex(): Promise<{ entries: Entry[]; stale: boolean }> {
  if (entries && Date.now() - loadedAt < MAX_AGE_MS) return { entries, stale: false };
  if (loading) return loading;
  loading = (async () => {
    const file = dir('raw-lyrics-index.jsonl');
    let cached: { text: string; mtime: number } | null = null;
    try {
      const st = await fs.stat(file);
      cached = { text: await fs.readFile(file, 'utf8'), mtime: st.mtimeMs };
    } catch {
      cached = null;
    }
    if (cached && Date.now() - cached.mtime < MAX_AGE_MS) {
      entries = parseAmllIndex(cached.text);
      loadedAt = cached.mtime;
      return { entries, stale: false };
    }
    try {
      const text = await getText(`${BASE}/${INDEX_PATH}`, 20000);
      await fs.mkdir(dir(), { recursive: true });
      await fs.writeFile(`${file}.tmp`, text, 'utf8');
      await fs.rename(`${file}.tmp`, file);
      entries = parseAmllIndex(text);
      loadedAt = Date.now();
      return { entries, stale: false };
    } catch (e) {
      if (cached) {
        entries = parseAmllIndex(cached.text);
        loadedAt = Date.now() - MAX_AGE_MS + 3600_000; // retry the download in an hour
        return { entries, stale: true };
      }
      throw e;
    }
  })().finally(() => {
    loading = null;
  });
  return loading;
}

async function fetchFile(file: string): Promise<string> {
  const safe = createHash('sha1').update(file).digest('hex');
  const cachePath = dir('files', `${safe}.ttml`);
  try {
    return await fs.readFile(cachePath, 'utf8');
  } catch {
    /* not cached */
  }
  const text = await getText(`${BASE}/raw-lyrics/${encodeURIComponent(file)}`, 15000);
  await fs.mkdir(dir('files'), { recursive: true });
  await fs.writeFile(cachePath, text, 'utf8');
  return text;
}

export async function searchAmll(q: TrackQuery): Promise<AmllResponse> {
  try {
    const { entries: list, stale } = await loadIndex();
    const scored: { e: Entry; score: number; title: string; artist: string }[] = [];
    for (const e of list) {
      const artist = e.artists.join(', ');
      let best = 0;
      let title = e.titles[0];
      for (const t of e.titles) {
        const s = scoreCandidate(
          { ...q, durationSec: undefined },
          { title: t, artist, album: e.album, spotifyId: e.spotifyIds[0], isrc: e.isrcs[0] },
        );
        if (s > best) {
          best = s;
          title = t;
        }
      }
      // IDs anywhere in the entry are decisive
      if ((q.spotifyId && e.spotifyIds.includes(q.spotifyId)) || (q.isrc && e.isrcs.map((x) => x.toUpperCase()).includes(q.isrc.toUpperCase()))) best = 100;
      if (best >= 55) scored.push({ e, score: best, title, artist });
    }
    scored.sort((a, b) => b.score - a.score);
    const hits: AmllHit[] = [];
    for (const s of scored.slice(0, 2)) {
      const hit: AmllHit = { file: s.e.file, title: s.title, artist: s.artist, album: s.e.album, score: s.score, url: `${BASE}/raw-lyrics/${s.e.file}` };
      try {
        hit.ttml = await fetchFile(s.e.file);
      } catch (e: any) {
        hit.error = String(e?.message ?? e);
      }
      hits.push(hit);
    }
    return { ok: true, hits, indexSize: list.length, stale };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return { ok: false, error: /abort|ENOTFOUND|ERR_|ECONN/i.test(msg) ? 'AMLL TTML DB is unreachable (offline or blocked network)' : msg, offline: true };
  }
}
