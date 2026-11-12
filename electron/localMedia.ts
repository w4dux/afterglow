import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EmbeddedLyrics, LocalTrackInfo, LyricFileResult } from '../src/shared/api';
import { grant } from './mediaProtocol';

export const LYRIC_EXTENSIONS = ['lrc', 'elrc', 'ttml', 'xml', 'txt'];
const MAX_LYRIC_BYTES = 2 * 1024 * 1024;

export async function readLyricFile(filePath: string): Promise<LyricFileResult | null> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!LYRIC_EXTENSIONS.includes(ext)) return null;
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile() || st.size > MAX_LYRIC_BYTES) return null;
    const buf = await fs.readFile(filePath);
    return { path: filePath, name: path.basename(filePath), text: decodeText(buf) };
  } catch {
    return null;
  }
}

/** UTF-8 with BOM handling; UTF-16 LE/BE BOMs (some Windows tools write those). */
function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8').replace(/^﻿/, '');
}

function fmtLrcTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const cs = Math.floor((t % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function extractEmbeddedLyrics(common: any): EmbeddedLyrics {
  const out: EmbeddedLyrics = {};
  const tags: any[] = Array.isArray(common?.lyrics) ? common.lyrics : [];
  for (const tag of tags) {
    if (typeof tag === 'string') {
      if (/^\s*\[\d{1,3}:\d{2}/m.test(tag)) out.syncedLrc ??= tag;
      else out.unsynced ??= tag;
      continue;
    }
    if (!tag || typeof tag !== 'object') continue;
    const sync: any[] = Array.isArray(tag.syncText) ? tag.syncText : [];
    // SYLT with millisecond timestamps (timeStampFormat 2). MPEG-frame stamps are not converted.
    if (sync.length > 0 && (tag.timeStampFormat === 2 || tag.timeStampFormat === undefined) && sync.every((s) => typeof s.timestamp === 'number')) {
      out.syncedLrc ??= sync.map((s) => `[${fmtLrcTime(s.timestamp)}]${String(s.text ?? '').replace(/\r?\n/g, ' ').trim()}`).join('\n');
    }
    if (typeof tag.text === 'string' && tag.text.trim()) {
      if (/^\s*\[\d{1,3}:\d{2}/m.test(tag.text)) out.syncedLrc ??= tag.text;
      else out.unsynced ??= tag.text;
    }
  }
  return out;
}

async function findSidecar(audioPath: string): Promise<LocalTrackInfo['sidecar']> {
  const dir = path.dirname(audioPath);
  const base = path.basename(audioPath, path.extname(audioPath));
  for (const ext of ['elrc', 'lrc', 'ttml', 'txt']) {
    const p = path.join(dir, `${base}.${ext}`);
    const r = await readLyricFile(p);
    if (r) return r;
  }
  return undefined;
}

export async function describeLocalTrack(filePath: string): Promise<LocalTrackInfo> {
  const info: LocalTrackInfo = {
    path: filePath,
    url: grant(filePath),
    fileName: path.basename(filePath),
    genres: [],
    embedded: {},
  };
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseFile(filePath, { duration: true, skipCovers: false });
    const c = meta.common;
    info.title = c.title || undefined;
    info.artist = c.artist || c.albumartist || undefined;
    info.album = c.album || undefined;
    info.genres = (c.genre ?? []).flatMap((g: string) => g.split(/\s*[;/]\s*/)).filter(Boolean);
    if (meta.format.duration) info.durationMs = Math.round(meta.format.duration * 1000);
    const pic = c.picture?.[0];
    if (pic && pic.data && pic.data.length < 4 * 1024 * 1024) {
      info.artworkDataUrl = `data:${pic.format || 'image/jpeg'};base64,${Buffer.from(pic.data).toString('base64')}`;
    }
    info.embedded = extractEmbeddedLyrics(c);
  } catch (e: any) {
    info.metadataError = String(e?.message ?? e);
  }
  info.sidecar = await findSidecar(filePath);
  return info;
}

function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const folderCache = new Map<string, { at: number; files: string[] }>();

async function listLyricFiles(folder: string, depth = 2): Promise<string[]> {
  const cached = folderCache.get(folder);
  if (cached && Date.now() - cached.at < 15000) return cached.files;
  const out: string[] = [];
  async function walk(dir: string, d: number) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && d > 0) await walk(p, d - 1);
      else if (e.isFile() && LYRIC_EXTENSIONS.includes(path.extname(e.name).slice(1).toLowerCase())) out.push(p);
      if (out.length > 20000) return;
    }
  }
  await walk(folder, depth);
  folderCache.set(folder, { at: Date.now(), files: out });
  return out;
}

/**
 * Find "Artist - Title.lrc" (or "Title.lrc" inside an artist folder) in a user-chosen
 * lyrics folder. Exact normalized matches only; no fuzzy guessing.
 */
export async function findLyricsInFolder(folder: string, artist: string, title: string): Promise<LyricFileResult | null> {
  const files = await listLyricFiles(folder);
  const t = normName(title);
  const a = normName(artist.split(/\s*(?:,|&|feat\.?|ft\.?)\s*/i)[0] ?? artist);
  if (!t) return null;
  const rank = (p: string): number => {
    const base = normName(path.basename(p, path.extname(p)));
    const parent = normName(path.basename(path.dirname(p)));
    if (a && (base === `${a} ${t}` || base === `${t} ${a}`)) return 3;
    if (a && base === t && parent === a) return 2;
    if (base === t) return 1;
    return 0;
  };
  let best: string | null = null;
  let bestRank = 0;
  for (const f of files) {
    const r = rank(f);
    const extBonus = /\.(elrc|lrc|ttml)$/i.test(f) ? 0.5 : 0;
    if (r > 0 && r + extBonus > bestRank) {
      best = f;
      bestRank = r + extBonus;
    }
  }
  return best ? readLyricFile(best) : null;
}
