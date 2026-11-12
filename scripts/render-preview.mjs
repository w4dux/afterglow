#!/usr/bin/env node
/**
 * Renders a motion preview video, frame by frame, from the real renderer.
 * Each frame is the stage at an exact song position (the stage is a pure function
 * of playback time), so the result is smooth and exactly in sync with the audio
 * segment muxed underneath.
 *
 * Usage: node scripts/render-preview.mjs <baseUrl> <out.mp4> [fps]
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/node-tools/node_modules/playwright');
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [base, out, fpsArg] = process.argv.slice(2);
const FPS = Number(fpsArg ?? 30);
const W = 1280;
const H = 720;

const SEGMENTS = [
  { demo: 'night-shift', theme: 'cypher', from: 4600, to: 17600, label: 'Cypher · rap' },
  { demo: 'night-shift', theme: 'cypher', from: 25700, to: 33600, label: 'Cypher · hook', motion: 'jiggle' },
  { demo: 'chrome-hours', theme: 'nocturne', from: 9800, to: 19000, label: 'Nocturne · trap' },
  { demo: 'slow-honey', theme: 'velvet', from: 5900, to: 14500, label: 'Velvet · R&B' },
  { demo: 'sugar-signal', theme: 'sherbet', from: 13500, to: 22300, label: 'Sherbet · pop' },
  { demo: 'static-hearts', theme: 'feedback', from: 5600, to: 13500, label: 'Feedback · rock' },
  { demo: 'low-tide', theme: 'horizon', from: 21000, to: 31500, label: 'Horizon · ambient' },
];

const work = join(tmpdir(), `afterglow-preview-${process.pid}`);
mkdirSync(work, { recursive: true });
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));

let frameNo = 0;
const audioParts = [];
for (const [si, seg] of SEGMENTS.entries()) {
  await page.goto(`${base}?demo=${seg.demo}&automation`);
  await page.waitForFunction(() => window.__afterglow?.getApp().lyrics.status === 'synced', null, { timeout: 20000 });
  await page.addStyleTag({ content: '*{transition-duration:0s!important;animation-duration:0s!important} .chrome{display:none!important}' });
  await page.evaluate(async (seg) => {
    const { controller, setApp } = window.__afterglow;
    controller.updateSettings((s) => ({ ...s, theme: { ...s.theme, mode: 'manual', manualTheme: seg.theme }, motion: { ...s.motion, treatment: seg.motion ?? 'signature' } }));
    controller.chooseTheme(seg.theme);
    setApp((st) => ({ ui: { ...st.ui, controlsVisible: false } }));
    await document.fonts.ready;
  }, seg);
  await page.waitForTimeout(900);
  const frames = Math.round(((seg.to - seg.from) / 1000) * FPS);
  for (let i = 0; i < frames; i++) {
    const t = seg.from + (i * 1000) / FPS;
    await page.evaluate((t) => {
      window.__afterglow.controller.runtime.freezeAt(t);
      window.__afterglow.controller.runtime.renderNow();
    }, t);
    await page.screenshot({ path: join(work, `f${String(frameNo++).padStart(6, '0')}.jpg`), type: 'jpeg', quality: 92 });
  }
  const wav = join(work, `a${si}.wav`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(seg.from / 1000), '-to', String(seg.to / 1000), '-i', join(ROOT, 'public', 'demo', `${seg.demo}.ogg`), '-af', 'afade=t=in:d=0.04,afade=t=out:st=' + ((seg.to - seg.from) / 1000 - 0.08) + ':d=0.08', '-ar', '48000', '-ac', '2', wav]);
  audioParts.push(wav);
  console.log(`${seg.label}: ${frames} frames`);
}
await browser.close();

const list = join(work, 'audio.txt');
writeFileSync(list, audioParts.map((p) => `file '${p}'`).join('\n'));
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'pcm_s16le', join(work, 'audio.wav')]);
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-framerate', String(FPS), '-i', join(work, 'f%06d.jpg'),
  '-i', join(work, 'audio.wav'),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  '-c:a', 'aac', '-b:a', '160k', '-shortest', out,
]);
rmSync(work, { recursive: true, force: true });
console.log('wrote', out);
