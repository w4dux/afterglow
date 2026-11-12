import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sanitizeSettings, type Settings } from '../src/core/settings/schema';

/**
 * JSON settings file in userData. Writes are serialized and atomic (temp file + rename),
 * so a crash mid-write never leaves a truncated settings file.
 */
export class SettingsStore {
  private readonly file: string;
  private writing: Promise<void> = Promise.resolve();
  private cached: Settings | null = null;

  constructor(dir: string) {
    this.file = path.join(dir, 'settings.json');
  }

  async load(): Promise<Settings> {
    if (this.cached) return this.cached;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.cached = sanitizeSettings(JSON.parse(raw));
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        // Corrupt file: keep a copy for inspection and start from defaults.
        await fs.copyFile(this.file, this.file + '.corrupt').catch(() => undefined);
      }
      this.cached = sanitizeSettings(null);
    }
    return this.cached;
  }

  save(next: unknown): Promise<void> {
    const clean = sanitizeSettings(next);
    this.cached = clean;
    const body = JSON.stringify(clean, null, 2);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, this.file);
    }).catch((e) => console.error('[settings] write failed', e));
    return this.writing;
  }
}
