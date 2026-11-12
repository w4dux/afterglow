import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const output = resolve(process.env.AFTERGLOW_DESIGN_OUTPUT ?? 'docs/design-2.1.0');
mkdirSync(output, { recursive: true });
const app = await _electron.launch({ executablePath: process.env.AFTERGLOW_TEST_EXE ?? require('electron'), args: ['.'],
  env: { ...process.env, AFTERGLOW_USER_DATA: mkdtempSync(join(tmpdir(), 'afterglow-design-')), AFTERGLOW_QUERY: 'automation' } });
const errors = [], measurements = [];
try {
  const win = await app.firstWindow();
  win.on('pageerror', e => errors.push(e.message));
  await win.waitForFunction(() => window.__afterglow?.getApp().ready);
  const variants = [ ['cypher','night-shift',6300], ['velvet','slow-honey',5200], ['feedback','static-hearts',4300],
    ['afterhours','slow-honey',5200], ['riot','static-hearts',4300], ['prism','sugar-signal',5100] ];
  for (const [theme, demo, time] of variants) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await win.evaluate(async ({ theme, demo, time }) => {
      const { controller: c } = window.__afterglow;
      await c.playDemo(demo, false); c.chooseTheme(theme); c.runtime.freezeAt(time);
    }, { theme, demo, time });
    await win.waitForFunction(() => window.__afterglow.getApp().lyrics.doc?.timing === 'word');
    await win.waitForTimeout(650);
    await win.screenshot({ path: join(output, `${theme}.png`) });
    const measure = await win.evaluate(() => {
      const scene = document.querySelector('.scene-layer:not(.leaving) .scene');
      const bounds = scene.getBoundingClientRect();
      const visible = [...scene.querySelectorAll('.u')].filter(e => {
        const line = e.closest('.co-line,.cy-line,.vv-line,.fb-line');
        return line && getComputedStyle(line).visibility !== 'hidden' && Number(getComputedStyle(line).opacity) > .1;
      });
      return { words: visible.length, clipped: visible.filter(e => { const b = e.getBoundingClientRect();
        return b.left < bounds.left - 2 || b.right > bounds.right + 2 || b.top < bounds.top - 2 || b.bottom > bounds.bottom + 2;
      }).length };
    });
    assert.equal(measure.clipped, 0, `${theme}: words outside stage`); measurements.push({ theme, ...measure });
    if (['afterhours','riot','prism'].includes(theme)) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(520, 680));
      await win.waitForTimeout(350);
      await win.screenshot({ path: join(output, `${theme}-compact.png`) });
      await win.evaluate(() => window.__afterglow.controller.updateSettings(s => ({ ...s, motion: { ...s.motion, reduced: 'on' } })));
      await win.waitForTimeout(200);
      const before = await win.locator('.scene-layer:not(.leaving) .co-disc').getAttribute('style');
      await win.evaluate(t => window.__afterglow.controller.runtime.freezeAt(t), time + 900);
      await win.waitForTimeout(200);
      assert.equal(await win.locator('.scene-layer:not(.leaving) .co-disc').getAttribute('style'), before);
      await win.evaluate(t => window.__afterglow.controller.runtime.freezeAt(t), time);
      await win.evaluate(() => window.__afterglow.controller.updateSettings(s => ({ ...s, motion: { ...s.motion, reduced: 'off' } })));
    }
    console.log('preview', theme, JSON.stringify(measure));
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  await win.evaluate(() => window.__afterglow.setApp(s => ({ ui: { ...s.ui, panel: 'themes' } })));
  await win.waitForTimeout(1200);
  await win.screenshot({ path: join(output, 'theme-library.png') });
  assert.equal(await win.getByRole('listbox', { name: 'Choose a theme' }).getByRole('option').count(), 10);
  for (const [name, id] of [['Afterhours', 'afterhours'], ['Riot', 'riot'], ['Prism', 'prism']]) {
    await win.getByRole('listbox', { name: 'Choose a theme' }).getByRole('option').filter({ hasText: name }).click();
    await win.waitForFunction(id => window.__afterglow.getApp().theme.activeId === id, id);
  }
  await win.waitForTimeout(400);
  const saved = await win.evaluate(async () => {
    const raw = await window.afterglow.loadSettings();
    return Object.values(raw.theme.trackThemes).includes('prism');
  });
  assert.ok(saved, 'new theme choice persists');
  await win.evaluate(() => window.__afterglow.setApp(s => ({ ui: { ...s.ui, panel: null } })));
  // A long authored line and non-Latin text must remain readable at compact size.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(520, 680));
  for (const id of ['afterhours', 'riot', 'prism']) {
    await win.evaluate(id => {
      const c = window.__afterglow.controller;
      c.useLyricsText(['[00:01.00]We keep the music playing through the city lights and every little moment that we never want to end', '[00:09.00]এই রাতের আলোয় নতুন গল্প লিখি', '[00:16.00]End of side'].join(String.fromCharCode(10)), 'layout.lrc');
      c.chooseTheme(id); c.runtime.freezeAt(3000);
    }, id);
    await win.waitForTimeout(400);
    const outside = await win.evaluate(() => [...document.querySelectorAll('.scene-layer:not(.leaving) .co-line .u')].filter(e => {
      const b = e.getBoundingClientRect(); return getComputedStyle(e.closest('.co-line')).visibility !== 'hidden' &&
        (b.left < -2 || b.right > innerWidth + 2 || b.top < 0 || b.bottom > innerHeight);
    }).length);
    assert.equal(outside, 0, `${id}: long line fits compact stage`);
    await win.evaluate(() => window.__afterglow.controller.runtime.freezeAt(10500));
    await win.waitForTimeout(100);
    const hasNonLatin = await win.locator('.scene-layer:not(.leaving) .co-line').filter({ hasText: 'এই রাতের' }).count();
    assert.ok(hasNonLatin, 'non-Latin line rendered');
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'checks.json'), JSON.stringify({ errors, measurements, themeCount: 10, selectionAndPersistence: true, reducedMotion: true, compactLongLines: true, nonLatinText: true }, null, 2));
} finally { await app.close(); }
