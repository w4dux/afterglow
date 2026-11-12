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
import { grainTexture } from '../stage/textures';

/**
 * HALO: melodic, emotional rap. Centred lowercase lines under a soft ring of light.
 * Upcoming words wait out of focus and sharpen as they are sung; each sung word sends
 * a brief swell through the ring (from the word's own timestamp, never a guessed
 * beat). Dust motes drift upward. Everything is a function of lyric time.
 */
export const HALO_FONT: FontSpec = { family: 'Inter Variable', weight: 680, tracking: -0.035, lineHeight: 1.08, lower: true };

const MOTES = 16;

export class HaloScene extends Scene {
  protected readonly font = HALO_FONT;
  private readonly stage: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private readonly next: HTMLDivElement;
  private readonly meta: HTMLDivElement;
  private readonly gap: HTMLDivElement;
  private readonly gapTime: HTMLDivElement;
  private readonly estTag: HTMLDivElement;
  private readonly motes: HTMLDivElement[] = [];
  private box = { w: 0, h: 0 };
  private lastLine = -2;
  private lastRing = '';
  private motesPlaced = false;

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'halo');
    const r = this.root;
    el('div', 'ha-sky', r);
    this.ring = el('div', 'ha-ring', r);
    el('div', 'ha-ring ha-ring-b', r);
    const dust = el('div', 'ha-dust', r);
    for (let i = 0; i < MOTES; i++) this.motes.push(el('div', 'ha-mote', dust));
    this.meta = el('div', 'ha-meta', r);
    this.stage = el('div', 'ha-stage', r);
    this.next = el('div', 'ha-next', r);
    const gap = el('div', 'ha-gap', r);
    this.gap = el('div', 'ha-gap-title', gap);
    this.gapTime = el('div', 'ha-gap-time', gap);
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    el('div', 'ha-grain', r).style.backgroundImage = `url(${grainTexture(160, 0.1)})`;
    this.onContext();
    this.onResize();
  }

  protected override onContext(): void {
    const p = this.ctx.artwork?.palette;
    // The ring takes the artwork's most vivid colour when there is one.
    this.root.style.setProperty('--glow', p ? p.vibrant : '#8f7bff');
    this.root.style.setProperty('--glow2', p ? p.light : '#7fd4ff');
    this.root.dataset.context = this.ctx.context;
    setText(this.meta, [this.ctx.title, this.ctx.artist].filter(Boolean).join('  ·  ').toLocaleLowerCase());
    this.lastLine = -2;
  }

  protected override onResize(): void {
    this.box = { w: Math.min(this.w * 0.8, 1500), h: this.h * 0.4 };
    this.stage.style.cssText = `left:${(this.w - this.box.w) / 2}px;top:${this.h * 0.3}px;width:${this.box.w}px;height:${this.box.h}px`;
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview)}px`);
    this.root.style.setProperty('--h', `${this.h}px`);
    this.lastLine = -2;
    this.motesPlaced = false;
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, HALO_FONT, 'ha-line');
    this.stage.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const maxSize = Math.min(this.h * 0.115, this.w * 0.072) * this.ctx.textScale;
    const r = layoutFlowInto(v, this.space, this.box, { maxRows: 3, lineHeight: HALO_FONT.lineHeight, maxSize, minSize: this.ctx.preview ? 4 : Math.max(14, this.h * 0.032) }, 'ha-row');
    v.el.style.top = `${Math.max(0, (this.box.h - r.height) / 2)}px`;
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

    let swell = 0;
    if (cur) {
      const age = t - cur.line.startMs;
      const e = m.transforms ? easeOutCubic(age / 560) : clamp01(age / 200);
      let op = gapOn ? 0 : e;
      if (gap && gap.kind !== 'intro') op *= 1 - clamp01((t - gap.startMs - 200) / 600);
      showView(cur, op > 0.002);
      setLineStyle(cur, m.transforms ? `translate3d(0,${((1 - e) * this.h * 0.05).toFixed(1)}px,0)` : '', op.toFixed(3));
      const stagger = staggerFor(cur, 55);
      const est = this.ctx.estimatedSweep && cur.line.wordTiming !== 'exact' ? estimatedUnit(cur, t, this.ctx.analysis.p80Sps) : -1;
      this.estTag.classList.toggle('on', this.ctx.estimatedSweep && cur.line.wordTiming !== 'exact');
      for (const u of cur.units) {
        const s = stateOf(cur, u.index, t, stagger, est);
        setUnitState(u, s);
        const since = t - unitArrival(cur, u.index, stagger);
        if (s === 'active' || (s !== 'future' && since < 700)) swell = Math.max(swell, Math.exp(-Math.max(0, since) / 380));
        // a sung word settles from slightly below, without moving the layout
        const k = m.wordMotion && m.transforms && s !== 'future' ? 1 - easeOutCubic(since / 420) : 0;
        setUnitTransform(u, k > 0.001 ? `translate3d(0,${(k * 0.12 * m.amount).toFixed(3)}em,0)` : '', '');
      }
    }
    if (prev) {
      const x = clamp01((t - (cur?.line.startMs ?? prev.line.endMs)) / 460);
      const op = gapOn || (cur && cur.line.startMs - prev.line.endMs >= 4500) ? 0 : 1 - x;
      showView(prev, op > 0.002);
      if (prev.shown) {
        setLineStyle(prev, m.transforms ? `translate3d(0,${(-x * this.h * 0.07).toFixed(1)}px,0) scale(${(1 - x * 0.06).toFixed(4)})` : '', op.toFixed(3));
        for (const u of prev.units) setUnitState(u, 'past');
      }
    }

    // The ring: a slow breath over the line, plus a swell on each sung word.
    const lineP = cur ? clamp01((t - cur.line.startMs) / Math.max(1, cur.line.endMs - cur.line.startMs)) : 0;
    const breath = m.transforms ? 0.97 + 0.03 * Math.sin(Math.PI * lineP) : 1;
    const glow = gapOn ? 0.35 : 0.55 + 0.45 * swell;
    const ring = `${(breath + (m.transforms ? swell * 0.015 * m.amount : 0)).toFixed(4)}|${glow.toFixed(3)}`;
    if (ring !== this.lastRing) {
      this.lastRing = ring;
      this.ring.style.transform = `translate(-50%,-50%) scale(${ring.split('|')[0]})`;
      this.ring.style.opacity = glow.toFixed(3);
    }

    // Dust motes rise slowly; positions come from time, not from frame counts.
    // With reduced motion they are placed once and stay still.
    const moving = m.transforms && !this.ctx.preview;
    if (moving || !this.motesPlaced) {
      const tt = moving ? Math.max(0, t) : 0;
      for (let i = 0; i < MOTES; i++) {
        const speed = 0.012 + hash01(i, 3) * 0.02; // screen heights per second
        const y = 1 - ((hash01(i, 1) + (tt / 1000) * speed) % 1);
        const x = hash01(i, 2) + Math.sin(tt / 2300 + i) * 0.01;
        this.motes[i].style.transform = `translate3d(${(x * this.w).toFixed(1)}px,${(y * this.h).toFixed(1)}px,0)`;
      }
      this.motesPlaced = !moving;
    }

    if (li !== this.lastLine) {
      this.lastLine = li;
      const nl = lines[li + 1] ?? (li < 0 ? lines[0] : undefined);
      setText(this.next, nl ? nl.text.toLocaleLowerCase() : '');
    }
    this.root.classList.toggle('hide-next', this.ctx.context !== 'full' || gapOn);
    if (gapOn && gap) {
      setText(this.gap, gap.kind === 'intro' ? (this.ctx.title ?? '').toLocaleLowerCase() : gap.kind === 'outro' ? '' : '…');
      setText(this.gapTime, Number.isFinite(gap.endMs) ? `vocals in ${fmtClock(gap.endMs - t + 999)}` : '');
    }
  }
}
