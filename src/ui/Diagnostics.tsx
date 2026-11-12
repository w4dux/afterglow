import { useEffect, useRef } from 'react';
import { controller } from '../app/controller';
import { isElectron } from '../app/platform';
import { useApp } from '../app/store';

const f = (x: number | null | undefined, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));

/**
 * Developer diagnostics: source vs estimated position, observation age and latency,
 * active cue, offsets and the last correction events. Text is written directly at
 * ~8 Hz; React does not re-render.
 */
export function Diagnostics() {
  const pre = useRef<HTMLPreElement>(null);
  const events = useRef<HTMLOListElement>(null);
  useEffect(() => {
    let last = 0;
    let frames = 0;
    let fpsAt = performance.now();
    let fps = 0;
    // keep values (observation age etc.) fresh while paused, at a low rate
    const keepAlive = setInterval(() => controller.runtime.wake(30), 250);
    const unsub = controller.runtime.subscribe((fi) => {
      frames++;
      if (fi.now - fpsAt >= 1000) {
        fps = (frames * 1000) / (fi.now - fpsAt);
        frames = 0;
        fpsAt = fi.now;
      }
      if (fi.now - last < 120) return;
      last = fi.now;
      const s = useApp.getState();
      const snap = controller.engine.snapshot(fi.now);
      const doc = s.lyrics.doc;
      const cue = fi.cue;
      const line = cue && cue.lineIndex >= 0 ? doc?.lines[cue.lineIndex] : undefined;
      const word = line && cue && cue.wordIndex >= 0 ? line.words[cue.wordIndex] : undefined;
      const sys = s.system;
      const st = snap.stats;
      const lines = [
        `source        ${s.track?.sourceLabel ?? '—'} (${snap.source ?? '—'})`,
        `quality       ${snap.quality} — ${snap.qualityReason}`,
        `playing       ${snap.playing} rate ${f(snap.rate, 2)}`,
        `source pos    ${f(snap.lastObservedPositionMs)} ms (last observation)`,
        `estimated     ${f(fi.mediaMs)} ms  raw ${f(snap.rawPositionMs)}  residual ${f(snap.residualMs, 1)}`,
        `obs age       ${f(snap.observationAgeMs)} ms   latency ${f(snap.lastLatencyMs, 1)} ms`,
        `offset        ${controller.currentOffset()} ms (global ${s.settings.timing.globalOffsetMs}, track ${controller.trackOffset()})`,
        `lyric time    ${f(fi.lyricMs)} ms   timing ${doc?.timing ?? '—'}${s.lineOnly ? ' (line-only preview)' : ''}`,
        `active line   ${cue ? cue.lineIndex : '—'}${line ? ` [${line.startMs}–${line.endMs}) ${cue?.inLine ? 'in' : 'held'}` : ''}${cue?.gap ? ` gap:${cue.gap.kind}` : ''}`,
        `active word   ${word ? `${cue!.wordIndex} "${word.text}" [${word.startMs}–${word.endMs})` : '—'}`,
        `observations  ok ${st.accepted} rej ${st.rejected} dup ${st.duplicates} | snaps ${st.snaps} slews ${st.slews} seeks ${st.seeks}`,
        `obs error     mean ${f(st.meanAbsErrorMs, 1)}  p95 ${f(st.p95AbsErrorMs, 1)}  max ${f(st.maxAbsErrorMs, 1)} ms (n=${st.samples})`,
        `render        ${fps.toFixed(0)} fps  theme ${s.theme.activeId}  scene.frame avg ${controller.runtime.frameCost().avg.toFixed(2)} p95 ${controller.runtime.frameCost().p95.toFixed(2)} ms`,
        `display       ${controller.runtime.refreshHz || '—'} Hz, drawing ${controller.runtime.frameDivisor === 1 ? 'every frame' : `every ${controller.runtime.frameDivisor}${controller.runtime.frameDivisor === 2 ? 'nd' : controller.runtime.frameDivisor === 3 ? 'rd' : 'th'} frame`}${controller.batterySaving() ? ' (battery saver)' : ''}`,
      ];
      if (sys) {
        lines.push(
          `bridge        ${sys.bridge}${sys.message ? ` — ${sys.message}` : ''}`,
          `session       ${sys.app ?? '—'} ${sys.status ?? ''} timeline:${sys.timelineAvailable ?? '—'}`,
          `gsmtc         last ${sys.lastCause ?? '—'} | LastUpdated age ${f(sys.lastAgeMs)} ms | update interval ${f(sys.timelineIntervalMs)} ms`,
          `gsmtc counts  ${Object.entries(sys.counts).map(([k, v]) => `${k}:${v}`).join(' ')}`,
        );
      }
      const len = s.lyrics.length;
      if (len?.reportedSec) {
        const used = len.usedSec !== undefined ? `matched as ${f(len.usedSec, 1)} s` : 'matched by range (no correction learned yet)';
        const learned = len.learnedOffsetSec !== undefined ? ` | learned ${len.learnedOffsetSec >= 0 ? '+' : ''}${f(len.learnedOffsetSec, 1)} s` : '';
        const gap = len.measuredGapSec !== undefined ? ` | this song ${len.measuredGapSec >= 0 ? '+' : ''}${f(len.measuredGapSec, 1)} s` : '';
        lines.push(`length        player ${f(len.reportedSec, 1)} s, ${used}${learned}${gap}`);
      }
      if (pre.current) pre.current.textContent = lines.join('\n');
      if (events.current) {
        const ev = controller.engine.corrections.slice(-8).reverse();
        events.current.innerHTML = '';
        for (const e of ev) {
          const li = document.createElement('li');
          li.className = `ev ev-${e.kind}`;
          li.textContent = `${((fi.now - e.at) / 1000).toFixed(1)}s ago  ${e.kind.padEnd(7)} ${e.errorMs !== undefined ? `${e.errorMs > 0 ? '+' : ''}${e.errorMs.toFixed(1)}ms ` : ''}@${e.positionMs.toFixed(0)}${e.reason ? `  ${e.reason}` : ''}`;
          events.current.appendChild(li);
        }
      }
    });
    return () => {
      clearInterval(keepAlive);
      unsub();
    };
  }, []);
  return (
    <section className="diagnostics" aria-label="Diagnostics">
      <h2>Sync diagnostics</h2>
      <div className="diag-actions">
        <button onClick={() => void controller.copyDiagnostics()}>Copy report</button>
        {isElectron && <button onClick={() => controller.openLogFolder()}>Open log folder</button>}
      </div>
      <pre ref={pre} />
      <h3>Correction events</h3>
      <ol ref={events} />
    </section>
  );
}
