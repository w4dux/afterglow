import { useEffect, useRef, useState } from 'react';
import { analyzeLyrics } from '../../core/lyrics/analysis';
import { CueIndex } from '../../core/lyrics/cues';
import type { LyricDocument } from '../../core/lyrics/model';
import { parseLyrics } from '../../core/lyrics/parse';
import type { ThemeId } from '../../core/themes/matcher';
import { controller } from '../../app/controller';
import { useApp } from '../../app/store';
import { ensureFonts } from '../../stage/layout';
import { beatAt, resolveMotion } from '../../stage/motion';
import type { Scene } from '../../stage/scene';
import { extractPalette } from '../../stage/textures';
import { NEW_THEMES, THEMES, THEME_ORDER } from '../../themes';
import { Panel, Segmented, Toggle } from './Panel';

/** Library order: the most-used looks first, then the newest, then the rest. */
const GALLERY_ORDER: ThemeId[] = ['cypher', 'velvet', 'feedback', 'zine', 'afterhours', 'halo', 'monsoon', 'haze', 'rave', 'singalong', 'departures', 'riot', 'prism', 'nocturne', 'sherbet', 'horizon', 'quiet'];
const COUNT_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];

const docCache = new Map<string, Promise<LyricDocument | null>>();
function demoDoc(id: string, lyricsUrl?: string): Promise<LyricDocument | null> {
  if (!lyricsUrl) return Promise.resolve(null);
  let p = docCache.get(id);
  if (!p) {
    p = fetch(lyricsUrl)
      .then((r) => r.text())
      .then((t) => parseLyrics(t, { kind: 'demo', label: 'preview' }, lyricsUrl))
      .catch(() => null);
    docCache.set(id, p);
  }
  return p;
}

/** Live miniature of a theme: a real scene rendered at a fixed time; animates on hover/focus. */
function ThemePreview({ id, animate }: { id: ThemeId; animate: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{ scene: Scene; cues: CueIndex; doc: LyricDocument } | null>(null);
  const demos = useApp((s) => s.demos);
  const reduced = useApp((s) => s.reducedMotionSystem || s.settings.motion.reduced === 'on');
  const def = THEMES[id];
  const demo = demos.find((d) => d.id === def.previewDemo);

  useEffect(() => {
    let dead = false;
    void (async () => {
      const doc = await demoDoc(def.previewDemo, demo?.lyrics);
      await ensureFonts(def.fonts);
      if (dead || !doc || !box.current) return;
      const palette = demo ? await extractPalette(demo.artwork) : null;
      if (dead) return;
      const scene = def.create(box.current, {
        doc,
        analysis: analyzeLyrics(doc),
        motion: resolveMotion('signature', 1, reduced ? 'on' : 'off', false, true),
        context: 'full',
        artwork: demo ? { url: demo.artwork, palette } : null,
        title: demo?.title,
        artist: demo?.artist,
        estimatedSweep: false,
        textScale: 1,
        preview: true,
      });
      const cues = new CueIndex(doc);
      sceneRef.current = { scene, cues, doc };
      const t = def.previewAtMs;
      const b = beatAt(t, doc.meta.bpm, doc.meta.beatOffsetMs);
      scene.frame({ t, cue: cues.cue(t), playing: false, beat: b });
    })();
    return () => {
      dead = true;
      sceneRef.current?.scene.destroy();
      sceneRef.current = null;
    };
  }, [id, demo, reduced, def]);

  useEffect(() => {
    if (!animate || reduced) {
      const s = sceneRef.current;
      if (s) s.scene.frame({ t: def.previewAtMs, cue: s.cues.cue(def.previewAtMs), playing: false, beat: null });
      return;
    }
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      const s = sceneRef.current;
      if (s) {
        const t = def.previewAtMs - 900 + ((now - start) % 6000);
        const b = beatAt(t, s.doc.meta.bpm, s.doc.meta.beatOffsetMs);
        s.scene.frame({ t, cue: s.cues.cue(t), playing: true, beat: b });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [animate, reduced, def]);

  return <div className={`preview theme-${id}`} ref={box} aria-hidden="true" />;
}

export function ThemePanel() {
  const theme = useApp((s) => s.theme);
  const settings = useApp((s) => s.settings);
  const track = useApp((s) => s.track);
  const [hover, setHover] = useState<ThemeId | null>(null);
  const [forArtist, setForArtist] = useState(false);
  const d = theme.decision;
  const mode = settings.theme.mode;
  const hasTrackChoice = !!(track && settings.theme.trackThemes[track.themeKey ?? track.key]);

  return (
    <Panel id="themes" title="Find your frequency" wide>
      <p className="theme-intro">{COUNT_WORDS[THEME_ORDER.length] ?? THEME_ORDER.length} ways to feel a song. Pick a mood and make it yours.</p>
      <Segmented
        label="Theme selection"
        value={mode}
        onChange={(v) => controller.setThemeMode(v)}
        options={[
          { value: 'auto', label: 'Auto', hint: 'Match each song' },
          { value: 'manual', label: 'Manual', hint: 'One theme for everything' },
        ]}
      />
      {d && (
        <div className={`decision b-${d.basis}`} role="status">
          <strong>{THEMES[d.themeId].name}</strong>
          <span>{d.label}</span>
          {d.basis === 'suggested' && <small>A suggestion from measured lyric pace — not genre detection.</small>}
          {d.basis === 'fallback' && <small>No reliable genre for this track, so your default theme is used.</small>}
          {d.basis === 'known-genre' && <small>Genre stated by the track’s metadata or a music catalogue, never guessed from the audio.</small>}
        </div>
      )}
      <div className="gallery" role="listbox" aria-label="Choose a theme">
        {GALLERY_ORDER.map((id) => {
          const i = THEME_ORDER.indexOf(id);
          const def = THEMES[id];
          const active = theme.activeId === id;
          return (
            <button
              key={id}
              role="option"
              aria-selected={active}
              style={{ '--swatch': def.swatch[1] } as React.CSSProperties}
              className={`card${active ? ' active' : ''}`}
              onMouseEnter={() => setHover(id)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(id)}
              onBlur={() => setHover(null)}
              onClick={() => controller.chooseTheme(id, { forArtist })}
              data-autofocus={active ? true : undefined}
            >
              <ThemePreview id={id} animate={hover === id} />
              <span className="card-meta">
                <b>
                  {i < 10 && <kbd>{(i + 1) % 10}</kbd>} {def.name}
                  {NEW_THEMES.includes(id) && <span className="theme-new">NEW</span>}
                </b>
                <span>{def.genre}</span>
              </span>
              <span className="card-tag">{def.tagline}</span>
            </button>
          );
        })}
      </div>
      {mode === 'auto' && track && (
        <div className="row-actions">
          <Toggle label={`Also use my pick for ${track.artist ?? 'this artist'}`} checked={forArtist} onChange={setForArtist} disabled={!track.artist} />
          {hasTrackChoice && (
            <button className="chip" onClick={() => controller.clearTrackTheme()}>
              Forget my pick for this track
            </button>
          )}
        </div>
      )}
      <details className="explain">
        <summary>How Auto picks a theme</summary>
        <ol>
          <li>Your choice for this track, then your choice for the artist (if enabled).</li>
          <li>A genre stated in metadata: file tags, the system media session, the lyric file, demo metadata, or Apple’s catalogue (when online lookups are on).</li>
          <li>Optional suggestion from timed lyrics: very fast pace suggests Cypher, sparse lyrics with long breaks suggest Horizon. This is a heuristic, labelled as such.</li>
          <li>Otherwise your default theme.</li>
        </ol>
        <p>The decision is made once per track and never changes on its own while the song plays. Afterglow does not analyse audio for genre, mood, energy or BPM.</p>
        <Toggle label="Use lyric-pace suggestions" checked={settings.theme.useSuggestions} onChange={(v) => controller.updateSettings((s) => ({ ...s, theme: { ...s.theme, useSuggestions: v } }))} />
        <Toggle label="Remember artist picks" checked={settings.theme.useArtistPrefs} onChange={(v) => controller.updateSettings((s) => ({ ...s, theme: { ...s.theme, useArtistPrefs: v } }))} />
        <label className="field">
          Default theme for unknown songs
          <select value={settings.theme.fallbackTheme} onChange={(e) => controller.updateSettings((s) => ({ ...s, theme: { ...s.theme, fallbackTheme: e.target.value as ThemeId } }))}>
            {THEME_ORDER.map((id) => (
              <option key={id} value={id}>
                {THEMES[id].name}
              </option>
            ))}
          </select>
        </label>
      </details>
    </Panel>
  );
}
