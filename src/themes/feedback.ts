import type { LyricLine } from '../core/lyrics/model';
import type { FontSpec } from '../stage/layout';
import { clamp01, easeInCubic, easeOutCubic, hashSigned } from '../stage/motion';
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
  showView,
  staggerFor,
  stateOf,
  unitArrival,
  unitSize,
} from '../stage/scene';
import { grainTexture, halftone, paperTexture } from '../stage/textures';

/**
 * FEEDBACK — rock / alternative.
 * A photocopied gig poster: warm paper, black ink, one red. Each word is printed on its
 * own strip of black tape and *stamped* in when sung — a hard, fast hit with a red
 * misregistration that settles. Unsung words wait as faint toner. The active word
 * "boils" (stop-motion jitter at 8 fps) — controlled roughness that freezes on pause.
 */
const FONT: FontSpec = { family: 'Big Shoulders Display Variable', weight: 900, upper: true, tracking: 0.01, lineHeight: 1.08 };

export class FeedbackScene extends Scene {
  protected readonly font = FONT;
  private photo!: HTMLDivElement;
  private photoImg!: HTMLImageElement;
  private block!: HTMLDivElement;
  private prev!: HTMLDivElement;
  private next!: HTMLDivElement;
  private stamp!: HTMLDivElement;
  private stampClock!: HTMLDivElement;
  private header!: HTMLDivElement;
  private estTag!: HTMLDivElement;
  private boxW = 0;
  private boxH = 0;
  private lastLine = -2;

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'feedback');
    const r = this.root;
    el('div', 'fb-paper', r).style.backgroundImage = `url(${paperTexture()})`;
    this.photo = el('div', 'fb-photo', r);
    this.photoImg = el('img', '', this.photo);
    this.photoImg.alt = '';
    el('div', 'fb-photo-screen', this.photo).style.backgroundImage = `url(${halftone(5, '#e8e2d4')})`;
    el('div', 'fb-tape t1', this.photo);
    el('div', 'fb-tape t2', this.photo);
    el('div', 'fb-catalog', r, 'AFTERGLOW / IN STEREO');
    el('div', 'fb-seal', r, 'PLAY\nIT\nLOUD');
    this.header = el('div', 'fb-header', r);
    this.prev = el('div', 'fb-prev', r);
    this.block = el('div', 'fb-block', r);
    this.next = el('div', 'fb-next', r);
    this.stamp = el('div', 'fb-stamp', r);
    el('div', 'fb-stamp-word', this.stamp, 'Instrumental');
    this.stampClock = el('div', 'fb-stamp-clock', this.stamp);
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    el('div', 'fb-edge', r);
    el('div', 'fb-grain', r).style.backgroundImage = `url(${grainTexture(180, 0.2)})`;
    this.onContext();
    this.onResize();
  }

  protected override onContext(): void {
    const a = this.ctx.artwork;
    this.root.classList.toggle('has-art', !!a);
    if (a && this.photoImg.src !== a.url) this.photoImg.src = a.url;
    setText(this.header, [this.ctx.artist, this.ctx.title].filter(Boolean).join(' ✕ ') || 'Afterglow');
    this.lastLine = -2;
  }

  protected override onResize(): void {
    const art = this.ctx.artwork && this.w > 800 ? 0.18 : 0;
    this.boxW = this.w * (0.84 - art);
    this.boxH = this.h * (this.h < 420 ? 0.52 : 0.48);
    this.block.style.cssText = `left:${this.w * 0.07}px;top:${this.h * 0.5 - this.boxH / 2}px;width:${this.boxW}px;height:${this.boxH}px`;
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview)}px`);
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, FONT, 'fb-line');
    if (v.hook) v.el.classList.add('is-hook');
    this.block.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const maxSize = Math.min(this.h * 0.2, this.w * 0.14) * this.ctx.textScale * (v.hook ? 1.08 : 1);
    const r = layoutFlowInto(v, this.space * 1.6, { w: this.boxW * 0.94, h: this.boxH }, { maxRows: 4, lineHeight: FONT.lineHeight, maxSize, minSize: Math.max(14, this.h * 0.04) }, 'fb-row');
    v.el.style.top = `${(this.boxH - r.height) / 2}px`;
    // zig-zag row offsets like a pasted-up poster
    v.rows.forEach((row, i) => {
      row.style.marginLeft = `${((i % 2 ? 1 : 0) * 0.35 + hashSigned(v.line.index, i) * 0.12).toFixed(3)}em`;
    });
  }

  frame(f: FrameInput): void {
    const { t, cue } = f;
    const m = this.ctx.motion;
    const li = cue.lineIndex;
    const lines = this.ctx.doc.lines;
    const gap = cue.gap;
    const gapOn = !!gap && (gap.kind === 'intro' || t - gap.startMs > 600);
    const cur = li >= 0 ? this.view(li) : null;
    const prevV = li >= 1 ? this.view(li - 1) : null;
    this.prune(li - 1, li + 1);
    for (const v of this.views.values()) if (v !== cur && v !== prevV) showView(v, false);

    if (cur) {
      const age = t - cur.line.startMs;
      let op = 1;
      if (gap && gap.kind !== 'intro') op = 1 - clamp01((t - gap.startMs - 200) / 350);
      if (!m.transforms) op *= clamp01(age / 100);
      showView(cur, op > 0.002);
      const rot = -2.4 + (cur.line.index % 3) * 0.8;
      setLineStyle(cur, `rotate(${rot}deg)`, op.toFixed(3));
      this.animateUnits(cur, t, f);
    }
    if (prevV) {
      // torn away fast: drops and tilts while it fades, so it never sits under the new print
      const k = clamp01((t - (cur ? cur.line.startMs : prevV.line.endMs)) / 150);
      if (k >= 1 || leftDuringGap(prevV, cur)) showView(prevV, false);
      else {
        showView(prevV, true);
        const e = easeInCubic(k);
        setLineStyle(prevV, m.transforms ? `translate3d(0,${(e * this.h * 0.3).toFixed(1)}px,0) rotate(${(-2.4 + e * 9).toFixed(2)}deg)` : 'rotate(-2.4deg)', ((1 - k) * (1 - k)).toFixed(3));
        for (const u of prevV.units) setUnitState(u, 'past');
      }
    }

    if (li !== this.lastLine) {
      this.lastLine = li;
      setText(this.prev, li >= 1 ? lines[li - 1].text : '');
      const nl = lines[li + 1] ?? (li < 0 ? lines[0] : undefined);
      setText(this.next, nl ? `next → ${nl.text}` : '');
    }
    const ctxOn = this.ctx.context !== 'off' && !gapOn;
    this.prev.style.opacity = ctxOn && cur ? (0.32 * clamp01((t - cur.line.startMs - 150) / 250)).toFixed(3) : '0';
    this.next.style.opacity = ctxOn && this.ctx.context === 'full' ? '0.75' : '0';

    this.root.classList.toggle('in-gap', gapOn);
    if (gapOn && gap) {
      const k = gap.kind === 'intro' ? 1 : clamp01((t - gap.startMs - 600) / 120);
      const sc = m.transforms ? 1.25 - 0.25 * easeOutCubic(k) : 1;
      this.stamp.style.opacity = k.toFixed(3);
      this.stamp.style.transform = `translate(-50%,-50%) rotate(-7deg) scale(${sc.toFixed(4)})`;
      setText(this.stampClock, Number.isFinite(gap.endMs) ? `back in ${fmtClock(gap.endMs - t + 999)}` : 'end of side');
      const word = gap.kind === 'intro' ? (this.ctx.title ?? 'Intro') : gap.kind === 'outro' ? 'The end' : 'Instrumental';
      const label = this.stamp.firstChild as HTMLElement;
      if (label.textContent !== word) {
        label.textContent = word;
        // long song titles get a smaller stamp so it stays clear of the photo and the edges
        this.stamp.style.setProperty('--fit', Math.min(1, 13 / Math.max(1, word.length)).toFixed(3));
      }
    } else this.stamp.style.opacity = '0';
  }

  private animateUnits(v: LineView, t: number, f: FrameInput): void {
    const m = this.ctx.motion;
    const stagger = staggerFor(v, 50);
    const est = this.ctx.estimatedSweep && v.line.wordTiming !== 'exact' ? estimatedUnit(v, t, this.ctx.analysis.p80Sps) : -1;
    this.estTag.classList.toggle('on', this.ctx.estimatedSweep && v.line.wordTiming !== 'exact');
    for (const u of v.units) {
      const s = stateOf(v, u.index, t, stagger, est);
      setUnitState(u, s);
      const age = t - unitArrival(v, u.index, stagger);
      let tf = '';
      let shadow = '';
      if (s !== 'future' && m.transforms) {
        if (m.wordMotion && age < 260) {
          const k = easeOutCubic(age / 85);
          const sc = 1 + (1.38 - 1) * (1 - k) * m.amount;
          const rot = hashSigned(u.seed, 3) * 4 * (1 - k) * m.amount;
          tf = `scale(${sc.toFixed(4)}) rotate(${rot.toFixed(2)}deg)`;
        }
        // misregistration settling from 0.09em to 0.025em
        const mis = 0.025 + 0.065 * (1 - easeOutCubic(age / 240));
        shadow = `${mis.toFixed(3)}em ${(mis * 0.6).toFixed(3)}em 0 var(--red-ink)`;
        if (s === 'active') {
          const step = Math.floor(t / 125); // 8 fps "boil"
          const amp = 0.6 + m.jiggle * 1.6;
          const dx = hashSigned(u.seed, step) * 0.012 * amp;
          const dy = hashSigned(u.seed + 7, step) * 0.01 * amp;
          const rot = hashSigned(u.seed + 3, step) * 0.7 * amp + (m.jiggle > 0 ? Math.sin((t - u.word.startMs) / 70) * 2.2 * m.jiggle * Math.exp(-(t - u.word.startMs) / 500) : 0);
          const beat = f.beat && m.pulse ? 1 + f.beat.env * 0.03 : 1;
          tf = `${tf} translate(${dx.toFixed(3)}em,${dy.toFixed(3)}em) rotate(${rot.toFixed(2)}deg) scale(${beat.toFixed(4)})`;
        }
      } else if (s !== 'future') {
        shadow = '0.025em 0.015em 0 var(--red-ink)';
      }
      if (u.tf !== tf) {
        u.tf = tf;
        u.el.style.transform = tf;
      }
      if (u.extra !== shadow) {
        u.extra = shadow;
        u.el.style.textShadow = shadow;
      }
      const op = s !== 'future' && age < 40 && m.transforms ? clamp01(age / 40).toFixed(3) : '';
      if (u.op !== op) {
        u.op = op;
        u.el.style.opacity = op;
      }
    }
  }
}
