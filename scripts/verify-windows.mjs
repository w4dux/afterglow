// Tests the built Electron app in an isolated profile. --live temporarily controls Spotify.
import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const output = resolve(process.env.AFTERGLOW_TEST_OUTPUT ?? 'docs/measurements/windows-2.0.3');
mkdirSync(output, { recursive: true });
const app = await _electron.launch({ executablePath: process.env.AFTERGLOW_TEST_EXE ?? require('electron'), args: ['.'], env: { ...process.env,
  AFTERGLOW_USER_DATA: mkdtempSync(join(tmpdir(), 'afterglow-203-')), AFTERGLOW_QUERY: 'automation' } });
const results = []; let win; let initial;
const snapshot = () => win.evaluate(() => {
  const { controller: c, getApp } = window.__afterglow; const s = getApp();
  return { title: s.track?.title, playing: s.playing, position: c.engine.position(), sync: c.engine.snapshot(),
    source: s.source, timing: s.lyrics.doc?.timing, version: s.info.version };
});
const run = async (name, fn) => { await fn(); results.push({ name, passed: true }); console.log('PASS', name); };
try {
  win = await app.firstWindow();
  const errors = []; win.on('pageerror', e => errors.push(e.message));
  await win.waitForFunction(() => window.__afterglow?.getApp().ready, null, { timeout: 20000 });
  await run('offline demo word timing', async () => {
    await win.waitForFunction(() => window.__afterglow.getApp().lyrics.status === 'synced');
    assert.equal((await snapshot()).timing, 'word');
    await win.evaluate(() => window.__afterglow.controller.togglePlay());
    await win.waitForFunction(() => window.__afterglow.controller.engine.position() > 700, null, { timeout: 10000 });
    await win.evaluate(() => window.__afterglow.controller.togglePlay());
    await win.waitForTimeout(200); const p = (await snapshot()).position;
    await win.waitForTimeout(400); assert.equal((await snapshot()).position, p);
  });
  if (process.argv.includes('--live')) {
    await win.evaluate(() => { window.__bridgeStates = []; window.afterglow.onBridge(m => {
      if (m.type === 'hello') window.__bridgePid = m.pid;
      if (m.type === 'bridge-exit') window.__bridgeExit = true;
      if (m.type === 'state') window.__bridgeStates.push({ at: performance.now(), ...m });
    }); window.__afterglow.controller.followSystem(true); });
    await win.waitForFunction(() => window.__bridgeStates.length > 0, null, { timeout: 12000 });
    initial = await snapshot();
    assert.ok(initial.title && initial.title !== 'undefined', 'a player must be active');
    await run('mid-song attachment', async () => { assert.ok(initial.position > 3000); });
    await win.evaluate(() => window.afterglow.bridgeCommand({ cmd: 'play' }));
    await win.waitForTimeout(1200);
    await run('live pause and stable frozen position', async () => {
      await win.evaluate(() => window.afterglow.bridgeCommand({ cmd: 'pause' }));
      await win.waitForFunction(() => !window.__afterglow.getApp().playing);
      await win.waitForTimeout(1800); const p = (await snapshot()).position;
      await win.waitForTimeout(400); assert.ok(Math.abs((await snapshot()).position - p) < 25, 'no paused extrapolation; allow small player corrections');
    });
    await run('live forward/backward seeks', async () => {
      for (const target of [60000, 15000, 15500]) {
        await win.evaluate(t => window.__afterglow.controller.seek(t), target);
        await win.waitForTimeout(700);
        assert.ok(Math.abs((await snapshot()).position - target) < 200, `seek ${target}`);
      }
    });
    await run('live resume advances', async () => {
      await win.evaluate(() => window.afterglow.bridgeCommand({ cmd: 'play' }));
      await win.waitForFunction(() => window.__afterglow.getApp().playing);
      const p = (await snapshot()).position; await win.waitForTimeout(1000);
      assert.ok((await snapshot()).position > p + 800);
    });
    await run('native helper crash recovers', async () => {
      const pid = await app.evaluate(() => process.pid);
      const announced = await win.evaluate(() => window.__bridgePid);
      const child = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${Number(announced) || -1} -and $_.Name -eq 'afterglow-media-bridge.exe' } | Select-Object -ExpandProperty ProcessId`], { windowsHide: true }).toString().trim();
      console.log('helper check', JSON.stringify({ mainPid: pid, announced, child }));
      assert.match(child, /^\d+$/); process.kill(Number(child));
      await win.waitForFunction(() => window.__bridgeExit === true, null, { timeout: 12000 });
      await win.waitForFunction(() => window.__afterglow.getApp().system?.bridge === 'on', null, { timeout: 12000 });
      await win.waitForTimeout(1000); assert.ok((await snapshot()).playing);
    });
    await run('live online provider lookup', async () => {
      await win.evaluate(() => window.__afterglow.controller.setOnlineLyrics(true));
      await win.waitForFunction(() => ['synced', 'unsynced', 'not-found', 'error'].includes(window.__afterglow.getApp().lyrics.status), null, { timeout: 60000 });
      const lyrics = await win.evaluate(() => { const x = window.__afterglow.getApp().lyrics; return { status: x.status, timing: x.doc?.timing, tried: x.tried }; });
      console.log('first provider', JSON.stringify(lyrics)); assert.equal(lyrics.status, 'synced');
      await win.waitForFunction(() => window.__afterglow.getApp().lyrics.tried.some(t => t.source.startsWith('Chosen:')), null, { timeout: 60000 });
      console.log('final providers', JSON.stringify(await win.evaluate(() => window.__afterglow.getApp().lyrics.tried)));
    });
    await win.screenshot({ path: join(output, 'live.png') });
  }
  assert.deepEqual(errors, []); results.push({ name: 'renderer errors', passed: true });
} catch (e) { results.push({ passed: false, error: String(e) }); process.exitCode = 1; console.error(e); }
finally {
  if (initial && win) {
    const current = await snapshot();
    if (current.title === initial.title) {
      await win.evaluate(() => window.afterglow.bridgeCommand({ cmd: 'pause' }));
      await win.waitForFunction(() => !window.__afterglow.getApp().playing);
      await win.waitForTimeout(1600);
      await win.evaluate(p => window.__afterglow.controller.seek(p), initial.position);
      await win.waitForTimeout(600);
      if (initial.playing) {
        await win.evaluate(() => window.afterglow.bridgeCommand({ cmd: 'play' }));
        await win.waitForTimeout(500);
      }

    }
  }
  writeFileSync(join(output, 'results.json'), JSON.stringify({ initial, results, final: win ? await snapshot() : null }, null, 2));
  await app.close();
}
