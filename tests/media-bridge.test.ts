import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ app: { getAppPath: () => 'D:/test' } }));
vi.mock('node:fs', () => ({ existsSync: () => true }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { MediaBridge } from '../electron/mediaBridge';

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
