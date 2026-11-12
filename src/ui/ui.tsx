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
//   <Section title right onAdd onRemove>…</Section>  inspector section: small title, "+" / "−" on the right, hairline below
//   <FieldRow label>…fields…</FieldRow>        a labelled row of fields (two NumFields share it)
//   <SwatchRow color label value>              swatch + type + amount (fill rows)
//   <Dialog title onClose actions>…</Dialog>   modal with backdrop, focus trap, escape
//   <ColorSwatch value onInput onChange />     native color input as a swatch
//   <Kbd>⌘Z</Kbd>
//   tooltips: any element with data-tooltip="…" (css only, see styles.css); Button's `tip`.

import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Minus, Plus, X } from 'lucide-preact';

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
  /** short text ("X", "W") or an icon */
  label: ComponentChildren;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (v: number, mergeKey?: string) => void;
  suffix?: string;
  title?: string;
  /** quiet text at the field's right end ("Fixed", "px") */
  hint?: string;
}

/** scrubbable number field: drag the label (shift ×10, alt ×0.1), type math like `100+20` or `*2`, arrows ±1 (shift ±10) */
export function NumField(props: NumFieldProps) {
  const [text, setText] = useState<string | null>(null);
  // the text being edited, readable synchronously (enter commits and then blurs in the same tick:
  // the state closure would still hold the old text and commit twice)
  const editing = useRef<string | null>(null);
  // sensible precision for the space a field has: 1180, 480.1, 12.25
  const fmt = (v: number) => { const a = Math.abs(v), k = a >= 1000 ? 1 : a >= 100 ? 10 : 100; return (Math.round(v * k) / k).toString(); };
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
      {props.hint && <span class="num-hint" aria-hidden="true">{props.hint}</span>}
      <input
        aria-label={props.title ?? (typeof props.label === 'string' ? props.label : undefined)}
        inputMode="decimal"
        value={text ?? fmt(props.value) + (props.suffix ?? '')}
        onFocus={e => { editing.current = fmt(props.value); setText(editing.current); const el = e.target as HTMLInputElement;
          // select() also focuses: only while the field still has focus, or a quick Tab is pulled back here
          requestAnimationFrame(() => { if (document.activeElement === el) el.select(); }); }}
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
  s = s.trim().replace(/(\d),(\d)/g, '$1.$2').replace(/[^0-9+\-*/(). e]/gi, ''); // 12,5 = 12.5
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
/**
 * an inspector / panel section: a small title, actions on the right, the body, a hairline below.
 * `onAdd` shows a "+" (add a fill, an effect, an expression...), `onRemove` a "−". a section with
 * an `onAdd` and no children collapses to its title row (the "add a stroke" state).
 */
export function Section(props: {
  title: ComponentChildren; children?: ComponentChildren; right?: ComponentChildren; class?: string;
  onAdd?: (e?: MouseEvent) => void; addLabel?: string; onRemove?: () => void; removeLabel?: string;
}) {
  const empty = props.children === undefined || props.children === null || props.children === false || (Array.isArray(props.children) && props.children.every(c => c === null || c === undefined || c === false));
  return (
    <section class={cx('section', 'insp-section', empty && 'empty', props.class)}>
      <header class="section-header insp-title">
        <h3 class="section-title">{props.title}</h3>
        <span class="section-actions">
          {props.right}
          {props.onRemove && <Button variant="ghost" icon size="sm" tip={props.removeLabel ?? 'Remove'} onClick={props.onRemove}><Minus size={14} /></Button>}
          {props.onAdd && <Button variant="ghost" icon size="sm" tip={props.addLabel ?? 'Add'} onClick={props.onAdd as any}><Plus size={14} /></Button>}
        </span>
      </header>
      {props.children}
    </section>
  );
}

/** a row of fields with a quiet label on the left (Position, Size…) and an optional trailing control (keyframe button) */
export function FieldRow(props: { label?: ComponentChildren; children?: ComponentChildren; trail?: ComponentChildren; class?: string; title?: string }) {
  return (
    <div class={cx('field-row', props.class)} title={props.title}>
      {props.label !== undefined && <span class="field-row-label">{props.label}</span>}
      <span class="field-row-fields">{props.children}</span>
      {props.trail !== undefined && <span class="field-row-trail">{props.trail}</span>}
    </div>
  );
}

/** a fill-style row: a color swatch, what it is (Solid, Linear…), and an amount (100%) */
export function SwatchRow(props: { swatch: ComponentChildren; label: ComponentChildren; value?: ComponentChildren; trail?: ComponentChildren }) {
  return (
    <div class="swatch-row">
      <span class="swatch-row-swatch">{props.swatch}</span>
      <span class="swatch-row-label">{props.label}</span>
      {props.value !== undefined && <span class="swatch-row-value">{props.value}</span>}
      {props.trail}
    </div>
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

/** keep Tab / Shift+Tab inside a modal container (wraps at the ends) */
export function trapTab(e: KeyboardEvent, box: HTMLElement) {
  if (e.key !== 'Tab') return;
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

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
    trapTab(e, ref.current!);
  };
  const dismissable = props.dismissable ?? !!props.onClose;
  return (
    <div class="dialog-backdrop" onPointerDown={e => { if (e.target === e.currentTarget && dismissable) onClose.current?.(); }}>
      <div ref={ref} class={cx('dialog', props.class)} role="dialog" aria-modal="true" aria-labelledby={props.label ? undefined : id.current} aria-label={props.label}
        tabIndex={-1} style={props.width ? { width: typeof props.width === 'number' ? props.width + 'px' : props.width } : undefined} onKeyDown={onKeyDown as any}>
        <header class="dialog-header">
          <h2 class="dialog-title" id={id.current}>{props.title}</h2>
          {props.onClose && (props.closeButton ?? true) && <Button variant="ghost" icon size="sm" tip="Close (Esc)" onClick={() => onClose.current?.()}><X size={14} /></Button>}
        </header>
        <div class="dialog-body">{props.children}</div>
        {props.actions && <footer class={cx('dialog-actions', props.actionsClass)}>{props.actions}</footer>}
      </div>
    </div>
  );
}
