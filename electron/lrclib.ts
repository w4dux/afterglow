import { net } from 'electron';
import type { LrclibRecord, LrclibResponse } from '../src/shared/api';
import { pickLrclib, queryVariants } from '../src/core/lyrics/lrclibMatch';

/**
 * LRCLIB (https://lrclib.net) — a free, community-maintained lyrics database with a
 * documented public API and no key. It is used only when the user enables online
 * lookups; requests send the artist, title, album and duration of the current track.
 * LRCLIB content is user-contributed: availability does not grant publishing rights,
 * so lyrics are attributed and shown for personal use only.
 */
const BASE = 'https://lrclib.net/api';
const UA = 'Afterglow/2.0 (desktop lyrics companion)';

/**
 * LRCLIB limits request rates (this audit hit HTTP 429 after a few dozen requests in
 * a minute). After a 429 no requests are sent until the server's Retry-After (or 30 s,
 * at most 5 min) has passed; lookups meanwhile fail fast and saved copies are used.
 */
let busyUntil = 0;

async function getJson(url: string, timeoutMs = 8000): Promise<{ status: number; body: any }> {
  if (Date.now() < busyUntil) return { status: 429, body: null };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': UA, 'Lrclib-Client': UA }, signal: ctl.signal });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after'));
      busyUntil = Date.now() + Math.min(300_000, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 30_000);
    }
    const body = res.status === 200 ? await res.json() : null;
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const statusError = (status: number, what: string) =>
  status === 429 ? 'LRCLIB is busy (too many requests); saved lyrics are used and it will be tried again shortly' : `LRCLIB ${what}responded ${status}`;

export async function queryLrclib(q: { artist: string; title: string; album?: string; durationSec?: number }): Promise<LrclibResponse> {
  try {
    const variants = queryVariants(q);
    let exact: LrclibRecord | undefined;
    // 1. exact lookups (LRCLIB matches duration within ~2 s server-side)
    if (q.durationSec) {
      for (const v of variants) {
        if (!v.artist) continue;
        const p = new URLSearchParams({ artist_name: v.artist, track_name: v.title, duration: String(Math.round(q.durationSec)) });
        if (q.album && v.title === q.title) p.set('album_name', q.album);
        const r = await getJson(`${BASE}/get?${p}`);
        if (r.status === 200 && r.body && (r.body.syncedLyrics || r.body.hasWordSync || r.body.instrumental)) {
          exact = r.body as LrclibRecord;
          break;
        }
        if (r.status !== 200 && r.status !== 404) return { ok: false, error: statusError(r.status, ''), status: r.status };
      }
    }
    if (exact) return { ok: true, exact, candidates: [] };
    // 2. field searches with each variant, then a free-text search
    const candidates: LrclibRecord[] = [];
    const seen = new Set<number>();
    const add = (list: unknown) => {
      if (!Array.isArray(list)) return;
      for (const r of list as LrclibRecord[]) if (r && !seen.has(r.id)) (seen.add(r.id), candidates.push(r));
    };
    let lastStatus = 200;
    for (const v of variants) {
      const sp = new URLSearchParams({ track_name: v.title });
      if (v.artist) sp.set('artist_name', v.artist);
      const s = await getJson(`${BASE}/search?${sp}`);
      lastStatus = s.status;
      if (s.status === 200) add(s.body);
      if (pickLrclib(candidates, q).best?.syncedLyrics) break;
    }
    if (!pickLrclib(candidates, q).best) {
      const last = variants[variants.length - 1];
      const s = await getJson(`${BASE}/search?${new URLSearchParams({ q: `${last.artist} ${last.title}`.trim() })}`);
      lastStatus = s.status;
      if (s.status === 200) add(s.body);
    }
    if (!candidates.length && lastStatus !== 200) return { ok: false, error: statusError(lastStatus, 'search '), status: lastStatus };
    return { ok: true, candidates: candidates.slice(0, 40) };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const offline = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ERR_PROXY|ERR_TUNNEL|ECONNREFUSED|aborted/i.test(msg);
    return { ok: false, error: offline ? 'LRCLIB is unreachable (offline or blocked network)' : msg, offline };
  }
}

/** A specific record the user picked earlier. */
export async function queryLrclibById(id: number): Promise<LrclibResponse> {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'invalid id' };
  try {
    const r = await getJson(`${BASE}/get/${id}`);
    if (r.status === 200 && r.body) return { ok: true, exact: r.body as LrclibRecord, candidates: [] };
    return { ok: false, error: `LRCLIB responded ${r.status}`, status: r.status };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), offline: true };
  }
}
