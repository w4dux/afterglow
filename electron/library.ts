import { app } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Where Afterglow keeps data it downloaded (saved lyrics, the AMLL index).
 *
 * Up to 2.1.0 this was `userData/cache`. On Windows folder names ignore case, so that
 * was the same folder as Chromium's own `Cache`, which clean-up tools treat as
 * disposable. It now lives in `userData/library`; older folders are moved once.
 */
export function libraryDir(...p: string[]): string {
  return path.join(app.getPath('userData'), 'library', ...p);
}

/** Most saved-lyrics files kept; the oldest are removed beyond this (about 30-60 MB). */
export const MAX_SAVED_LYRICS = 3000;

export async function prepareLibrary(): Promise<void> {
  const old = path.join(app.getPath('userData'), 'cache');
  for (const sub of ['lyrics', 'amll']) {
    const src = path.join(old, sub);
    const dst = libraryDir(sub);
    if (!existsSync(src) || existsSync(dst)) continue;
    try {
      await fs.mkdir(libraryDir(), { recursive: true });
      await fs.rename(src, dst);
    } catch {
      // e.g. a file still open in an older Afterglow window: copy instead
      await fs.cp(src, dst, { recursive: true }).catch(() => undefined);
    }
  }
  await pruneOldest(libraryDir('lyrics'), MAX_SAVED_LYRICS).catch(() => undefined);
}

async function pruneOldest(dir: string, keep: number): Promise<void> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
  if (names.length <= keep) return;
  const stats = await Promise.all(names.map(async (n) => ({ n, t: (await fs.stat(path.join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })));
  stats.sort((a, b) => a.t - b.t);
  for (const { n } of stats.slice(0, names.length - keep)) await fs.rm(path.join(dir, n), { force: true }).catch(() => undefined);
}
