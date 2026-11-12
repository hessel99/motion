// the ease studio: the inspector's easing area rebuilt around feel instead of numbers.
//  - Feel tab: the feel pad (attack x smoothness) + an overshoot knob
//  - Spring tab: a bounce knob with detents at the named springs
//  - Curve tab: the classic bezier editor (rendered by the inspector itself)
//  - live swatches: hover (or keyboard-focus) a swatch and the REAL selected layer plays that
//    ease on the canvas; the spacing lane races the current ease (A) against it (B). click applies.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { parseKeyId } from '../../core/commands';
import { SPRING_PRESETS } from '../../core/easing';
import type { PropKey } from '../../core/model';
import { bezierToFeel, feelName, feelToBezier, type Feel } from './feel';
import { Knob } from './Knob';
import { applyEase, EasePreview, type EaseSpec } from './ops';
import { onTick, setupCanvas } from './ticker';
import { ptPalette } from './palette';
import { drawLane, easeAt as easeY, loopPhase, sameSpec, strokeEase } from './draw';
import { FeelPad } from './FeelPad';
import './patterns.css';

// ---------------- studio state shared with the inspector (which tab is open) ----------------

export type StudioTab = 'feel' | 'spring' | 'curve';
const LS = 'motion.easeStudio';
let enabled = read('enabled') !== 'off';
let tab: StudioTab = (read('tab') as StudioTab) || 'feel';
function read(k: string) { try { return localStorage.getItem(LS + '.' + k); } catch { return null; } }
function write(k: string, v: string) { try { localStorage.setItem(LS + '.' + k, v); } catch { /* private mode */ } }

/** the inspector shows its classic bezier editor + preset chips only when this is true */
export function showClassicEase() { return !enabled || tab === 'curve'; }
export function studioEnabled() { return enabled; }
export function setStudioEnabled(on: boolean) { enabled = on; write('enabled', on ? 'on' : 'off'); editor.store.emit('keys'); }
function setTab(t: StudioTab) { tab = t; write('tab', t); editor.store.emit('keys'); }

// ---------------- swatches ----------------

interface Swatch { name: string; spec: EaseSpec }
const bz = (a: number, k: number, o: number): EaseSpec => ({ kind: 'bezier', v: feelToBezier({ attack: a, smooth: k, overshoot: o }) });
export const SWATCHES: Swatch[] = [
  { name: 'Linear', spec: { kind: 'linear' } },
  { name: 'Silky', spec: bz(0.5, 1, 0) },
  { name: 'Lazy', spec: bz(0.1, 0.9, 0) },
  { name: 'Ease out', spec: bz(0.8, 0.6, 0) },
  { name: 'Snappy', spec: bz(1, 1, 0) },
  { name: 'Overshoot', spec: bz(0.95, 0.75, 0.45) },
  { name: 'Wind-up', spec: bz(0.1, 0.7, 0.55) },
  { name: 'Elastic', spec: bz(0.5, 0.85, 0.55) },
  ...SPRING_PRESETS.map(p => ({ name: p.name + ' spring', spec: { kind: 'spring', bounce: p.bounce } as EaseSpec })),
];

// ---------------- the studio ----------------

interface Seg { layerId: string; key: PropKey; i: number }

function currentSegment(keys: string[]): Seg | null {
  const store = editor.store;
  let seg: Seg | null = null;
  for (const k of keys) {
    const p = parseKeyId(k);
    const kf = store.layer(p.layerId)?.props[p.key]?.kf;
    if (kf && p.index < kf.length - 1) return { layerId: p.layerId, key: p.key, i: p.index };
    if (kf && p.index > 0 && !seg) seg = { layerId: p.layerId, key: p.key, i: p.index - 1 };
  }
  return seg;
}

function specOf(seg: Seg | null): EaseSpec | null {
  if (!seg) return null;
  const kf = editor.store.layer(seg.layerId)!.props[seg.key]!.kf!;
  const a = kf[seg.i], b = kf[seg.i + 1];
  if (a.interp === 'hold') return null;
  if (a.interp === 'linear') return { kind: 'linear' };
  if (a.interp === 'spring') return { kind: 'spring', bounce: a.bounce ?? 0.3 };
  return { kind: 'bezier', v: [a.out[0], a.out[1], b.in[0], b.in[1]] };
}

export function EaseStudio() {
  const store = editor.store;
  const keys = [...store.keySelection];
  const preview = useMemo(() => new EasePreview(store), []);
  const seg = currentSegment(keys);
  const spec = specOf(seg);
  const hover = useRef<Swatch | null>(null);
  const [hoverName, setHoverName] = useState<string | null>(null);
  // the last feel we set, so the puck stays exactly where it was put (the inverse mapping is a
  // nearest-match and could nudge it)
  const lastFeel = useRef<{ v: string; f: Feel } | null>(null);
  const lastBounce = useRef(0.3);
  const gesture = useRef<string | null>(null);
  const kbSession = useRef<{ key: string; at: number } | null>(null);

  const bezStr = spec?.kind === 'bezier' ? spec.v.join(',') : spec?.kind ?? '';
  const feel: Feel = useMemo(() => {
    if (lastFeel.current && lastFeel.current.v === bezStr) return lastFeel.current.f;
    if (spec?.kind === 'bezier') return bezierToFeel(spec.v);
    if (spec?.kind === 'linear') return { attack: 0.5, smooth: 0, overshoot: 0 };
    return lastFeel.current?.f ?? { attack: 0.5, smooth: 0.7, overshoot: 0 };
  }, [bezStr]);
  if (spec?.kind === 'spring') lastBounce.current = spec.bounce;

  // stop previewing when the panel goes away or anything else happens (keys, undo)
  useEffect(() => {
    // the preview also ends itself on any document change / undo / redo (an agent edit, ⌘Z)
    preview.onEnd = () => { hover.current = null; setHoverName(null); };
    const stop = () => { if (preview.active) preview.end(); };
    window.addEventListener('keydown', stop, true);
    return () => { window.removeEventListener('keydown', stop, true); preview.onEnd = null; preview.end(); };
  }, []);

  const setFeel = (f: Feel, mk: string) => {
    const v = feelToBezier(f);
    lastFeel.current = { v: v.join(','), f };
    applyEase(store, keys, v[0] === v[1] && v[2] === v[3] ? { kind: 'linear' } : { kind: 'bezier', v }, mk);
  };
  const onFeel = (f: Feel, phase: 'start' | 'move' | 'end') => {
    if (phase === 'start') gesture.current = 'feel:' + Math.random();
    let mk = gesture.current;
    if (!mk) { // keyboard: nudges within 700ms are one undo step
      const now = performance.now();
      if (!kbSession.current || now - kbSession.current.at > 700) kbSession.current = { key: 'feelkb:' + Math.random(), at: now };
      kbSession.current.at = now;
      mk = kbSession.current.key;
    }
    if (tab !== 'feel') setTab('feel');
    setFeel(f, mk);
    if (phase === 'end') gesture.current = null;
  };

  const startPreview = (s: Swatch) => {
    if (!keys.length) return;
    preview.begin(keys, s.spec);
    if (!preview.active) return;
    hover.current = s;
    setHoverName(s.name);
  };
  // drive the looping preview playhead only while a swatch is previewed
  useEffect(() => (hoverName ? onTick(now => preview.tick(now)) : undefined), [hoverName]);
  const stopPreview = () => {
    hover.current = null;
    setHoverName(null);
    preview.end();
  };
  const applySwatch = (s: Swatch) => {
    const stillHovered = hover.current === s;
    preview.end();
    if (s.spec.kind === 'spring') { applyEase(store, keys, s.spec); if (tab === 'feel') setTab('spring'); }
    else {
      if (s.spec.kind === 'bezier') lastFeel.current = { v: s.spec.v.join(','), f: bezierToFeel(s.spec.v) };
      applyEase(store, keys, s.spec);
      if (tab === 'spring') setTab('feel');
    }
    // keep previewing the (now applied) ease while the pointer stays on it
    if (stillHovered) startPreview(s);
  };

  if (!seg) return null;
  const isSpring = spec?.kind === 'spring';

  return (
    <div class="pt-studio">
      <div class="pt-tabs" role="tablist" aria-label="Easing mode">
        {(['feel', 'spring', 'curve'] as StudioTab[]).map(t => (
          <button role="tab" aria-selected={tab === t} class={'pt-tab' + (tab === t ? ' on' : '')} onClick={() => setTab(t) /* view only: never edits the document */}>{t === 'feel' ? 'Feel' : t === 'spring' ? 'Spring' : 'Curve'}</button>
        ))}
        <span class="pt-feel-name">{hoverName ? <span class="pt-b">B · {hoverName.replace(' spring', '')}</span> : isSpring ? `Spring ${Math.round(lastBounce.current * 100)}%` : spec?.kind === 'linear' ? 'Linear' : feelName(feel)}</span>
      </div>

      {tab === 'feel' && <>
        <FeelPad feel={feel} onFeel={onFeel} inactive={isSpring || !spec} />
        <div class="pt-row">
          <Knob label="Overshoot" value={feel.overshoot} min={0} max={1} defaultValue={0} size={46}
            format={v => Math.round(v * 100) + '%'} detents={[{ v: 0, label: 'none' }]}
            title="Anticipation on lazy curves, overshoot on punchy ones"
            onChange={(v, mk) => setFeel({ ...feel, overshoot: Math.round(v * 100) / 100 }, mk)} />
          <Lane spec={spec} b={hover} hoverName={hoverName} />
        </div>
      </>}

      {tab === 'spring' && (
        <div class="pt-row">
          <Knob label="Bounce" value={isSpring ? lastBounce.current : 0.3} min={0} max={0.9} defaultValue={0.3} size={58}
            format={v => Math.round(v * 100) + '%'} detents={SPRING_PRESETS.map(p => ({ v: p.bounce, label: p.name }))}
            title="0% settles without bouncing; detents click into the named springs"
            onChange={(v, mk) => applyEase(store, keys, { kind: 'spring', bounce: Math.round(v * 100) / 100 }, mk)} />
          <Lane spec={spec} b={hover} hoverName={hoverName} tall />
        </div>
      )}

      {tab === 'curve' && <Lane spec={spec} b={hover} hoverName={hoverName} wide />}

      <div class="pt-swatches" role="listbox" aria-label="Ease swatches: focus or hover to preview on the canvas, Enter or click to apply"
        onPointerLeave={stopPreview}>
        {SWATCHES.map(s => (
          <SwatchTile s={s} on={sameSpec(s.spec, spec)} hovered={hoverName === s.name}
            onEnter={() => startPreview(s)} onApply={() => applySwatch(s)} onLeave={stopPreview} />
        ))}
      </div>
      <div class="pt-hint">Hover a swatch: the selected layer plays it on the canvas.</div>
    </div>
  );
}

// ---------------- A/B spacing lane ----------------

/** how long the lane keeps animating after a change before it settles into a still frame */
const LANE_LIVE_MS = 2 * (220 + 900 + 520);

/** the current ease (A) as a spacing chart with a live ball; while a swatch is hovered, B races it.
 *  it only animates while B is shown or for a couple of loops after A changed, then draws one
 *  still frame and stops ticking (a selected key alone costs nothing per frame). */
function Lane({ spec, b, hoverName, tall, wide }: { spec: EaseSpec | null; b: { current: Swatch | null }; hoverName: string | null; tall?: boolean; wide?: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const specRef = useRef(spec);
  specRef.current = spec;
  const W = wide ? 236 : 168, H = tall ? 70 : 56;
  const anim = useRef<{ off: (() => void) | null; until: number }>({ off: null, until: 0 });
  useEffect(() => () => { anim.current.off?.(); anim.current.off = null; }, []);
  const specKey = spec ? JSON.stringify(spec) : '';
  useEffect(() => {
    const c = cv.current!;
    const paint = (ph: number) => {
      const ctx = setupCanvas(c, W, H);
      const P = ptPalette();
      const { accent, warm } = P;
      const dim = P.ink(0.4);
      ctx.clearRect(0, 0, W, H);
      const A = specRef.current, B = b.current?.spec ?? null;
      const x0 = 14, x1 = W - 26;
      // faint curve of A behind the lanes
      if (A) {
        ctx.strokeStyle = P.ink(0.1);
        ctx.lineWidth = 1.5;
        strokeEase(ctx, A, x0, 6, x1 - x0, H - 12, -0.25, A.kind === 'spring' ? 1.6 : 1.3, 48);
      }
      if (B) {
        if (A) drawLane(ctx, A, x0, x1, H * 0.32, ph, accent, dim);
        drawLane(ctx, B, x0, x1, H * 0.7, ph, warm, P.warmA(0.35));
        ctx.font = '600 8px Inter, system-ui, sans-serif';
        ctx.fillStyle = P.ink(0.5);
        ctx.fillText('A', 2, H * 0.32 + 3);
        ctx.fillStyle = warm;
        ctx.fillText('B', 2, H * 0.7 + 3);
      } else if (A) drawLane(ctx, A, x0, x1, H / 2, ph, accent, dim);
      // end marks
      ctx.fillStyle = P.ink(0.2);
      ctx.fillRect(x0 - 0.5, 8, 1, H - 16); ctx.fillRect(x1 - 0.5, 8, 1, H - 16);
    };
    const a = anim.current;
    a.until = performance.now() + LANE_LIVE_MS;
    a.off?.();
    a.off = onTick(now => {
      if (!c.isConnected) return;
      const live = !!b.current || now < a.until;
      paint(live ? loopPhase(now) : 1);
      if (!live) { a.off?.(); a.off = null; }
    });
  }, [W, H, specKey, hoverName]);
  return <canvas ref={cv} class="pt-lane" aria-hidden="true" />;
}

// ---------------- swatch tile ----------------

function SwatchTile({ s, on, hovered, onEnter, onLeave, onApply }: { s: Swatch; on: boolean; hovered: boolean; onEnter: () => void; onLeave: () => void; onApply: () => void }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const W = 50, H = 26;
  const draw = (ph: number) => {
    const c = cv.current;
    if (!c) return;
    const ctx = setupCanvas(c, W, H);
    ctx.clearRect(0, 0, W, H);
    const spring = s.spec.kind === 'spring';
    const lo = spring ? -0.1 : -0.35, hi = spring ? 1.6 : 1.35;
    const P = ptPalette();
    ctx.strokeStyle = hovered ? P.warm : on ? P.accent : P.ink(0.55);
    ctx.lineWidth = 1.4;
    strokeEase(ctx, s.spec, 3, 2, W - 6, H - 4, lo, hi, 30);
    if (ph >= 0) {
      const y = 2 + (H - 4) - ((easeY(s.spec, ph) - lo) / (hi - lo)) * (H - 4);
      ctx.fillStyle = P.ink(1);
      ctx.beginPath(); ctx.arc(3 + ph * (W - 6), y, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  };
  useEffect(() => {
    draw(-1);
    if (!hovered) return;
    return onTick(now => draw(loopPhase(now, 800, 150, 350)));
  }, [hovered, on]);
  return (
    <button role="option" aria-selected={on} class={'pt-swatch' + (on ? ' on' : '') + (hovered ? ' hover' : '')}
      title={`${s.name} — hover to preview on the canvas, click to apply`}
      onPointerEnter={onEnter} onFocus={onEnter} onBlur={onLeave} onClick={onApply}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onApply(); } }}>
      <canvas ref={cv} />
      <span>{s.name.replace(' spring', '')}{s.spec.kind === 'spring' && <i class="pt-spring-dot" />}</span>
    </button>
  );
}

/** the studio on/off pill shown in the easing section title */
export function StudioSwitch() {
  return (
    <button class={'pt-switch' + (enabled ? ' on' : '')} aria-pressed={enabled} title={enabled ? 'Ease studio on (click for the classic editor)' : 'Turn on the ease studio'}
      onClick={() => setStudioEnabled(!enabled)}>Studio</button>
  );
}
