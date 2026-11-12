import type { LyricLine } from '../core/lyrics/model';
import { type FontSpec, displayText, fitStack, measureEm } from '../stage/layout';
import { clamp01, easeInCubic, easeOutCubic, easeOutExpo, hashSigned, spring, wobble } from '../stage/motion';
import {
  type FrameInput,
  type LineView,
  Scene,
  type SceneContext,
  applyRows,
  buildLineView,
  el,
  estimatedUnit,
  fmtClock,
  leftDuringGap,
  setText,
  setUnitState,
  setUnitTransform,
  setVar,
  staggerFor,
  stateOf,
  unitArrival,
} from '../stage/scene';
import { grainTexture, halftone } from '../stage/textures';

/**
 * CYPHER — rap / hip-hop.
 * Editorial poster stack: every row of the current bar is scaled to the full width.
 * Words punch in exactly when they are rapped (spring with a small overshoot and a
 * seeded tilt), upcoming words wait as outlines so you can read ahead, the active
 * word takes the accent. Hooks (repeated lines) get a signal-yellow block.
 */
const FONT: FontSpec = { family: 'Anton', weight: 400, upper: true, tracking: 0.005, lineHeight: 0.93 };
const MONO: FontSpec = { family: 'JetBrains Mono Variable', weight: 600, upper: true, tracking: 0.08, lineHeight: 1.3 };
const MAX_GROUPS_PER_PAGE = 9;

export class CypherScene extends Scene {
  protected readonly font = FONT;
  private art!: HTMLDivElement;
  private artImg!: HTMLImageElement;
  private num!: HTMLDivElement;
  private hookBar!: HTMLDivElement;
  private meta!: HTMLDivElement;
  private metaLeft!: HTMLSpanElement;
  private metaCount!: HTMLSpanElement;
  private metaTag!: HTMLSpanElement;
  private pulseDot!: HTMLSpanElement;
  private stage!: HTMLDivElement;
  private prev!: HTMLDivElement;
  private next!: HTMLDivElement;
  private nextText!: HTMLSpanElement;
  private gap!: HTMLDivElement;
  private gapTitle!: HTMLDivElement;
  private gapBar!: HTMLDivElement;
  private gapClock!: HTMLDivElement;
  private estTag!: HTMLDivElement;
  private vars: Record<string, string> = {};
  private box = { x: 0, y: 0, w: 0, h: 0 };
  private lastLine = -2;

  constructor(host: HTMLElement, ctx: SceneContext) {
    super(host, ctx, 'cypher');
    const r = this.root;
    this.art = el('div', 'cy-art', r);
    this.artImg = el('img', 'cy-art-img', this.art);
    this.artImg.alt = '';
    el('div', 'cy-art-screen', this.art).style.backgroundImage = `url(${halftone(6, '#000')})`;
    this.num = el('div', 'cy-num', r);
    this.hookBar = el('div', 'cy-hookbar', r);
    this.meta = el('div', 'cy-meta', r);
    this.pulseDot = el('span', 'cy-dot', this.meta);
    this.metaLeft = el('span', 'cy-meta-title', this.meta);
    el('span', 'cy-meta-fill', this.meta);
    this.metaTag = el('span', 'cy-meta-tag', this.meta);
    this.metaCount = el('span', 'cy-meta-count', this.meta);
    this.prev = el('div', 'cy-prev', r);
    this.stage = el('div', 'cy-stage', r);
    this.next = el('div', 'cy-next', r);
    el('span', 'cy-next-label', this.next, 'Next');
    this.nextText = el('span', 'cy-next-text', this.next);
    this.gap = el('div', 'cy-gap', r);
    this.gapTitle = el('div', 'cy-gap-title', this.gap);
    const bar = el('div', 'cy-gap-track', this.gap);
    this.gapBar = el('div', 'cy-gap-fill', bar);
    this.gapClock = el('div', 'cy-gap-clock', this.gap);
    this.estTag = el('div', 'est-tag', r, '≈ estimated word timing');
    el('div', 'cy-grain', r).style.backgroundImage = `url(${grainTexture()})`;
    this.onContext();
    this.onResize();
  }

  protected override onContext(): void {
    const a = this.ctx.artwork;
    this.root.classList.toggle('has-art', !!a);
    if (a && this.artImg.src !== a.url) this.artImg.src = a.url;
    this.root.dataset.context = this.ctx.context;
    setText(this.metaLeft, [this.ctx.title, this.ctx.artist].filter(Boolean).join(' — ') || 'Afterglow');
    this.lastLine = -2;
  }

  protected override onResize(): void {
    const pad = Math.max(20, Math.min(this.w, this.h) * 0.06);
    const artW = this.ctx.artwork ? 0.1 : 0;
    const w = this.w * (0.9 - artW) - pad;
    const top = this.h * (this.h < 420 ? 0.16 : 0.19);
    const h = this.h * (this.ctx.context === 'off' ? 0.7 : 0.6);
    this.box = { x: pad, y: top, w, h };
    const meta = this.ctx.preview ? Math.max(5, this.h * 0.03) : Math.max(10, Math.min(15, this.h * 0.018));
    this.root.style.setProperty('--pad', `${pad}px`);
    this.root.style.setProperty('--meta', `${meta}px`);
    this.prev.style.top = `${Math.max(0, top - meta * 1.25 * 1.3 - this.h * 0.025)}px`;
    this.stage.style.cssText = `left:${pad}px;top:${top}px;width:${w}px;height:${h}px`;
    this.layoutGap();
    this.lastLine = -2;
  }

  protected createView(line: LyricLine): LineView {
    const v = buildLineView(line, this.ctx.analysis, FONT, 'cy-line');
    // Very long word-timed lines are paged so the type stays big.
    const pages: [number, number][] = [];
    const n = v.groups.length;
    if (line.wordTiming === 'exact' && n > MAX_GROUPS_PER_PAGE) {
      const count = Math.ceil(n / MAX_GROUPS_PER_PAGE);
      const per = Math.ceil(n / count);
      for (let p = 0; p < n; p += per) pages.push([p, Math.min(n, p + per)]);
    } else pages.push([0, n]);
    v.data.pages = pages;
    v.data.page = 0;
    if (v.hook) v.el.classList.add('is-hook');
    this.stage.appendChild(v.el);
    return v;
  }

  protected layoutView(v: LineView): void {
    const page: [number, number] = v.data.pages[v.data.page];
    const widths = v.groupWidthsEm.slice(page[0], page[1]);
    const short = this.h < 420;
    const fit = fitStack(widths, this.space, { w: this.box.w, h: this.box.h }, {
      maxRows: v.line.wordTiming === 'exact' ? 4 : 6,
      lineHeight: FONT.lineHeight,
      maxSize: this.box.h * (short ? 0.62 : 0.52) * this.ctx.textScale,
      maxRatio: 2.3,
    });
    const rows = fit.rows.map(([a, b]) => [a + page[0], b + page[0]] as [number, number]);
    // hide groups outside the page
    v.groupEls.forEach((g, i) => (g.style.display = i >= page[0] && i < page[1] ? '' : 'none'));
    applyRows(v, rows, fit.sizes.map((s) => s * 0.985), 'cy-row');
    v.data.height = fit.totalHeight;
    v.data.sizes = fit.sizes;
    v.data.rowOfGroup = new Map<number, number>();
    rows.forEach(([a, b], ri) => {
      for (let g = a; g < b; g++) v.data.rowOfGroup.set(g, ri);
    });
    v.el.style.top = `${Math.max(0, (this.box.h - fit.totalHeight) * 0.5)}px`;
  }

  private layoutGap(): void {
    const size = Math.min(this.box.h * 0.32, this.box.w / Math.max(4, measureEm('INSTRUMENTAL', FONT)));
    this.gapTitle.style.fontSize = `${size}px`;
    this.gap.style.cssText = `left:${this.box.x}px;top:${this.box.y + this.box.h * 0.5 - size * 0.7}px;width:${this.box.w}px`;
  }

  frame(f: FrameInput): void {
    const { t, cue } = f;
    const lines = this.ctx.doc.lines;
    const li = cue.lineIndex;
    const m = this.ctx.motion;
    const gap = cue.gap;
    const showGap = !!gap && (gap.kind !== 'instrumental' || t - gap.startMs > 650) && (gap.kind !== 'intro' || true);

    // --- lines on stage: current + previous during its exit
    const cur = li >= 0 ? this.view(li) : null;
    const prevV = li >= 1 ? this.view(li - 1) : null;
    this.prune(li - 1, li + 1);
    if (li + 1 < lines.length) this.view(li + 1);

    for (const v of this.views.values()) {
      if (v !== cur && v !== prevV && v.shown) {
        v.shown = false;
        v.el.style.visibility = 'hidden';
      }
    }

    const amount = m.amount;
    const H = this.box.h;

    if (cur) {
      // page selection for long lines (follows the arrived words)
      if (cur.data.pages.length > 1) {
        let p = 0;
        const arrived = cue.arrivedCount;
        cur.data.pages.forEach(([a]: [number, number], pi: number) => {
          const firstUnit = cur.groups[a][0];
          if (arrived > firstUnit) p = pi;
        });
        if (p !== cur.data.page) {
          cur.data.page = p;
          this.layoutView(cur);
        }
      }
      const age = t - cur.line.startMs;
      // fade the held line out once an instrumental gap really starts
      let lineOp = 1;
      let lineY = 0;
      if (gap && gap.kind !== 'intro') {
        const g = clamp01((t - gap.startMs - 250) / 400);
        lineOp = 1 - g;
        lineY = -g * H * 0.04 * amount;
      }
      if (!cur.shown) {
        cur.shown = true;
        cur.el.style.visibility = 'visible';
      }
      const enter = m.transforms ? easeOutExpo(age / 160) : 1;
      setStyleCached(cur, `translate3d(0,${((1 - enter) * H * 0.05 * amount + lineY).toFixed(1)}px,0)`, (lineOp * (m.transforms ? 1 : clamp01(age / 120))).toFixed(3));
      this.animateUnits(cur, t, f);
    }

    if (prevV) {
      const exitAge = t - (cur ? cur.line.startMs : prevV.line.endMs);
      const k = clamp01(exitAge / 190);
      if (k >= 1 || exitAge < 0 || leftDuringGap(prevV, cur)) {
        if (prevV.shown) {
          prevV.shown = false;
          prevV.el.style.visibility = 'hidden';
        }
      } else {
        if (!prevV.shown) {
          prevV.shown = true;
          prevV.el.style.visibility = 'visible';
        }
        const e = easeInCubic(k);
        setStyleCached(prevV, m.transforms ? `translate3d(0,${(-e * H * 0.12 * amount).toFixed(1)}px,0) scale(${(1 - e * 0.06 * amount).toFixed(4)})` : 'none', (1 - easeOutCubic(k)).toFixed(3));
        // make sure the exiting line shows fully sung
        for (const u of prevV.units) {
          setUnitState(u, prevV.line.wordTiming === 'exact' ? 'past' : 'arrived');
          setUnitTransform(u, '', '');
        }
      }
    }

    // --- hook block
    if (cur && cur.hook && !showGap) {
      const age = t - cur.line.startMs;
      const k = m.transforms ? easeOutExpo(age / 260) : clamp01(age / 200);
      const top = this.box.y + parseFloat(cur.el.style.top || '0') - H * 0.03;
      const height = (cur.data.height as number) + H * 0.06;
      const pulse = f.beat && m.pulse ? 1 + f.beat.env * 0.012 : 1;
      this.hookBar.style.cssText = `top:${top}px;height:${height}px;transform:scaleX(${k.toFixed(4)}) scaleY(${pulse.toFixed(4)});opacity:1`;
    } else if (this.hookBar.style.opacity !== '0') {
      this.hookBar.style.opacity = '0';
    }

    // --- context
    const ctxMode = this.ctx.context;
    if (li !== this.lastLine) {
      this.lastLine = li;
      const pl = li >= 1 ? lines[li - 1] : null;
      setText(this.prev, pl ? displayText(pl.text, MONO) : '');
      const nl = lines[li + 1] ?? (li < 0 ? lines[0] : null);
      setText(this.nextText, nl ? nl.text : '');
      this.next.style.visibility = nl ? 'visible' : 'hidden';
      setText(this.metaCount, li >= 0 ? `${String(li + 1).padStart(3, '0')} / ${String(lines.length).padStart(3, '0')}` : `000 / ${String(lines.length).padStart(3, '0')}`);
      setText(this.num, li >= 0 ? String(li + 1).padStart(2, '0') : '00');
    }
    const tag = showGap ? (gap!.kind === 'intro' ? 'Intro' : gap!.kind === 'outro' ? 'Outro' : 'Break') : cur?.hook ? 'Hook' : cur?.fast ? 'Verse · fast' : 'Verse';
    setText(this.metaTag, tag);
    this.root.classList.toggle('ctx-off', ctxMode === 'off');
    this.root.classList.toggle('ctx-min', ctxMode === 'minimal');
    const prevAge = cur ? t - cur.line.startMs : 0;
    this.prev.style.opacity = cur && !showGap ? (0.5 * clamp01((prevAge - 120) / 220)).toFixed(3) : '0';

    // --- beat dot (only with trusted timing)
    const pulse = f.beat && m.pulse ? f.beat.env : 0;
    setVar(this.root, '--pulse', pulse.toFixed(3), this.vars);
    this.pulseDot.classList.toggle('on', !!f.beat && m.pulse);

    // --- gap / intro / outro
    this.root.classList.toggle('in-gap', showGap);
    if (showGap && gap) {
      const title = gap.kind === 'intro' ? (this.ctx.title ?? 'Intro') : gap.kind === 'outro' ? 'Outro' : 'Instrumental';
      setText(this.gapTitle, displayText(title, FONT));
      const remain = Number.isFinite(gap.endMs) ? gap.endMs - t : 0;
      this.gapBar.style.transform = `scaleX(${gap.progress.toFixed(4)})`;
      setText(this.gapClock, Number.isFinite(gap.endMs) ? `Vocals in ${fmtClock(remain + 999)}` : this.ctx.artist ?? '');
      const k = gap.kind === 'intro' ? 1 : clamp01((t - gap.startMs - 650) / 450);
      this.gap.style.opacity = k.toFixed(3);
    } else {
      this.gap.style.opacity = '0';
    }

    // --- artwork / number drift: a slow push tied to playback (freezes on pause)
    if (m.transforms) {
      const drift = ((t / 1000) % 120) / 120;
      setVar(this.root, '--drift', drift.toFixed(4), this.vars);
    }
  }

  private animateUnits(v: LineView, t: number, f: FrameInput): void {
    const m = this.ctx.motion;
    const stagger = staggerFor(v, 42);
    const est = this.ctx.estimatedSweep && v.line.wordTiming !== 'exact' ? estimatedUnit(v, t, this.ctx.analysis.p80Sps) : -1;
    this.estTag.classList.toggle('on', this.ctx.estimatedSweep && v.line.wordTiming !== 'exact');
    const sizes: number[] = v.data.sizes ?? [];
    const rowOf: Map<number, number> = v.data.rowOfGroup;
    const fast = v.fast;
    const freq = fast ? 11 : 8;
    for (const u of v.units) {
      const s = stateOf(v, u.index, t, stagger, est);
      const exact = v.line.wordTiming === 'exact';
      setUnitState(u, s === 'future' ? (exact ? 'ghost' : 'future') : s);
      if (!m.transforms) {
        setUnitTransform(u, '', s === 'future' && !exact ? '0' : '');
        continue;
      }
      const arrive = unitArrival(v, u.index, stagger);
      const age = t - arrive;
      if (s === 'future') {
        setUnitTransform(u, '', exact ? '' : '0');
        continue;
      }
      const size = sizes[rowOf.get(u.group) ?? 0] ?? 60;
      const amt = m.wordMotion ? m.amount : 0;
      let ty = 0;
      let rot = 0;
      let sc = 1;
      if (age < 900 && amt > 0) {
        const p = spring(age, freq, 0.48);
        ty = (1 - p) * size * 0.32 * amt;
        rot = hashSigned(u.seed) * 6 * (1 - p) * amt;
        sc = 1 + (1 - p) * 0.2 * amt;
      }
      if (m.jiggle > 0 && s === 'active') {
        const a = t - u.word.startMs;
        rot += wobble(a, 6.5, 420) * 4 * m.jiggle + Math.sin(a / 95 + u.seed) * 1.2 * m.jiggle;
        ty += -Math.abs(wobble(a, 6.5, 300)) * size * 0.06 * m.jiggle;
      }
      if (s === 'active') {
        sc *= 1 + 0.035 * m.amount + (f.beat && m.pulse ? f.beat.env * 0.03 : 0);
      }
      const op = age < 50 ? clamp01(age / 50).toFixed(3) : '';
      const tf = ty === 0 && rot === 0 && sc === 1 ? '' : `translate3d(0,${ty.toFixed(1)}px,0) rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(4)})`;
      setUnitTransform(u, tf, op);
    }
  }
}

function setStyleCached(v: LineView, tf: string, op: string): void {
  if (v.tf !== tf) {
    v.tf = tf;
    v.el.style.transform = tf;
  }
  if (v.op !== op) {
    v.op = op;
    v.el.style.opacity = op;
  }
}
