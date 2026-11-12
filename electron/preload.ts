import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AfterglowApi, BridgeMessage } from '../src/shared/api';

function on<T>(channel: string, cb: (v: T) => void): () => void {
  const fn = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

const api: AfterglowApi = {
  info: () => ipcRenderer.invoke('app:info'),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  openAudio: () => ipcRenderer.invoke('dialog:openAudio'),
  openAudioPath: (p) => ipcRenderer.invoke('audio:openPath', p),
  openLyrics: () => ipcRenderer.invoke('dialog:openLyrics'),
  readLyricFile: (p) => ipcRenderer.invoke('lyrics:read', p),
  saveLyrics: (name, text) => ipcRenderer.invoke('lyrics:save', name, text),
  chooseLyricsFolder: () => ipcRenderer.invoke('lyrics:chooseFolder'),
  findLyricsInFolder: (folder, artist, title) => ipcRenderer.invoke('lyrics:findInFolder', folder, artist, title),
  lrclib: (q) => ipcRenderer.invoke('lyrics:lrclib', q),
  lrclibById: (id) => ipcRenderer.invoke('lyrics:lrclibById', id),
  amll: (q) => ipcRenderer.invoke('lyrics:amll', q),
  lyricsCacheGet: (key) => ipcRenderer.invoke('lyrics:cacheGet', key),
  lyricsCachePut: (key, entry) => ipcRenderer.invoke('lyrics:cachePut', key, entry),
  lyricsCacheRemove: (key) => ipcRenderer.invoke('lyrics:cacheRemove', key),
  bridgeStart: (preferred) => ipcRenderer.invoke('bridge:start', preferred),
  bridgeStop: () => ipcRenderer.invoke('bridge:stop'),
  bridgeCommand: (cmd) => ipcRenderer.invoke('bridge:command', cmd),
  onBridge: (cb) => on<BridgeMessage>('bridge:message', cb),
  onPower: (cb) => on('power:event', cb),
  onBattery: () => ipcRenderer.invoke('power:onBattery'),
  setFullscreen: (v) => ipcRenderer.invoke('window:setFullscreen', v),
  isFullscreen: () => ipcRenderer.invoke('window:isFullscreen'),
  onFullscreen: (cb) => on<boolean>('window:fullscreen', cb),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  mediaPeek: () => ipcRenderer.invoke('media:peek'),
  log: (text) => ipcRenderer.invoke('log:write', text),
  readLog: (lines) => ipcRenderer.invoke('log:read', lines),
  openLogFolder: () => ipcRenderer.invoke('log:openFolder'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  catalog: (q) => ipcRenderer.invoke('catalog:lookup', q),
  catalogArtwork: (url) => ipcRenderer.invoke('catalog:artwork', url),
};

contextBridge.exposeInMainWorld('afterglow', api);
