#!/usr/bin/env node
/**
 * Measures synchronization against the real HTMLAudioElement clock in Chromium.
 *
 *  1. Granularity of audio.currentTime updates while playing.
 *  2. Error of the engine's displayed position vs. a least-squares fit of the audio
 *     clock (the best available estimate of the true media clock).
 *  3. Pause response: displayed position drift after pause().
 *  4. Seek response: frames until the displayed position reflects a seek.
 *  5. Track change: frames until a new track's position is displayed.
 *
 * Usage: node scripts/measure-sync.mjs <baseUrl> [out.json]
 * Note: headless Chromium renders audio to a fake output device, so this measures the
 * media clock and the engine, not the latency of real speakers or Bluetooth.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/node-tools/node_modules/playwright');
}
const [base, out] = process.argv.slice(2);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
await page.goto(`${base}?demo=night-shift&automation`);
await page.waitForFunction(() => window.__afterglow?.getApp().lyrics.status === 'synced', null, { timeout: 20000 });

const result = await page.evaluate(async () => {
  const { controller } = window.__afterglow;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const adapter = () => controller.adapter;
  controller.seek(4000);
  controller.adapter.play();
  await sleep(1500);

  // --- 1 & 2: sample per frame for 12 s
  const samples = [];
  const end = performance.now() + 12000;
  let lastCt = -1;
  const changes = [];
  while (performance.now() < end) {
    const now = await frame();
    const a = adapter().audio;
    const ct = a.currentTime * 1000;
    const disp = controller.engine.position(performance.now());
    const pn = performance.now();
    if (ct !== lastCt) {
      changes.push(pn);
      lastCt = ct;
    }
    samples.push({ pn, ct, disp });
  }
  // least-squares fit ct = a + b * pn
  const n = samples.length;
  const mx = samples.reduce((s, x) => s + x.pn, 0) / n;
  const my = samples.reduce((s, x) => s + x.ct, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const s of samples) {
    sxx += (s.pn - mx) ** 2;
    sxy += (s.pn - mx) * (s.ct - my);
  }
  const b = sxy / sxx;
  const a0 = my - b * mx;
  const rawResid = samples.map((s) => s.ct - (a0 + b * s.pn));
  const dispErr = samples.map((s) => s.disp - (a0 + b * s.pn));
  const stats = (arr) => {
    const abs = arr.map(Math.abs).sort((x, y) => x - y);
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    return {
      n: arr.length,
      meanSigned: +mean.toFixed(2),
      meanAbs: +(abs.reduce((s, x) => s + x, 0) / abs.length).toFixed(2),
      p95Abs: +abs[Math.floor(abs.length * 0.95)].toFixed(2),
      maxAbs: +abs[abs.length - 1].toFixed(2),
    };
  };
  const intervals = changes.slice(1).map((t, i) => t - changes[i]).sort((x, y) => x - y);
  // frame-to-frame monotonicity of the displayed position
  let backwards = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i].disp < samples[i - 1].disp - 0.01) backwards++;

  // --- 3: pause response
  adapter().pause();
  const pauseAt = performance.now();
  await frame();
  const p0 = controller.engine.position();
  await sleep(1000);
  const p1 = controller.engine.position();
  const pausedCt = adapter().audio.currentTime * 1000;

  // --- 4: seek response (while playing)
  adapter().play();
  await sleep(600);
  const seekTarget = 40000;
  controller.seek(seekTarget);
  const seekStart = performance.now();
  let seekFrames = 0;
  for (;;) {
    await frame();
    seekFrames++;
    if (Math.abs(controller.engine.position() - seekTarget) < 400 || seekFrames > 120) break;
  }
  const seekMs = performance.now() - seekStart;
  const cueAfterSeek = controller.runtime.last.cue?.lineIndex;
  await sleep(1500);
  const afterSeekErr = controller.engine.position() - adapter().audio.currentTime * 1000;

  // --- 5: track change
  const before = controller.engine.currentGeneration;
  await controller.playDemo('chrome-hours', true);
  const tcStart = performance.now();
  let tcFrames = 0;
  for (;;) {
    await frame();
    tcFrames++;
    if (controller.engine.currentGeneration !== before && controller.engine.position() < 1500) break;
    if (tcFrames > 240) break;
  }
  const tcMs = performance.now() - tcStart;
  const snap = controller.engine.snapshot();

  return {
    userAgent: navigator.userAgent,
    playbackSampleSeconds: 12,
    frames: n,
    audioClockRateVsPerformanceNow: +b.toFixed(6),
    currentTimeUpdateIntervalMs: {
      min: +intervals[0].toFixed(2),
      median: +intervals[Math.floor(intervals.length / 2)].toFixed(2),
      max: +intervals[intervals.length - 1].toFixed(2),
      distinctValues: changes.length,
    },
    rawCurrentTimeResidualMs: stats(rawResid),
    displayedPositionErrorMs: stats(dispErr),
    displayedWentBackwardsFrames: backwards,
    pause: {
      driftAfter1sMs: +(p1 - p0).toFixed(3),
      displayedMinusAudioMs: +(p1 - pausedCt).toFixed(2),
      firstFrameAfterPauseMs: +(performance.now() - pauseAt).toFixed(0) && undefined,
    },
    seek: { target: seekTarget, msUntilDisplayed: +seekMs.toFixed(1), frames: seekFrames, lineAfterSeek: cueAfterSeek, steadyStateErrorAfter1500ms: +afterSeekErr.toFixed(2) },
    trackChange: { msUntilNewTrackDisplayed: +tcMs.toFixed(1), frames: tcFrames, generation: snap.generation },
    engineStats: snap.stats,
  };
});
console.log(JSON.stringify(result, null, 2));
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
await browser.close();
