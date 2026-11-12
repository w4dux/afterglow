import type { LyricLine } from '../core/lyrics/model';
import type { FontSpec } from '../stage/layout';
import { clamp01, easeOutCubic, hash01 } from '../stage/motion';
import {
  type FrameInput,
  type LineView,
  Scene,
  type SceneContext,
  buildLineView,
  el,
  estimatedUnit,
  fmtClock,
  layoutFlowInto,
  setLineStyle,
  setText,
  setUnitState,
  setUnitTransform,
  showView,
  staggerFor,
  stateOf,
  unitArrival,
  unitSize,
} from '../stage/scene';

/**
 * MONSOON: Bangla and South Asian band music, ballads, rainy-night songs. A window at
 * night: rain runs down the glass over warm, out-of-focus city lights. Upcoming words
 * sit fogged on the glass and clear as they are sung. Rain and drifting lights are
 * functions of lyric time. Bengali text falls back to Nirmala UI (Windows) or Noto Bengali (Linux).
 */
export const MONSOON_FONT: FontSpec = { family: 'Fraunces Variable', weight: 360, tracking: -0.015, lineHeight: 1.14 };

const textures = new Map<string, string>();

/** Short falling streaks, tiled; drawn once. */
function rainTexture(w: number, h: number, count: number, alpha: number, seed: number): string {
  const key = `rain|${w}|${h}|${count}|${alpha}|${seed}`;
  const hit = textures.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  for (let i = 0; i < count; i++) {
    const x = hash01(i, seed) * w;
    const y = hash01(i, seed + 1) * h;
    const len = 18 + hash01(i, seed + 2) * 46;
    const a = alpha * (0.35 + hash01(i, seed + 3) * 0.65);
    const grad = g.createLinearGradient(x, y, x - len * 0.12, y + len);
    grad.addColorStop(0, 'rgba(210,232,255,0)');
    grad.addColorStop(1, `rgba(210,232,255,${a.toFixed(3)})`);
    g.strokeStyle = grad;
    g.lineWidth = hash01(i, seed + 4) > 0.85 ? 1.6 : 1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - len * 0.12, y + len);
    g.stroke();
  }
  const url = c.toDataURL();
  textures.set(key, url);
  return url;
}

/** Beads of water on the glass; drawn once. */
function dropsTexture(size: number): string {
  const key = `drops|${size}`;
  const hit = textures.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 140; i++) {
    const x = hash01(i, 71) * size;
    const y = hash01(i, 72) * size;
    const r = 1.2 + hash01(i, 73) ** 3 * 7;
    const grad = g.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.45, 'rgba(200,225,240,0.10)');
    grad.addColorStop(1, 'rgba(0,0,0,0.18)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const url = c.toDataURL();
  textures.set(key, url);
  return url;
}

const LIGHTS = 9;
const RAIN = [
  { tile: 220, count: 44, alpha: 0.16, speed: 0.9, seed: 11 },
  { tile: 360, count: 26, alpha: 0.28, speed: 1.6, seed: 31 },
];

export class MonsoonScene extends Scene {
  protected readonly font = MONSOON_FONT;
  private readonly stage: HTMLDivElement;
  private readonly city: HTMLDivElement;
  private readonly rain: HTMLDivElement[] = [];
  private readonly next: HTMLDivElement;
  private readonly meta: HTMLDivElement;
  private readonly gap: HTMLDivElement;
  private readonly gapTime: HTMLDivElement;
  private readonly estTag: HTMLDivElement;
  private box = { w: 0, h: 0 };
  private lastLine = -2;
  private lastCity = '';

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'monsoon');
    const r = this.root;
    el('div', 'mo-night', r);
    this.city = el('div', 'mo-city', r);
    for (let i = 0; i < LIGHTS; i++) {
      const b = el('div', `mo-light l${i % 3}`, this.city);
      const s = 0.07 + hash01(i, 5) * 0.12;
      b.style.cssText = `left:${(hash01(i, 6) * 100).toFixed(1)}%;top:${(62 + hash01(i, 7) * 34).toFixed(1)}%;width:calc(var(--h)*${s.toFixed(3)});height:calc(var(--h)*${s.toFixed(3)});opacity:${(0.35 + hash01(i, 8) * 0.5).toFixed(2)}`;
    }
    for (const layer of RAIN) {
      const e = el('div', 'mo-rain', r);
      e.style.backgroundImage = `url(${rainTexture(layer.tile, layer.tile, layer.count, layer.alpha, layer.seed)})`;
      e.style.backgroundSize = `${layer.tile}px ${layer.tile}px`;
      e.style.top = `-${layer.tile}px`;
      e.style.height = `calc(100% + ${layer.tile}px)`;
      this.rain.push(e);
    }
    el('div', 'mo-glass', r).style.backgroundImage = `url(${dropsTexture(420)})`;
    const head = el('div', 'mo-head', r);
    el('span', 'mo-brand', head, 'MONSOON');
    el('span', 'mo-tag', head, 'বৃষ্টির রাত');
    this.meta = el('div', 'mo-meta', r);
    this.stage = el('div', 'mo-stage', r);
    this.next = el('div', 'mo-next', r);
    const gap = el('div', 'mo-gap', r);
    this.gap = el('div', 'mo-gap-title', gap);
    this.gapTime = el('div', 'mo-gap-time', gap);
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    this.onContext();
    this.onResize();
  }

  protected override onContext(): void {
    this.root.dataset.context = this.ctx.context;
    setText(this.meta, [this.ctx.title, this.ctx.artist].filter(Boolean).join(' — '));
    this.lastLine = -2;
  }

  protected override onResize(): void {
    const narrow = this.w / this.h < 1.1;
    this.box = { w: this.w * (narrow ? 0.86 : 0.72), h: this.h * 0.42 };
    this.stage.style.cssText = `left:${this.w * (narrow ? 0.07 : 0.085)}px;top:${this.h * 0.29}px;width:${this.box.w}px;height:${this.box.h}px`;
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview)}px`);
    this.root.style.setProperty('--h', `${this.h}px`);
    this.lastLine = -2;
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, MONSOON_FONT, 'mo-line');
    this.stage.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const maxSize = Math.min(this.h * 0.12, this.w * 0.07) * this.ctx.textScale;
    const r = layoutFlowInto(v, this.space, this.box, { maxRows: 3, lineHeight: MONSOON_FONT.lineHeight, maxSize, minSize: this.ctx.preview ? 4 : Math.max(14, this.h * 0.032) }, 'mo-row');
    v.el.style.top = `${Math.max(0, (this.box.h - r.height) * 0.55)}px`;
  }

  frame(f: FrameInput): void {
    const { t, cue } = f;
    const m = this.ctx.motion;
    const li = cue.lineIndex;
    const lines = this.ctx.doc.lines;
    const gap = cue.gap;
    const gapOn = !!gap && (gap.kind === 'intro' || t - gap.startMs > 800);
    this.root.classList.toggle('in-gap', gapOn);
    const cur = li >= 0 ? this.view(li) : null;
    const prev = li >= 1 ? this.view(li - 1) : null;
    this.prune(li - 1, li + 1);
    for (const v of this.views.values()) if (v !== cur && v !== prev) showView(v, false);

    if (cur) {
      const age = t - cur.line.startMs;
      const e = m.transforms ? easeOutCubic(age / 700) : clamp01(age / 240);
      let op = gapOn ? 0 : e;
      if (gap && gap.kind !== 'intro') op *= 1 - clamp01((t - gap.startMs - 300) / 700);
      showView(cur, op > 0.002);
      setLineStyle(cur, m.transforms ? `translate3d(0,${(-(1 - e) * this.h * 0.03).toFixed(1)}px,0)` : '', op.toFixed(3));
      const stagger = staggerFor(cur, 70);
      const est = this.ctx.estimatedSweep && cur.line.wordTiming !== 'exact' ? estimatedUnit(cur, t, this.ctx.analysis.p80Sps) : -1;
      this.estTag.classList.toggle('on', this.ctx.estimatedSweep && cur.line.wordTiming !== 'exact');
      for (const u of cur.units) {
        const s = stateOf(cur, u.index, t, stagger, est);
        setUnitState(u, s);
        // a sung word gathers like a drop: a tiny drop-and-settle, layout untouched
        const since = t - unitArrival(cur, u.index, stagger);
        const k = m.wordMotion && m.transforms && s !== 'future' && since < 600 ? 1 - easeOutCubic(since / 600) : 0;
        setUnitTransform(u, k > 0.001 ? `translate3d(0,${(-k * 0.08 * m.amount).toFixed(3)}em,0)` : '', '');
      }
    }
    if (prev) {
      // the previous line runs down the glass and fades
      const x = clamp01((t - (cur?.line.startMs ?? prev.line.endMs)) / 900);
      const op = gapOn || (cur && cur.line.startMs - prev.line.endMs >= 4500) ? 0 : (1 - x) * 0.85;
      showView(prev, op > 0.002);
      if (prev.shown) {
        setLineStyle(prev, m.transforms ? `translate3d(0,${(x * x * this.h * 0.12).toFixed(1)}px,0)` : '', op.toFixed(3));
        for (const u of prev.units) setUnitState(u, 'past');
      }
    }

    // rain falls and the city lights drift, both from time
    if (m.transforms && !this.ctx.preview) {
      for (let i = 0; i < this.rain.length; i++) {
        const L = RAIN[i];
        const y = ((Math.max(0, t) / 1000) * L.speed * L.tile * 2) % L.tile;
        this.rain[i].style.transform = `translate3d(0,${y.toFixed(1)}px,0)`;
      }
      const drift = `translate3d(${(Math.sin(t / 11000) * this.w * 0.015).toFixed(1)}px,0,0)`;
      if (drift !== this.lastCity) {
        this.lastCity = drift;
        this.city.style.transform = drift;
      }
    }

    if (li !== this.lastLine) {
      this.lastLine = li;
      const nl = lines[li + 1] ?? (li < 0 ? lines[0] : undefined);
      setText(this.next, nl ? nl.text : '');
    }
    this.root.classList.toggle('hide-next', this.ctx.context !== 'full' || gapOn);
    if (gapOn && gap) {
      setText(this.gap, gap.kind === 'intro' ? this.ctx.title ?? '' : gap.kind === 'outro' ? '' : '…');
      setText(this.gapTime, Number.isFinite(gap.endMs) ? `VOCALS IN ${fmtClock(gap.endMs - t + 999)}` : '');
    }
  }
}
