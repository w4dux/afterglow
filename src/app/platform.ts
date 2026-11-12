import type { AfterglowApi, AppInfo, LocalTrackInfo, LyricFileResult } from '../shared/api';

/**
 * Access to the Electron bridge with browser fallbacks, so the renderer also runs in
 * a plain browser (dev server, automated screenshots). Browser mode has no system
 * media integration and stores settings in localStorage.
 */
export const native: AfterglowApi | null = typeof window !== 'undefined' && window.afterglow ? window.afterglow : null;
export const isElectron = native !== null;

const LS_KEY = 'afterglow.settings.v2';

export async function appInfo(): Promise<AppInfo> {
  if (native) return native.info();
  return {
    version: '2.6.0',
    platform: 'browser',
    electron: '-',
    chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '?',
    bridgeAvailable: false,
    userData: 'localStorage',
  };
}

export async function loadSettingsRaw(): Promise<unknown> {
  if (native) return native.loadSettings();
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export async function saveSettingsRaw(s: unknown): Promise<void> {
  if (native) return native.saveSettings(s);
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Browser fallback: object URL, no tag parsing (labelled as such in the UI). */
export function localTrackFromFile(file: File): LocalTrackInfo {
  return {
    path: file.name,
    url: URL.createObjectURL(file),
    fileName: file.name,
    genres: [],
    embedded: {},
    metadataError: 'Tags are read only in the desktop app.',
  };
}

export async function openAudio(): Promise<LocalTrackInfo | null> {
  if (native) return native.openAudio();
  const f = await pickFile('audio/*');
  return f ? localTrackFromFile(f) : null;
}

export async function openLyrics(): Promise<LyricFileResult | null> {
  if (native) return native.openLyrics();
  const f = await pickFile('.lrc,.elrc,.ttml,.xml,.txt');
  if (!f) return null;
  return { path: f.name, name: f.name, text: await f.text() };
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
