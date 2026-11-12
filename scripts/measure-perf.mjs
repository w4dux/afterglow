#!/usr/bin/env node
/**
 * Resource measurement in real Electron (dist build): for each theme, play its demo
 * for a few seconds and record scene.frame() main-thread cost, frame rate, and
 * Electron's per-process CPU / memory (app.getAppMetrics()). Also measures CPU while
 * paused (the render loop should stop).
 * Run: xvfb-run -a node scripts/measure-perf.mjs [out.json]
 * Note: under Xvfb there is no GPU (software compositing), so CPU is pessimistic.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const electronPath = require('electron');
const out = process.argv[2];

const app = await pw._electron.launch({
  executablePath: electronPath,
  args: ['.', '--no-sandbox'],
  env: { ...process.env, AFTERGLOW_USER_DATA: mkdtempSync(join(tmpdir(), 'afterglow-perf-')), AFTERGLOW_QUERY: 'automation' },
});
const win = await app.firstWindow();
await win.setViewportSize({ width: 1600, height: 900 }).catch(() => {});
await win.waitForFunction(() => window.__afterglow?.getApp().lyrics.status === 'synced', null, { timeout: 20000 });

const metrics = async () =>
  app.evaluate(({ app }) =>
    app.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage, memMB: Math.round(m.memory.workingSetSize / 1024) })),
  );

const runs = [
  ['cypher', 'night-shift', 5000],
  ['nocturne', 'chrome-hours', 9500],
  ['velvet', 'slow-honey', 5000],
  ['sherbet', 'sugar-signal', 13500],
  ['feedback', 'static-hearts', 5500],
  ['horizon', 'low-tide', 21000],
  ['quiet', 'night-shift', 5000],
];
const results = [];
for (const [theme, demo, at] of runs) {
  await win.evaluate(async ([theme, demo, at]) => {
    const { controller } = window.__afterglow;
    controller.updateSettings((s) => ({ ...s, theme: { ...s.theme, mode: 'manual', manualTheme: theme } }));
    await controller.playDemo(demo, false);
    controller.chooseTheme(theme);
  }, [theme, demo, at]);
  await win.waitForFunction(() => window.__afterglow.getApp().lyrics.status === 'synced');
  await win.waitForTimeout(800);
  await win.evaluate((at) => {
    const { controller } = window.__afterglow;
    controller.seek(at);
    controller.togglePlay();
  }, at);
  await win.waitForTimeout(1500);
  await metrics(); // reset CPU sampling window
  const f0 = await win.evaluate(() => window.__afterglow.controller.runtime.frameCount);
  await win.waitForTimeout(6000);
  const m = await metrics();
  const r = await win.evaluate((f0) => {
    const { controller } = window.__afterglow;
    const cost = controller.runtime.frameCost();
    return { frames: controller.runtime.frameCount - f0, cost, heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576) };
  }, f0);
  results.push({
    theme,
    fps: +(r.frames / 6).toFixed(1),
    sceneFrameMs: { avg: +r.cost.avg.toFixed(3), p95: +r.cost.p95.toFixed(3), max: +r.cost.max.toFixed(3) },
    jsHeapMB: r.heapMB,
    cpuPercentByProcess: Object.fromEntries(m.map((x) => [x.type, +x.cpu.toFixed(1)])),
    totalCpuPercent: +m.reduce((s, x) => s + x.cpu, 0).toFixed(1),
    totalMemMB: m.reduce((s, x) => s + x.memMB, 0),
  });
  console.log(JSON.stringify(results.at(-1)));
  await win.evaluate(() => window.__afterglow.controller.togglePlay());
}
// paused: render loop should be idle
await win.waitForTimeout(1500);
await metrics();
const fp = await win.evaluate(() => window.__afterglow.controller.runtime.frameCount);
await win.waitForTimeout(5000);
const mp = await metrics();
const fp2 = await win.evaluate(() => window.__afterglow.controller.runtime.frameCount);
const paused = { framesIn5s: fp2 - fp, totalCpuPercent: +mp.reduce((s, x) => s + x.cpu, 0).toFixed(1), totalMemMB: mp.reduce((s, x) => s + x.memMB, 0) };
console.log('paused', JSON.stringify(paused));
await app.close();
const report = { note: 'Electron on Linux under Xvfb (software compositing, no GPU); 1600x900 window.', playing: results, paused };
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
