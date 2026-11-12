#!/usr/bin/env node
/**
 * Deterministic screenshots of the renderer (browser mode) at exact song positions.
 * Usage: node scripts/shoot.mjs <outDir> <url> <spec.json>
 * spec: [{ name, w, h, demo, theme, atMs, scale?, actions?: [js...] }]
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/node-tools/node_modules/playwright');
}

const [outDir, base, specPath] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
mkdirSync(outDir, { recursive: true });

const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
for (const s of spec) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: s.scale ?? 1, reducedMotion: s.reducedMotion ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${s.name}] pageerror`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.error(`[${s.name}] console`, m.text()));
  await page.goto(`${base}?demo=${s.demo ?? 'night-shift'}&automation`);
  await page.waitForFunction(() => window.__afterglow?.getApp().lyrics.status === 'synced', null, { timeout: 15000 });
  await page.evaluate(async (s) => {
    const { controller, setApp, getApp } = window.__afterglow;
    controller.runtime.freezeAt(null);
    if (s.theme) controller.chooseTheme(s.theme);
    if (s.settings) controller.updateSettings((x) => ({ ...x, ...s.settings, motion: { ...x.motion, ...(s.settings.motion ?? {}) }, display: { ...x.display, ...(s.settings.display ?? {}) } }));
    if (s.ui) setApp((st) => ({ ui: { ...st.ui, ...s.ui } }));
    if (s.lineOnly) controller.setLineOnly(true);
    await document.fonts.ready;
  }, s);
  await page.waitForTimeout(700);
  await page.evaluate((s) => {
    const { controller, setApp } = window.__afterglow;
    controller.runtime.freezeAt(s.atMs);
    if (s.hideChrome !== false) setApp((st) => ({ ui: { ...st.ui, controlsVisible: false } }));
  }, s);
  if (s.actions) for (const a of s.actions) await page.evaluate(a);
  await page.waitForTimeout(s.wait ?? 600);
  await page.screenshot(s.jpeg ? { path: join(outDir, `${s.name}.jpg`), type: 'jpeg', quality: 88 } : { path: join(outDir, `${s.name}.png`) });
  console.log('shot', s.name);
  await ctx.close();
}
await browser.close();
