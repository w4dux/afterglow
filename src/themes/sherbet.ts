import type { LyricLine } from '../core/lyrics/model';
import type { FontSpec } from '../stage/layout';
import { clamp01, easeInCubic, easeOutBack, easeOutCubic, hashSigned, spring, wobble } from '../stage/motion';
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
  unitRects,
} from '../stage/scene';
import { relLuma } from '../stage/textures';

/**
 * SHERBET — pop.
 * Each phrase is a sticker card that pops onto a fresh colour field; the new colour
 * wipes out from the card in a circle. Words bounce in as they are sung and a
 * pill-shaped bubble hops from word to word. Hooks get a bigger, brighter card.
 */
const FONT: FontSpec = { family: 'Bricolage Grotesque Variable', weight: 800, tracking: -0.02, lineHeight: 1.02 };
const PALETTE = ['#ff3d7f', '#2f6bff', '#ffcf00', '#19e3b1', '#ff7a1a', '#b26bff', '#00c2ff'];
const ink = (bg: string) => (relLuma(bg) > 0.42 ? '#111' : '#fff');

export class SherbetScene extends Scene {
  protected readonly font = FONT;
  private fieldA!: HTMLDivElement;
  private fieldB!: HTMLDivElement;
  private blobs: HTMLDivElement[] = [];
  private stage!: HTMLDivElement;
  private nextCard!: HTMLDivElement;
  private gap!: HTMLDivElement;
  private gapClock!: HTMLDivElement;
  private gapDots: HTMLSpanElement[] = [];
  private tag!: HTMLDivElement;
  private estTag!: HTMLDivElement;
  private vars: Record<string, string> = {};
  private colors = PALETTE;
  private boxW = 0;
  private boxH = 0;
  private lastLine = -3;

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'sherbet');
    const r = this.root;
    this.fieldA = el('div', 'sb-field', r);
    this.fieldB = el('div', 'sb-field wipe', r);
    for (let i = 0; i < 4; i++) this.blobs.push(el('div', `sb-blob b${i}`, r));
    this.tag = el('div', 'sb-tag', r);
    this.stage = el('div', 'sb-stage', r);
    this.nextCard = el('div', 'sb-next', r);
    this.gap = el('div', 'sb-gap', r);
    const dots = el('div', 'sb-dots', this.gap);
    for (let i = 0; i < 3; i++) this.gapDots.push(el('span', '', dots));
    this.gapClock = el('div', 'sb-gap-clock', this.gap);
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    this.onContext();
    this.onResize();
  }

  protected override onContext(): void {
    const p = this.ctx.artwork?.palette;
    // put the artwork's vibrant colour first if it is lively enough
    this.colors = p && relLuma(p.vibrant) > 0.08 ? [p.vibrant, ...PALETTE.filter((c) => c !== p.vibrant)] : PALETTE;
    setText(this.tag, this.ctx.title ?? '');
    this.lastLine = -3;
  }

  protected override onResize(): void {
    this.boxW = Math.min(this.w * 0.8, this.h * 1.9);
    this.boxH = this.h * 0.42;
    this.stage.style.cssText = `left:${(this.w - this.boxW) / 2}px;top:${this.h * 0.47 - this.boxH / 2}px;width:${this.boxW}px;height:${this.boxH}px`;
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview)}px`);
  }

  private bgOf(i: number): string {
    return this.colors[(((i + 1) % this.colors.length) + this.colors.length) % this.colors.length];
  }
  private cardOf(i: number): string {
    const bg = this.bgOf(i);
    if (relLuma(bg) > 0.42) return '#111111';
    return i % 3 === 0 ? '#ffffff' : i % 3 === 1 ? '#fff4c2' : '#111111';
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, FONT, 'sb-card');
    const bubble = document.createElement('div');
    bubble.className = 'sb-bubble';
    v.el.prepend(bubble);
    v.data.bubble = bubble;
    const card = this.cardOf(line.index);
    v.el.style.setProperty('--card', card);
    v.el.style.setProperty('--ink', ink(card));
    v.el.style.setProperty('--hi', this.bgOf(line.index + 2));
    v.el.style.setProperty('--hi-ink', ink(this.bgOf(line.index + 2)));
    if (v.hook) v.el.classList.add('is-hook');
    this.stage.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const scale = v.hook ? 1.12 : 1;
    const maxSize = Math.min(this.h * 0.14, this.w * 0.09) * scale * this.ctx.textScale;
    const padX = Math.max(14, this.boxH * 0.08);
    const r = layoutFlowInto(v, this.space, { w: this.boxW - padX * 2, h: this.boxH * 0.86 }, { maxRows: 3, lineHeight: FONT.lineHeight, maxSize, minSize: Math.max(13, this.h * 0.03) }, 'sb-row');
    const cardW = Math.min(this.boxW, r.widthPx + padX * 2.2);
    const cardH = r.height + padX * 1.4;
    v.el.style.cssText += `;width:${cardW}px;height:${cardH}px;left:${(this.boxW - cardW) / 2}px;top:${(this.boxH - cardH) / 2}px;padding:${padX * 0.7}px ${padX * 1.1}px;font-size:${r.size}px`;
    v.data.pad = padX;
  }

  frame(f: FrameInput): void {
    const { t, cue } = f;
    const m = this.ctx.motion;
    const li = cue.lineIndex;
    const lines = this.ctx.doc.lines;
    const gap = cue.gap;
    const gapOn = !!gap && (gap.kind === 'intro' || t - gap.startMs > 700);

    // ---- colour field with circular wipe at each line start
    const fromC = this.bgOf(li - 1);
    const toC = this.bgOf(li);
    const wipeAge = li >= 0 ? t - lines[li].startMs : 1e9;
    const wk = m.transforms ? easeOutCubic(wipeAge / 520) : clamp01(wipeAge / 200);
    const aColor = wk >= 1 ? toC : fromC;
    if (this.vars['a'] !== aColor) {
      this.vars['a'] = aColor;
      this.fieldA.style.background = aColor;
    }
    if (this.vars['b'] !== toC) {
      this.vars['b'] = toC;
      this.fieldB.style.background = toC;
    }
    const clip = wk >= 1 ? 'circle(0% at 50% 47%)' : `circle(${(wk * 120).toFixed(2)}% at 50% 47%)`;
    if (this.vars['clip'] !== clip) {
      this.vars['clip'] = clip;
      this.fieldB.style.clipPath = clip;
    }

    // ---- floating blobs (playback time, freeze on pause)
    if (m.transforms) {
      const s = t / 1000;
      this.blobs.forEach((b, i) => {
        const a = s * (0.22 + i * 0.05) + i * 1.7;
        const beat = f.beat && m.pulse ? 1 + f.beat.env * 0.05 : 1;
        b.style.transform = `translate3d(${(Math.cos(a) * 3).toFixed(2)}vw,${(Math.sin(a * 1.2) * 4).toFixed(2)}vh,0) scale(${beat.toFixed(4)})`;
      });
    }
    if (li !== this.lastLine) {
      this.lastLine = li;
      this.blobs.forEach((b, i) => (b.style.background = this.bgOf(li + 2 + i)));
      const nl = lines[li + 1] ?? (li < 0 ? lines[0] : undefined);
      setText(this.nextCard, nl ? nl.text : '');
      this.nextCard.style.setProperty('--card', this.cardOf((li < 0 ? 0 : li + 1)));
      this.nextCard.style.setProperty('--ink', ink(this.cardOf(li < 0 ? 0 : li + 1)));
    }

    // ---- cards
    const cur = li >= 0 ? this.view(li) : null;
    const prevV = li >= 1 ? this.view(li - 1) : null;
    this.prune(li - 1, li + 1);
    for (const v of this.views.values()) if (v !== cur && v !== prevV) showView(v, false);
    if (cur) {
      const age = t - cur.line.startMs;
      const side = cur.line.index % 2 ? 1 : -1;
      let op = 1;
      let tf: string;
      if (m.transforms) {
        const p = spring(age, 4.2, 0.5);
        const rot = side * (2.2 + (1 - p) * 9 * m.amount);
        const sc = 0.82 + 0.18 * p;
        let ty = (1 - p) * this.h * 0.05 * m.amount;
        if (gap && gap.kind !== 'intro') {
          const g = easeInCubic(clamp01((t - gap.startMs - 250) / 450));
          op = 1 - g;
          ty -= g * this.h * 0.1;
        }
        tf = `translate3d(0,${ty.toFixed(1)}px,0) rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(4)})`;
      } else {
        tf = `rotate(${side * 2}deg)`;
        op = clamp01(age / 160) * (gap && gap.kind !== 'intro' ? 1 - clamp01((t - gap.startMs - 250) / 300) : 1);
      }
      showView(cur, op > 0.002);
      setLineStyle(cur, tf, op.toFixed(3));
      this.animateUnits(cur, t, f);
    }
    if (prevV) {
      const k = clamp01((t - (cur ? cur.line.startMs : prevV.line.endMs)) / 340);
      if (k >= 1 || leftDuringGap(prevV, cur)) showView(prevV, false);
      else {
        showView(prevV, true);
        const side = prevV.line.index % 2 ? 1 : -1;
        const e = easeInCubic(k);
        setLineStyle(
          prevV,
          m.transforms ? `translate3d(${(side * -e * this.w * 0.5).toFixed(1)}px,${(-e * this.h * 0.35).toFixed(1)}px,0) rotate(${(side * (2.2 + e * 24)).toFixed(2)}deg) scale(${(1 - e * 0.3).toFixed(4)})` : '',
          (1 - (m.transforms ? k * k : k)).toFixed(3),
        );
        (prevV.data.bubble as HTMLElement).style.opacity = '0';
      }
    }

    // ---- next card peek
    const showNext = this.ctx.context === 'full' && !gapOn && lines.length > 0 && li + 1 < lines.length;
    const nextAppear = cur ? clamp01((t - cur.line.startMs - 300) / 400) : 1;
    this.nextCard.style.opacity = showNext ? (nextAppear * 0.92).toFixed(3) : '0';

    // ---- gap
    this.root.classList.toggle('in-gap', gapOn);
    if (gapOn && gap) {
      this.gap.style.opacity = (gap.kind === 'intro' ? 1 : clamp01((t - gap.startMs - 700) / 400)).toFixed(3);
      setText(this.gapClock, Number.isFinite(gap.endMs) ? `back in ${fmtClock(gap.endMs - t + 999)}` : 'that’s a wrap');
      this.gapDots.forEach((d, i) => {
        const y = m.transforms ? Math.abs(Math.sin(t / 260 + i * 0.7)) * -0.6 : 0;
        d.style.transform = `translate3d(0,${y.toFixed(3)}em,0)`;
      });
    } else this.gap.style.opacity = '0';
  }

  private animateUnits(v: LineView, t: number, f: FrameInput): void {
    const m = this.ctx.motion;
    const stagger = staggerFor(v, 40);
    const est = this.ctx.estimatedSweep && v.line.wordTiming !== 'exact' ? estimatedUnit(v, t, this.ctx.analysis.p80Sps) : -1;
    this.estTag.classList.toggle('on', this.ctx.estimatedSweep && v.line.wordTiming !== 'exact');
    let active = -1;
    for (const u of v.units) {
      const s = stateOf(v, u.index, t, stagger, est);
      setUnitState(u, s);
      if (s === 'active') active = u.index;
      if (!m.transforms || s === 'future' || !m.wordMotion) {
        setUnitTransform(u, '', '');
        continue;
      }
      const age = t - unitArrival(v, u.index, stagger);
      let sc = age < 600 ? 0.55 + 0.45 * spring(age, v.fast ? 9 : 6.5, 0.42) : 1;
      let rot = age < 600 ? hashSigned(u.seed) * 8 * (1 - spring(age, 6.5, 0.6)) : 0;
      let ty = 0;
      if (m.jiggle > 0 && s === 'active') {
        const a = t - u.word.startMs;
        rot += wobble(a, 5, 380) * 6 * m.jiggle;
        ty = -Math.abs(wobble(a, 5, 260)) * 0.12 * m.jiggle;
      }
      if (s === 'active' && f.beat && m.pulse) sc *= 1 + f.beat.env * 0.04;
      sc = 1 + (sc - 1) * m.amount;
      rot *= m.amount;
      setUnitTransform(u, sc !== 1 || rot || ty ? `translate3d(0,${ty.toFixed(3)}em,0) rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(4)})` : '', '');
    }
    // bubble hops from the previous word to the active one (pure function of time)
    const bubble = v.data.bubble as HTMLElement;
    const rects = unitRects(v);
    if (active >= 0 && rects[active]) {
      const r = rects[active];
      const from = rects[active - 1] ?? r;
      const age = t - v.line.words[active].startMs;
      const k = m.transforms ? easeOutBack(clamp01(age / 150), 1.4) : 1;
      const x = from.x + (r.x - from.x) * k;
      const y = from.y + (r.y - from.y) * k;
      const w = from.w + (r.w - from.w) * k;
      const pad = r.h * 0.12;
      bubble.style.cssText = `opacity:1;transform:translate3d(${(x - pad).toFixed(1)}px,${(y + r.h * 0.06).toFixed(1)}px,0);width:${(w + pad * 2).toFixed(1)}px;height:${(r.h * 0.94).toFixed(1)}px`;
    } else bubble.style.opacity = '0';
  }
}
