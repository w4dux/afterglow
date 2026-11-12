import { app } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A small local log (userData/logs/afterglow.log, rolled over at 1 MB into
 * afterglow.1.log) so a problem can be looked at after it happened. It stays on this
 * PC; the "Copy diagnostics report" button includes its last lines when the user
 * chooses to share them.
 */
const MAX_BYTES = 1_000_000;
const MAX_LINE = 600;
/** Renderer lines allowed per minute (protects the disk from a runaway loop). */
const RENDERER_PER_MINUTE = 120;

let windowStart = 0;
let windowCount = 0;

export function logDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

function logFile(): string {
  return path.join(logDir(), 'afterglow.log');
}

export function writeLog(source: 'main' | 'bridge' | 'renderer', text: string): void {
  if (source === 'renderer') {
    const now = Date.now();
    if (now - windowStart > 60_000) {
      windowStart = now;
      windowCount = 0;
    }
    if (++windowCount > RENDERER_PER_MINUTE) return;
  }
  try {
    const f = logFile();
    mkdirSync(logDir(), { recursive: true });
    const size = statSync(f, { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_BYTES) renameSync(f, path.join(logDir(), 'afterglow.1.log'));
    const clean = String(text).replace(/[\r\n\t]+/g, ' ').slice(0, MAX_LINE);
    appendFileSync(f, `${new Date().toISOString()} [${source}] ${clean}\n`, 'utf8');
  } catch {
    /* logging must never break the app */
  }
}

/** The last `n` lines of the current log. */
export function readLogTail(n = 150): string[] {
  try {
    const lines = readFileSync(logFile(), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(1000, n)));
  } catch {
    return [];
  }
}
