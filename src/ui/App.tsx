import { useEffect } from 'react';
import { controller } from '../app/controller';
import { localTrackFromFile, native } from '../app/platform';
import { getApp, setUi, useApp } from '../app/store';
import { THEME_ORDER, THEMES } from '../themes';
import { Chrome } from './Chrome';
import { Diagnostics } from './Diagnostics';
import { HelpPanel, PasteDialog, SourcesPanel } from './panels/SourcesPanel';
import { MotionPanel, TimingPanel } from './panels/MotionTimingPanels';
import { ThemePanel } from './panels/ThemePanel';
import { Stage } from './Stage';
import { Attribution, StatusLayer } from './StatusLayer';
import { TranslationCaption } from './TranslationCaption';
import { Welcome } from './Welcome';

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function jumpLine(dir: -1 | 1): void {
  const doc = getApp().lyrics.doc;
  const cue = controller.runtime.last.cue;
  if (!doc || !doc.lines.length) return;
  const cur = cue?.lineIndex ?? -1;
  const lineStart = doc.lines[cur]?.startMs ?? 0;
  // "previous" restarts the current line if we are more than 1.2 s into it
  let target = dir > 0 ? cur + 1 : cue && cue.t - lineStart > 1200 ? cur : cur - 1;
  target = Math.max(0, Math.min(doc.lines.length - 1, target));
  controller.seek(doc.lines[target].startMs + controller.currentOffset() - 120);
}

export function App() {
  const ready = useApp((s) => s.ready);
  const panel = useApp((s) => s.ui.panel);
  const diagnostics = useApp((s) => s.ui.diagnostics);
  const tone = useApp((s) => THEMES[s.theme.activeId].tone);
  const welcome = useApp(() => controller.shouldWelcome());
  const saver = useApp((s) => s.onBattery && s.settings.display.batterySaver);

  useEffect(() => {
    void controller.init();
  }, []);

  // Linux draws the window controls itself: keep them readable on light themes.
  useEffect(() => {
    void native?.setWindowTone?.(tone).catch(() => undefined);
  }, [tone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = getApp();
      const k = e.key;
      const inPanel = !!(e.target as HTMLElement)?.closest?.('.panel, .modal');
      const handled = (() => {
        if (k === ' ' || k === 'k' || k === 'K') {
          if ((e.target as HTMLElement)?.tagName === 'BUTTON' && k === ' ') return false;
          controller.togglePlay();
        } else if (k === 'ArrowLeft' && !inPanel) controller.seekBy(e.shiftKey ? -15000 : -5000);
        else if (k === 'ArrowRight' && !inPanel) controller.seekBy(e.shiftKey ? 15000 : 5000);
        else if (k === ',') jumpLine(-1);
        else if (k === '.') jumpLine(1);
        else if (k === '[' || k === '{') controller.nudge(e.shiftKey ? -250 : -50);
        else if (k === ']' || k === '}') controller.nudge(e.shiftKey ? 250 : 50);
        else if (k === '\\') controller.setTrackOffset(0);
        else if (k === 'f' || k === 'F' || k === 'F11') void controller.setFullscreen(!s.ui.fullscreen);
        else if (k === 'Escape') {
          if (s.ui.pasteOpen) setUi({ pasteOpen: false });
          else if (s.ui.panel) setUi({ panel: null });
          else if (s.ui.fullscreen) void controller.setFullscreen(false);
          else return false;
        } else if (k === 't' || k === 'T') setUi({ panel: s.ui.panel === 'themes' ? null : 'themes' });
        else if (k === 'm' || k === 'M') setUi({ panel: s.ui.panel === 'motion' ? null : 'motion' });
        else if (k === 's' || k === 'S') setUi({ panel: s.ui.panel === 'sources' ? null : 'sources' });
        else if (k === '?' || k === 'h' || k === 'H') setUi({ panel: s.ui.panel === 'help' ? null : 'help' });
        else if (k === 'd' || k === 'D') {
          setUi({ diagnostics: !s.ui.diagnostics });
          controller.updateSettings((x) => ({ ...x, diagnostics: !s.ui.diagnostics }));
        } else if (k === 'c' || k === 'C') {
          const order = ['full', 'minimal', 'off'] as const;
          const next = order[(order.indexOf(s.settings.display.context) + 1) % 3];
          controller.updateSettings((x) => ({ ...x, display: { ...x.display, context: next } }));
        } else if (k === 'o' || k === 'O') void controller.openLocal();
        else if (k === 'l' || k === 'L') void controller.importLyrics();
        else if (/^[0-9]$/.test(k)) controller.chooseTheme(THEME_ORDER[k === '0' ? 9 : parseInt(k, 10) - 1]);
        else return false;
        return true;
      })();
      if (handled) {
        e.preventDefault();
        controller.runtime.wake(400);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Drag & drop: audio files open, lyric files attach.
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = async (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const name = file.name.toLowerCase();
      if (/\.(lrc|elrc|ttml|xml|txt)$/.test(name)) {
        const path = window.afterglow?.pathForFile(file);
        controller.useLyricsText(await file.text(), file.name, path || undefined);
      } else if (/\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm|mp4)$/.test(name)) {
        const path = window.afterglow?.pathForFile(file);
        if (path && window.afterglow) {
          const info = await window.afterglow.openAudioPath(path);
          if (info) await controller.openLocal(info);
        } else {
          await controller.openLocal(localTrackFromFile(file));
        }
      }
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  return (
    <div className={`app tone-${tone} os-${native?.platform ?? 'browser'}${saver ? ' battery-saver' : ''}`}>
      <Stage />
      <TranslationCaption />
      {ready && <StatusLayer />}
      <Attribution />
      <Chrome />
      {panel === 'themes' && <ThemePanel />}
      {panel === 'motion' && <MotionPanel />}
      {panel === 'timing' && <TimingPanel />}
      {panel === 'sources' && <SourcesPanel />}
      {panel === 'help' && <HelpPanel />}
      <PasteDialog />
      {welcome && <Welcome />}
      {diagnostics && <Diagnostics />}
      <Toasts />
    </div>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone ?? 'info'}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
