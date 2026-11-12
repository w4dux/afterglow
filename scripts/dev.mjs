#!/usr/bin/env node
// Dev loop: Vite dev server for the renderer + Electron pointed at it.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const url = 'http://127.0.0.1:5199/';
const sh = process.platform === 'win32';
await new Promise((res, rej) => {
  const b = spawn('node', ['scripts/build-electron.mjs'], { stdio: 'inherit', shell: sh });
  b.on('exit', (c) => (c === 0 ? res() : rej(new Error('electron build failed'))));
});
const vite = spawn('npx', ['vite', '--host', '127.0.0.1'], { stdio: 'inherit', shell: sh });
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}
const electron = spawn(require('electron'), ['.'], { stdio: 'inherit', env: { ...process.env, AFTERGLOW_DEV_URL: url } });
electron.on('exit', () => {
  vite.kill();
  process.exit(0);
});
