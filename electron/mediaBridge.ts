import { app } from 'electron';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BridgeCommand, BridgeMessage, MediaPeek } from '../src/shared/api';

/**
 * Supervises the native GSMTC bridge process. Lines on its stdout are JSON messages;
 * the receipt wall time is attached so the renderer can account for pipe latency.
 * Restarts with backoff if it crashes; never restarts after an explicit stop.
 */
export class MediaBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private wanted = false;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private preferred = 'spotify';
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastStateAt = 0;
  private refreshSent = false;

  constructor(private readonly send: (msg: BridgeMessage) => void) {}

  static executablePath(): string | null {
    if (process.platform !== 'win32') return null;
    const candidates = [
      path.join(process.resourcesPath ?? '', 'bin', 'afterglow-media-bridge.exe'),
      path.join(app.getAppPath(), 'resources', 'bin', 'afterglow-media-bridge.exe'),
      path.join(app.getAppPath(), '..', 'resources', 'bin', 'afterglow-media-bridge.exe'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  /**
   * One quick look at what is playing (for the first-run welcome), without following
   * it: runs the bridge until its first state report or `timeoutMs`, then closes it.
   */
  static peek(timeoutMs = 2500): Promise<MediaPeek | null> {
    const exe = MediaBridge.executablePath();
    if (!exe) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      let buf = '';
      const proc = spawn(exe, ['--prefer', 'spotify'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const finish = (v: MediaPeek | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          proc.stdin.end(); // the bridge exits when stdin closes
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill();
        }, 800);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      proc.on('error', () => finish(null));
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          try {
            const m = JSON.parse(line);
            if (m?.type === 'state') {
              finish({
                app: typeof m.app === 'string' ? m.app : null,
                status: typeof m.status === 'string' ? m.status : undefined,
                title: typeof m.media?.title === 'string' && m.media.title ? m.media.title : undefined,
                artist: typeof m.media?.artist === 'string' && m.media.artist ? m.media.artist : undefined,
              });
            }
          } catch {
            /* ignore malformed line */
          }
        }
      });
    });
  }

  start(preferredApp: string): { started: boolean; reason?: string } {
    this.preferred = preferredApp || 'spotify';
    this.wanted = true;
    const exe = MediaBridge.executablePath();
    if (!exe) {
      const reason =
        process.platform !== 'win32'
          ? 'System media sessions (GSMTC) are a Windows feature; not available on this OS.'
          : 'afterglow-media-bridge.exe was not found in the app resources.';
      this.send({ type: 'bridge-unavailable', reason });
      return { started: false, reason };
    }
    if (this.proc) {
      this.command({ cmd: 'select', app: this.preferred });
      return { started: true };
    }
    this.spawn(exe);
    return { started: true };
  }

  private spawn(exe: string): void {
    const startedAt = Date.now();
    const proc = spawn(exe, ['--prefer', this.preferred], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.buf = '';
    this.lastStateAt = Date.now();
    this.refreshSent = false;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.proc !== proc || !this.wanted) return;
      const age = Date.now() - this.lastStateAt;
      if (age > 16000) proc.kill();
      else if (age > 8000 && !this.refreshSent) {
        this.refreshSent = true;
        this.command({ cmd: 'refresh' });
      }
    }, 1000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      if (this.proc !== proc) return;
      const recv = Date.now();
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg && msg.type === 'state') msg.mainRecvWallMs = recv;
          if (msg?.type === 'state') {
            this.lastStateAt = Date.now();
            this.refreshSent = false;
          }
          this.send(msg as BridgeMessage);
        } catch {
          /* ignore malformed line */
        }
      }
    });
    proc.stderr.on('data', (d) => console.warn('[bridge]', String(d).trim()));
    proc.on('error', (err) => {
      this.send({ type: 'bridge-exit', code: null, signal: null, restarting: false, error: String(err.message) });
    });
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
      // Only a sustained healthy connection resets the restart budget.
      if (Date.now() - startedAt > 30000) this.restarts = 0;
      this.proc = null;
      const restarting = this.wanted && this.restarts < 5;
      this.send({ type: 'bridge-exit', code, signal, restarting });
      if (restarting) {
        const delay = 500 * 2 ** this.restarts++;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.wanted) this.spawn(exe);
        }, delay);
      }
    });
  }

  command(cmd: BridgeCommand & { id?: number }): void {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify(cmd) + '\n');
    } catch {
      /* process went away */
    }
  }

  stop(): void {
    this.wanted = false;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.proc) {
      try {
        this.proc.stdin.end(); // the bridge exits when stdin closes
      } catch {
        /* ignore */
      }
      const p = this.proc;
      setTimeout(() => {
        if (!p.killed && p.exitCode === null) p.kill();
      }, 800);
      this.proc = null;
    }
  }
}
