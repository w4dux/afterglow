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
 * HAZE: slow, hazy, psychedelic listening. Lava-lamp colour drifts behind chunky,
 * soft 70s letters that float a little and carry double-vision trails; the colours
 * shift slowly across the song. Words fade up out of the haze and finished lines
 * dissolve upward like smoke. Everything is slow and every motion is a function of
 * lyric time; with reduced motion the scene is still.
 */
export const HAZE_FONT: FontSpec = { family: 'Fraunces Variable', weight: 900, tracking: -0.02, lineHeight: 1.04 };

const BLOBS = 5;
const WISPS = 3;

export class HazeScene extends Scene {
  protected readonly font = HAZE_FONT;
  private readonly stage: HTMLDivElement;
  private readonly lava: HTMLDivElement;
  private readonly blobs: HTMLDivElement[] = [];
  private readonly wisps: HTMLDivElement[] = [];
  private readonly next: HTMLDivElement;
  private readonly meta: HTMLDivElement;
  private readonly gap: HTMLDivElement;
  private readonly gapTime: HTMLDivElement;
  private readonly estTag: HTMLDivElement;
  private box = { w: 0, h: 0 };
  private lastLine = -2;
  private lastHue = -1;
  private placed = false;

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'haze');
    const r = this.root;
    el('div', 'hy-bg', r);
    this.lava = el('div', 'hy-lava', r);
    for (let i = 0; i < BLOBS; i++) this.blobs.push(el('div', `hy-blob b${i}`, this.lava));
    const smoke = el('div', 'hy-smoke', r);
    for (let i = 0; i < WISPS; i++) this.wisps.push(el('div', `hy-wisp w${i}`, smoke));
    el('div', 'hy-veil', r);
    this.meta = el('div', 'hy-meta', r);
    this.stage = el('div', 'hy-stage', r);
    this.next = el('div', 'hy-next', r);
    const gap = el('div', 'hy-gap', r);
    this.gap = el('div', 'hy-gap-title', gap);
    this.gapTime = el('div', 'hy-gap-time', gap);
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    el('div', 'hy-grain', r).style.backgroundImage = `url(${grainTexture(180, 0.12)})`;
    this.onContext();
    this.onResize();
  }

  protected override onContext(): void {
    this.root.dataset.context = this.ctx.context;
    setText(this.meta, [this.ctx.title, this.ctx.artist].filter(Boolean).join('  ~  '));
    this.lastLine = -2;
    this.placed = false;
  }

  protected override onResize(): void {
    this.box = { w: Math.min(this.w * 0.78, 1420), h: this.h * 0.44 };
    this.stage.style.cssText = `left:${(this.w - this.box.w) / 2}px;top:${this.h * 0.28}px;width:${this.box.w}px;height:${this.box.h}px`;
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview)}px`);
    this.root.style.setProperty('--h', `${this.h}px`);
    this.lastLine = -2;
    this.placed = false;
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, HAZE_FONT, 'hy-line');
    this.stage.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const maxSize = Math.min(this.h * 0.125, this.w * 0.075) * this.ctx.textScale;
    const r = layoutFlowInto(v, this.space, this.box, { maxRows: 3, lineHeight: HAZE_FONT.lineHeight, maxSize, minSize: this.ctx.preview ? 4 : Math.max(14, this.h * 0.032) }, 'hy-row');
    v.el.style.top = `${Math.max(0, (this.box.h - r.height) / 2)}px`;
  }

  frame(f: FrameInput): void {
    const { t, cue } = f;
    const m = this.ctx.motion;
    const li = cue.lineIndex;
    const lines = this.ctx.doc.lines;
    const gap = cue.gap;
    const gapOn = !!gap && (gap.kind === 'intro' || t - gap.startMs > 1000);
    this.root.classList.toggle('in-gap', gapOn);
    const cur = li >= 0 ? this.view(li) : null;
    const prev = li >= 1 ? this.view(li - 1) : null;
    this.prune(li - 1, li + 1);
    for (const v of this.views.values()) if (v !== cur && v !== prev) showView(v, false);
    const floating = m.wordMotion && m.transforms;

    if (cur) {
      const age = t - cur.line.startMs;
      const e = m.transforms ? easeOutCubic(age / 1000) : clamp01(age / 300);
      let op = gapOn ? 0 : e;
      if (gap && gap.kind !== 'intro') op *= 1 - clamp01((t - gap.startMs - 400) / 900);
      showView(cur, op > 0.002);
      cur.el.classList.remove('gone');
      setLineStyle(cur, m.transforms ? `translate3d(0,${((1 - e) * this.h * 0.035).toFixed(1)}px,0)` : '', op.toFixed(3));
      const stagger = staggerFor(cur, 90);
      const est = this.ctx.estimatedSweep && cur.line.wordTiming !== 'exact' ? estimatedUnit(cur, t, this.ctx.analysis.p80Sps) : -1;
      this.estTag.classList.toggle('on', this.ctx.estimatedSweep && cur.line.wordTiming !== 'exact');
      for (const u of cur.units) {
        const s = stateOf(cur, u.index, t, stagger, est);
        setUnitState(u, s);
        if (!floating) {
          setUnitTransform(u, '', '');
          continue;
        }
        // each word floats on its own slow current; the sung word swells a little
        const dy = Math.sin(t / 1300 + u.seed * 0.7) * 0.045 * m.amount;
        const rot = Math.sin(t / 1900 + u.seed) * 1.4 * m.amount;
        const since = t - unitArrival(cur, u.index, stagger);
        const swell = s === 'active' ? 1 + 0.06 * easeOutCubic(since / 600) * m.amount : 1;
        setUnitTransform(u, `translate3d(0,${dy.toFixed(3)}em,0) rotate(${rot.toFixed(2)}deg) scale(${swell.toFixed(3)})`, '');
      }
    }
    if (prev) {
      // the finished line drifts up out of the way and dissolves like smoke; quick enough
      // that the two lines are never stacked long enough to be hard to read
      const x = clamp01((t - (cur?.line.startMs ?? prev.line.endMs)) / 800);
      const op = gapOn || (cur && cur.line.startMs - prev.line.endMs >= 4500) ? 0 : (1 - x) * (1 - x) * 0.7;
      showView(prev, op > 0.002);
      if (prev.shown) {
        prev.el.classList.add('gone');
        setLineStyle(prev, m.transforms ? `translate3d(0,${(-easeOutCubic(x) * this.h * 0.14).toFixed(1)}px,0) scale(${(1 + x * 0.04).toFixed(4)})` : '', op.toFixed(3));
        for (const u of prev.units) setUnitState(u, 'past');
      }
    }

    // lava, smoke and a slow colour drift, all from lyric time
    const moving = m.transforms && !this.ctx.preview;
    if (moving || !this.placed) {
      const tt = moving ? Math.max(0, t) : 0;
      for (let i = 0; i < BLOBS; i++) {
        const px = 21000 + hash01(i, 1) * 17000;
        const py = 26000 + hash01(i, 2) * 15000;
        const x = 0.5 + 0.34 * Math.sin((tt / px) * Math.PI * 2 + hash01(i, 3) * 6.28);
        const y = 0.5 + 0.3 * Math.cos((tt / py) * Math.PI * 2 + hash01(i, 4) * 6.28);
        const s = 1 + 0.18 * Math.sin(tt / (9000 + i * 1700) + i);
        this.blobs[i].style.transform = `translate3d(${(x * this.w).toFixed(1)}px,${(y * this.h).toFixed(1)}px,0) translate(-50%,-50%) scale(${s.toFixed(3)})`;
      }
      for (let i = 0; i < WISPS; i++) {
        const period = 16000 + i * 4500;
        const p = ((tt + i * 5300) % period) / period;
        const x = (0.2 + 0.3 * i + 0.05 * Math.sin(tt / 4000 + i)) * this.w;
        this.wisps[i].style.transform = `translate3d(${x.toFixed(1)}px,${((1 - p) * this.h * 1.1).toFixed(1)}px,0) rotate(${(-12 + 24 * p).toFixed(1)}deg)`;
        this.wisps[i].style.opacity = (Math.sin(p * Math.PI) * 0.5).toFixed(3);
      }
      // a full colour cycle about every two minutes, changed in whole degrees only
      const hue = moving ? Math.floor((tt / 1000) * 3) % 360 : 0;
      if (hue !== this.lastHue) {
        this.lastHue = hue;
        this.lava.style.setProperty('--hue', `${hue}deg`);
      }
      this.placed = !moving;
    }

    if (li !== this.lastLine) {
      this.lastLine = li;
      const nl = lines[li + 1] ?? (li < 0 ? lines[0] : undefined);
      setText(this.next, nl ? nl.text : '');
    }
    this.root.classList.toggle('hide-next', this.ctx.context !== 'full' || gapOn);
    if (gapOn && gap) {
      setText(this.gap, gap.kind === 'intro' ? this.ctx.title ?? '' : gap.kind === 'outro' ? '' : '~ ~ ~');
      setText(this.gapTime, Number.isFinite(gap.endMs) ? `vocals in ${fmtClock(gap.endMs - t + 999)}` : '');
    }
  }
}
