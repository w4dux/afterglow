import { useEffect, useRef } from 'react';
import { controller } from '../app/controller';
import { useApp } from '../app/store';

/**
 * Translation of the current line, when the lyric source states one (TTML
 * x-translation spans or Apple-style head translations). Never machine-translated.
 * Text is written straight to the DOM when the line changes; React does not render
 * per frame.
 */
export function TranslationCaption() {
  const el = useRef<HTMLDivElement>(null);
  const doc = useApp((s) => s.lyrics.doc);
  const enabled = useApp((s) => s.settings.display.translations);
  const has = !!doc?.lines.some((l) => l.translation);

  useEffect(() => {
    if (!enabled || !has || !doc) return;
    let shownIndex = -2;
    const unsub = controller.runtime.subscribe((f) => {
      const i = f.cue?.lineIndex ?? -1;
      const line = i >= 0 ? doc.lines[i] : undefined;
      const text = line && f.cue && !f.cue.gap ? line.translation ?? '' : '';
      const key = text ? i : -1;
      if (key === shownIndex || !el.current) return;
      shownIndex = key;
      if (text) el.current.textContent = text;
      el.current.classList.toggle('on', !!text);
    });
    return unsub;
  }, [doc, enabled, has]);

  if (!enabled || !has) return null;
  return <div ref={el} className="translation-caption" aria-live="off" />;
}
