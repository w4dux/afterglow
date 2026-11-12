import type { LyricLine } from '../core/lyrics/model';
import type { FontSpec } from '../stage/layout';
import { clamp01, easeOutBack } from '../stage/motion';
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
  unitArrival,
  unitSize,
} from '../stage/scene';

/**
 * DEPARTURES: a station departure board. Every word is a flap tile; tiles flip in as
 * their word arrives (from the word's own timestamp; for line-timed lyrics a short
 * decorative cascade at the line start), and the word being sung lights amber. The
 * previous and next lines sit on the board as small rows. The board clock shows the
 * song position.
 */
export const DEPARTURES_FONT: FontSpec = { family: 'JetBrains Mono Variable', weight: 760, tracking: 0.01, lineHeight: 1.32, upper: true };

/** Extra width (em) each word tile adds (padding and margins), less the tightened word space, in departures.css. */
const TILE_EM = 0.38 - 0.3;
const FLIP_MS = 300;

export class DeparturesScene extends Scene {
  protected readonly font = DEPARTURES_FONT;
  private readonly stage: HTMLDivElement;
  private readonly clock: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly prevRow: HTMLDivElement;
  private readonly nextRow: HTMLDivElement;
  private readonly prevText: HTMLSpanElement;
  private readonly nextText: HTMLSpanElement;
  private readonly prevNo: HTMLSpanElement;
  private readonly nextNo: HTMLSpanElement;
  private readonly meta: HTMLDivElement;
  private readonly gap: HTMLDivElement;
  private readonly gapTime: HTMLDivElement;
  private readonly estTag: HTMLDivElement;
  private box = { w: 0, h: 0 };
  private lastLine = -2;
  private lastSecond = -1;

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'departures');
    const r = this.root;
    el('div', 'dp-board', r);
    const head = el('div', 'dp-head', r);
    el('span', 'dp-brand', head, 'DEPARTURES');
    el('span', 'dp-cols', head, 'NO.   DESTINATION');
    this.clock = el('div', 'dp-clock', head, '0:00');
    this.meta = el('div', 'dp-meta', r);
    this.prevRow = el('div', 'dp-row dp-prev', r);
    this.prevNo = el('span', 'dp-no', this.prevRow);
    this.prevText = el('span', 'dp-text', this.prevRow);
    el('span', 'dp-state', this.prevRow, 'DEPARTED');
    this.status = el('div', 'dp-status', r, 'NOW BOARDING');
    this.stage = el('div', 'dp-stage', r);
    this.nextRow = el('div', 'dp-row dp-nextrow', r);
    this.nextNo = el('span', 'dp-no', this.nextRow);
    this.nextText = el('span', 'dp-text', this.nextRow);
    el('span', 'dp-state', this.nextRow, 'NEXT');
    const gap = el('div', 'dp-gap', r);
    this.gap = el('div', 'dp-gap-title', gap);
    this.gapTime = el('div', 'dp-gap-time', gap);
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    this.onContext();
    this.onResize();
  }

  protected override onContext(): void {
    this.root.dataset.context = this.ctx.context;
    setText(this.meta, [this.ctx.title, this.ctx.artist].filter(Boolean).join('  /  ').toLocaleUpperCase());
    this.lastLine = -2;
  }

  protected override onResize(): void {
    const narrow = this.w / this.h < 1.1;
    const left = this.w * (narrow ? 0.06 : 0.07);
    this.box = { w: this.w * (narrow ? 0.88 : 0.86) * 0.95, h: this.h * 0.36 };
    this.stage.style.cssText = `left:${left}px;top:${this.h * 0.34}px;width:${this.box.w}px;height:${this.box.h}px`;
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview)}px`);
    this.root.style.setProperty('--h', `${this.h}px`);
    this.lastLine = -2;
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, DEPARTURES_FONT, 'dp-line');
    this.stage.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const maxSize = Math.min(this.h * 0.085, this.w * 0.05) * this.ctx.textScale;
    const r = layoutFlowInto(v, this.space + TILE_EM, this.box, { maxRows: 4, lineHeight: DEPARTURES_FONT.lineHeight, maxSize, minSize: this.ctx.preview ? 4 : Math.max(12, this.h * 0.026) }, 'dp-trow');
    v.el.style.top = `${Math.max(0, (this.box.h - r.height) / 2)}px`;
    v.data.flip = v.groups.map(() => '');
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
    this.prune(li, li);
    for (const v of this.views.values()) if (v !== cur) showView(v, false);

    if (cur) {
      let op = gapOn ? 0 : clamp01((t - cur.line.startMs) / 120);
      if (gap && gap.kind !== 'intro') op *= 1 - clamp01((t - gap.startMs - 300) / 400);
      showView(cur, op > 0.002);
      setLineStyle(cur, '', op.toFixed(3));
      const stagger = staggerFor(cur, 60);
      const est = this.ctx.estimatedSweep && cur.line.wordTiming !== 'exact' ? estimatedUnit(cur, t, this.ctx.analysis.p80Sps) : -1;
      this.estTag.classList.toggle('on', this.ctx.estimatedSweep && cur.line.wordTiming !== 'exact');
      for (const u of cur.units) setUnitState(u, stateOf(cur, u.index, t, stagger, est));
      // Flip each word tile when its first unit arrives.
      const flips = cur.data.flip as string[];
      cur.groups.forEach(([a], gi) => {
        const since = t - unitArrival(cur, a, stagger);
        const g = cur.groupEls[gi];
        let tf = '';
        let shown = since >= 0;
        if (m.transforms && since >= 0 && since < FLIP_MS) {
          const p = easeOutBack(since / FLIP_MS, 1.4);
          tf = `perspective(4em) rotateX(${((1 - p) * -88).toFixed(1)}deg)`;
          shown = since > FLIP_MS * 0.25;
        }
        const key = `${shown ? 1 : 0}|${tf}`;
        if (flips[gi] !== key) {
          flips[gi] = key;
          g.style.transform = tf;
          g.dataset.f = shown ? '1' : '0';
        }
      });
    }

    const second = Math.floor(Math.max(0, t) / 1000);
    if (second !== this.lastSecond) {
      this.lastSecond = second;
      setText(this.clock, fmtClock(Math.max(0, t)));
    }
    if (li !== this.lastLine) {
      this.lastLine = li;
      const pl = li >= 1 ? lines[li - 1] : undefined;
      const nl = lines[li + 1] ?? (li < 0 ? lines[0] : undefined);
      setText(this.prevNo, pl ? String(pl.index + 1).padStart(2, '0') : '');
      setText(this.prevText, pl ? pl.text.toLocaleUpperCase() : '');
      setText(this.nextNo, nl ? String(nl.index + 1).padStart(2, '0') : '');
      setText(this.nextText, nl ? nl.text.toLocaleUpperCase() : '');
      this.prevRow.classList.toggle('empty', !pl);
      this.nextRow.classList.toggle('empty', !nl);
      setText(this.status, li >= 0 ? `NOW BOARDING  ·  LINE ${String(li + 1).padStart(2, '0')}` : 'BOARDING SOON');
    }
    const ctxMode = this.ctx.context;
    this.root.classList.toggle('hide-prev', ctxMode === 'off' || gapOn);
    this.root.classList.toggle('hide-next', ctxMode !== 'full');
    if (gapOn && gap) {
      setText(this.gap, gap.kind === 'intro' ? 'BOARDING SOON' : gap.kind === 'outro' ? 'END OF THE LINE' : 'INTERLUDE');
      setText(this.gapTime, Number.isFinite(gap.endMs) ? `VOCALS IN ${fmtClock(gap.endMs - t + 999)}` : (this.ctx.title ?? '').toLocaleUpperCase());
    }
  }
}
