import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LyricsCacheEntry } from '../src/shared/api';
import { libraryDir } from './library';

/**
 * Lyrics found online are saved per track (userData/library/lyrics), so a song plays
 * instantly next time and still has lyrics when a provider is down or the PC is
 * offline. "Search again" bypasses and replaces the saved copy.
 */
function fileFor(key: string): string {
  return libraryDir('lyrics', `${createHash('sha1').update(key).digest('hex')}.json`);
}

export async function cacheGet(key: string): Promise<LyricsCacheEntry | null> {
  try {
    const e = JSON.parse(await fs.readFile(fileFor(key), 'utf8'));
    return e && typeof e.text === 'string' && typeof e.format === 'string' ? (e as LyricsCacheEntry) : null;
  } catch {
    return null;
  }
}

export async function cachePut(key: string, entry: LyricsCacheEntry): Promise<void> {
  if (!entry || typeof entry.text !== 'string' || entry.text.length > 2_000_000) return;
  const f = fileFor(key);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(`${f}.tmp`, JSON.stringify(entry), 'utf8');
  await fs.rename(`${f}.tmp`, f);
}

export async function cacheRemove(key: string): Promise<void> {
  await fs.rm(fileFor(key), { force: true });
}
