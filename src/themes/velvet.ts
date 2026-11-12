import type { LyricLine } from '../core/lyrics/model';
import type { FontSpec } from '../stage/layout';
import { clamp01, easeInOutSine, easeOutCubic, lerp, wobble } from '../stage/motion';
import {
  type FrameInput,
  type LineView,
  Scene,
  type SceneContext,
  buildLineView,
  el,
  estimatedUnit,
  layoutFlowInto,
  setLineStyle,
  setText,
  setUnitState,
  setUnitTransform,
  setVar,
  showView,
  staggerFor,
  stateOf,
  unitArrival,
  unitSize,
  unitRects,
} from '../stage/scene';
import { blurredArtwork, grainTexture } from '../stage/textures';

/**
 * VELVET — R&B / soul.
 * A slow, continuous column of serif italics. The whole column glides upward as each
 * line begins (one fluid motion, no cuts); the previous line shrinks into the dark
 * above, the next waits faintly below. Sung words warm from smoke-grey to gold, and a
 * candle-like bloom follows the active word. Lights are tinted from the artwork.
 */
const FONT: FontSpec = { family: 'Fraunces Variable', weight: 360, style: 'italic', tracking: -0.005, lineHeight: 1.1 };
const GLIDE_MS = 760;
const SMALL = 0.5;

export class VelvetScene extends Scene {
  protected readonly font = FONT;
  private lights: HTMLDivElement[] = [];
  private bloom!: HTMLDivElement;
  private column!: HTMLDivElement;
  private art!: HTMLDivElement;
  private artUrl = '';
  private gap!: HTMLDivElement;
  private gapDots!: HTMLDivElement;
  private gapClock!: HTMLDivElement;
  private credit!: HTMLDivElement;
  private estTag!: HTMLDivElement;
  private vars: Record<string, string> = {};
  private colX = 0;
  private colW = 0;
  private baseY = 0;
  private bloomPos = { x: 0, y: 0 };

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'velvet');
    const r = this.root;
    this.art = el('div', 'vv-art', r);
    el('div', 'vv-orbit', r);
    el('div', 'vv-wordmark', r, 'Velvet');
    el('div', 'vv-side', r, 'SLOW DOWN. STAY A LITTLE.');
    for (let i = 0; i < 3; i++) this.lights.push(el('div', `vv-light l${i}`, r));
    this.bloom = el('div', 'vv-bloom', r);
    this.column = el('div', 'vv-column', r);
    this.gap = el('div', 'vv-gap', r);
    this.gapDots = el('div', 'vv-gap-dots', this.gap, 'instrumental');
    this.gapClock = el('div', 'vv-gap-clock', this.gap);
    this.credit = el('div', 'vv-credit', r);
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    el('div', 'vv-vignette', r);
    el('div', 'vv-grain', r).style.backgroundImage = `url(${grainTexture(200, 0.14)})`;
    this.onContext();
    this.onResize();
  }

  protected override onContext(): void {
    const a = this.ctx.artwork;
    const p = a?.palette;
    this.root.classList.toggle('has-art', !!a);
    if (a && this.artUrl !== a.url) {
      this.artUrl = a.url;
      void blurredArtwork(a.url, 40, 2, 1.2, 0.6).then((u) => {
        if (u && this.artUrl === a.url) this.art.style.backgroundImage = `url(${u})`;
      });
    }
    // tint the lights from the artwork, keeping them warm and deep
    this.root.style.setProperty('--l0', p ? p.vibrant : '#c4622d');
    this.root.style.setProperty('--l1', p ? p.dominant : '#8f2d56');
    this.root.style.setProperty('--l2', p ? p.light : '#f6c7a1');
    this.root.style.setProperty('--base', p ? p.dark : '#1c0a1f');
    setText(this.credit, [this.ctx.title, this.ctx.artist].filter(Boolean).join('  ·  '));
  }

  protected override onResize(): void {
    this.colX = this.w * (this.w < 700 ? 0.07 : 0.11);
    this.colW = this.w * (this.w < 700 ? 0.86 : 0.74);
    this.baseY = this.h * 0.5;
    this.column.style.cssText = `left:${this.colX}px;width:${this.colW}px`;
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview)}px`);
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, FONT, 'vv-line');
    this.column.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const maxSize = Math.min(this.h * 0.145, this.w * 0.084) * this.ctx.textScale;
    const r = layoutFlowInto(v, this.space, { w: this.colW, h: this.h * 0.34 }, { maxRows: 3, lineHeight: FONT.lineHeight, maxSize, minSize: Math.max(14, this.h * 0.035) }, 'vv-row');
    v.data.height = r.height;
  }

  frame(f: FrameInput): void {
    const { t, cue } = f;
    const m = this.ctx.motion;
    const li = cue.lineIndex;
    const lines = this.ctx.doc.lines;
    const gap = cue.gap;
    const gapOn = !!gap && (gap.kind === 'intro' || t - gap.startMs > 900);

    // continuous column position c: integer = settled on line c
    let c: number;
    if (li < 0) c = -1;
    else {
      const p = m.transforms ? easeInOutSine((t - lines[li].startMs) / GLIDE_MS) : clamp01((t - lines[li].startMs) / 300);
      c = li - 1 + p;
    }
    const lo = Math.max(0, Math.floor(c) - 1);
    const hi = Math.min(lines.length - 1, Math.ceil(c) + 2);
    this.prune(lo, hi);
    const views: LineView[] = [];
    for (let i = lo; i <= hi; i++) {
      const v = this.view(i);
      if (v) views.push(v);
    }
    for (const v of this.views.values()) if (!views.includes(v)) showView(v, false);

    const ctxMode = this.ctx.context;
    const gapFade = gap && gap.kind !== 'intro' ? clamp01((t - gap.startMs - 300) / 900) : 0;
    // Neighbours keep clear of a tall (2-3 row) current line instead of a fixed distance.
    const curH = li >= 0 ? ((this.views.get(li)?.data.height as number | undefined) ?? 0) : 0;
    const extra = Math.max(0, curH / 2 - this.h * 0.085);
    let bloomTarget: { x: number; y: number } | null = null;
    for (const v of views) {
      const k = v.line.index - c; // 0 = current slot, -1 = previous, +1 = next
      const scale = k >= 0 ? lerp(1, SMALL, clamp01(k)) : lerp(1, SMALL, clamp01(-k));
      const h = v.data.height as number;
      // vertical placement: current centred on baseY; neighbours stacked with gaps
      let y: number;
      if (k >= 0) y = this.baseY - (h / 2) * scale + k * (this.h * 0.2 + extra);
      else y = this.baseY - (h / 2) * scale + k * (this.h * 0.18 + extra) - (1 - scale) * h * 0.2;
      let op: number;
      if (k <= -1.6 || k >= 1.8) op = 0;
      else if (k < 0) op = lerp(1, ctxMode === 'off' ? 0 : 0.34, clamp01(-k)) * clamp01(1.6 + k);
      else if (k <= 1) op = lerp(1, ctxMode === 'full' ? 0.3 : 0, clamp01(k));
      else op = (ctxMode === 'full' ? 0.3 : 0) * clamp01(1.8 - k);
      if (Math.abs(k) < 0.5) op *= 1 - gapFade;
      // lines that ended before an instrumental gap stay dimmed as context
      if (k < 0 && li >= 0 && lines[li].startMs - v.line.endMs >= 4500) op *= 0.5;
      if (li < 0 && v.line.index === 0) {
        // before the first line: preview it softly
        op = gapOn ? 0.3 : op;
      }
      showView(v, op > 0.003);
      if (!v.shown) continue;
      const tf = m.transforms ? `translate3d(0,${y.toFixed(1)}px,0) scale(${scale.toFixed(4)})` : `translate3d(0,${y.toFixed(1)}px,0) scale(${scale.toFixed(4)})`;
      setLineStyle(v, tf, op.toFixed(3));
      const isCur = v.line.index === li;
      const b = this.animateUnits(v, t, f, isCur);
      if (b && isCur) bloomTarget = { x: this.colX + b.x, y: y + b.y * scale };
    }

    // candle bloom follows the active word, eased (pure function of the target)
    if (bloomTarget && !gapOn) {
      this.bloomPos = bloomTarget;
      this.bloom.style.opacity = '1';
    } else this.bloom.style.opacity = '0';
    this.bloom.style.transform = `translate3d(${this.bloomPos.x.toFixed(1)}px,${this.bloomPos.y.toFixed(1)}px,0)`;

    // slow orbiting lights, tied to playback time (freeze on pause)
    if (m.transforms) {
      const s = t / 1000;
      this.lights.forEach((l, i) => {
        const a = s * (0.05 + i * 0.017) + i * 2.1;
        l.style.transform = `translate3d(${(Math.cos(a) * 9).toFixed(2)}vw,${(Math.sin(a * 1.3) * 7).toFixed(2)}vh,0)`;
      });
    }
    const pulse = f.beat && m.pulse ? f.beat.env : 0;
    setVar(this.root, '--pulse', pulse.toFixed(3), this.vars);
    this.root.classList.toggle('in-gap', gapOn);
    this.gap.style.opacity = gapOn ? (gap!.kind === 'intro' ? '1' : clamp01((t - gap!.startMs - 900) / 700).toFixed(3)) : '0';
    if (gapOn && gap) {
      setText(this.gapDots, gap.kind === 'intro' ? (this.ctx.title ?? '') : gap.kind === 'outro' ? 'fin' : 'instrumental');
      setText(this.gapClock, Number.isFinite(gap.endMs) ? `${Math.ceil((gap.endMs - t) / 1000)}` : '');
      // a slow breath on the word, tied to playback time
      if (m.transforms) this.gapDots.style.opacity = (0.65 + 0.35 * Math.sin(t / 900)).toFixed(3);
    }
  }

  /** Returns the active word's centre (line-local) for the bloom. */
  private animateUnits(v: LineView, t: number, f: FrameInput, isCur: boolean): { x: number; y: number } | null {
    const m = this.ctx.motion;
    const stagger = staggerFor(v, 70);
    const est = isCur && this.ctx.estimatedSweep && v.line.wordTiming !== 'exact' ? estimatedUnit(v, t, this.ctx.analysis.p80Sps) : -1;
    if (isCur) this.estTag.classList.toggle('on', this.ctx.estimatedSweep && v.line.wordTiming !== 'exact');
    let active: { x: number; y: number } | null = null;
    const before = t < v.line.startMs;
    for (const u of v.units) {
      const s = before ? 'future' : stateOf(v, u.index, t, stagger, est);
      setUnitState(u, s);
      if (!m.transforms || s === 'future' || !isCur) {
        setUnitTransform(u, '', '');
        if (s === 'active' && isCur) active = this.center(v, u.index);
        continue;
      }
      const age = t - unitArrival(v, u.index, stagger);
      let ty = m.wordMotion ? (1 - easeOutCubic(age / 420)) * 0.22 : 0; // em
      let rot = 0;
      if (s === 'active') {
        active = this.center(v, u.index);
        if (m.jiggle > 0) {
          const a = t - u.word.startMs;
          rot = Math.sin(a / 180) * 2 * m.jiggle;
          ty += -Math.abs(wobble(a, 3.5, 500)) * 0.08 * m.jiggle;
        }
      }
      const sc = s === 'active' && f.beat && m.pulse ? 1 + f.beat.env * 0.02 : 1;
      setUnitTransform(u, ty || rot || sc !== 1 ? `translate3d(0,${(ty * m.amount).toFixed(3)}em,0) rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(4)})` : '', '');
    }
    return active;
  }

  private center(v: LineView, i: number): { x: number; y: number } {
    const r = unitRects(v)[i];
    return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: 0, y: 0 };
  }
}
