/**
 * Text measurement and fitting. Measurements happen once per line (and on resize),
 * never per frame. Widths are computed at 1px font size ("em" units) so that any
 * font size can be derived by multiplication.
 */

export interface FontSpec {
  family: string;
  weight: number;
  style?: 'normal' | 'italic';
  /** CSS letter-spacing in em. */
  tracking?: number;
  upper?: boolean;
  /** Set in lowercase (display and measurement). */
  lower?: boolean;
  /** CSS line-height multiplier used for layout. */
  lineHeight: number;
}

let ctx: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

function context(): CanvasRenderingContext2D {
  if (!ctx) {
    const c = document.createElement('canvas');
    ctx = c.getContext('2d')!;
  }
  return ctx;
}

export function cssFont(f: FontSpec, sizePx: number): string {
  return `${f.style === 'italic' ? 'italic ' : ''}${f.weight} ${sizePx}px "${f.family}"`;
}

export function displayText(text: string, f: FontSpec): string {
  return f.upper ? text.toLocaleUpperCase() : f.lower ? text.toLocaleLowerCase() : text;
}

/** Width in em of `text` rendered with font f (includes letter-spacing). */
export function measureEm(text: string, f: FontSpec): number {
  const t = displayText(text, f);
  const key = `${f.family}|${f.weight}|${f.style}|${f.tracking}|${t}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const c = context();
  c.font = cssFont(f, 100);
  const w = c.measureText(t).width / 100 + (f.tracking ?? 0) * [...t].length;
  if (cache.size > 6000) cache.clear();
  cache.set(key, w);
  return w;
}

export function spaceEm(f: FontSpec): number {
  return Math.max(0.18, measureEm(' ', f));
}

export async function ensureFonts(fonts: FontSpec[]): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  await Promise.all(
    fonts.map((f) =>
      document.fonts.load(cssFont(f, 40), 'AaÉé').catch(() => undefined),
    ),
  );
  cache.clear();
}

function rowWidth(widths: number[], space: number, a: number, b: number): number {
  let w = 0;
  for (let i = a; i < b; i++) w += widths[i];
  return w + space * Math.max(0, b - a - 1);
}

/**
 * Partition words into `rows` contiguous rows minimizing the maximum row width
 * (balanced wrapping). Returns row break indices as [start, end) pairs.
 */
export function balancedRows(widths: number[], space: number, rows: number): [number, number][] {
  const n = widths.length;
  rows = Math.max(1, Math.min(rows, n));
  // best[r][i]: minimal max width for first i words in r rows
  const INF = Number.POSITIVE_INFINITY;
  const best: number[][] = Array.from({ length: rows + 1 }, () => new Array(n + 1).fill(INF));
  const cut: number[][] = Array.from({ length: rows + 1 }, () => new Array(n + 1).fill(0));
  best[0][0] = 0;
  for (let r = 1; r <= rows; r++) {
    for (let i = r; i <= n; i++) {
      for (let k = r - 1; k < i; k++) {
        const v = Math.max(best[r - 1][k], rowWidth(widths, space, k, i));
        if (v < best[r][i]) {
          best[r][i] = v;
          cut[r][i] = k;
        }
      }
    }
  }
  const out: [number, number][] = [];
  let i = n;
  for (let r = rows; r >= 1; r--) {
    const k = cut[r][i];
    out.unshift([k, i]);
    i = k;
  }
  return out;
}

/** Greedy row count at a given available width (em). */
function greedyRows(widths: number[], space: number, maxW: number): number {
  let rows = 1;
  let cur = 0;
  for (let i = 0; i < widths.length; i++) {
    const add = cur === 0 ? widths[i] : cur + space + widths[i];
    if (add > maxW && cur > 0) {
      rows++;
      cur = widths[i];
    } else cur = add;
  }
  return rows;
}

export interface FlowFit {
  size: number;
  rows: [number, number][];
  rowWidthsEm: number[];
}

/**
 * Largest font size so the words wrap into at most maxRows balanced rows within the box.
 */
export function fitFlow(
  widths: number[],
  space: number,
  box: { w: number; h: number },
  opts: { maxRows: number; lineHeight: number; maxSize: number; minSize: number },
): FlowFit {
  if (widths.length === 0) return { size: opts.maxSize, rows: [], rowWidthsEm: [] };
  let lo = opts.minSize;
  let hi = opts.maxSize;
  const fits = (s: number) => {
    const r = greedyRows(widths, space, box.w / s);
    return r <= opts.maxRows && r * s * opts.lineHeight <= box.h;
  };
  if (!fits(lo)) {
    // Too long even at min size: allow more rows at min size.
    const r = greedyRows(widths, space, box.w / lo);
    const rows = balancedRows(widths, space, r);
    return { size: lo, rows, rowWidthsEm: rows.map(([a, b]) => rowWidth(widths, space, a, b)) };
  }
  for (let k = 0; k < 18; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  const size = lo;
  const count = greedyRows(widths, space, box.w / size);
  const rows = balancedRows(widths, space, count);
  return { size, rows, rowWidthsEm: rows.map(([a, b]) => rowWidth(widths, space, a, b)) };
}

export interface StackFit {
  rows: [number, number][];
  sizes: number[];
  rowWidthsEm: number[];
  totalHeight: number;
}

/**
 * Editorial stack: each row is scaled to fill the width (poster style), rows are
 * chosen to maximize the smallest row size (legibility), with a cap on how much
 * bigger a short row may become.
 */
export function fitStack(
  widths: number[],
  space: number,
  box: { w: number; h: number },
  opts: { maxRows: number; lineHeight: number; maxSize: number; maxRatio: number },
): StackFit {
  const n = widths.length;
  if (n === 0) return { rows: [], sizes: [], rowWidthsEm: [], totalHeight: 0 };
  let best: StackFit | null = null;
  let bestScore = -Infinity;
  for (let R = 1; R <= Math.min(opts.maxRows, n); R++) {
    const rows = varianceRows(widths, space, R);
    const rw = rows.map(([a, b]) => rowWidth(widths, space, a, b));
    let sizes = rw.map((w) => Math.min(opts.maxSize, box.w / w));
    const minS = Math.min(...sizes);
    sizes = sizes.map((s) => Math.min(s, minS * opts.maxRatio));
    let total = sizes.reduce((a, s) => a + s * opts.lineHeight, 0);
    if (total > box.h) {
      const k = box.h / total;
      sizes = sizes.map((s) => s * k);
      total = box.h;
    }
    const eff = Math.min(...sizes);
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const score = eff * 0.75 + mean * 0.25 - R * 0.002 * box.h;
    if (score > bestScore) {
      bestScore = score;
      best = { rows, sizes, rowWidthsEm: rw, totalHeight: total };
    }
  }
  return best!;
}

/** Partition minimizing the variance of row widths (target = total / rows). */
function varianceRows(widths: number[], space: number, rows: number): [number, number][] {
  const n = widths.length;
  const total = rowWidth(widths, space, 0, n);
  const target = total / rows;
  const INF = Number.POSITIVE_INFINITY;
  const best: number[][] = Array.from({ length: rows + 1 }, () => new Array(n + 1).fill(INF));
  const cut: number[][] = Array.from({ length: rows + 1 }, () => new Array(n + 1).fill(0));
  best[0][0] = 0;
  for (let r = 1; r <= rows; r++) {
    for (let i = r; i <= n; i++) {
      for (let k = r - 1; k < i; k++) {
        const d = rowWidth(widths, space, k, i) - target;
        const v = best[r - 1][k] + d * d;
        if (v < best[r][i]) {
          best[r][i] = v;
          cut[r][i] = k;
        }
      }
    }
  }
  const out: [number, number][] = [];
  let i = n;
  for (let r = rows; r >= 1; r--) {
    const k = cut[r][i];
    out.unshift([k, i]);
    i = k;
  }
  return out;
}
