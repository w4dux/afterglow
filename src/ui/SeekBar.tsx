import { useEffect, useRef, useState } from 'react';
import { controller } from '../app/controller';
import { useApp } from '../app/store';
import { fmtClock } from '../stage/scene';

/**
 * Seek bar with lyric-line ticks. Progress and clock are written directly from the
 * stage runtime (no React re-render per frame). Keyboard: arrows ±5 s, Home/End.
 */
export function SeekBar() {
  const bar = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const elapsed = useRef<HTMLSpanElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<{ x: number; ms: number } | null>(null);
  const duration = useApp((s) => s.durationMs);
  const canSeek = useApp((s) => s.caps.seek);
  const doc = useApp((s) => s.lyrics.doc);
  const analysis = useApp((s) => s.analysis);
  useApp((s) => s.settings.timing);
  useApp((s) => s.track?.key);
  const offset = controller.currentOffset();

  useEffect(() => {
    let lastSec = -1;
    return controller.runtime.subscribe((f) => {
      if (drag !== null) return;
      const d = useApp.getState().durationMs;
      const p = d > 0 ? Math.min(1, f.mediaMs / d) : 0;
      if (fill.current) fill.current.style.transform = `scaleX(${p.toFixed(5)})`;
      if (knob.current) knob.current.style.left = `${(p * 100).toFixed(3)}%`;
      const sec = Math.floor(f.mediaMs / 1000);
      if (sec !== lastSec && elapsed.current) {
        lastSec = sec;
        elapsed.current.textContent = fmtClock(f.mediaMs);
        bar.current?.setAttribute('aria-valuenow', String(sec));
        bar.current?.setAttribute('aria-valuetext', `${fmtClock(f.mediaMs)} of ${fmtClock(d)}`);
      }
    });
  }, [drag]);

  const msAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!canSeek || !duration) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(msAt(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!duration) return;
    const ms = msAt(e.clientX);
    const r = bar.current!.getBoundingClientRect();
    setHover({ x: e.clientX - r.left, ms });
    if (drag !== null) {
      setDrag(ms);
      const p = ms / duration;
      if (fill.current) fill.current.style.transform = `scaleX(${p})`;
      if (knob.current) knob.current.style.left = `${p * 100}%`;
    }
  };
  const onPointerUp = () => {
    if (drag !== null) controller.seek(drag);
    setDrag(null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 15000 : 5000;
    if (e.key === 'ArrowLeft') controller.seekBy(-step);
    else if (e.key === 'ArrowRight') controller.seekBy(step);
    else if (e.key === 'Home') controller.seek(0);
    else if (e.key === 'End') controller.seek(duration - 1000);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const hoverLine = hover && doc ? doc.lines.findLast((l) => l.startMs + offset <= hover.ms) : undefined;

  return (
    <div className="seek">
      <span className="seek-time" ref={elapsed}>0:00</span>
      <div
        ref={bar}
        className={`seek-bar${canSeek ? '' : ' disabled'}`}
        role="slider"
        tabIndex={canSeek ? 0 : -1}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.floor(duration / 1000)}
        aria-disabled={!canSeek}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
      >
        <div className="seek-track">
          {duration > 0 &&
            doc?.lines.map((l) => (
              <i
                key={l.index}
                className={analysis?.hookLines.has(l.index) ? 'tick hook' : 'tick'}
                style={{ left: `${(((l.startMs + offset) / duration) * 100).toFixed(3)}%` }}
              />
            ))}
          <div className="seek-fill" ref={fill} />
        </div>
        <div className="seek-knob" ref={knob} />
        {hover && duration > 0 && (
          <div className="seek-tip" style={{ left: hover.x }}>
            <b>{fmtClock(hover.ms)}</b>
            {hoverLine && <span>{hoverLine.text}</span>}
          </div>
        )}
      </div>
      <span className="seek-time dim">{duration ? fmtClock(duration) : '–:––'}</span>
    </div>
  );
}
