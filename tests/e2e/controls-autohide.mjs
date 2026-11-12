// End-to-end check that the controls hide while playing and come back on input.
// Drives the built app with real mouse and keyboard input. Run: npm run e2e:controls
// (needs `npm run build` first; uses a throwaway settings folder, never your own).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const project = process.cwd();
const require = createRequire(path.join(project, 'package.json'));
const { _electron } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT = 3400; // the default hide delay is 2.6 s

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'afterglow-e2e-'));
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ firstRunDone: true, sources: { followSystemMedia: false } }));
const app = await _electron.launch({ executablePath: require('electron'), args: [project], env: { ...process.env, AFTERGLOW_USER_DATA: ud, AFTERGLOW_QUERY: 'automation' } });
const results = [];
const check = (name, ok) => results.push({ name, ok: !!ok });
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => window.__afterglow?.getApp().ready, null, { timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1280, 800); w.webContents.setAudioMuted(true); });
  const hidden = () => win.evaluate(() => document.body.classList.contains('chrome-hidden'));
  await win.evaluate(async () => { await window.__afterglow.controller.playDemo('night-shift', false); });
  await sleep(500);

  await win.locator('.chrome-bottom button').first().click(); // play; the button keeps focus
  await win.mouse.move(640, 400);
  await sleep(WAIT);
  check('hides after clicking play and moving away', await hidden());

  await win.mouse.move(600, 380);
  await sleep(200);
  check('mouse movement brings them back', !(await hidden()));

  await win.evaluate(() => window.__afterglow.controller.togglePlay());
  await sleep(WAIT);
  check('stay up while paused', !(await hidden()));
  await win.evaluate(() => window.__afterglow.controller.togglePlay()); // like pressing play in Spotify
  await sleep(WAIT);
  check('hide when playback starts with no input here', await hidden());

  await win.mouse.move(600, 380);
  await win.locator('[data-panel-trigger]').first().click();
  await sleep(WAIT);
  check('stay up while a panel is open', !(await hidden()));
  await win.keyboard.press('Escape');
  await win.mouse.move(640, 420);
  await sleep(WAIT);
  check('hide after the panel closes', await hidden());

  await win.mouse.move(640, 780);
  await sleep(WAIT);
  check('stay up while the pointer rests on them', !(await hidden()));

  await win.mouse.move(640, 400);
  await win.keyboard.press('Tab');
  await sleep(WAIT);
  check('stay up while tabbing through them', !(await hidden()));
  await win.mouse.move(620, 390);
  await sleep(WAIT);
  check('hide again once the mouse is used', await hidden());
} finally {
  await app.close().catch(() => {});
  fs.rmSync(ud, { recursive: true, force: true });
}
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} failed` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
