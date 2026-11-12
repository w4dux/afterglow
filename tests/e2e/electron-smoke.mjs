#!/usr/bin/env node
/**
 * End-to-end check of the packaged-style app (dist/) in real Electron:
 * boot, demo playback & sync quality, theme switching, settings persistence across
 * restarts, local file import with sidecar LRC, embedded tags, missing lyrics,
 * reduced motion, and the system-media path on a non-Windows host.
 * Run: xvfb-run -a node tests/e2e/electron-smoke.mjs <fixturesDir> <shotsDir>
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const electronPath = require('electron');
const [fixtures, shots] = process.argv.slice(2);
mkdirSync(shots, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'afterglow-e2e-'));
const results = [];
const check = (name, fn) => results.push({ name, fn });

async function launch(extraEnv = {}) {
  const app = await pw._electron.launch({
    executablePath: electronPath,
    args: ['.', '--no-sandbox'],
    env: { ...process.env, AFTERGLOW_USER_DATA: userData, AFTERGLOW_QUERY: 'automation', ...extraEnv },
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => console.error('pageerror', e.message));
  await win.waitForFunction(() => window.__afterglow?.getApp().ready === true, null, { timeout: 20000 });
  return { app, win };
}

let { app, win } = await launch();
const log = (...a) => console.log('  ', ...a);

// 1. boot + demo
await win.waitForFunction(() => window.__afterglow.getApp().lyrics.status === 'synced', null, { timeout: 20000 });
let st = await win.evaluate(() => {
  const s = window.__afterglow.getApp();
  return { theme: s.theme.activeId, basis: s.theme.decision?.basis, label: s.theme.decision?.label, info: s.info, track: s.track?.title, timing: s.lyrics.doc?.timing };
});
log('boot', JSON.stringify(st));
assert.equal(st.theme, 'cypher');
assert.equal(st.basis, 'known-genre');
assert.equal(st.timing, 'word');
assert.ok(st.info.electron && st.info.electron !== '-', 'running in electron');

// 2. play demo, check sync quality and that lyrics advance
await win.evaluate(() => window.__afterglow.controller.togglePlay());
await win.waitForTimeout(2500);
st = await win.evaluate(() => {
  const { controller, getApp } = window.__afterglow;
  return { playing: getApp().playing, pos: controller.engine.position(), q: controller.engine.snapshot().quality, frames: controller.runtime.frameCount };
});
log('playing', JSON.stringify(st));
assert.ok(st.playing && st.pos > 1500, 'audio is playing in electron');
assert.equal(st.q, 'locked');
await win.evaluate(() => window.__afterglow.controller.seek(26500));
await win.waitForTimeout(600);
await win.screenshot({ path: join(shots, 'electron-cypher.png') });
const cue = await win.evaluate(() => window.__afterglow.controller.runtime.last.cue?.lineIndex);
assert.equal(cue, 8, 'seek lands on the hook line');

// 3. pause freezes
await win.evaluate(() => window.__afterglow.controller.togglePlay());
await win.waitForTimeout(300);
const pA = await win.evaluate(() => window.__afterglow.controller.engine.position());
await win.waitForTimeout(800);
const pB = await win.evaluate(() => window.__afterglow.controller.engine.position());
log('pause drift', pB - pA);
assert.equal(pB, pA, 'paused position is frozen');

// 4. theme override is remembered for the track; offset nudges persist
await win.evaluate(() => {
  const { controller } = window.__afterglow;
  controller.chooseTheme('velvet');
  controller.nudge(50);
  controller.nudge(50);
  controller.updateSettings((s) => ({ ...s, motion: { ...s.motion, treatment: 'jiggle', intensity: 0.8 } }));
});
await win.waitForTimeout(700);
st = await win.evaluate(() => {
  const s = window.__afterglow.getApp();
  return { theme: s.theme.activeId, basis: s.theme.decision?.basis, offset: window.__afterglow.controller.currentOffset() };
});
log('override', JSON.stringify(st));
assert.equal(st.theme, 'velvet');
assert.equal(st.basis, 'track-choice');
assert.equal(st.offset, 100);
await app.close();

// 5. restart: persisted settings
({ app, win } = await launch());
await win.waitForFunction(() => window.__afterglow.getApp().lyrics.status === 'synced', null, { timeout: 20000 });
await win.waitForTimeout(300);
st = await win.evaluate(() => {
  const s = window.__afterglow.getApp();
  return { theme: s.theme.activeId, basis: s.theme.decision?.basis, offset: window.__afterglow.controller.currentOffset(), treatment: s.settings.motion.treatment, intensity: s.settings.motion.intensity };
});
log('after restart', JSON.stringify(st));
assert.equal(st.theme, 'velvet');
assert.equal(st.basis, 'track-choice');
assert.equal(st.offset, 100);
assert.equal(st.treatment, 'jiggle');
assert.equal(st.intensity, 0.8);

// 6. local file with sidecar .lrc (line-timed) and tags
const local = await win.evaluate(async (p) => {
  const info = await window.afterglow.openAudioPath(p);
  await window.__afterglow.controller.openLocal(info);
  return { title: info.title, artist: info.artist, genres: info.genres, sidecar: info.sidecar?.name, dur: info.durationMs, url: info.url.slice(0, 24) };
}, join(fixtures, 'tagged-song.mp3'));
log('local', JSON.stringify(local));
await win.waitForFunction(() => ['synced', 'unsynced', 'not-found'].includes(window.__afterglow.getApp().lyrics.status), null, { timeout: 10000 });
await win.waitForTimeout(1500);
st = await win.evaluate(() => {
  const s = window.__afterglow.getApp();
  return { status: s.lyrics.status, src: s.lyrics.doc?.source, timing: s.lyrics.doc?.timing, theme: s.theme.activeId, label: s.theme.decision?.label, playing: s.playing, pos: window.__afterglow.controller.engine.position() };
});
log('local lyrics', JSON.stringify(st));
assert.equal(local.title, 'Paper Lanterns');
assert.equal(local.sidecar, 'tagged-song.lrc');
assert.equal(st.status, 'synced');
assert.equal(st.timing, 'line');
assert.equal(st.src.kind, 'sidecar');
assert.equal(st.theme, 'feedback', 'genre tag Alternative maps to Feedback');
assert.match(st.label, /file tag/);
assert.ok(st.playing && st.pos > 300, 'local file plays through the media protocol (with range support)');
await win.evaluate(() => window.__afterglow.controller.seek(9000));
await win.waitForTimeout(700);
await win.screenshot({ path: join(shots, 'electron-local-line-synced.png') });

// 7. embedded lyrics only (no sidecar) and missing lyrics
const emb = await win.evaluate(async (p) => {
  const info = await window.afterglow.openAudioPath(p);
  await window.__afterglow.controller.openLocal(info);
  return { embedded: info.embedded, genres: info.genres };
}, join(fixtures, 'embedded-only.mp3'));
await win.waitForFunction(() => ['synced', 'unsynced', 'not-found'].includes(window.__afterglow.getApp().lyrics.status), null, { timeout: 10000 });
st = await win.evaluate(() => ({ status: window.__afterglow.getApp().lyrics.status, kind: window.__afterglow.getApp().lyrics.doc?.source.kind }));
log('embedded', JSON.stringify(emb).slice(0, 160), JSON.stringify(st));
assert.ok(emb.embedded.unsynced || emb.embedded.syncedLrc, 'embedded lyrics read from tags');
assert.equal(st.kind, 'embedded');

await win.evaluate(async (p) => {
  const info = await window.afterglow.openAudioPath(p);
  await window.__afterglow.controller.openLocal(info);
}, join(fixtures, 'no-lyrics.ogg'));
await win.waitForFunction(() => ['synced', 'unsynced', 'not-found'].includes(window.__afterglow.getApp().lyrics.status), null, { timeout: 10000 });
await win.waitForTimeout(2800);
st = await win.evaluate(() => {
  const s = window.__afterglow.getApp();
  return { status: s.lyrics.status, tried: s.lyrics.tried, theme: s.theme.activeId, basis: s.theme.decision?.basis };
});
log('missing', JSON.stringify(st));
assert.equal(st.status, 'not-found');
assert.equal(st.basis, 'fallback');
await win.screenshot({ path: join(shots, 'electron-no-lyrics.png') });

// 8. system media on a non-Windows host: honest unavailability
await win.evaluate(() => window.__afterglow.controller.followSystem(true));
await win.waitForTimeout(1200);
st = await win.evaluate(() => window.__afterglow.getApp().system);
log('system', JSON.stringify(st));
assert.equal(st.bridge, 'unavailable');
await win.screenshot({ path: join(shots, 'electron-system-unavailable.png') });
await win.evaluate(() => window.__afterglow.controller.followSystem(false));

// 9. reduced motion → no word transforms
await win.evaluate(async () => {
  const { controller } = window.__afterglow;
  controller.updateSettings((s) => ({ ...s, motion: { ...s.motion, reduced: 'on' }, theme: { ...s.theme, mode: 'manual', manualTheme: 'cypher' } }));
  await controller.playDemo('night-shift', true);
});
await win.waitForTimeout(1500);
await win.evaluate(() => window.__afterglow.controller.seek(6200));
await win.waitForTimeout(500);
const transforms = await win.evaluate(() => [...document.querySelectorAll('.scene .u')].filter((u) => u.style.transform && u.style.transform !== 'none').length);
log('reduced-motion transformed units', transforms);
assert.equal(transforms, 0);
await app.close();
console.log('ELECTRON E2E: all checks passed');
