import type { LyricLine } from '../core/lyrics/model';
import type { FontSpec } from '../stage/layout';
import { clamp01, easeOutCubic, hash01, spring } from '../stage/motion';
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
 * RAVE: a party. Laser fans sweep over a crowd of raised hands; every sung word gives
 * the lights and the crowd a lift, and big neon words punch in. A chorus (a line
 * the lyrics repeat) fires a confetti burst. The lasers swing on the beat only when
 * the lyric source states a tempo; otherwise they sweep slowly. No strobe and no
 * full-screen flashes: brightness changes are brief and partial.
 */
export const RAVE_FONT: FontSpec = { family: 'Unbounded Variable', weight: 800, tracking: -0.01, lineHeight: 1.02, upper: true };

const BEAMS = 9;
const CONFETTI = 40;
const CONFETTI_MS = 3200;
const BEAM_COLORS = ['#ff2bd6', '#3fe0ff', '#b6ff3b'];

/** Silhouettes of a crowd with raised hands; deterministic, drawn once. */
function crowdSvg(): string {
  let d = '';
  for (let i = 0; i < 34; i++) {
    const x = (i + 0.3 + hash01(i, 11) * 0.5) * (1000 / 34);
    const head = 112 + hash01(i, 12) * 26;
    const r = 13 + hash01(i, 13) * 4;
    d += `M${(x - r).toFixed(1)},${head.toFixed(1)}a${r},${r} 0 1,0 ${(2 * r).toFixed(1)},0a${r},${r} 0 1,0 ${(-2 * r).toFixed(1)},0Z`;
    d += `M${(x - r * 2.4).toFixed(1)},200L${(x - r * 2).toFixed(1)},${(head + r * 1.6).toFixed(1)}Q${x.toFixed(1)},${(head + r * 0.6).toFixed(1)} ${(x + r * 2).toFixed(1)},${(head + r * 1.6).toFixed(1)}L${(x + r * 2.4).toFixed(1)},200Z`;
    if (hash01(i, 14) > 0.45) {
      const side = hash01(i, 15) > 0.5 ? 1 : -1;
      const top = head - 60 - hash01(i, 16) * 40;
      const hx = x + side * (12 + hash01(i, 17) * 22);
      d += `M${(x + side * r * 1.2).toFixed(1)},${(head + r * 1.8).toFixed(1)}L${(hx - 4).toFixed(1)},${top.toFixed(1)}L${(hx + 5).toFixed(1)},${(top + 2).toFixed(1)}L${(x + side * r * 1.9).toFixed(1)},${(head + r * 2).toFixed(1)}Z`;
      d += `M${(hx - 8).toFixed(1)},${(top + 4).toFixed(1)}a8,9 0 1,0 16,0a8,9 0 1,0 -16,0Z`;
    }
  }
  return `<svg viewBox="0 0 1000 200" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#05030b"/></svg>`;
}

export class RaveScene extends Scene {
  protected readonly font = RAVE_FONT;
  private readonly stage: HTMLDivElement;
  private readonly fan: HTMLDivElement;
  private readonly beams: HTMLDivElement[] = [];
  private readonly crowd: HTMLDivElement;
  private readonly confetti: HTMLDivElement;
  private readonly bits: HTMLDivElement[] = [];
  private readonly next: HTMLDivElement;
  private readonly meta: HTMLSpanElement;
  private readonly gap: HTMLDivElement;
  private readonly gapTime: HTMLDivElement;
  private readonly estTag: HTMLDivElement;
  private box = { w: 0, h: 0 };
  private lastLine = -2;
  private cache: Record<string, string> = {};

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'rave');
    const r = this.root;
    el('div', 'rv-bg', r);
    this.fan = el('div', 'rv-fan', r);
    for (let i = 0; i < BEAMS; i++) {
      const b = el('div', 'rv-beam', this.fan);
      b.style.setProperty('--c', BEAM_COLORS[i % BEAM_COLORS.length]);
      this.beams.push(b);
    }
    el('div', 'rv-haze', r);
    this.confetti = el('div', 'rv-confetti', r);
    for (let i = 0; i < CONFETTI; i++) {
      const c = el('div', 'rv-bit', this.confetti);
      c.style.background = BEAM_COLORS[i % 3] === '#b6ff3b' ? '#ffe14d' : BEAM_COLORS[i % 3];
      c.style.width = `${(5 + hash01(i, 21) * 7).toFixed(1)}px`;
      c.style.height = `${(9 + hash01(i, 22) * 10).toFixed(1)}px`;
      this.bits.push(c);
    }
    this.crowd = el('div', 'rv-crowd', r);
    this.crowd.innerHTML = crowdSvg();
    const head = el('div', 'rv-head', r);
    el('span', 'rv-live', head, 'LIVE');
    this.meta = el('span', 'rv-meta', head);
    this.stage = el('div', 'rv-stage', r);
    this.next = el('div', 'rv-next', r);
    const gap = el('div', 'rv-gap', r);
    this.gap = el('div', 'rv-gap-title', gap);
    this.gapTime = el('div', 'rv-gap-time', gap);
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    this.onContext();
    this.onResize();
  }

  protected override onContext(): void {
    this.root.dataset.context = this.ctx.context;
    setText(this.meta, [this.ctx.title, this.ctx.artist].filter(Boolean).join('  ·  ').toLocaleUpperCase());
    this.lastLine = -2;
    this.cache = {};
  }

  protected override onResize(): void {
    this.box = { w: Math.min(this.w * 0.86, 1600), h: this.h * 0.42 };
    this.stage.style.cssText = `left:${(this.w - this.box.w) / 2}px;top:${this.h * 0.22}px;width:${this.box.w}px;height:${this.box.h}px`;
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview)}px`);
    this.root.style.setProperty('--h', `${this.h}px`);
    this.lastLine = -2;
    this.cache = {};
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, RAVE_FONT, 'rv-line');
    v.el.classList.toggle('is-hook', v.hook);
    this.stage.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const maxSize = Math.min(this.h * 0.11, this.w * 0.07) * this.ctx.textScale;
    const r = layoutFlowInto(v, this.space, this.box, { maxRows: 3, lineHeight: RAVE_FONT.lineHeight, maxSize, minSize: this.ctx.preview ? 4 : Math.max(12, this.h * 0.03) }, 'rv-row');
    v.el.style.top = `${Math.max(0, (this.box.h - r.height) / 2)}px`;
  }

  private set(e: HTMLElement, key: string, prop: 'transform' | 'opacity', value: string): void {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    e.style[prop] = value;
  }

  frame(f: FrameInput): void {
    const { t, cue } = f;
    const m = this.ctx.motion;
    const li = cue.lineIndex;
    const lines = this.ctx.doc.lines;
    const gap = cue.gap;
    const gapOn = !!gap && (gap.kind === 'intro' || t - gap.startMs > 700);
    this.root.classList.toggle('in-gap', gapOn);
    const cur = li >= 0 ? this.view(li) : null;
    const prev = li >= 1 ? this.view(li - 1) : null;
    this.prune(li - 1, li + 1);
    for (const v of this.views.values()) if (v !== cur && v !== prev) showView(v, false);

    let lastHit = -Infinity;
    if (cur) {
      const age = t - cur.line.startMs;
      const e = m.transforms ? easeOutCubic(age / 260) : clamp01(age / 160);
      let op = gapOn ? 0 : e;
      if (gap && gap.kind !== 'intro') op *= 1 - clamp01((t - gap.startMs - 200) / 400);
      showView(cur, op > 0.002);
      setLineStyle(cur, m.transforms ? `translate3d(0,${((1 - e) * this.h * 0.04).toFixed(1)}px,0) scale(${(0.96 + 0.04 * e).toFixed(4)})` : '', op.toFixed(3));
      const stagger = staggerFor(cur, 45);
      const est = this.ctx.estimatedSweep && cur.line.wordTiming !== 'exact' ? estimatedUnit(cur, t, this.ctx.analysis.p80Sps) : -1;
      this.estTag.classList.toggle('on', this.ctx.estimatedSweep && cur.line.wordTiming !== 'exact');
      for (const u of cur.units) {
        const s = stateOf(cur, u.index, t, stagger, est);
        setUnitState(u, s);
        const at = unitArrival(cur, u.index, stagger);
        if (s !== 'future' && at <= t) lastHit = Math.max(lastHit, at);
        let sc = 1;
        if (s === 'active' && m.wordMotion && m.transforms) sc = 1.2 - 0.2 * spring(t - at, 8, 0.45);
        if (s === 'active' && f.beat && m.pulse) sc += f.beat.env * 0.04;
        setUnitTransform(u, sc !== 1 && m.transforms ? `scale(${sc.toFixed(3)})` : '', '');
      }
    }
    if (prev) {
      const x = clamp01((t - (cur?.line.startMs ?? prev.line.endMs)) / 300);
      const op = gapOn || (cur && cur.line.startMs - prev.line.endMs >= 4500) ? 0 : 1 - x;
      showView(prev, op > 0.002);
      if (prev.shown) {
        setLineStyle(prev, m.transforms ? `translate3d(0,${(-x * this.h * 0.06).toFixed(1)}px,0) scale(${(1 - x * 0.08).toFixed(4)})` : '', op.toFixed(3));
        for (const u of prev.units) setUnitState(u, 'past');
      }
    }

    // a word landing lifts the lights and the crowd for a moment (no flashes)
    const hit = m.transforms && Number.isFinite(lastHit) ? Math.exp(-(t - lastHit) / 280) : 0;
    this.set(this.fan, 'fanOp', 'opacity', (gapOn ? 0.55 : 0.5 + 0.35 * hit).toFixed(3));
    const beatSwing = f.beat && m.pulse && m.transforms ? Math.sin(f.beat.phase * Math.PI * 2) * 7 : 0;
    for (let i = 0; i < BEAMS; i++) {
      const base = -64 + (128 * i) / (BEAMS - 1);
      const sweep = m.transforms ? Math.sin(t / 2600 + i * 0.9) * 14 + beatSwing * (i % 2 ? 1 : -1) : 0;
      this.set(this.beams[i], `b${i}`, 'transform', `rotate(${(base + sweep).toFixed(2)}deg)`);
    }
    this.set(this.crowd, 'crowd', 'transform', m.transforms ? `translate3d(0,${(-hit * this.h * 0.012).toFixed(1)}px,0)` : '');

    // chorus confetti: falls for a few seconds after a repeated line begins
    const burst = cur && cur.hook && m.transforms && !this.ctx.preview ? t - cur.line.startMs : -1;
    const showConfetti = burst >= 0 && burst < CONFETTI_MS;
    this.root.classList.toggle('confetti-on', showConfetti);
    if (showConfetti) {
      const s = burst / 1000;
      for (let i = 0; i < CONFETTI; i++) {
        const x = (hash01(i, 31) + Math.sin(s * 2 + i) * 0.03) * this.w;
        const y = (-0.08 + s * (0.32 + hash01(i, 32) * 0.22)) * this.h;
        const rot = s * 360 * (0.4 + hash01(i, 33)) * (i % 2 ? 1 : -1);
        this.bits[i].style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) rotate(${rot.toFixed(1)}deg)`;
      }
    }

    if (li !== this.lastLine) {
      this.lastLine = li;
      const nl = lines[li + 1] ?? (li < 0 ? lines[0] : undefined);
      setText(this.next, nl ? nl.text.toLocaleUpperCase() : '');
    }
    this.root.classList.toggle('hide-next', this.ctx.context !== 'full' || gapOn);
    if (gapOn && gap) {
      setText(this.gap, gap.kind === 'intro' ? 'GET READY' : gap.kind === 'outro' ? 'ONE MORE?' : 'HANDS UP');
      setText(this.gapTime, Number.isFinite(gap.endMs) ? `VOCALS IN ${fmtClock(gap.endMs - t + 999)}` : (this.ctx.title ?? '').toLocaleUpperCase());
    }
  }
}
