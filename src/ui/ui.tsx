// component primitives of the design system. thin wrappers that only pick the right css
// classes (styles.css, "components") and accessibility attributes: no state, no effects
// except Dialog's focus handling and NumField's editing. markup can also use the classes
// directly (menus and toasts are built with plain dom for speed: see menu.ts, actions.ts).
//
//   <Button variant="primary|secondary|ghost|danger" size="sm|md|lg" icon active tip="...">
//   <NumField label value onChange />          scrub label + math input (inspector fields)
//   <Select value onChange options />          native select, styled
//   <Checkbox checked onChange>label</Checkbox>
//   <Toggle checked onChange label />          switch (role=switch)
//   <Slider value min max step onChange />     range input
//   <Segmented value options onChange />       single choice button group
//   <Section title right>…</Section>           inspector panel section + header
//   <Dialog title onClose actions>…</Dialog>   modal with backdrop, focus trap, escape
//   <ColorSwatch value onInput onChange />     native color input as a swatch
//   <Kbd>⌘Z</Kbd>
//   tooltips: any element with data-tooltip="…" (css only, see styles.css); Button's `tip`.

import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------------- button ----------------
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ControlSize = 'sm' | 'md' | 'lg';

export type ButtonProps = Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'size' | 'icon'> & {
  variant?: ButtonVariant;
  size?: ControlSize;
  /** square icon-only button (give it a `tip` or aria-label) */
  icon?: boolean;
  /** toggled on (aria-pressed) */
  active?: boolean;
  /** tooltip text; also the accessible name of icon buttons */
  tip?: string;
  /** tooltip placement (default below) */
  tipSide?: 'top' | 'bottom';
  disabled?: boolean;
  class?: string;
};

export function Button({ variant = 'secondary', size = 'md', icon, active, tip, tipSide, class: cls, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      // primary / ghost also carry their legacy alias class (.primary / .ghost): older markup,
      // tests and scripts select on those
      class={cx('btn', variant !== 'secondary' && `btn-${variant}`, (variant === 'primary' || variant === 'ghost') && variant, size !== 'md' && `btn-${size}`, icon && 'btn-icon', active && 'on', cls)}
      aria-pressed={active === undefined ? undefined : active}
      data-tooltip={tip}
      data-tooltip-side={tip ? tipSide : undefined}
      aria-label={icon && tip ? tip : (rest as any)['aria-label']}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------- number field (scrub label + input) ----------------
export interface NumFieldProps {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (v: number, mergeKey?: string) => void;
  suffix?: string;
  title?: string;
}

/** scrubbable number field: drag the label (shift ×10, alt ×0.1), type math like `100+20` or `*2`, arrows ±1 (shift ±10) */
export function NumField(props: NumFieldProps) {
  const [text, setText] = useState<string | null>(null);
  // the text being edited, readable synchronously (enter commits and then blurs in the same tick:
  // the state closure would still hold the old text and commit twice)
  const editing = useRef<string | null>(null);
  const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
  const clamp = (v: number) => Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v));
  const onScrub = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX, v0 = props.value;
    const key = 'scrub' + Math.random();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      props.onChange(clamp(v0 + Math.round((ev.clientX - startX) * (props.step ?? 1) * mult * 100) / 100), key);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const commit = () => {
    const text = editing.current;
    if (text == null) return;
    editing.current = null;
    setText(null);
    // focus + blur without editing must not touch the document (no rounding, no stray keyframe)
    if (text.trim() === fmt(props.value)) return;
    const v = evalExpr(text, props.value);
    if (v != null && isFinite(v)) props.onChange(clamp(v));
  };
  return (
    <div class="num" title={props.title}>
      <span class="num-label" aria-hidden="true" onPointerDown={onScrub as any}>{props.label}</span>
      <input
        aria-label={props.title ?? props.label}
        inputMode="decimal"
        value={text ?? fmt(props.value) + (props.suffix ?? '')}
        onFocus={e => { editing.current = fmt(props.value); setText(editing.current); requestAnimationFrame(() => (e.target as HTMLInputElement).select()); }}
        onInput={e => { editing.current = (e.target as HTMLInputElement).value; setText(editing.current); }}
        onBlur={commit}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { editing.current = null; setText(null); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1);
            props.onChange(clamp(props.value + d));
            editing.current = fmt(clamp(props.value + d));
            setText(editing.current);
          }
        }}
      />
    </div>
  );
}

/** allows simple math in fields: "100+20", "*2", "/2" */
export function evalExpr(s: string, cur: number): number | null {
  s = s.trim().replace(/[^0-9+\-*/(). e]/gi, '');
  if (!s) return null;
  if (/^[*/+]/.test(s)) s = cur + s;
  try { return Function(`"use strict";return (${s})`)() as number; } catch { return null; }
}

// ---------------- select ----------------
export type SelectProps = Omit<JSX.HTMLAttributes<HTMLSelectElement>, 'onChange' | 'size'> & {
  value: string;
  onChange: (v: string) => void;
  options: (string | { value: string; label: string; disabled?: boolean })[];
  size?: ControlSize;
  class?: string;
};

export function Select({ value, onChange, options, size = 'md', class: cls, ...rest }: SelectProps) {
  return (
    <select class={cx('select', size !== 'md' && `select-${size}`, cls)} value={value} onChange={e => onChange((e.target as HTMLSelectElement).value)} {...rest}>
      {options.map(o => (typeof o === 'string' ? <option value={o}>{o}</option> : <option value={o.value} disabled={o.disabled}>{o.label}</option>))}
    </select>
  );
}

// ---------------- checkbox / toggle ----------------
export function Checkbox(props: { checked: boolean; onChange: (v: boolean) => void; children?: ComponentChildren; class?: string; disabled?: boolean; title?: string }) {
  return (
    <label class={cx('check', props.class)} title={props.title}>
      <input type="checkbox" class="checkbox" checked={props.checked} disabled={props.disabled} onChange={e => props.onChange((e.target as HTMLInputElement).checked)} />
      {props.children}
    </label>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: ComponentChildren; class?: string; disabled?: boolean; title?: string }) {
  return (
    <label class={cx('check', props.class)} title={props.title}>
      <input type="checkbox" role="switch" class="switch" checked={props.checked} disabled={props.disabled} onChange={e => props.onChange((e.target as HTMLInputElement).checked)} />
      {props.label}
    </label>
  );
}

// ---------------- slider ----------------
export function Slider(props: { value: number; min: number; max: number; step?: number; onChange?: (v: number) => void; onInput?: (v: number) => void; label?: string; class?: string; style?: any }) {
  return (
    <input type="range" class={cx('slider', props.class)} style={props.style} aria-label={props.label}
      min={props.min} max={props.max} step={props.step ?? 'any'} value={props.value}
      onInput={props.onInput && (e => props.onInput!(+(e.target as HTMLInputElement).value))}
      onChange={props.onChange && (e => props.onChange!(+(e.target as HTMLInputElement).value))} />
  );
}

// ---------------- segmented control ----------------
export function Segmented<V extends string | number>(props: {
  value: V;
  options: (V | { value: V; label: ComponentChildren; title?: string })[];
  onChange: (v: V) => void;
  disabled?: boolean;
  size?: ControlSize;
  class?: string;
  label?: string;
}) {
  return (
    <div class={cx('seg', props.size && props.size !== 'md' && `seg-${props.size}`, props.class)} role="group" aria-label={props.label}>
      {props.options.map(o => {
        const opt = typeof o === 'object' ? o : { value: o, label: String(o), title: undefined };
        const on = opt.value === props.value;
        return (
          <button type="button" class={cx('seg-item', on && 'on')} aria-pressed={on} title={opt.title} disabled={props.disabled} onClick={() => props.onChange(opt.value)}>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------- section (panel header + body) ----------------
export function Section(props: { title: ComponentChildren; children?: ComponentChildren; right?: ComponentChildren; class?: string }) {
  return (
    <section class={cx('section', 'insp-section', props.class)}>
      <header class="section-header insp-title"><h3 class="section-title">{props.title}</h3>{props.right}</header>
      {props.children}
    </section>
  );
}

// ---------------- color swatch ----------------
/** a native color picker shown as a swatch. alpha (0..1) is drawn over a checkerboard. */
export function ColorSwatch(props: { value: string; alpha?: number; onInput?: (hex: string) => void; onChange?: (hex: string) => void; label?: string; size?: ControlSize }) {
  return (
    <span class={cx('swatch', props.size && props.size !== 'md' && `swatch-${props.size}`)} style={{ '--swatch': props.value, '--swatch-alpha': props.alpha ?? 1 } as any}>
      <input type="color" aria-label={props.label ?? 'Color'} value={props.value}
        onInput={props.onInput && (e => props.onInput!((e.target as HTMLInputElement).value))}
        onChange={props.onChange && (e => props.onChange!((e.target as HTMLInputElement).value))} />
    </span>
  );
}

export function Kbd(props: { children: ComponentChildren }) {
  return <kbd class="kbd">{props.children}</kbd>;
}

// ---------------- dialog ----------------
let dialogSeq = 0;
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * modal dialog: backdrop, title, body, actions. focus moves into the dialog on open (the
 * element with `autofocus`, else the dialog itself), tab is trapped inside, escape calls
 * onClose (when given), and focus returns to where it was on close.
 */
export function Dialog(props: {
  title: ComponentChildren;
  children?: ComponentChildren;
  actions?: ComponentChildren;
  onClose?: () => void;
  /** clicking the backdrop closes (default true when onClose is given) */
  dismissable?: boolean;
  /** show the ✕ button in the header (default true when onClose is given) */
  closeButton?: boolean;
  width?: number | string;
  class?: string;
  actionsClass?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useRef('dlg-' + ++dialogSeq);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    (el.querySelector<HTMLElement>('[autofocus]') ?? el).focus({ preventScroll: true });
    return () => { if (prev && document.contains(prev)) prev.focus({ preventScroll: true }); };
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && onClose.current) { e.preventDefault(); e.stopPropagation(); onClose.current(); return; }
    if (e.key !== 'Tab') return;
    const items = [...ref.current!.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const dismissable = props.dismissable ?? !!props.onClose;
  return (
    <div class="dialog-backdrop" onPointerDown={e => { if (e.target === e.currentTarget && dismissable) onClose.current?.(); }}>
      <div ref={ref} class={cx('dialog', props.class)} role="dialog" aria-modal="true" aria-labelledby={props.label ? undefined : id.current} aria-label={props.label}
        tabIndex={-1} style={props.width ? { width: typeof props.width === 'number' ? props.width + 'px' : props.width } : undefined} onKeyDown={onKeyDown as any}>
        <header class="dialog-header">
          <h2 class="dialog-title" id={id.current}>{props.title}</h2>
          {props.onClose && (props.closeButton ?? true) && <Button variant="ghost" icon size="sm" tip="Close (Esc)" onClick={() => onClose.current?.()}>✕</Button>}
        </header>
        <div class="dialog-body">{props.children}</div>
        {props.actions && <footer class={cx('dialog-actions', props.actionsClass)}>{props.actions}</footer>}
      </div>
    </div>
  );
}
