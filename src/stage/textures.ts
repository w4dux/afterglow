import type { Palette } from './scene';

/** Procedural textures generated once and cached as data URLs (no image assets). */
const cache = new Map<string, string>();

export function grainTexture(size = 192, alpha = 0.16): string {
  const key = `grain${size}${alpha}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  let s = 12345;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 16807) % 2147483647;
    const v = (s / 2147483647) * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = alpha * 255;
  }
  g.putImageData(img, 0, 0);
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

/** Photocopied paper: soft blotches, fibres and toner specks. */
export function paperTexture(size = 512): string {
  const key = `paper${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(0,0,0,0)';
  g.fillRect(0, 0, size, size);
  let s = 777;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 90; i++) {
    const x = r() * size;
    const y = r() * size;
    const rad = 20 + r() * 90;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(60,45,30,${0.05 * r()})`);
    grd.addColorStop(1, 'rgba(60,45,30,0)');
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  g.strokeStyle = 'rgba(40,30,20,0.08)';
  for (let i = 0; i < 260; i++) {
    const x = r() * size;
    const y = r() * size;
    g.lineWidth = 0.5 + r();
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + (r() - 0.5) * 30, y + (r() - 0.5) * 30, x + (r() - 0.5) * 40, y + (r() - 0.5) * 40);
    g.stroke();
  }
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(0,0,0,${0.08 + r() * 0.3})`;
    const d = r() * 1.6;
    g.fillRect(r() * size, r() * size, d, d);
  }
  // photocopy streaks
  for (let i = 0; i < 6; i++) {
    const y = r() * size;
    g.fillStyle = `rgba(0,0,0,${0.02 + r() * 0.04})`;
    g.fillRect(0, y, size, 1 + r() * 4);
  }
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

/** Halftone dot screen as an SVG data URL (used as a multiply overlay). */
export function halftone(cell = 7, color = '#000'): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${cell}"><circle cx="${cell / 2}" cy="${cell / 2}" r="${cell * 0.32}" fill="${color}"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return hex(f(0) * 255, f(8) * 255, f(4) * 255);
}

export function relLuma(hexColor: string): number {
  const v = hexColor.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Extract a small palette from an artwork image (same-origin or data URL). */
export async function extractPalette(url: string): Promise<Palette | null> {
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 40;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, 40, 40);
    const d = g.getImageData(0, 0, 40, 40).data;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    let vib: [number, number, number, number] = [0, 0, 0, -1];
    let dark: [number, number, number, number] = [0, 0, 0, 2];
    let light: [number, number, number, number] = [255, 255, 255, -1];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const [r, gg, b] = [d[i], d[i + 1], d[i + 2]];
      sr += r;
      sg += gg;
      sb += b;
      n++;
      const [, s, l] = rgbToHsl(r, gg, b);
      const score = s * (1 - Math.abs(l - 0.5) * 1.6);
      if (score > vib[3]) vib = [r, gg, b, score];
      if (l < dark[3]) dark = [r, gg, b, l];
      if (l > light[3]) light = [r, gg, b, l];
    }
    if (!n) return null;
    const dom = hex(sr / n, sg / n, sb / n);
    const [h, s, l] = rgbToHsl(sr / n, sg / n, sb / n);
    const vibrantHex = vib[3] > 0.15 ? hex(vib[0], vib[1], vib[2]) : hslToHex(h, Math.max(0.55, s), 0.55);
    return {
      dominant: dom,
      vibrant: vibrantHex,
      dark: hslToHex(rgbToHsl(dark[0], dark[1], dark[2])[0], Math.min(0.6, s + 0.1), Math.min(0.14, l * 0.4 + 0.04)),
      light: hex(light[0], light[1], light[2]),
      muted: hslToHex(h, Math.min(0.35, s), 0.32),
      luma: relLuma(dom),
    };
  } catch {
    return null;
  }
}

const blurCache = new Map<string, Promise<string | null>>();

/**
 * A pre-blurred, low-resolution copy of the artwork as a data URL. Displayed scaled up,
 * it reads as a heavy blur but costs nothing per frame (no CSS filter to recompute).
 */
export function blurredArtwork(url: string, size = 48, blurPx = 3, saturate = 1.2, brightness = 1): Promise<string | null> {
  const key = `${url}|${size}|${blurPx}|${saturate}|${brightness}`;
  let p = blurCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const g = c.getContext('2d')!;
        g.filter = `blur(${blurPx}px) saturate(${saturate}) brightness(${brightness})`;
        // draw slightly oversized so blurred edges do not fade to transparent
        g.drawImage(img, -size * 0.15, -size * 0.15, size * 1.3, size * 1.3);
        return c.toDataURL('image/png');
      } catch {
        return null;
      }
    })();
    blurCache.set(key, p);
  }
  return p;
}
