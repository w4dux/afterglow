import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ app: { getAppPath: () => 'D:/test' } }));
vi.mock('node:fs', () => ({ existsSync: () => true }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { MediaBridge, bridgeFileName } from '../electron/mediaBridge';

describe('native bridge supervision', () => {
  const processes: any[] = [];
  let bridge: MediaBridge;
  let messages: any[];
  beforeEach(() => {
    vi.useFakeTimers(); messages = []; processes.length = 0;
    mocks.spawn.mockImplementation(() => {
      const p: any = new EventEmitter(); p.stdout = new EventEmitter(); p.stdout.setEncoding = () => {};
      p.stderr = new EventEmitter(); p.stdin = { write: vi.fn(), end: vi.fn() };
      p.exitCode = null; p.kill = vi.fn(() => { p.exitCode = 1; p.emit('exit', 1, null); });
      processes.push(p); return p;
    });
    bridge = new MediaBridge(m => messages.push(m)); bridge.start('spotify');
  });
  afterEach(() => { bridge.stop(); vi.useRealTimers(); });
  it('probes an idle bridge and restarts a silent one', () => {
    vi.advanceTimersByTime(9000);
    expect(processes[0].stdin.write).toHaveBeenCalledWith('{"cmd":"refresh"}\n');
    vi.advanceTimersByTime(9000);
    expect(processes[0].kill).toHaveBeenCalled(); expect(processes).toHaveLength(2);
    expect(messages.some(m => m.type === 'bridge-exit' && m.restarting)).toBe(true);
  });
  it('treats fresh states as health even if the playback timeline is unchanged', () => {
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(7000);
      processes[0].stdout.emit('data', '{"type":"state","positionMs":1000}\n');
    }
    expect(processes[0].kill).not.toHaveBeenCalled();
  });
  it('does not let a stopped process clear or restart a new bridge', () => {
    const old = processes[0]; bridge.stop(); bridge.start('spotify');
    old.emit('exit', 0, null); vi.advanceTimersByTime(1000);
    bridge.command({ cmd: 'pause' });
    expect(processes).toHaveLength(2); expect(processes[1].stdin.write).toHaveBeenCalledWith('{"cmd":"pause"}\n');
  });
});

describe('Linux media bridge', () => {
  it('uses the MPRIS bridge binary on Linux and the GSMTC one on Windows', () => {
    expect(bridgeFileName('linux')).toBe('afterglow-media-bridge');
    expect(bridgeFileName('win32')).toBe('afterglow-media-bridge.exe');
    expect(bridgeFileName('darwin')).toBeNull();
  });
  it('fetches artwork that a Linux player publishes as a URL', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }));
    vi.stubGlobal('fetch', fetchMock);
    const procs: any[] = [];
    mocks.spawn.mockImplementation(() => {
      const p: any = new EventEmitter(); p.stdout = new EventEmitter(); p.stdout.setEncoding = () => {};
      p.stderr = new EventEmitter(); p.stdin = { write: vi.fn(), end: vi.fn() }; p.exitCode = null; p.kill = vi.fn();
      procs.push(p); return p;
    });
    const got: any[] = [];
    const b = new MediaBridge(m => got.push(m)); b.start('spotify');
    procs[0].stdout.emit('data', JSON.stringify({ type: 'artwork', app: 'spotify', title: 'T', artist: 'A', mime: null, base64: null, url: 'https://i.scdn.co/image/x' }) + '\n');
    expect(got.some(m => m.type === 'artwork')).toBe(false);
    await vi.waitFor(() => expect(got.find(m => m.type === 'artwork')).toBeTruthy());
    const art = got.find(m => m.type === 'artwork');
    expect(fetchMock).toHaveBeenCalledWith('https://i.scdn.co/image/x', expect.anything());
    expect(art).toMatchObject({ mime: 'image/jpeg', base64: 'AQID', title: 'T' });
    expect(art.url).toBeUndefined();
    b.stop(); vi.unstubAllGlobals();
  });
});
