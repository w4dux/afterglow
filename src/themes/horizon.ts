import type { LyricLine } from '../core/lyrics/model';
import type { FontSpec } from '../stage/layout';
import { clamp01, easeInOutSine, easeOutCubic } from '../stage/motion';
import {
  type FrameInput,
  type LineView,
  Scene,
  type SceneContext,
  buildLineView,
  el,
  estimatedUnit,
  layoutFlowInto,
  leftDuringGap,
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
} from '../stage/scene';
import { blurredArtwork, grainTexture } from '../stage/textures';

/**
 * HORIZON — ambient / acoustic.
 * Cinematic negative space: a single line low in the frame, the artwork dissolved
 * into the sky above it, light that breathes on an 8-second cycle (tied to playback,
 * so it holds still when paused). Lines arrive slowly and leave slower; nothing
 * bounces. The next line appears in italics only shortly before it is sung.
 */
const FONT: FontSpec = { family: 'Instrument Serif', weight: 400, tracking: 0.005, lineHeight: 1.12 };
const BREATH_MS = 8000;

export class HorizonScene extends Scene {
  protected readonly font = FONT;
  private sky!: HTMLDivElement;
  private art!: HTMLDivElement;
  private artUrl = '';
  private breath!: HTMLDivElement;
  private stage!: HTMLDivElement;
  private next!: HTMLDivElement;
  private rule!: HTMLDivElement;
  private ruleFill!: HTMLDivElement;
  private caption!: HTMLDivElement;
  private gapWord!: HTMLDivElement;
  private estTag!: HTMLDivElement;
  private vars: Record<string, string> = {};
  private boxW = 0;
  private baseY = 0;
  private lastLine = -2;

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'horizon');
    const r = this.root;
    this.sky = el('div', 'hz-sky', r);
    this.art = el('div', 'hz-art', r);
    this.breath = el('div', 'hz-breath', r);
    el('div', 'hz-ground', r);
    this.caption = el('div', 'hz-caption', r);
    this.stage = el('div', 'hz-stage', r);
    this.next = el('div', 'hz-next', r);
    this.rule = el('div', 'hz-rule', r);
    this.ruleFill = el('div', 'hz-rule-fill', this.rule);
    this.gapWord = el('div', 'hz-gap', r);
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    el('div', 'hz-grain', r).style.backgroundImage = `url(${grainTexture(220, 0.1)})`;
    this.onContext();
    this.onResize();
  }

  protected override onContext(): void {
    const a = this.ctx.artwork;
    const p = a?.palette;
    this.root.classList.toggle('has-art', !!a);
    if (a && this.artUrl !== a.url) {
      this.artUrl = a.url;
      void blurredArtwork(a.url, 40, 2.5, 1.15).then((u) => {
        if (u && this.artUrl === a.url) this.art.style.backgroundImage = `url(${u})`;
      });
    }
    this.root.style.setProperty('--sky-top', p ? p.dark : '#0e1824');
    this.root.style.setProperty('--sky-mid', p ? p.muted : '#2c4257');
    this.root.style.setProperty('--sky-glow', p ? p.light : '#f2c8a0');
    setText(this.caption, [this.ctx.title, this.ctx.artist].filter(Boolean).join(' — '));
    this.lastLine = -2;
  }

  protected override onResize(): void {
    this.boxW = this.w * (this.w < 700 ? 0.84 : 0.62);
    this.baseY = this.h * 0.66;
    this.stage.style.cssText = `left:${this.w * 0.08}px;width:${this.boxW}px;top:0;height:100%`;
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview)}px`);
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, FONT, 'hz-line');
    this.stage.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const maxSize = Math.min(this.h * 0.085, this.w * 0.06) * this.ctx.textScale;
    const r = layoutFlowInto(v, this.space, { w: this.boxW, h: this.h * 0.24 }, { maxRows: 3, lineHeight: FONT.lineHeight, maxSize, minSize: Math.max(14, this.h * 0.032) }, 'hz-row');
    v.data.height = r.height;
  }

  frame(f: FrameInput): void {
    const { t, cue } = f;
    const m = this.ctx.motion;
    const li = cue.lineIndex;
    const lines = this.ctx.doc.lines;
    const gap = cue.gap;
    const gapOn = !!gap && (gap.kind === 'intro' || t - gap.startMs > 1200);
    const cur = li >= 0 ? this.view(li) : null;
    const prevV = li >= 1 ? this.view(li - 1) : null;
    this.prune(li - 1, li + 1);
    for (const v of this.views.values()) if (v !== cur && v !== prevV) showView(v, false);

    if (cur) {
      const age = t - cur.line.startMs;
      const k = easeOutCubic(age / 900);
      let op = k;
      if (gap && gap.kind !== 'intro') op *= 1 - easeInOutSine(clamp01((t - gap.startMs - 400) / 1600));
      const h = cur.data.height as number;
      const y = this.baseY - h + (m.transforms ? (1 - k) * this.h * 0.02 : 0);
      showView(cur, op > 0.002);
      setLineStyle(cur, `translate3d(0,${y.toFixed(1)}px,0)`, op.toFixed(3));
      this.animateUnits(cur, t);
    }
    if (prevV) {
      const k = clamp01((t - (cur ? cur.line.startMs : prevV.line.endMs)) / 1100);
      if (k >= 1 || leftDuringGap(prevV, cur)) showView(prevV, false);
      else {
        showView(prevV, true);
        const h = prevV.data.height as number;
        // rise clear of the incoming line quickly, then fade slowly
        const lift = easeOutCubic(clamp01(k * 1.8));
        const y = this.baseY - h - (lift * (h + this.h * 0.05));
        setLineStyle(prevV, `translate3d(0,${y.toFixed(1)}px,0)`, ((1 - easeInOutSine(k)) * 0.6).toFixed(3));
        for (const u of prevV.units) {
          setUnitState(u, 'past');
          setUnitTransform(u, '', '');
        }
      }
    }

    // next line: appears in italics ~1.8 s before it starts
    if (li !== this.lastLine) {
      this.lastLine = li;
      const nl = lines[li + 1] ?? (li < 0 ? lines[0] : undefined);
      setText(this.next, nl ? nl.text : '');
    }
    const nextLine = lines[li + 1] ?? (li < 0 ? lines[0] : undefined);
    const until = nextLine ? nextLine.startMs - t : Infinity;
    const nextOp = this.ctx.context === 'full' && nextLine ? 0.42 * clamp01((1800 - until) / 900) : 0;
    this.next.style.opacity = nextOp.toFixed(3);

    // breathing light and slow drift, both functions of playback time
    const phase = ((t % BREATH_MS) + BREATH_MS) % BREATH_MS / BREATH_MS;
    const breathe = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    setVar(this.root, '--breath', (m.transforms ? breathe : 0.5).toFixed(3), this.vars);
    if (m.transforms) {
      const d = t / 1000;
      this.art.style.transform = `translate3d(${(Math.sin(d * 0.021) * 2.5).toFixed(2)}%,${(Math.cos(d * 0.017) * 2).toFixed(2)}%,0) scale(${(1.25 + Math.sin(d * 0.013) * 0.04).toFixed(4)})`;
    }

    // gap: a thin horizon rule fills; the word "instrumental" rests in italics
    this.root.classList.toggle('in-gap', gapOn);
    if (gapOn && gap) {
      const g = gap.kind === 'intro' ? 1 : clamp01((t - gap.startMs - 1200) / 1500);
      this.rule.style.opacity = (g * 0.9).toFixed(3);
      this.ruleFill.style.transform = `scaleX(${gap.progress.toFixed(4)})`;
      setText(this.gapWord, gap.kind === 'intro' ? (this.ctx.title ?? '') : gap.kind === 'outro' ? 'fin' : 'instrumental');
      this.gapWord.style.opacity = (g * 0.8).toFixed(3);
    } else {
      this.rule.style.opacity = '0';
      this.gapWord.style.opacity = '0';
    }
  }

  private animateUnits(v: LineView, t: number): void {
    const m = this.ctx.motion;
    const stagger = staggerFor(v, 90);
    const est = this.ctx.estimatedSweep && v.line.wordTiming !== 'exact' ? estimatedUnit(v, t, this.ctx.analysis.p80Sps) : -1;
    this.estTag.classList.toggle('on', this.ctx.estimatedSweep && v.line.wordTiming !== 'exact');
    for (const u of v.units) {
      const s = stateOf(v, u.index, t, stagger, est);
      setUnitState(u, s);
      if (!m.transforms || s === 'future' || !m.wordMotion) {
        setUnitTransform(u, '', '');
        continue;
      }
      const age = t - unitArrival(v, u.index, stagger);
      const k = easeOutCubic(age / 700);
      let ty = (1 - k) * 0.18 * m.amount;
      if (m.jiggle > 0 && s === 'active') ty += Math.sin((t - u.word.startMs) / 400) * 0.03 * m.jiggle;
      setUnitTransform(u, ty ? `translate3d(0,${ty.toFixed(3)}em,0)` : '', '');
    }
  }
}
