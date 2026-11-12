import type { LyricLine } from '../core/lyrics/model';
import type { FontSpec } from '../stage/layout';
import { clamp01, easeOutCubic, hashSigned, spring, wobble } from '../stage/motion';
import { Scene, buildLineView, el, estimatedUnit, fmtClock, layoutFlowInto, setLineStyle,
  setText, setUnitState, setUnitTransform, showView, staggerFor, stateOf, unitArrival, unitSize,
  type FrameInput, type LineView, type SceneContext } from '../stage/scene';
import { grainTexture } from '../stage/textures';

type Edition = 'afterhours' | 'riot' | 'prism';
export const COLLECTION_FONTS: Record<Edition, FontSpec> = {
  afterhours: { family: 'Fraunces Variable', weight: 420, style: 'italic', tracking: -0.025, lineHeight: 1.13 },
  riot: { family: 'Big Shoulders Display Variable', weight: 900, upper: true, tracking: 0.005, lineHeight: 1.04 },
  prism: { family: 'Archivo Variable', weight: 850, upper: true, tracking: -0.035, lineHeight: 1.02 },
};

/** Three art directions sharing the same timestamp-driven lyric lifecycle. */
export class CollectionScene extends Scene {
  protected readonly font: FontSpec;
  private readonly block: HTMLDivElement;
  private readonly next: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly artist: HTMLDivElement;
  private readonly count: HTMLDivElement;
  private readonly disc: HTMLDivElement;
  private readonly cover: HTMLImageElement;
  private readonly gap: HTMLDivElement;
  private readonly gapTime: HTMLDivElement;
  private readonly estimate: HTMLDivElement;
  private box = { w: 0, h: 0 };
  private lastLine = -2;

  constructor(host: HTMLElement, ctx: SceneContext, private readonly edition: Edition) {
    super(host, ctx, `collection ${edition}`);
    this.font = COLLECTION_FONTS[edition];
    el('div', 'co-field', this.root);
    el('div', 'co-orbit orbit-a', this.root);
    el('div', 'co-orbit orbit-b', this.root);
    this.disc = el('div', 'co-disc', this.root);
    this.cover = el('img', 'co-cover', this.disc); this.cover.alt = '';
    el('div', 'co-spindle', this.disc);
    el('div', 'co-tape tape-a', this.root, 'TURN IT UP / STAY A WHILE / TURN IT UP / STAY A WHILE');
    el('div', 'co-tape tape-b', this.root);
    const header = el('div', 'co-header', this.root);
    el('span', 'co-brand', header, edition === 'afterhours' ? 'AFTERHOURS' : edition === 'riot' ? 'RIOT / LIVE PRINT' : 'PRISM.');
    el('span', 'co-edition', header, edition === 'afterhours' ? 'THE LISTENING ROOM' : edition === 'riot' ? 'NO SKIPS. ALL FEELING.' : 'SOUND IN FULL COLOUR');
    this.title = el('div', 'co-title', this.root);
    this.artist = el('div', 'co-artist', this.root);
    this.count = el('div', 'co-count', this.root);
    this.block = el('div', 'co-block', this.root);
    const footer = el('div', 'co-footer', this.root);
    el('span', 'co-next-label', footer, 'UP NEXT');
    this.next = el('div', 'co-next', footer);
    el('div', 'co-barcode', this.root);
    const gap = el('div', 'co-gap', this.root);
    this.gap = el('div', 'co-gap-title', gap);
    this.gapTime = el('div', 'co-gap-time', gap);
    this.estimate = el('div', 'est-tag', this.root, '≈ estimated word timing');
    el('div', 'co-grain', this.root).style.backgroundImage = `url(${grainTexture(160, 0.12)})`;
    this.onContext(); this.onResize();
  }

  protected override onContext(): void {
    const art = this.ctx.artwork;
    this.root.classList.toggle('has-art', !!art);
    if (art && this.cover.getAttribute('src') !== art.url) this.cover.src = art.url;
    if (!art) this.cover.removeAttribute('src');
    this.root.dataset.context = this.ctx.context;
    this.root.dataset.reduced = String(!this.ctx.motion.transforms);
    // Riot keeps the artist as a vertical poster label; the others read "Title — Artist".
    const titleLine = this.edition === 'riot' ? this.ctx.title : [this.ctx.title, this.ctx.artist].filter(Boolean).join(' — ');
    setText(this.title, titleLine || 'A moment, on repeat.');
    setText(this.artist, this.ctx.artist ?? 'AFTERGLOW');
    this.lastLine = -2;
  }

  protected override onResize(): void {
    const compact = this.w / this.h < 1.12;
    this.root.dataset.compact = String(compact);
    this.root.style.setProperty('--u', `${unitSize(this.h, this.ctx.preview)}px`);
    this.root.style.setProperty('--h', `${this.h}px`);
    const width = this.w * (compact ? 0.85 : this.edition === 'afterhours' ? 0.66 : 0.79);
    this.box = { w: width, h: this.h * (this.edition === 'riot' ? 0.5 : 0.46) };
    this.block.style.cssText = `left:${this.w * 0.065}px;top:${this.h * 0.27}px;width:${width}px;height:${this.box.h}px`;
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, this.font, 'co-line');
    v.el.classList.toggle('is-hook', v.hook);
    this.block.appendChild(v.el); return v;
  }

  protected layoutView(v: LineView): void {
    const max = this.h * (this.edition === 'riot' ? 0.21 : this.edition === 'prism' ? 0.155 : 0.145);
    const fit = layoutFlowInto(v, this.space + (this.edition === 'prism' ? 0.07 : 0), this.box, { maxRows: 5, lineHeight: this.font.lineHeight,
      maxSize: max * this.ctx.textScale, minSize: this.ctx.preview ? 4 : 12 }, 'co-row');
    v.data.height = fit.height;
    v.el.style.top = `${Math.max(0, (this.box.h - fit.height) / 2)}px`;
    if (this.edition === 'riot') v.rows.forEach((r, i) => { r.style.marginLeft = `${i % 2 ? 0.18 : 0}em`; });
  }

  frame(f: FrameInput): void {
    const { t, cue } = f, li = cue.lineIndex, m = this.ctx.motion;
    const lines = this.ctx.doc.lines;
    const gapOn = !!cue.gap && (cue.gap.kind === 'intro' || t - cue.gap.startMs > 650);
    this.root.classList.toggle('in-gap', gapOn);
    const cur = li >= 0 ? this.view(li) : null;
    const prev = li >= 1 ? this.view(li - 1) : null;
    this.prune(li - 1, li + 1);
    for (const v of this.views.values()) {
      if (v !== cur && v !== prev) { showView(v, false); continue; }
      const active = v === cur;
      const age = t - (cur?.line.startMs ?? v.line.endMs);
      const enter = easeOutCubic(age / (this.edition === 'afterhours' ? 650 : 280));
      const exit = clamp01(age / 240);
      const opacity = gapOn ? 0 : active ? (m.transforms ? enter : 1) : 1 - exit;
      showView(v, opacity > 0.002);
      if (!v.shown) continue;
      const shift = m.transforms ? (active ? (1 - enter) * 24 : -exit * 30) * m.amount : 0;
      const angle = this.edition === 'riot' && m.transforms ? (active ? -0.8 * (1 - enter) : exit * -2) : 0;
      setLineStyle(v, `translate3d(0,${shift.toFixed(2)}px,0) rotate(${angle.toFixed(2)}deg)`, opacity.toFixed(3));
      const stagger = staggerFor(v, this.edition === 'afterhours' ? 80 : 40);
      const estimated = active && this.ctx.estimatedSweep && v.line.wordTiming !== 'exact' ? estimatedUnit(v, t, this.ctx.analysis.p80Sps) : -1;
      if (active) this.estimate.classList.toggle('on', this.ctx.estimatedSweep && v.line.wordTiming !== 'exact');
      for (const u of v.units) {
        const state = active ? stateOf(v, u.index, t, stagger, estimated) : 'past';
        setUnitState(u, state);
        let dy = 0, rot = 0, sc = 1;
        const elapsed = t - unitArrival(v, u.index, stagger);
        if (active && state !== 'future' && m.wordMotion && m.transforms) {
          const k = this.edition === 'riot' ? spring(elapsed, 11, 0.62) : easeOutCubic(elapsed / 480);
          dy = (1 - k) * 0.16 * m.amount;
          rot = (1 - k) * hashSigned(u.seed) * (this.edition === 'riot' ? 5 : 1.2) * m.amount;
          if (state === 'active' && m.jiggle) rot += wobble(elapsed, 5, 480) * 2.5 * m.jiggle;
        }
        if (state === 'active' && f.beat && m.pulse) sc += f.beat.env * 0.025;
        setUnitTransform(u, m.transforms ? `translate3d(0,${dy.toFixed(3)}em,0) rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(3)})` : '', '');
      }
    }
    if (li !== this.lastLine) {
      this.lastLine = li;
      setText(this.count, String(Math.max(1, li + 1)).padStart(2, '0'));
      setText(this.next, lines[li + 1]?.text ?? (li < 0 ? lines[0]?.text ?? '' : 'End of side.'));
    }
    const turn = this.edition === 'riot' ? -8 : m.transforms ? t / (this.edition === 'afterhours' ? 180 : 900) : 0;
    this.disc.style.transform = `rotate(${turn.toFixed(2)}deg)`;
    this.root.style.setProperty('--pulse', String(f.beat && m.pulse ? f.beat.env : 0));
    if (gapOn && cue.gap) {
      setText(this.gap, cue.gap.kind === 'intro' ? this.ctx.title ?? 'Side A' : cue.gap.kind === 'outro' ? 'End of side.' : 'Let it play.');
      setText(this.gapTime, Number.isFinite(cue.gap.endMs) ? `VOCALS IN ${fmtClock(cue.gap.endMs - t + 999)}` : this.ctx.artist ?? '');
    }
  }
}
