import type { LyricLine } from '../core/lyrics/model';
import { type FontSpec, displayText, measureEm } from '../stage/layout';
import { clamp01, easeInCubic, easeOutCubic, hash01, hashSigned } from '../stage/motion';
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
  showView,
  staggerFor,
  stateOf,
  unitArrival,
  unitSize,
} from '../stage/scene';
import { grainTexture, halftone, paperTexture } from '../stage/textures';

/**
 * ZINE: punk / DIY. A cut-and-paste fanzine page, Feedback's younger sibling. Every word
 * is a scrap cut from a different magazine (its own typeface and paper) and is slapped
 * down and glued when it is sung; unsung words wait as pencilled "cut here" outlines.
 * The word being sung is on fluorescent pink paper and boils at 8 fps, like Feedback.
 * Photocopy grain, staples, tape, and the artwork as a cut-out-and-keep coupon.
 * All motion comes from lyric time; with reduced motion the scraps sit still.
 */

/** A cut-out typeface: `scale` is its size relative to the row, so mixed faces look even. */
interface Cut extends FontSpec {
  scale: number;
}
export const ZINE_CUTS: Cut[] = [
  { family: 'Anton', weight: 400, upper: true, lineHeight: 1.1, scale: 1 },
  { family: 'Fraunces Variable', weight: 900, style: 'italic', lineHeight: 1.1, scale: 0.9 },
  { family: 'JetBrains Mono Variable', weight: 800, upper: true, lineHeight: 1.1, scale: 0.74 },
  { family: 'Archivo Variable', weight: 850, upper: true, lineHeight: 1.1, scale: 0.84 },
  { family: 'Instrument Serif', weight: 400, lineHeight: 1.1, scale: 1.1 },
  { family: 'Big Shoulders Display Variable', weight: 900, upper: true, lineHeight: 1.1, scale: 1.06 },
];
/** Row font (spaces between words) and the layout line height, which leaves room for tilted scraps. */
export const ZINE_FONT: FontSpec = { family: 'Anton', weight: 400, lineHeight: 1.3 };
/** Paper padding on each side of a scrap, in the scrap's own em. */
const PAD = 0.13;
const PAPERS = 4;

/** A jagged scissor-cut outline, fixed per word. */
function scissorCut(seed: number): string {
  const j = (k: number, amp: number) => (hash01(seed, k) * amp).toFixed(1);
  return `polygon(${j(1, 3)}% ${j(2, 7)}%, 38% ${j(3, 5)}%, ${(100 - +j(4, 3)).toFixed(1)}% ${j(5, 8)}%, ${(100 - +j(6, 2)).toFixed(1)}% 52%, ${(100 - +j(7, 3)).toFixed(1)}% ${(100 - +j(8, 7)).toFixed(1)}%, 61% ${(100 - +j(9, 4)).toFixed(1)}%, ${j(10, 3)}% ${(100 - +j(11, 8)).toFixed(1)}%, ${j(12, 2)}% 47%)`;
}

/** Pick a value 0..n-1 from the seed that differs from the previous one. */
function pick(seed: number, salt: number, n: number, prev: number): number {
  let k = Math.floor(hash01(seed, salt) * n) % n;
  if (k === prev) k = (k + 1) % n;
  return k;
}

export class ZineScene extends Scene {
  protected readonly font = ZINE_FONT;
  private readonly block: HTMLDivElement;
  private readonly next: HTMLDivElement;
  private readonly strip: HTMLDivElement;
  private readonly page: HTMLDivElement;
  private readonly coupon: HTMLDivElement;
  private readonly couponImg: HTMLImageElement;
  private readonly couponTitle: HTMLDivElement;
  private readonly gap: HTMLDivElement;
  private readonly gapWord: HTMLDivElement;
  private readonly gapClock: HTMLDivElement;
  private readonly estTag: HTMLDivElement;
  private box = { w: 0, h: 0 };
  private lastLine = -2;
  private gapText = '';

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'zine');
    const r = this.root;
    el('div', 'zn-paper', r).style.backgroundImage = `url(${paperTexture()})`;
    el('div', 'zn-copier', r);
    el('div', 'zn-staple s1', r);
    el('div', 'zn-staple s2', r);
    const mast = el('div', 'zn-mast', r);
    el('span', 'zn-mast-name', mast, 'AFTERGLOW');
    el('span', 'zn-mast-sub', mast, 'ZINE · FREE · TAKE ONE');
    this.strip = el('div', 'zn-strip', r);
    this.coupon = el('div', 'zn-coupon', r);
    const pic = el('div', 'zn-coupon-pic', this.coupon);
    this.couponImg = el('img', '', pic);
    this.couponImg.alt = '';
    el('div', 'zn-coupon-screen', pic).style.backgroundImage = `url(${halftone(4, '#e9e6df')})`;
    this.couponTitle = el('div', 'zn-coupon-title', pic);
    el('div', 'zn-coupon-cut', this.coupon, '✂  CUT OUT & KEEP');
    el('div', 'zn-tape', this.coupon);
    this.block = el('div', 'zn-block', r);
    this.next = el('div', 'zn-next', r);
    this.page = el('div', 'zn-page', r);
    const gap = el('div', 'zn-gap', r);
    this.gapWord = el('div', 'zn-gap-word', gap);
    this.gapClock = el('div', 'zn-gap-clock', gap);
    this.gap = gap;
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    el('div', 'zn-grain', r).style.backgroundImage = `url(${grainTexture(160, 0.28)})`;
    this.onContext();
    this.onResize();
  }

  protected override onContext(): void {
    const a = this.ctx.artwork;
    this.root.classList.toggle('has-art', !!a);
    if (a && this.couponImg.getAttribute('src') !== a.url) this.couponImg.src = a.url;
    if (!a) this.couponImg.removeAttribute('src');
    this.root.dataset.context = this.ctx.context;
    setText(this.strip, [this.ctx.title, this.ctx.artist].filter(Boolean).join('  /  ') || 'Afterglow');
    setText(this.couponTitle, this.ctx.title ?? 'Side A');
    this.lastLine = -2;
    this.gapText = '';
  }

  protected override onResize(): void {
    const coupon = this.w > 820 && this.w / this.h > 1.15;
    this.root.classList.toggle('with-coupon', coupon);
    this.box = { w: this.w * (coupon ? 0.62 : 0.86), h: this.h * (this.h < 420 ? 0.5 : 0.48) };
    this.block.style.cssText = `left:${this.w * 0.07}px;top:${this.h * 0.51 - this.box.h / 2}px;width:${this.box.w}px;height:${this.box.h}px`;
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview)}px`);
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, ZINE_FONT, 'zn-line');
    if (v.hook) v.el.classList.add('is-hook');
    // each word: its own typeface and paper, never the same as the word before
    let lastCut = -1;
    let lastPaper = -1;
    const widths = v.units.map((u) => {
      const c = pick(u.seed, 1, ZINE_CUTS.length, lastCut);
      const p = pick(u.seed, 2, PAPERS, lastPaper);
      lastCut = c;
      lastPaper = p;
      const cut = ZINE_CUTS[c];
      u.el.textContent = displayText(u.word.text, cut);
      u.el.classList.add(`c${c}`, `p${p}`);
      u.el.style.clipPath = scissorCut(u.seed);
      return (measureEm(u.word.text, cut) + PAD * 2) * cut.scale * (u.word.bg ? 0.62 : 1);
    });
    v.groupWidthsEm = v.groups.map(([a, b]) => {
      let w = 0;
      for (let i = a; i < b; i++) w += widths[i];
      return w;
    });
    this.block.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const maxSize = Math.min(this.h * 0.17, this.w * 0.12) * this.ctx.textScale * (v.hook ? 1.06 : 1);
    const r = layoutFlowInto(v, this.space + 0.14, { w: this.box.w * 0.95, h: this.box.h }, { maxRows: 4, lineHeight: ZINE_FONT.lineHeight, maxSize, minSize: this.ctx.preview ? 4 : Math.max(14, this.h * 0.04) }, 'zn-row');
    v.el.style.top = `${(this.box.h - r.height) / 2}px`;
    // pasted-up rows never line up exactly
    v.rows.forEach((row, i) => {
      row.style.marginLeft = `${((i % 2 ? 0.28 : 0) + hashSigned(v.line.index, i + 5) * 0.1).toFixed(3)}em`;
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
    const prev = li >= 1 ? this.view(li - 1) : null;
    this.prune(li - 1, li + 1);
    for (const v of this.views.values()) if (v !== cur && v !== prev) showView(v, false);

    if (cur) {
      let op = 1;
      if (gap && gap.kind !== 'intro') op = 1 - clamp01((t - gap.startMs - 200) / 350);
      if (!m.transforms) op *= clamp01((t - cur.line.startMs) / 100);
      showView(cur, op > 0.002);
      setLineStyle(cur, `rotate(${(-1.6 + (cur.line.index % 3) * 0.9).toFixed(1)}deg)`, op.toFixed(3));
      this.units(cur, t, f);
    }
    if (prev) {
      // ripped off the page: lifts, twists and falls away in 170 ms
      const k = clamp01((t - (cur ? cur.line.startMs : prev.line.endMs)) / 170);
      if (k >= 1 || leftDuringGap(prev, cur)) showView(prev, false);
      else {
        showView(prev, true);
        const e = easeInCubic(k);
        const base = -1.6 + (prev.line.index % 3) * 0.9;
        setLineStyle(prev, m.transforms ? `translate3d(${(e * this.w * 0.04).toFixed(1)}px,${(e * this.h * 0.32).toFixed(1)}px,0) rotate(${(base + e * 12).toFixed(2)}deg)` : `rotate(${base.toFixed(1)}deg)`, ((1 - k) * (1 - k)).toFixed(3));
        for (const u of prev.units) setUnitState(u, 'past');
      }
    }

    if (li !== this.lastLine) {
      this.lastLine = li;
      const nl = lines[li + 1] ?? (li < 0 ? lines[0] : undefined);
      setText(this.next, nl ? `next → ${nl.text}` : '');
      setText(this.page, `p.${String(Math.max(1, li + 1)).padStart(2, '0')}`);
    }
    this.root.classList.toggle('hide-next', this.ctx.context !== 'full' || gapOn);
    this.root.classList.toggle('in-gap', gapOn);
    if (gapOn && gap) {
      const word = gap.kind === 'intro' ? this.ctx.title ?? 'Side A' : gap.kind === 'outro' ? 'The end' : 'No words, just noise';
      if (word !== this.gapText) this.ransom(word);
      const k = gap.kind === 'intro' ? 1 : clamp01((t - gap.startMs - 600) / 140);
      const sc = m.transforms ? 1.2 - 0.2 * easeOutCubic(k) : 1;
      this.gap.style.opacity = k.toFixed(3);
      this.gap.style.transform = `translate(-50%,-50%) rotate(-4deg) scale(${sc.toFixed(4)})`;
      setText(this.gapClock, Number.isFinite(gap.endMs) ? `back in ${fmtClock(gap.endMs - t + 999)}` : 'end of side');
    } else this.gap.style.opacity = '0';
  }

  private units(v: LineView, t: number, f: FrameInput): void {
    const m = this.ctx.motion;
    const stagger = staggerFor(v, 55);
    const exact = v.line.wordTiming === 'exact';
    const est = this.ctx.estimatedSweep && !exact ? estimatedUnit(v, t, this.ctx.analysis.p80Sps) : -1;
    this.estTag.classList.toggle('on', this.ctx.estimatedSweep && !exact);
    for (const u of v.units) {
      const s = stateOf(v, u.index, t, stagger, est);
      setUnitState(u, s);
      // where the scrap was glued: a fixed tilt and a little vertical wander
      const tilt = hashSigned(u.seed, 4) * 3.2;
      const lift = hashSigned(u.seed, 5) * 0.04;
      let tf = `translate(0,${lift.toFixed(3)}em) rotate(${tilt.toFixed(2)}deg)`;
      if (s !== 'future' && m.transforms) {
        const age = t - unitArrival(v, u.index, stagger);
        if (m.wordMotion && age < 240) {
          // slapped down: big and twisted, lands in about 110 ms
          const k = easeOutCubic(age / 110);
          const sc = 1 + 0.45 * (1 - k) * m.amount;
          const twist = tilt + hashSigned(u.seed, 6) * 16 * (1 - k) * m.amount;
          tf = `translate(0,${(lift - 0.22 * (1 - k) * m.amount).toFixed(3)}em) rotate(${twist.toFixed(2)}deg) scale(${sc.toFixed(4)})`;
        } else if (s === 'active') {
          const step = Math.floor(t / 125); // 8 fps "boil", like Feedback
          const amp = 0.6 + m.jiggle * 1.6;
          const dx = hashSigned(u.seed, step) * 0.014 * amp;
          const dy = hashSigned(u.seed + 7, step) * 0.012 * amp;
          const rot = tilt + hashSigned(u.seed + 3, step) * 0.9 * amp;
          const beat = f.beat && m.pulse ? 1 + f.beat.env * 0.03 : 1;
          tf = `translate(${dx.toFixed(3)}em,${(lift + dy).toFixed(3)}em) rotate(${rot.toFixed(2)}deg) scale(${beat.toFixed(4)})`;
        }
      }
      setUnitTransform(u, tf, '');
    }
  }

  /** The gap card in ransom-note letters, one cut-out per letter. */
  private ransom(text: string): void {
    this.gapText = text;
    this.gapWord.textContent = '';
    let lastCut = -1;
    let lastPaper = -1;
    let word: HTMLSpanElement | null = null;
    [...text].forEach((ch, i) => {
      if (ch === ' ') {
        this.gapWord.appendChild(document.createTextNode(' '));
        word = null;
        return;
      }
      // letters of one word stay together when the card wraps
      if (!word) word = el('span', 'zn-word', this.gapWord);
      const seed = 9001 + i * 37 + text.length;
      const c = pick(seed, 1, ZINE_CUTS.length, lastCut);
      const p = pick(seed, 2, PAPERS, lastPaper);
      lastCut = c;
      lastPaper = p;
      const s = el('span', `zn-letter c${c} p${p}`, word, displayText(ch, ZINE_CUTS[c]));
      s.style.transform = `rotate(${(hashSigned(seed, 4) * 7).toFixed(1)}deg)`;
      s.style.clipPath = scissorCut(seed);
    });
  }
}
