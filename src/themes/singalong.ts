import type { LyricLine } from '../core/lyrics/model';
import type { FontSpec } from '../stage/layout';
import { clamp01, easeOutCubic } from '../stage/motion';
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
  showView,
  stateOf,
  unitRects,
  unitSize,
} from '../stage/scene';

/**
 * SINGALONG: a karaoke party screen. Two rows alternate: the line being sung and the
 * one after it. With real word timing each word fills with colour as it is sung and
 * a ball bounces from word to word on the words' own timestamps. With line timing the
 * whole line fills when it starts and there is no ball (no word timing is implied);
 * the optional estimated sweep fills word by word and is labelled. Countdown dots
 * appear in the last three seconds before vocals return. Duet voices fill in
 * different colours.
 */
export const SINGALONG_FONT: FontSpec = { family: 'Archivo Variable', weight: 780, tracking: -0.01, lineHeight: 1.42 };

/** Two rows, with room above each word for the ball to hop without touching the row above. */
const ROW_TOP = [0.44, 0.67];
const ROW_H = 0.21;
/** Hop height and ball radius, as fractions of the stage height. */
const HOP = 0.022;
const BALL_R = 0.013;

export class SingalongScene extends Scene {
  protected readonly font = SINGALONG_FONT;
  private readonly stage: HTMLDivElement;
  private readonly rays: HTMLDivElement;
  private readonly ball: HTMLDivElement;
  private readonly count: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly cardTitle: HTMLDivElement;
  private readonly cardArtist: HTMLDivElement;
  private readonly estTag: HTMLDivElement;
  private box = { w: 0, h: 0, left: 0 };
  private lastRays = '';
  private lastBall = '';
  private lastCount = '';

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'singalong');
    const r = this.root;
    el('div', 'sg-bg', r);
    this.rays = el('div', 'sg-rays', r);
    el('div', 'sg-floor', r);
    this.card = el('div', 'sg-card', r);
    el('div', 'sg-card-kicker', this.card, '♪  SING ALONG  ♪');
    this.cardTitle = el('div', 'sg-card-title', this.card);
    this.cardArtist = el('div', 'sg-card-artist', this.card);
    this.stage = el('div', 'sg-stage', r);
    this.count = el('div', 'sg-count', r);
    for (let i = 0; i < 3; i++) el('span', 'sg-dot', this.count);
    this.ball = el('div', 'sg-ball', r);
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    this.onContext();
    this.onResize();
  }

  protected override onContext(): void {
    this.root.dataset.context = this.ctx.context;
    setText(this.cardTitle, this.ctx.title ?? 'Sing along');
    setText(this.cardArtist, this.ctx.artist ?? '');
  }

  protected override onResize(): void {
    const w = Math.min(this.w * 0.88, 1600);
    this.box = { w, h: this.h * ROW_H, left: (this.w - w) / 2 };
    this.stage.style.cssText = `left:${this.box.left}px;top:0;width:${w}px;height:${this.h}px`;
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview)}px`);
    this.root.style.setProperty('--h', `${this.h}px`);
    this.lastBall = '';
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, SINGALONG_FONT, 'sg-line');
    // the coloured fill is a copy of each word drawn over it and revealed left to right
    for (const u of v.units) u.el.dataset.t = u.el.textContent ?? '';
    this.stage.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const maxSize = Math.min(this.h * 0.085, this.w * 0.06) * this.ctx.textScale;
    const r = layoutFlowInto(v, this.space, { w: this.box.w, h: this.box.h }, { maxRows: 2, lineHeight: SINGALONG_FONT.lineHeight, maxSize, minSize: this.ctx.preview ? 4 : Math.max(12, this.h * 0.026) }, 'sg-row');
    const top = this.h * ROW_TOP[v.line.index % 2] + Math.max(0, (this.box.h - r.height) / 2);
    v.el.style.top = `${top}px`;
    v.data.top = top;
    v.data.fill = v.units.map(() => '');
  }

  /** Fill fraction of each unit (0..1), written only when it changes. */
  private fill(v: LineView, i: number, p: number): void {
    const s = p <= 0 ? '0' : p >= 1 ? '1' : p.toFixed(3);
    const cache = v.data.fill as string[];
    if (cache[i] === s) return;
    cache[i] = s;
    v.units[i].el.style.setProperty('--p', s);
  }

  frame(f: FrameInput): void {
    const { t, cue } = f;
    const m = this.ctx.motion;
    const li = cue.lineIndex;
    const lines = this.ctx.doc.lines;
    const gap = cue.gap;
    const intro = !!gap && gap.kind === 'intro';
    this.root.classList.toggle('in-intro', intro);

    // the line being sung (or the first one, before it) and the line after it
    const a = li >= 0 ? li : 0;
    const cur = lines.length ? this.view(a) : null;
    const nxt = a + 1 < lines.length ? this.view(a + 1) : null;
    this.prune(a, a + 1);
    for (const v of this.views.values()) if (v !== cur && v !== nxt) showView(v, false);

    let ballAt: { x: number; y: number; hop: number } | null = null;
    const outro = !!gap && gap.kind === 'outro';
    if (cur) {
      const op = outro ? 1 - clamp01((t - gap!.startMs - 600) / 700) : 1;
      showView(cur, op > 0.002);
      setLineStyle(cur, '', op.toFixed(3));
      const exact = cur.line.wordTiming === 'exact';
      // line timing: every word fills at the line's start (a staggered fill would look like word timing)
      const stagger = 0;
      const est = li >= 0 && this.ctx.estimatedSweep && !exact ? estimatedUnit(cur, t, this.ctx.analysis.p80Sps) : -1;
      this.estTag.classList.toggle('on', li >= 0 && this.ctx.estimatedSweep && !exact);
      for (const u of cur.units) {
        const s = li >= 0 ? stateOf(cur, u.index, t, stagger, est) : 'future';
        setUnitState(u, s);
        let p = 0;
        if (li >= 0) {
          if (exact) {
            const w = u.word;
            p = t >= w.endMs ? 1 : t <= w.startMs ? 0 : (t - w.startMs) / Math.max(1, w.endMs - w.startMs);
          } else if (est >= 0) p = u.index <= est ? 1 : 0;
          else p = s === 'future' ? 0 : 1;
        }
        this.fill(cur, u.index, p);
      }
      // the bouncing ball: only on real word timestamps, or on the labelled estimate
      if (li >= 0 && t < cur.line.endMs) {
        const rects = unitRects(cur);
        const top = cur.data.top as number;
        // landing point: the top of the word's capitals (inside the generous line spacing)
        const centre = (i: number) => ({ x: this.box.left + rects[i].x + rects[i].w / 2, y: top + rects[i].y + rects[i].h * 0.27 });
        if (exact) {
          const ws = cur.line.words;
          let i = -1;
          for (let k = 0; k < ws.length; k++) if (ws[k].startMs <= t) i = k;
          if (i < 0) {
            const c = centre(0);
            ballAt = { x: c.x, y: c.y, hop: clamp01((ws[0].startMs - t) / 400) };
          } else if (i + 1 < ws.length) {
            const u = clamp01((t - ws[i].startMs) / Math.max(1, ws[i + 1].startMs - ws[i].startMs));
            const c0 = centre(i);
            const c1 = centre(i + 1);
            ballAt = { x: c0.x + (c1.x - c0.x) * u, y: c0.y + (c1.y - c0.y) * u, hop: Math.sin(Math.PI * u) };
          } else {
            const c = centre(i);
            ballAt = { x: c.x, y: c.y, hop: 0 };
          }
        } else if (est >= 0) {
          const c = centre(est);
          ballAt = { x: c.x, y: c.y, hop: 0 };
        }
      }
    }
    if (nxt) {
      // the row after: fades in as soon as the line before it has finished with that row
      const since = li >= 0 ? t - cur!.line.startMs : 1000;
      const op = outro ? 0 : (m.transforms ? easeOutCubic(since / 350) : 1) * 0.92;
      showView(nxt, op > 0.002);
      setLineStyle(nxt, '', op.toFixed(3));
      for (const u of nxt.units) {
        setUnitState(u, 'future');
        this.fill(nxt, u.index, 0);
      }
    }

    // ball position (transform only) and visibility
    const lift = ballAt ? (BALL_R + HOP * ballAt.hop * (m.transforms ? 1 : 0)) * this.h : 0;
    const ballKey = ballAt ? `${ballAt.x.toFixed(1)}|${(ballAt.y - lift).toFixed(1)}` : 'off';
    if (ballKey !== this.lastBall) {
      this.lastBall = ballKey;
      if (ballAt) {
        const [x, y] = ballKey.split('|');
        this.ball.style.transform = `translate3d(${x}px,${y}px,0)`;
        this.ball.classList.add('on');
      } else this.ball.classList.remove('on');
    }

    // countdown dots before vocals return (from timestamps)
    const upcoming = li < 0 ? lines[0] : gap && gap.kind === 'instrumental' ? lines[li + 1] : undefined;
    const left = upcoming ? upcoming.startMs - t : Infinity;
    const n = left > 0 && left <= 3000 ? Math.ceil(left / 1000) : 0;
    const countKey = n ? `${n}|${upcoming!.index % 2}` : '0';
    if (countKey !== this.lastCount) {
      this.lastCount = countKey;
      this.count.dataset.n = String(n);
      if (n && upcoming) this.count.style.top = `${this.h * ROW_TOP[upcoming.index % 2] - this.h * 0.045}px`;
    }

    // slow light rays behind (time-driven)
    const deg = m.transforms && !this.ctx.preview ? Math.round(((Math.max(0, t) / 1000) * 4 % 360) * 10) / 10 : 0;
    const rays = deg ? `rotate(${deg}deg)` : '';
    if (rays !== this.lastRays) {
      this.lastRays = rays;
      this.rays.style.transform = rays;
    }
  }
}
