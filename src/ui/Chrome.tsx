import { useEffect, useRef } from 'react';
import { controller } from '../app/controller';
import { type PanelId, setUi, useApp } from '../app/store';
import { appDisplayName } from '../playback/SystemMediaAdapter';
import { THEMES } from '../themes';
import { Icon } from './Icons';
import { SeekBar } from './SeekBar';

const QUALITY_LABEL = { locked: 'Locked', tracking: 'Tracking', estimating: 'Estimating', unavailable: 'No timing' } as const;
/** Plain words for the top bar; the technical label stays in the tooltip. */
const QUALITY_FRIENDLY = { locked: 'In sync', tracking: 'In sync', estimating: 'Catching up', unavailable: 'No timing' } as const;

export function qualityTitle(q: keyof typeof QUALITY_LABEL, reason: string): string {
  return `${QUALITY_LABEL[q]} — ${reason}`;
}

/** Short source name: "Spotify", "Demo", "File". */
function sourceName(t: { source: string; app?: string; sourceLabel: string } | null, preferredApp: string): string {
  if (!t) return 'No source';
  if (t.source === 'system') return appDisplayName(t.app || preferredApp);
  if (t.source === 'demo') return 'Demo';
  if (t.source === 'local') return 'File';
  return t.sourceLabel;
}

/**
 * Controls hide while playing, unless a panel or the paste box is open, the pointer is
 * over them, or someone is using the keyboard in them. A button that merely kept focus
 * after a click (or after a panel closed) does not count once the mouse has moved, or one
 * click would pin the controls for the rest of the song.
 */
export function shouldHide(pointerOverChrome: boolean, keyboardLast: boolean): boolean {
  const s = useApp.getState();
  if (!s.playing || s.ui.panel || s.ui.pasteOpen || pointerOverChrome) return false;
  const keyboardInChrome = keyboardLast && !!document.activeElement?.closest('.chrome, .panel');
  return !keyboardInChrome;
}

function PanelButton({ id, label, children, hint }: { id: Exclude<PanelId, null>; label: string; hint?: string; children: React.ReactNode }) {
  const open = useApp((s) => s.ui.panel === id);
  return (
    <button
      className={`chip${open ? ' on' : ''}`}
      aria-expanded={open}
      aria-controls={`panel-${id}`}
      title={hint ? `${label} (${hint})` : label}
      data-panel-trigger={id}
      onClick={() => setUi({ panel: open ? null : id })}
    >
      {children}
    </button>
  );
}

/** Top and bottom control bars; they recede while playing and return on any input. */
export function Chrome() {
  const visible = useApp((s) => s.ui.controlsVisible);
  const panel = useApp((s) => s.ui.panel);
  const playing = useApp((s) => s.playing);
  const hideMs = useApp((s) => s.settings.display.controlsHideMs);
  const fullscreen = useApp((s) => s.ui.fullscreen);
  const pasteOpen = useApp((s) => s.ui.pasteOpen);
  const pointerOver = useRef(false);
  const keyboardLast = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = useRef<() => void>(() => {});

  useEffect(() => {
    schedule.current = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        if (shouldHide(pointerOver.current, keyboardLast.current)) setUi({ controlsVisible: false });
      }, hideMs);
    };
    const wake = (e: Event) => {
      if (e instanceof KeyboardEvent) keyboardLast.current = true;
      else if (e instanceof PointerEvent) keyboardLast.current = false;
      // Where the pointer is now, read from the event itself: pointerleave is not delivered
      // reliably over the window's drag area, so a stored "over the bar" flag could stick.
      if (e instanceof PointerEvent) pointerOver.current = !!(e.target instanceof Element && e.target.closest('.chrome, .panel'));
      if (!useApp.getState().ui.controlsVisible) setUi({ controlsVisible: true });
      schedule.current();
    };
    const left = (e: MouseEvent) => {
      if (!e.relatedTarget) {
        pointerOver.current = false;
        schedule.current();
      }
    };
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    window.addEventListener('focusin', wake);
    document.addEventListener('mouseout', left);
    schedule.current();
    return () => {
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
      window.removeEventListener('focusin', wake);
      document.removeEventListener('mouseout', left);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [hideMs]);

  useEffect(() => {
    if (!playing || panel || pasteOpen) setUi({ controlsVisible: true });
    // Playback started (often from Spotify itself, with no input here) or a panel closed:
    // start the countdown again, otherwise the controls would stay up until the mouse moved.
    else schedule.current();
  }, [playing, panel, pasteOpen]);

  useEffect(() => {
    document.body.classList.toggle('chrome-hidden', !visible);
    document.body.classList.toggle('is-fullscreen', fullscreen);
  }, [visible, fullscreen]);

  return (
    <>
      <header
        className="chrome chrome-top"
        onPointerEnter={() => (pointerOver.current = true)}
        onPointerLeave={() => (pointerOver.current = false)}
      >
        <TopBar />
      </header>
      <footer
        className="chrome chrome-bottom"
        onPointerEnter={() => (pointerOver.current = true)}
        onPointerLeave={() => (pointerOver.current = false)}
      >
        <Transport />
      </footer>
    </>
  );
}

function TopBar() {
  const track = useApp((s) => s.track);
  const preferredApp = useApp((s) => s.settings.sources.preferredApp);
  const sync = useApp((s) => s.sync);
  const theme = useApp((s) => s.theme);
  const diag = useApp((s) => s.ui.diagnostics);
  const fullscreen = useApp((s) => s.ui.fullscreen);
  const offset = useApp((s) => (s.track ? controller.currentOffset() : s.settings.timing.globalOffsetMs));
  const def = THEMES[theme.activeId];
  const basis = theme.decision?.basis;
  const basisShort =
    basis === 'known-genre' ? 'Genre' : basis === 'suggested' ? 'Suggested' : basis === 'track-choice' ? 'Your pick' : basis === 'artist-choice' ? 'Artist pick' : basis === 'manual' ? 'Manual' : basis === 'fallback' ? 'Default' : '…';
  return (
    <div className="bar">
      <div className="brand" aria-hidden="true">
        <span className="brand-mark" />
        Afterglow
      </div>
      <button className="now chip ghost" onClick={() => setUi({ panel: 'sources' })} title="Sources and lyrics">
        <span className={`q-dot q-${sync.quality}`} title={qualityTitle(sync.quality, sync.reason)} />
        <span className="now-title">{track?.title ?? (track?.source === 'system' ? 'Waiting for music' : 'Nothing playing')}</span>
        {track?.artist && <span className="now-artist">{track.artist}</span>}
        <span className="now-src">
          {sourceName(track, preferredApp)}
          {track?.title ? ` · ${QUALITY_FRIENDLY[sync.quality]}` : ''}
        </span>
      </button>
      <div className="bar-fill" />
      <PanelButton id="themes" label="Themes" hint="T">
        <Icon.Palette />
        <span>{def.name}</span>
        <em className={`basis b-${basis ?? 'none'}`}>{basisShort}</em>
      </PanelButton>
      <PanelButton id="motion" label="Motion & display" hint="M">
        <Icon.Motion />
      </PanelButton>
      <PanelButton id="timing" label="Timing" hint="[ ]">
        <Icon.Clock />
        {offset !== 0 && <span className="mono">{offset > 0 ? '+' : ''}{offset}ms</span>}
      </PanelButton>
      <PanelButton id="sources" label="Music & lyrics" hint="S">
        <Icon.Source />
      </PanelButton>
      <button className={`chip icon${diag ? ' on' : ''}`} aria-pressed={diag} title="Diagnostics (D)" onClick={() => {
        setUi({ diagnostics: !diag });
        controller.updateSettings((s) => ({ ...s, diagnostics: !diag }));
      }}>
        <Icon.Bug />
      </button>
      <PanelButton id="help" label="Shortcuts" hint="?">
        <Icon.Help />
      </PanelButton>
      <button className="chip icon" title={fullscreen ? 'Exit full screen (F / Esc)' : 'Full screen (F)'} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={() => void controller.setFullscreen(!fullscreen)}>
        {fullscreen ? <Icon.Exit /> : <Icon.Full />}
      </button>
    </div>
  );
}

function Transport() {
  const playing = useApp((s) => s.playing);
  const caps = useApp((s) => s.caps);
  const lyrics = useApp((s) => s.lyrics);
  const lineOnly = useApp((s) => s.lineOnly);
  const timingLabel = lyrics.doc ? (lyrics.doc.timing === 'word' ? 'word-synced' : lyrics.doc.timing === 'line' ? 'line-synced' : 'unsynced') : lyrics.status === 'loading' ? 'searching…' : 'no lyrics';
  return (
    <div className="bar">
      <div className="transport">
        {caps.nextPrev && (
          <button className="round" aria-label="Previous track" onClick={() => controller.prev()}>
            <Icon.Prev />
          </button>
        )}
        <button className="round big" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'} disabled={!caps.playPause} onClick={() => controller.togglePlay()}>
          {playing ? <Icon.Pause /> : <Icon.Play />}
        </button>
        {caps.nextPrev && (
          <button className="round" aria-label="Next track" onClick={() => controller.next()}>
            <Icon.Next />
          </button>
        )}
      </div>
      <SeekBar />
      <div className="nudge" role="group" aria-label="Lyrics timing: move lyrics earlier or later">
        <button className="chip" title="Lyrics running late? Show them 50 ms earlier ( [ key, Shift for 250 ms)" onClick={() => controller.nudge(-50)}>
          Earlier
        </button>
        <button className="chip" title="Lyrics running early? Show them 50 ms later ( ] key, Shift for 250 ms)" onClick={() => controller.nudge(50)}>
          Later
        </button>
      </div>
      <button className="chip lyr-src" onClick={() => setUi({ panel: 'sources' })} title="Where these lyrics came from (S)">
        <Icon.Lyrics />
        <span>{lyrics.doc?.source.label ?? 'Lyrics'}</span>
        <em>{lineOnly && lyrics.doc ? 'line-only preview' : timingLabel}</em>
      </button>
    </div>
  );
}
