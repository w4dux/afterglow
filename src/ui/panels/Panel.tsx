import { type ReactNode, useEffect, useRef } from 'react';
import { type PanelId, setUi } from '../../app/store';
import { Icon } from '../Icons';

/** Side sheet with focus management: focuses itself on open, Esc closes, focus returns to its trigger. */
export function Panel({ id, title, children, wide }: { id: Exclude<PanelId, null>; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first =
      ref.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      ref.current?.querySelector<HTMLElement>('.panel-body button, .panel-body input, .panel-body select, .panel-body [tabindex="0"]');
    first?.focus({ preventScroll: true });
    return () => {
      const trigger = document.querySelector<HTMLElement>(`[data-panel-trigger="${id}"]`);
      (trigger ?? prev)?.focus?.({ preventScroll: true });
    };
  }, [id]);
  return (
    <aside
      ref={ref}
      id={`panel-${id}`}
      className={`panel${wide ? ' wide' : ''}`}
      role="dialog"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setUi({ panel: null });
        }
      }}
    >
      <div className="panel-head">
        <h2>{title}</h2>
        <button className="chip icon" aria-label="Close panel" onClick={() => setUi({ panel: null })}>
          <Icon.Close />
        </button>
      </div>
      <div className="panel-body">{children}</div>
    </aside>
  );
}

export function Toggle({ label, checked, onChange, hint, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`toggle${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-ui" aria-hidden="true" />
      <span className="toggle-text">
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} title={o.hint} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
