import { BrowserWindow, app, clipboard, dialog, ipcMain, powerMonitor, shell } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BridgeCommand, BridgeMessage } from '../src/shared/api';
import { LYRIC_EXTENSIONS, describeLocalTrack, findLyricsInFolder, readLyricFile } from './localMedia';
import { queryLrclib, queryLrclibById } from './lrclib';
import { searchAmll } from './amll';
import { catalogArtwork, lookupCatalog } from './catalog';
import { cacheGet, cachePut, cacheRemove } from './lyricsCache';
import { prepareLibrary } from './library';
import { logDir, readLogTail, writeLog } from './log';
import { MediaBridge } from './mediaBridge';
import { AUDIO_EXTENSIONS, installMediaProtocol, registerMediaSchemePrivileges } from './mediaProtocol';
import { SettingsStore } from './settingsStore';

// Allow the offline demo to start without a click; local playback is user-initiated anyway.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
registerMediaSchemePrivileges();

if (process.env.AFTERGLOW_USER_DATA) app.setPath('userData', process.env.AFTERGLOW_USER_DATA);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win: BrowserWindow | null = null;
let settings: SettingsStore;
const bridge = new MediaBridge((msg: BridgeMessage) => {
  if (msg.type === 'bridge-exit' || msg.type === 'bridge-unavailable' || (msg.type === 'status' && !msg.available) || msg.type === 'hello') {
    writeLog('bridge', JSON.stringify(msg));
  }
  win?.webContents.send('bridge:message', msg);
});

function rendererEntry(): { url?: string; file?: string } {
  if (process.env.AFTERGLOW_DEV_URL) return { url: process.env.AFTERGLOW_DEV_URL };
  return { file: path.join(__dirname, '..', 'renderer', 'index.html') };
}

function iconPath(): string | undefined {
  const p = path.join(__dirname, '..', '..', 'build', 'icon.png');
  return existsSync(p) ? p : undefined;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 480,
    minHeight: 320,
    backgroundColor: '#07070a',
    title: 'Afterglow',
    icon: iconPath(),
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e9e4d8', height: 34 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('enter-full-screen', () => win?.webContents.send('window:fullscreen', true));
  win.on('leave-full-screen', () => win?.webContents.send('window:fullscreen', false));
  win.on('closed', () => {
    win = null;
    bridge.stop();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.AFTERGLOW_DEV_URL ?? '\u0000')) e.preventDefault();
  });
  const entry = rendererEntry();
  if (entry.url) void win.loadURL(entry.url);
  else void win.loadFile(entry.file!, { query: process.env.AFTERGLOW_QUERY ? Object.fromEntries(new URLSearchParams(process.env.AFTERGLOW_QUERY)) : {} });
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    bridgeAvailable: MediaBridge.executablePath() !== null,
    bridgePath: MediaBridge.executablePath() ?? undefined,
    userData: app.getPath('userData'),
  }));
  ipcMain.handle('settings:load', () => settings.load());
  ipcMain.handle('settings:save', (_e, s: unknown) => settings.save(s));

  ipcMain.handle('dialog:openAudio', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: 'Open audio file',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return describeLocalTrack(r.filePaths[0]);
  });
  ipcMain.handle('audio:openPath', async (_e, p: string) => {
    if (typeof p !== 'string' || !AUDIO_EXTENSIONS.includes(path.extname(p).slice(1).toLowerCase())) return null;
    if (!existsSync(p)) return null;
    return describeLocalTrack(p);
  });
  ipcMain.handle('dialog:openLyrics', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: 'Import lyrics',
      properties: ['openFile'],
      filters: [{ name: 'Lyrics (LRC, enhanced LRC, TTML, text)', extensions: LYRIC_EXTENSIONS }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return readLyricFile(r.filePaths[0]);
  });
  ipcMain.handle('lyrics:read', (_e, p: string) => (typeof p === 'string' ? readLyricFile(p) : null));
  ipcMain.handle('lyrics:save', async (_e, name: string, text: string) => {
    if (!win || typeof text !== 'string') return null;
    const r = await dialog.showSaveDialog(win, {
      title: 'Save lyrics',
      defaultPath: String(name || 'lyrics.lrc').replace(/[\\/:*?"<>|]+/g, '_'),
      filters: [{ name: 'LRC', extensions: ['lrc'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, text, 'utf8');
    return r.filePath;
  });
  ipcMain.handle('lyrics:chooseFolder', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { title: 'Choose a lyrics folder', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  ipcMain.handle('lyrics:findInFolder', (_e, folder: string, artist: string, title: string) =>
    typeof folder === 'string' && folder ? findLyricsInFolder(folder, String(artist ?? ''), String(title ?? '')) : null,
  );
  ipcMain.handle('lyrics:lrclib', (_e, q) => queryLrclib(q));
  ipcMain.handle('lyrics:lrclibById', (_e, id: number) => queryLrclibById(Number(id)));
  ipcMain.handle('lyrics:amll', (_e, q) => searchAmll({ title: String(q?.title ?? ''), artist: String(q?.artist ?? ''), album: q?.album, durationSec: q?.durationSec }));
  ipcMain.handle('lyrics:cacheGet', (_e, key: string) => (typeof key === 'string' ? cacheGet(key) : null));
  ipcMain.handle('lyrics:cachePut', (_e, key: string, entry) => (typeof key === 'string' ? cachePut(key, entry) : undefined));
  ipcMain.handle('lyrics:cacheRemove', (_e, key: string) => (typeof key === 'string' ? cacheRemove(key) : undefined));

  ipcMain.handle('bridge:start', (_e, preferred: string) => bridge.start(String(preferred ?? 'spotify')));
  ipcMain.handle('bridge:stop', () => bridge.stop());
  ipcMain.handle('bridge:command', (_e, cmd: BridgeCommand) => bridge.command(cmd));

  ipcMain.handle('window:setFullscreen', (_e, on: boolean) => {
    win?.setFullScreen(Boolean(on));
    return win?.isFullScreen() ?? false;
  });
  ipcMain.handle('window:isFullscreen', () => win?.isFullScreen() ?? false);
  ipcMain.handle('media:peek', () => MediaBridge.peek());
  ipcMain.handle('catalog:lookup', (_e, q) => lookupCatalog({ artist: String(q?.artist ?? ''), title: String(q?.title ?? '') }));
  ipcMain.handle('catalog:artwork', (_e, url: unknown) => (typeof url === 'string' ? catalogArtwork(url) : null));
  ipcMain.handle('log:write', (_e, text: unknown) => {
    if (typeof text === 'string' && text) writeLog('renderer', text);
  });
  ipcMain.handle('log:read', (_e, n: unknown) => readLogTail(typeof n === 'number' && Number.isFinite(n) ? n : 150));
  ipcMain.handle('log:openFolder', async () => {
    mkdirSync(logDir(), { recursive: true });
    await shell.openPath(logDir());
  });
  ipcMain.handle('clipboard:write', (_e, text: unknown) => {
    if (typeof text !== 'string' || text.length > 200_000) return false;
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && ['lrclib.net', 'www.lrclib.net'].includes(u.hostname)) return shell.openExternal(u.toString());
    } catch {
      /* ignore */
    }
    return undefined;
  });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  settings = new SettingsStore(app.getPath('userData'));
  await settings.load();
  await prepareLibrary().catch(() => undefined);
  writeLog('main', `Afterglow ${app.getVersion()} started · ${process.platform} ${os.release()} · Electron ${process.versions.electron}`);
  installMediaProtocol();
  registerIpc();
  ipcMain.handle('power:onBattery', () => powerMonitor.isOnBatteryPower());
  for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'on-battery', 'on-ac'] as const) {
    powerMonitor.on(ev as any, () => win?.webContents.send('power:event', ev));
  }
  createWindow();
});

app.on('window-all-closed', () => {
  bridge.stop();
  app.quit();
});
