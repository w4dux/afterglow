import type { LyricLine } from '../core/lyrics/model';
import type { FontSpec } from '../stage/layout';
import { clamp01 } from '../stage/motion';
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
  showView,
  staggerFor,
  stateOf,
  unitSize,
} from '../stage/scene';

/**
 * QUIET — the minimal fallback. Centred sans-serif, one previous and one next line in
 * grey, colour-only word highlighting and short crossfades. No textures, no
 * transforms on words, lowest CPU. Used for unknown songs by default.
 */
const FONT: FontSpec = { family: 'Inter Variable', weight: 650, tracking: -0.015, lineHeight: 1.18 };

export class QuietScene extends Scene {
  protected readonly font = FONT;
  private stage!: HTMLDivElement;
  private prev!: HTMLDivElement;
  private next!: HTMLDivElement;
  private gap!: HTMLDivElement;
  private estTag!: HTMLDivElement;
  private boxW = 0;
  private lastLine = -2;

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'quiet');
    const r = this.root;
    this.prev = el('div', 'qt-prev', r);
    this.stage = el('div', 'qt-stage', r);
    this.next = el('div', 'qt-next', r);
    this.gap = el('div', 'qt-gap', r);
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    this.onResize();
  }

  protected override onResize(): void {
    this.boxW = Math.min(this.w * 0.84, 1500);
    this.stage.style.cssText = `left:${(this.w - this.boxW) / 2}px;width:${this.boxW}px;top:${this.h * 0.3}px;height:${this.h * 0.4}px`;
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview, 14, 30, 0.032)}px`);
    this.lastLine = -2;
  }

  protected override onContext(): void {
    this.lastLine = -2;
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, FONT, 'qt-line');
    this.stage.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const maxSize = Math.min(this.h * 0.085, this.w * 0.055) * this.ctx.textScale;
    const r = layoutFlowInto(v, this.space, { w: this.boxW, h: this.h * 0.4 }, { maxRows: 3, lineHeight: FONT.lineHeight, maxSize, minSize: Math.max(14, this.h * 0.03) }, 'qt-row');
    v.el.style.top = `${(this.h * 0.4 - r.height) / 2}px`;
  }

  frame(f: FrameInput): void {
    const { t, cue } = f;
    const li = cue.lineIndex;
    const lines = this.ctx.doc.lines;
    const gap = cue.gap;
    const gapOn = !!gap && (gap.kind === 'intro' || t - gap.startMs > 800);
    const cur = li >= 0 ? this.view(li) : null;
    this.prune(li, li + 1);
    for (const v of this.views.values()) if (v !== cur) showView(v, false);
    if (cur) {
      let op = clamp01((t - cur.line.startMs) / 160);
      if (gap && gap.kind !== 'intro') op *= 1 - clamp01((t - gap.startMs - 300) / 500);
      showView(cur, op > 0.002);
      setLineStyle(cur, '', op.toFixed(3));
      const stagger = staggerFor(cur, 0);
      const est = this.ctx.estimatedSweep && cur.line.wordTiming !== 'exact' ? estimatedUnit(cur, t, this.ctx.analysis.p80Sps) : -1;
      this.estTag.classList.toggle('on', this.ctx.estimatedSweep && cur.line.wordTiming !== 'exact');
      for (const u of cur.units) setUnitState(u, stateOf(cur, u.index, t, stagger, est));
    }
    if (li !== this.lastLine) {
      this.lastLine = li;
      setText(this.prev, li >= 1 ? lines[li - 1].text : '');
      const nl = lines[li + 1] ?? (li < 0 ? lines[0] : undefined);
      setText(this.next, nl ? nl.text : '');
    }
    const ctx = this.ctx.context;
    this.prev.style.opacity = ctx !== 'off' && !gapOn ? '0.32' : '0';
    this.next.style.opacity = ctx === 'full' && !gapOn ? '0.38' : '0';
    if (gapOn && gap) {
      setText(this.gap, gap.kind === 'intro' ? `${this.ctx.title ?? ''}` : gap.kind === 'outro' ? '' : `♪  ${Number.isFinite(gap.endMs) ? fmtClock(gap.endMs - t + 999) : ''}`);
      this.gap.style.opacity = '0.6';
    } else this.gap.style.opacity = '0';
  }
}
