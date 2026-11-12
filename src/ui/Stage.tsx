import { useEffect, useMemo, useRef } from 'react';
import { analyzeLyrics } from '../core/lyrics/analysis';
import { emptyDocument } from '../core/lyrics/model';
import { controller } from '../app/controller';
import { useApp } from '../app/store';
import { ensureFonts } from '../stage/layout';
import { resolveMotion } from '../stage/motion';
import type { Scene, SceneContext } from '../stage/scene';
import { THEMES } from '../themes';

const EMPTY_DOC = emptyDocument({ kind: 'none', label: 'none', format: 'none' });
const EMPTY_ANALYSIS = analyzeLyrics(EMPTY_DOC);

/**
 * Hosts the active theme scene. React only (re)creates scenes when the theme, the
 * lyric document or display settings change; per-frame work happens in StageRuntime.
 */
export function Stage() {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{ scene: Scene; themeId: string } | null>(null);
  const themeId = useApp((s) => s.theme.activeId);
  const doc = useApp((s) => s.lyrics.doc);
  const analysis = useApp((s) => s.analysis);
  const motion = useApp((s) => s.settings.motion);
  const display = useApp((s) => s.settings.display);
  const reducedSys = useApp((s) => s.reducedMotionSystem);
  const artwork = useApp((s) => s.artwork);
  const track = useApp((s) => s.track);
  const playing = useApp((s) => s.playing);
  const noTimeline = useApp((s) => s.source === 'system' && s.sync.quality === 'unavailable' && !!s.lyrics.doc && s.lyrics.doc.timing !== 'none');

  const ctx: SceneContext = useMemo(() => {
    const synced = doc && doc.timing !== 'none' && !noTimeline ? doc : EMPTY_DOC;
    return {
      doc: synced,
      analysis: synced === EMPTY_DOC ? EMPTY_ANALYSIS : analysis ?? EMPTY_ANALYSIS,
      motion: resolveMotion(motion.treatment, motion.intensity, motion.reduced, reducedSys, motion.beatPulse),
      context: display.context,
      artwork: display.showArtwork ? artwork : null,
      title: track?.title,
      artist: track?.artist,
      estimatedSweep: motion.estimatedSweep,
      textScale: display.textScale,
    };
  }, [doc, analysis, motion, display, reducedSys, artwork, track?.title, track?.artist, noTimeline]);

  // Create / swap scenes.
  useEffect(() => {
    const h = host.current;
    if (!h) return;
    let cancelled = false;
    const def = THEMES[themeId];
    void ensureFonts(def.fonts).then(() => {
      if (cancelled) return;
      const cur = sceneRef.current;
      if (cur && cur.themeId === themeId) {
        cur.scene.update(ctx);
        controller.runtime.wake(600);
        return;
      }
      const layer = document.createElement('div');
      layer.className = 'scene-layer entering';
      h.appendChild(layer);
      const scene = def.create(layer, ctx);
      controller.runtime.setScene(scene);
      controller.runtime.renderNow();
      requestAnimationFrame(() => layer.classList.remove('entering'));
      if (cur) {
        const old = cur.scene.root.parentElement as HTMLElement;
        old.classList.add('leaving');
        setTimeout(() => {
          cur.scene.destroy();
          old.remove();
        }, 420);
      }
      sceneRef.current = { scene, themeId };
    });
    return () => {
      cancelled = true;
    };
  }, [themeId, ctx]);

  // Resize handling.
  useEffect(() => {
    const h = host.current;
    if (!h) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      sceneRef.current?.scene.resize(r.width, r.height);
      controller.runtime.wake(300);
    });
    ro.observe(h);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      sceneRef.current?.scene.destroy();
      controller.runtime.setScene(null);
    },
    [],
  );

  return <div ref={host} className={`stage theme-${themeId}${playing ? '' : ' is-paused'}`} data-testid="stage" />;
}
