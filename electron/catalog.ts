import { net } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { CatalogEntry, CatalogResponse } from '../src/shared/api';
import { libraryDir } from './library';

/**
 * Apple's public iTunes Search API (no key, no account): the stated genre, length and
 * artwork of a song, used for the theme choice (Spotify publishes no genre), as a
 * second measure of the player's song-length gap, and as artwork when the player
 * provides none. Used only when the user allowed online lookups. Sends artist and
 * title. Results are kept 30 days (misses 7 days) so a song is looked up once.
 */
const API = 'https://itunes.apple.com/search';
const UA = 'Afterglow/2.2 (desktop lyrics companion)';
const KEEP_MS = 30 * 24 * 3600 * 1000;
const KEEP_MISS_MS = 7 * 24 * 3600 * 1000;
let busyUntil = 0;

function cacheFile(artist: string, title: string): string {
  const key = `${artist.toLowerCase().trim()}|${title.toLowerCase().trim()}`;
  return libraryDir('catalog', `${createHash('sha1').update(key).digest('hex')}.json`);
}

export async function lookupCatalog(q: { artist: string; title: string }): Promise<CatalogResponse> {
  const artist = String(q?.artist ?? '').slice(0, 200);
  const title = String(q?.title ?? '').slice(0, 200);
  if (!title.trim()) return { ok: false, error: 'no title' };
  const file = cacheFile(artist, title);
  try {
    const c = JSON.parse(await fs.readFile(file, 'utf8'));
    const age = Date.now() - c.savedAt;
    if (Array.isArray(c.entries) && age < (c.entries.length ? KEEP_MS : KEEP_MISS_MS)) return { ok: true, entries: c.entries, cached: true };
  } catch {
    /* not saved yet */
  }
  if (Date.now() < busyUntil) return { ok: false, error: 'Apple catalogue busy; try later' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const p = new URLSearchParams({ term: `${artist} ${title}`.trim(), media: 'music', entity: 'song', limit: '10' });
    const res = await net.fetch(`${API}?${p}`, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (res.status === 403 || res.status === 429) {
      busyUntil = Date.now() + 60_000;
      return { ok: false, error: `Apple catalogue responded ${res.status}` };
    }
    if (!res.ok) return { ok: false, error: `Apple catalogue responded ${res.status}` };
    const body = (await res.json()) as { results?: any[] };
    const entries: CatalogEntry[] = (body.results ?? [])
      .filter((r) => r && r.kind === 'song' && typeof r.trackName === 'string')
      .map((r) => ({
        title: String(r.trackName),
        artist: String(r.artistName ?? ''),
        album: typeof r.collectionName === 'string' ? r.collectionName : undefined,
        genre: typeof r.primaryGenreName === 'string' ? r.primaryGenreName : undefined,
        durationSec: Number.isFinite(r.trackTimeMillis) ? r.trackTimeMillis / 1000 : undefined,
        artworkUrl: typeof r.artworkUrl100 === 'string' ? r.artworkUrl100 : undefined,
        explicit: r.trackExplicitness === 'explicit',
      }));
    await fs.mkdir(libraryDir('catalog'), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ savedAt: Date.now(), entries }), 'utf8');
    return { ok: true, entries };
  } catch (e: any) {
    return { ok: false, error: /abort|ERR_|ENOTFOUND|ECONN/i.test(String(e?.message ?? e)) ? 'Apple catalogue unreachable' : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Album artwork from Apple's image servers only, as a data URL (the page allows no remote images). */
export async function catalogArtwork(url: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/(^|\.)mzstatic\.com$/.test(u.hostname)) return null;
  const big = u.toString().replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/600x600bb.jpg');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await net.fetch(big, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? 'image/jpeg';
    if (!/^image\/(jpeg|png|webp)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 3 * 1024 * 1024) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
