// a hardware-style rotary knob (Teenage Engineering-ish): an LED ring shows the value, detents
// click into named values, drag up/right to turn (shift = fine), wheel, arrow keys, double-click
// or Backspace resets. every turn is ONE undo step: the knob hands out a merge key per gesture.

import { useRef } from 'preact/hooks';
import './patterns.css';

export interface Detent { v: number; label?: string }

export interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** logarithmic travel (durations, ratios) */
  log?: boolean;
  format?: (v: number) => string;
  /** called with the merge key of the current gesture (drag, wheel burst or key burst) */
  onChange: (v: number, mergeKey: string) => void;
  /** a gesture starts (take snapshots here) */
  onStart?: () => void;
  onEnd?: () => void;
  defaultValue?: number;
  detents?: Detent[];
  size?: number;
  disabled?: boolean;
  title?: string;
  /** accent color override (css color) */
  hue?: string;
}

const SWEEP = 270; // degrees of travel
const LEDS = 19;

export function Knob(p: KnobProps) {
  const size = p.size ?? 52;
  const toN = (v: number) => {
    if (p.log) { const a = Math.log(Math.max(1e-6, p.min)), b = Math.log(p.max); return (Math.log(Math.max(1e-6, v)) - a) / (b - a); }
    return (v - p.min) / (p.max - p.min || 1);
  };
  const fromN = (n: number) => {
    n = Math.min(1, Math.max(0, n));
    if (p.log) { const a = Math.log(Math.max(1e-6, p.min)), b = Math.log(p.max); return Math.exp(a + (b - a) * n); }
    return p.min + (p.max - p.min) * n;
  };
  const n = Math.min(1, Math.max(0, toN(p.value)));
  const session = useRef<{ key: string; last: number; raw: number } | null>(null);
  const flash = useRef<SVGGElement>(null);

  const begin = () => {
    const now = performance.now();
    if (!session.current || now - session.current.last > 700) {
      if (session.current) p.onEnd?.();
      session.current = { key: 'knob:' + p.label + ':' + Math.random(), last: now, raw: n };
      p.onStart?.();
    }
    session.current.last = now;
    return session.current;
  };
  /** magnetic detents: within 2.5% of travel, the knob clicks into place */
  const emit = (raw: number) => {
    const s = session.current!;
    s.raw = Math.min(1, Math.max(0, raw));
    let out = s.raw;
    for (const d of p.detents ?? []) {
      const dn = toN(d.v);
      if (Math.abs(dn - out) < 0.025) {
        if (Math.abs(n - dn) > 1e-4) flash.current?.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 260 });
        p.onChange(d.v, s.key);
        return;
      }
    }
    p.onChange(fromN(out), s.key);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (p.disabled || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).focus({ focusVisible: false } as FocusOptions);
    session.current = null;
    const s = begin();
    s.raw = n;
    let lx = e.clientX, ly = e.clientY;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.classList.add('turning');
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - lx) - (ev.clientY - ly);
      lx = ev.clientX; ly = ev.clientY;
      s.last = performance.now();
      emit(s.raw + d / (ev.shiftKey ? 900 : 180));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('turning');
      session.current = null;
      p.onEnd?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const nudge = (d: number) => { const s = begin(); emit((Math.abs(s.raw - n) > 0.03 ? n : s.raw) + d); };
  const reset = () => { if (p.defaultValue === undefined) return; session.current = null; const s = begin(); p.onChange(p.defaultValue, s.key); session.current = null; p.onEnd?.(); };

  // geometry
  const c = size / 2, rLed = size / 2 - 3, rBody = size / 2 - 9;
  const ang = (t: number) => ((-SWEEP / 2 + t * SWEEP) - 90) * Math.PI / 180;
  const leds = [];
  for (let i = 0; i < LEDS; i++) {
    const t = i / (LEDS - 1), a = ang(t);
    leds.push(<circle cx={c + Math.cos(a) * rLed} cy={c + Math.sin(a) * rLed} r={1.5} class={'knob-led' + (t <= n + 1e-6 ? ' on' : '')} />);
  }
  const ticks = (p.detents ?? []).map(d => {
    const a = ang(toN(d.v));
    return <line x1={c + Math.cos(a) * (rBody + 1)} y1={c + Math.sin(a) * (rBody + 1)} x2={c + Math.cos(a) * (rBody + 3.5)} y2={c + Math.sin(a) * (rBody + 3.5)} class="knob-tick" />;
  });
  const a = ang(n);
  const fmt = p.format ?? ((v: number) => (Math.round(v * 100) / 100).toString());
  const detentHit = p.detents?.find(d => Math.abs(toN(d.v) - n) < 1e-3);
  return (
    <div class={'pt-knob' + (p.disabled ? ' disabled' : '')} style={p.hue ? { '--pt-hue': p.hue } as any : undefined} title={p.title}>
      <div class="pt-knob-label">{p.label}</div>
      <div
        class="pt-knob-dial" tabIndex={p.disabled ? -1 : 0} role="slider"
        aria-label={p.label} aria-valuemin={p.min} aria-valuemax={p.max} aria-valuenow={p.value} aria-valuetext={fmt(p.value)}
        onPointerDown={onPointerDown as any}
        onDblClick={reset}
        onWheel={e => { if (p.disabled) return; e.preventDefault(); nudge((e.deltaY > 0 ? -1 : 1) * (e.shiftKey ? 0.004 : 0.02)); }}
        onKeyDown={e => {
          if (p.disabled) return;
          const fine = e.shiftKey ? 0.1 : 0.02;
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); nudge(fine); }
          else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); nudge(-fine); }
          else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); nudge(-1); }
          else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); nudge(1); }
          else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); reset(); }
        }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {leds}
          {ticks}
          <circle cx={c} cy={c} r={rBody} class="knob-body" />
          <circle cx={c} cy={c} r={rBody - 3} class="knob-cap" />
          <line x1={c + Math.cos(a) * (rBody - 9)} y1={c + Math.sin(a) * (rBody - 9)} x2={c + Math.cos(a) * (rBody - 3)} y2={c + Math.sin(a) * (rBody - 3)} class="knob-pointer" />
          <g ref={flash} style={{ opacity: 0 }}><circle cx={c} cy={c} r={rBody + 2} class="knob-flash" /></g>
        </svg>
      </div>
      <div class="pt-knob-value">{detentHit?.label ?? fmt(p.value)}</div>
    </div>
  );
}
