import type { CueState } from '../core/lyrics/cues';
import { type LyricAnalysis, countSyllables } from '../core/lyrics/analysis';
import type { LyricDocument, LyricLine, LyricWord } from '../core/lyrics/model';
import type { ContextMode } from '../core/settings/schema';
import { type FontSpec, displayText, fitFlow, measureEm, spaceEm } from './layout';
import type { MotionProfile } from './motion';

export interface Palette {
  dominant: string;
  vibrant: string;
  dark: string;
  light: string;
  muted: string;
  /** Luminance of the dominant color, 0..1 */
  luma: number;
}

export interface ArtworkInfo {
  url: string;
  palette: Palette | null;
}

export interface SceneContext {
  doc: LyricDocument;
  analysis: LyricAnalysis;
  motion: MotionProfile;
  context: ContextMode;
  artwork: ArtworkInfo | null;
  title?: string;
  artist?: string;
  estimatedSweep: boolean;
  textScale: number;
  /** True for small gallery thumbnails. */
  preview?: boolean;
}

export interface FrameInput {
  /** Lyric time (ms). */
  t: number;
  cue: CueState;
  playing: boolean;
  /** Trusted beat envelope, or null. */
  beat: { env: number; index: number; phase: number } | null;
}

export interface UnitView {
  el: HTMLSpanElement;
  word: LyricWord;
  index: number;
  group: number;
  seed: number;
  /** Cached last-written values to avoid redundant style writes. */
  st: string;
  tf: string;
  op: string;
  extra: string;
}

export interface LineView {
  line: LyricLine;
  el: HTMLDivElement;
  units: UnitView[];
  /** Visual words: unit index ranges [a, b). */
  groups: [number, number][];
  groupEls: HTMLSpanElement[];
  groupWidthsEm: number[];
  rows: HTMLDivElement[];
  hook: boolean;
  fast: boolean;
  tf: string;
  op: string;
  shown: boolean;
  /** Free-form per-theme data (layout results etc.). */
  data: Record<string, any>;
}

export type UnitState = 'future' | 'active' | 'past';

export function setLineStyle(v: LineView, tf: string, op: string): void {
  if (v.tf !== tf) {
    v.tf = tf;
    v.el.style.transform = tf;
  }
  if (v.op !== op) {
    v.op = op;
    v.el.style.opacity = op;
  }
}

export function showView(v: LineView, on: boolean): void {
  if (v.shown === on) return;
  v.shown = on;
  v.el.style.visibility = on ? 'visible' : 'hidden';
}

export function setStyle(el: HTMLElement, prop: 'transform' | 'opacity', value: string, holder: { tf?: string; op?: string }, key: 'tf' | 'op'): void {
  if (holder[key] === value) return;
  holder[key] = value;
  el.style[prop] = value;
}

/** Visual word groups: consecutive units joined without whitespace. */
export function groupUnits(words: LyricWord[]): [number, number][] {
  const groups: [number, number][] = [];
  let a = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i].space || i === words.length - 1) {
      groups.push([a, i + 1]);
      a = i + 1;
    }
  }
  return groups;
}

export function buildLineView(line: LyricLine, analysis: LyricAnalysis, font: FontSpec, className: string): LineView {
  const el = document.createElement('div');
  el.className = className;
  el.setAttribute('aria-hidden', 'true');
  // Duets: the source names the singer; themes can style voice-1/voice-2/voice-group.
  if (line.voice !== undefined) el.classList.add(line.voice === 0 ? 'voice-group' : `voice-${line.voice}`);
  const groups = groupUnits(line.words);
  const units: UnitView[] = [];
  const groupEls: HTMLSpanElement[] = [];
  groups.forEach(([a, b], gi) => {
    const g = document.createElement('span');
    g.className = 'g';
    for (let i = a; i < b; i++) {
      const u = document.createElement('span');
      u.className = 'u';
      u.textContent = displayText(line.words[i].text, font);
      if (line.words[i].bg) u.classList.add('bg');
      g.appendChild(u);
      units.push({ el: u, word: line.words[i], index: i, group: gi, seed: line.index * 131 + i * 17, st: '', tf: '', op: '', extra: '' });
    }
    groupEls.push(g);
  });
  const groupWidthsEm = groups.map(([a, b]) => {
    let w = 0;
    for (let i = a; i < b; i++) w += measureEm(line.words[i].text, font);
    return w;
  });
  return {
    line,
    el,
    units,
    groups,
    groupEls,
    groupWidthsEm,
    rows: [],
    hook: analysis.hookLines.has(line.index),
    fast: analysis.fastLines.has(line.index),
    tf: '',
    op: '',
    shown: false,
    data: {},
  };
}

/** Place groups into row elements. sizes: font size per row (px) or a single size. */
export function applyRows(view: LineView, rows: [number, number][], sizes: number[] | number, rowClass = 'row'): void {
  for (const r of view.rows) r.remove();
  view.rows = rows.map(([a, b], ri) => {
    const row = document.createElement('div');
    row.className = rowClass;
    const size = Array.isArray(sizes) ? sizes[ri] : sizes;
    row.style.fontSize = `${size.toFixed(2)}px`;
    for (let g = a; g < b; g++) {
      row.appendChild(view.groupEls[g]);
      if (g < b - 1) row.appendChild(document.createTextNode(' '));
    }
    view.el.appendChild(row);
    return row;
  });
}

/** Unit rectangles relative to the line element (cached until the next layout). */
export function unitRects(view: LineView): { x: number; y: number; w: number; h: number }[] {
  if (view.data.rects) return view.data.rects;
  const rects = view.units.map((u) => {
    let x = 0;
    let y = 0;
    let e: HTMLElement | null = u.el;
    while (e && e !== view.el) {
      x += e.offsetLeft;
      y += e.offsetTop;
      e = e.offsetParent as HTMLElement | null;
      if (e && !view.el.contains(e)) break;
    }
    return { x, y, w: u.el.offsetWidth, h: u.el.offsetHeight };
  });
  view.data.rects = rects;
  return rects;
}

/** Balanced flow layout with one font size; invalidates cached rects. */
export function layoutFlowInto(
  view: LineView,
  space: number,
  box: { w: number; h: number },
  opts: { maxRows: number; lineHeight: number; maxSize: number; minSize: number },
  rowClass = 'row',
): { size: number; rows: number; height: number; widthPx: number } {
  const fit = fitFlow(view.groupWidthsEm, space, box, opts);
  applyRows(view, fit.rows, fit.size, rowClass);
  view.data.rects = undefined;
  const widthPx = Math.max(0, ...fit.rowWidthsEm) * fit.size;
  return { size: fit.size, rows: fit.rows.length, height: fit.rows.length * fit.size * opts.lineHeight, widthPx };
}

/**
 * True when the previous line already left the stage during an instrumental gap, so it
 * must not reappear to play its exit when the next line begins.
 */
export function leftDuringGap(prev: LineView, cur: LineView | null, gapMs = 4500): boolean {
  return !!cur && cur.line.startMs - prev.line.endMs >= gapMs;
}

export function setUnitState(u: UnitView, s: UnitState | 'arrived' | 'ghost'): void {
  if (u.st !== s) {
    u.st = s;
    u.el.dataset.s = s;
  }
}

export function setUnitTransform(u: UnitView, tf: string, op: string): void {
  if (u.tf !== tf) {
    u.tf = tf;
    u.el.style.transform = tf;
  }
  if (u.op !== op) {
    u.op = op;
    u.el.style.opacity = op;
  }
}

/**
 * Per-unit timing for animation. For exact timing these are the source timestamps.
 * For line-timed lyrics units "arrive" with a short decorative stagger at line start
 * and never become individually active (no karaoke claim).
 */
export function unitArrival(view: LineView, i: number, staggerMs: number): number {
  const l = view.line;
  if (l.wordTiming === 'exact') return l.words[i].startMs;
  return l.startMs + i * staggerMs;
}

/**
 * Optional, explicitly labelled estimate of which unit is being sung when the source
 * has line timing only. Heuristic, not measurement:
 *  - each word is weighted by syllables (blended with length), and the last word of
 *    the line gets extra time because line endings are usually held;
 *  - the sung part of the line is sized from the song's own pace (80th-percentile
 *    syllables/second over its timed lines), leaving the rest as a breath before the
 *    next line; without a pace it falls back to 85% of the line.
 */
export function estimatedUnit(view: LineView, t: number, paceSps?: number): number {
  const l = view.line;
  if (t < l.startMs || t >= l.endMs) return -1;
  let est = view.data.est as { w: number[]; total: number; span: number } | undefined;
  if (!est) {
    const n = l.words.length;
    const syl = l.words.map((w) => countSyllables(w.text));
    const w = l.words.map((u, i) => {
      const base = 0.75 * syl[i] + 0.25 * (u.text.replace(/[^\p{L}\p{N}]/gu, '').length / 3) + 0.15;
      return i === n - 1 ? base * (paceSps && paceSps > 4.5 ? 1.25 : 1.7) : base;
    });
    const total = w.reduce((a, b) => a + b, 0);
    const interval = l.endMs - l.startMs;
    const totalSyl = syl.reduce((a, b) => a + b, 0);
    // Sung length from the song's pace. It may stretch a little to fill a slow line
    // (at most 1.5x, at most 40% of the interval) but never across an instrumental break.
    const sung = paceSps && paceSps > 0.5 ? (totalSyl / paceSps) * 1000 * 1.15 : n * 380 + 200;
    const span = paceSps && paceSps > 0.5
      ? Math.min(interval * 0.92, Math.max(sung, Math.min(interval * 0.4, sung * 1.5)))
      : Math.min(interval * 0.85, sung);
    est = { w, total, span };
    view.data.est = est;
  }
  const k = ((t - l.startMs) / est.span) * est.total;
  let acc = 0;
  for (let i = 0; i < est.w.length; i++) {
    acc += est.w[i];
    if (k < acc) return i;
  }
  return -1;
}

export function stateOf(view: LineView, i: number, t: number, staggerMs: number, estimated: number): UnitState | 'arrived' {
  const l = view.line;
  if (l.wordTiming === 'exact') {
    const w = l.words[i];
    if (t < w.startMs) return 'future';
    if (t < w.endMs) return 'active';
    return 'past';
  }
  if (estimated >= 0) return i === estimated ? 'active' : i < estimated ? 'past' : 'arrived';
  return t >= unitArrival(view, i, staggerMs) ? 'arrived' : 'future';
}

/** Short stagger, compressed for fast lines and long lines. */
export function staggerFor(view: LineView, base = 45): number {
  const n = Math.max(1, view.units.length);
  const dur = view.line.endMs - view.line.startMs;
  return Math.min(base, 320 / n, (dur * 0.25) / n);
}

export abstract class Scene {
  protected views = new Map<number, LineView>();
  protected w = 0;
  protected h = 0;
  readonly root: HTMLDivElement;

  constructor(
    protected readonly host: HTMLElement,
    protected ctx: SceneContext,
    className: string,
  ) {
    this.root = document.createElement('div');
    this.root.className = `scene ${className}`;
    if (ctx.preview) this.root.classList.add('is-preview');
    host.appendChild(this.root);
    const r = host.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
  }

  /** Font used for the main lyric line (for measuring). */
  protected abstract readonly font: FontSpec;
  protected abstract createView(line: LyricLine): LineView;
  protected abstract layoutView(view: LineView): void;
  abstract frame(f: FrameInput): void;

  protected view(i: number): LineView | null {
    const line = this.ctx.doc.lines[i];
    if (!line) return null;
    let v = this.views.get(i);
    if (!v) {
      v = this.createView(line);
      this.layoutView(v);
      this.views.set(i, v);
    }
    return v;
  }

  /** Remove DOM for lines far from the current one. */
  protected prune(keepFrom: number, keepTo: number): void {
    for (const [i, v] of this.views) {
      if (i < keepFrom || i > keepTo) {
        v.el.remove();
        this.views.delete(i);
      }
    }
  }

  resize(w: number, h: number): void {
    if (Math.abs(w - this.w) < 1 && Math.abs(h - this.h) < 1) return;
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    // Themes recompute their boxes in onResize; lines on screen are then re-fitted to
    // the new boxes (before 2.5.0 they were re-fitted to the old ones, so a line on
    // screen kept its old size after entering/leaving full screen).
    this.onResize();
    for (const v of this.views.values()) this.layoutView(v);
  }

  protected onResize(): void {}

  update(ctx: SceneContext): void {
    const docChanged = ctx.doc !== this.ctx.doc;
    this.ctx = ctx;
    if (docChanged) {
      for (const v of this.views.values()) v.el.remove();
      this.views.clear();
    } else {
      for (const v of this.views.values()) this.layoutView(v);
    }
    this.onContext();
  }

  protected onContext(): void {}

  destroy(): void {
    this.root.remove();
    this.views.clear();
  }

  protected get space(): number {
    return spaceEm(this.font);
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** Write text only when it changed. */
export function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

export function setVar(e: HTMLElement, name: string, value: string, cache: Record<string, string>): void {
  if (cache[name] === value) return;
  cache[name] = value;
  e.style.setProperty(name, value);
}

/** Base UI unit for secondary text: scales with the stage, much smaller in previews. */
export function unitSize(h: number, preview?: boolean, lo = 10, hi = 15, k = 0.018): number {
  return preview ? Math.max(3, h * 0.026) : Math.max(lo, Math.min(hi, h * k));
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
