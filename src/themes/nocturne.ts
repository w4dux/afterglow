import type { LyricLine } from '../core/lyrics/model';
import type { FontSpec } from '../stage/layout';
import { clamp01, easeInCubic, easeOutCubic, easeOutExpo, easeOutQuart, wobble } from '../stage/motion';
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
  unitRects,
} from '../stage/scene';
import { grainTexture } from '../stage/textures';

/**
 * NOCTURNE — trap / dark electronic.
 * Deep black, one centred line of wide chrome type, long silences. Words are cut in
 * with a hard horizontal slice; the active word gets a neon underline that snaps
 * between words. A perspective floor grid advances one cell per beat when the tempo is
 * known (otherwise it drifts slowly and makes no beat claim). Exits collapse sharply.
 */
const FONT: FontSpec = { family: 'Unbounded Variable', weight: 640, upper: true, tracking: 0.03, lineHeight: 1.12 };

export class NocturneScene extends Scene {
  protected readonly font = FONT;
  private grid!: HTMLDivElement;
  private gridInner!: HTMLDivElement;
  private horizon!: HTMLDivElement;
  private spark!: HTMLDivElement;
  private art!: HTMLImageElement;
  private stage!: HTMLDivElement;
  private underline!: HTMLDivElement;
  private prev!: HTMLDivElement;
  private next!: HTMLDivElement;
  private gap!: HTMLDivElement;
  private gapText!: HTMLDivElement;
  private gapClock!: HTMLDivElement;
  private label!: HTMLDivElement;
  private estTag!: HTMLDivElement;
  private vars: Record<string, string> = {};
  private box = { w: 0, h: 0, cy: 0 };
  private lastLine = -2;

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'nocturne');
    const r = this.root;
    el('div', 'nc-fog a', r);
    el('div', 'nc-fog b', r);
    this.grid = el('div', 'nc-grid', r);
    this.gridInner = el('div', 'nc-grid-inner', el('div', 'nc-grid-plane', this.grid));
    this.horizon = el('div', 'nc-horizon', r);
    this.spark = el('div', 'nc-spark', this.horizon);
    this.art = el('img', 'nc-art', r);
    this.art.alt = '';
    this.label = el('div', 'nc-label', r);
    this.prev = el('div', 'nc-prev', r);
    this.stage = el('div', 'nc-stage', r);
    this.underline = el('div', 'nc-underline', this.stage);
    this.next = el('div', 'nc-next', r);
    this.gap = el('div', 'nc-gap', r);
    this.gapText = el('div', 'nc-gap-text', this.gap);
    this.gapClock = el('div', 'nc-gap-clock', this.gap);
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    el('div', 'nc-vignette', r);
    el('div', 'nc-grain', r).style.backgroundImage = `url(${grainTexture(160, 0.12)})`;
    this.onContext();
    this.onResize();
  }

  protected override onContext(): void {
    const a = this.ctx.artwork;
    this.root.classList.toggle('has-art', !!a);
    if (a && this.art.src !== a.url) this.art.src = a.url;
    this.root.dataset.context = this.ctx.context;
    setText(this.label, [this.ctx.artist, this.ctx.title].filter(Boolean).join('  /  '));
    this.lastLine = -2;
  }

  protected override onResize(): void {
    const w = this.w * 0.84;
    const h = this.h * (this.h < 420 ? 0.36 : 0.3);
    const cy = this.h * 0.4;
    this.box = { w, h, cy };
    this.stage.style.cssText = `left:${(this.w - w) / 2}px;top:${cy - h / 2}px;width:${w}px;height:${h}px`;
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview)}px`);
    this.lastLine = -2;
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, FONT, 'nc-line');
    this.stage.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const maxSize = Math.min(this.h * 0.115, this.w * 0.065) * this.ctx.textScale;
    const r = layoutFlowInto(v, this.space, { w: this.box.w, h: this.box.h }, { maxRows: 2, lineHeight: FONT.lineHeight, maxSize, minSize: Math.max(12, this.h * 0.028) }, 'nc-row');
    v.data.height = r.height;
    v.el.style.top = `${(this.box.h - r.height) / 2}px`;
    v.data.top = (this.box.h - r.height) / 2;
  }

  frame(f: FrameInput): void {
    const { t, cue } = f;
    const m = this.ctx.motion;
    const lines = this.ctx.doc.lines;
    const li = cue.lineIndex;
    const gap = cue.gap;
    const gapOn = !!gap && (gap.kind === 'intro' || t - gap.startMs > 500);
    const cur = li >= 0 ? this.view(li) : null;
    const prevV = li >= 1 ? this.view(li - 1) : null;
    this.prune(li - 1, li + 1);
    for (const v of this.views.values()) if (v !== cur && v !== prevV) showView(v, false);

    // ---- current line: hard slice-in of each word
    if (cur) {
      const age = t - cur.line.startMs;
      let op = 1;
      let tf = '';
      if (gap && gap.kind !== 'intro') {
        const g = clamp01((t - gap.startMs - 200) / 280);
        op = 1 - g;
        if (m.transforms) tf = `scaleY(${(1 - 0.85 * easeInCubic(g)).toFixed(4)})`;
      } else if (!m.transforms) {
        op = clamp01(age / 140);
      }
      showView(cur, op > 0.001);
      setLineStyle(cur, tf, op.toFixed(3));
      this.animateUnits(cur, t, f);
    } else {
      this.underline.style.opacity = '0';
    }
    if (prevV) {
      const k = clamp01((t - (cur ? cur.line.startMs : prevV.line.endMs)) / 170);
      if (k >= 1 || leftDuringGap(prevV, cur)) showView(prevV, false);
      else {
        showView(prevV, true);
        setLineStyle(prevV, m.transforms ? `translate3d(0,${(-easeInCubic(k) * this.box.h * 0.25).toFixed(1)}px,0) scaleY(${(1 - 0.9 * easeInCubic(k)).toFixed(4)})` : '', (1 - k).toFixed(3));
        for (const u of prevV.units) {
          setUnitState(u, 'past');
          setUnitTransform(u, '', '');
          u.el.style.clipPath = '';
        }
      }
    }

    // ---- context lines (outline above, small caps below)
    if (li !== this.lastLine) {
      this.lastLine = li;
      setText(this.prev, li >= 1 ? lines[li - 1].text : '');
      // keep the outline context line just above the current block
      const curTop = cur ? this.box.cy - this.box.h / 2 + (cur.data.top as number) : this.box.cy;
      this.prev.style.top = `${Math.max(this.h * 0.12, curTop - this.h * 0.075).toFixed(1)}px`;
      const nl = lines[li + 1] ?? (li < 0 ? lines[0] : undefined);
      setText(this.next, nl ? nl.text : '');
    }
    const showCtx = this.ctx.context !== 'off' && !gapOn;
    const prevAge = cur ? t - cur.line.startMs : 0;
    this.prev.style.opacity = showCtx && cur ? (0.42 * clamp01((prevAge - 140) / 300)).toFixed(3) : '0';
    this.next.style.opacity = showCtx && this.ctx.context === 'full' ? '0.5' : '0';

    // ---- horizon line: progress through the current line (or gap)
    const prog = gapOn && gap ? gap.progress : cue.lineProgress;
    this.spark.style.transform = `translate3d(${(prog * this.w).toFixed(1)}px,0,0)`;

    // ---- floor grid: one cell per beat with trusted tempo, slow drift otherwise
    let gridPhase: number;
    const meta = this.ctx.doc.meta;
    if (meta.bpm && meta.beatOffsetMs !== undefined) gridPhase = (((t - meta.beatOffsetMs) / (60000 / meta.bpm)) % 1 + 1) % 1;
    else gridPhase = ((t / 2400) % 1 + 1) % 1;
    if (m.transforms) this.gridInner.style.transform = `translate3d(0,${(gridPhase * 10).toFixed(3)}%,0)`;
    const pulse = f.beat && m.pulse ? f.beat.env : 0;
    setVar(this.root, '--pulse', pulse.toFixed(3), this.vars);
    const fog = m.transforms ? ((t / 1000) * 0.05) % (Math.PI * 2) : 0;
    setVar(this.root, '--fog-x', `${(Math.sin(fog) * 6).toFixed(2)}%`, this.vars);
    setVar(this.root, '--fog-y', `${(Math.cos(fog * 0.7) * 4).toFixed(2)}%`, this.vars);

    // ---- gap
    this.root.classList.toggle('in-gap', gapOn);
    if (gapOn && gap) {
      setText(this.gapText, gap.kind === 'intro' ? this.ctx.title ?? '' : gap.kind === 'outro' ? 'End' : 'Instrumental');
      setText(this.gapClock, Number.isFinite(gap.endMs) ? `${fmtClock(gap.endMs - t + 999)}` : this.ctx.artist ?? '');
      this.gap.style.opacity = (gap.kind === 'intro' ? 1 : clamp01((t - gap.startMs - 500) / 500)).toFixed(3);
    } else this.gap.style.opacity = '0';
  }

  private animateUnits(v: LineView, t: number, f: FrameInput): void {
    const m = this.ctx.motion;
    const stagger = staggerFor(v, 55);
    const est = this.ctx.estimatedSweep && v.line.wordTiming !== 'exact' ? estimatedUnit(v, t, this.ctx.analysis.p80Sps) : -1;
    this.estTag.classList.toggle('on', this.ctx.estimatedSweep && v.line.wordTiming !== 'exact');
    let activeIdx = -1;
    for (const u of v.units) {
      const s = stateOf(v, u.index, t, stagger, est);
      setUnitState(u, s);
      if (s === 'active') activeIdx = u.index;
      const age = t - unitArrival(v, u.index, stagger);
      if (!m.transforms || s === 'future') {
        if (u.el.style.clipPath) u.el.style.clipPath = '';
        setUnitTransform(u, '', '');
        continue;
      }
      // slice reveal: 0 -> 100% in ~110 ms (shorter on fast lines)
      const dur = v.fast ? 70 : 110;
      const k = clamp01(age / dur);
      const clip = k < 1 ? `inset(-20% ${((1 - easeOutQuart(k)) * 100).toFixed(1)}% -20% 0)` : '';
      if (u.el.style.clipPath !== clip) u.el.style.clipPath = clip;
      let tx = m.wordMotion ? (1 - easeOutExpo(age / 220)) * -18 * m.amount : 0;
      let rot = 0;
      if (m.jiggle > 0 && s === 'active') {
        const a = t - u.word.startMs;
        tx += wobble(a, 9, 200) * 4 * m.jiggle;
        rot = wobble(a, 7, 300) * 2.5 * m.jiggle;
      }
      const sc = s === 'active' && f.beat && m.pulse ? 1 + f.beat.env * 0.025 : 1;
      setUnitTransform(u, tx || rot || sc !== 1 ? `translate3d(${tx.toFixed(1)}px,0,0) rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(4)})` : '', '');
    }
    // neon underline snapping to the active word
    const rects = unitRects(v);
    if (activeIdx >= 0 && rects[activeIdx]) {
      const r = rects[activeIdx];
      const top = (v.data.top as number) + r.y + r.h * 0.96;
      const age = t - v.line.words[activeIdx].startMs;
      const k = m.transforms ? easeOutCubic(age / 90) : 1;
      // deterministic: slide from the previous word (pure function of time)
      const from = rects[activeIdx - 1] ?? { x: r.x, w: 0 };
      const x = from.x + (r.x - from.x) * k;
      const w = from.w + (r.w - from.w) * k;
      this.underline.style.cssText = `opacity:1;transform:translate3d(${x.toFixed(1)}px,${top.toFixed(1)}px,0);width:${w.toFixed(1)}px`;
    } else {
      this.underline.style.opacity = '0';
    }
  }
}
