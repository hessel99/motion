import { useEffect, useRef, useState } from 'preact/hooks';
import { editor } from '../app/editor';
import {
  addKeyframe, deleteKeyframes, isAnimated, keyId, parseKeyId, setCompSettings, setEase, setLayerField, setProp,
  setSegmentHandles, toggleAnimated, valueAt, setSpring,
} from '../core/commands';
import { EASE_PRESETS, SPRING_PRESETS, springAt } from '../core/easing';
import { PROP_DEFS, TYPE_PROPS, type Layer, type PropKey, type TextData } from '../core/model';
import { useChannels } from './hooks';
import { ANIM_PRESETS, alignLayers, applyPreset, distributeLayers, type Align } from '../core/presets';
import { invert } from './viewport-controller';
import { toast } from '../app/actions';

const st = () => editor.store;

export function Inspector() {
  useChannels(['selection', 'doc', 'time', 'keys', 'playing']);
  const store = st();
  if (store.playing) return <div class="inspector"><div class="insp-empty">Playing…</div></div>;
  const sel = store.selection.map(id => store.layer(id)).filter(Boolean) as Layer[];
  return (
    <div class="inspector">
      {store.keySelection.size > 0 && <EasePanel />}
      {sel.length === 0 && <CompPanel />}
      {sel.length > 0 && <LayerPanel layers={sel} />}
    </div>
  );
}

function Section(props: { title: string; children: any; right?: any }) {
  return (
    <div class="insp-section">
      <div class="insp-title"><span>{props.title}</span>{props.right}</div>
      {props.children}
    </div>
  );
}

// ---------------- number field (scrub label + input) ----------------
export function NumField(props: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number, mergeKey?: string) => void; suffix?: string; title?: string }) {
  const [text, setText] = useState<string | null>(null);
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
    if (text == null) return;
    const v = evalExpr(text, props.value);
    setText(null);
    if (v != null && isFinite(v)) props.onChange(clamp(v));
  };
  return (
    <label class="num" title={props.title}>
      <span class="num-label" onPointerDown={onScrub as any}>{props.label}</span>
      <input
        value={text ?? fmt(props.value) + (props.suffix ?? '')}
        onFocus={e => { setText(fmt(props.value)); requestAnimationFrame(() => (e.target as HTMLInputElement).select()); }}
        onInput={e => setText((e.target as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { setText(null); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1);
            props.onChange(clamp(props.value + d));
            setText(fmt(clamp(props.value + d)));
          }
        }}
      />
    </label>
  );
}

/** allows simple math in fields: "100+20", "*2", "/2" */
function evalExpr(s: string, cur: number): number | null {
  s = s.trim().replace(/[^0-9+\-*/(). e]/gi, '');
  if (!s) return null;
  if (/^[*/+]/.test(s)) s = cur + s;
  try { return Function(`"use strict";return (${s})`)() as number; } catch { return null; }
}

// ---------------- keyframe toggle ----------------
function KeyButton(props: { layers: Layer[]; prop: PropKey }) {
  const store = st();
  const animated = props.layers.some(l => isAnimated(l, props.prop));
  const atKey = props.layers.some(l => l.props[props.prop]?.kf?.some(k => Math.abs(k.t - store.time) < 1e-6));
  const click = (e: MouseEvent) => {
    const ids = props.layers.map(l => l.id);
    if (e.altKey || (animated && e.shiftKey)) { toggleAnimated(store, ids, props.prop); return; }
    if (atKey) {
      const keys: string[] = [];
      for (const l of props.layers) l.props[props.prop]?.kf?.forEach((k, i) => { if (Math.abs(k.t - store.time) < 1e-6) keys.push(keyId(l.id, props.prop, i)); });
      deleteKeyframes(store, keys);
    } else addKeyframe(store, ids, props.prop);
    (globalThis as any).timeline?.expand(ids[0], true);
  };
  return (
    <button class={'keybtn' + (animated ? ' animated' : '') + (atKey ? ' at' : '')} title={animated ? 'Add/remove keyframe (alt: stop animating)' : 'Animate this property'} onClick={click}>
      <svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z" /></svg>
    </button>
  );
}

// ---------------- layer panel ----------------
function LayerPanel({ layers }: { layers: Layer[] }) {
  const store = st();
  const l = layers[0];
  const t = store.time;
  const ids = layers.map(x => x.id);
  const set = (key: PropKey, v: number[], mk?: string) => { for (const x of layers) setProp(store, x.id, key, v, { mergeKey: mk }); };
  const v = (key: PropKey) => valueAt(l, key, t);
  const pos = v('position'), size = v('size'), scale = v('scale'), anchor = v('anchor');
  const rot = v('rotation')[0], opa = v('opacity')[0];
  const types = new Set(layers.map(x => x.type));
  const common = [...types].reduce<PropKey[]>((acc, ty, i) => (i === 0 ? TYPE_PROPS[ty] : acc.filter(p => TYPE_PROPS[ty].includes(p))), []);
  const vec = (key: PropKey, idx: number, val: number, cur: number[], mk?: string) => { const n = cur.slice(); n[idx] = val; set(key, n, mk); };
  // per-layer vector set keeps other layers' components
  const vecMulti = (key: PropKey, idx: number, val: number, mk?: string) => {
    for (const x of layers) { const n = valueAt(x, key, t); n[idx] = val; setProp(store, x.id, key, n, { mergeKey: mk }); }
  };
  return (
    <>
      <AlignBar ids={ids} />
      <Section title={layers.length > 1 ? `${layers.length} layers` : l.name} right={<span class="insp-type">{layers.length > 1 ? 'mixed' : l.type}</span>}>
        <div class="row">
          <KeyButton layers={layers} prop="position" />
          <NumField label="X" value={pos[0]} onChange={(n, mk) => vecMulti('position', 0, n, mk)} />
          <NumField label="Y" value={pos[1]} onChange={(n, mk) => vecMulti('position', 1, n, mk)} />
        </div>
        {common.includes('size') && (
          <div class="row">
            <KeyButton layers={layers} prop="size" />
            <NumField label="W" min={0} value={size[0]} onChange={(n, mk) => sizeChange(layers, 0, n, mk)} />
            <NumField label="H" min={0} value={size[1]} onChange={(n, mk) => sizeChange(layers, 1, n, mk)} />
          </div>
        )}
        <div class="row">
          <KeyButton layers={layers} prop="scale" />
          <NumField label="SX" value={scale[0]} suffix="%" onChange={(n, mk) => vecMulti('scale', 0, n, mk)} />
          <NumField label="SY" value={scale[1]} suffix="%" onChange={(n, mk) => vecMulti('scale', 1, n, mk)} />
        </div>
        <div class="row">
          <KeyButton layers={layers} prop="rotation" />
          <NumField label="↻" title="Rotation" value={rot} suffix="°" onChange={(n, mk) => set('rotation', [n], mk)} />
          <KeyButton layers={layers} prop="opacity" />
          <NumField label="◐" title="Opacity" value={opa} min={0} max={100} suffix="%" onChange={(n, mk) => set('opacity', [n], mk)} />
        </div>
        <div class="row">
          <KeyButton layers={layers} prop="anchor" />
          <NumField label="AX" title="Anchor X" value={anchor[0]} onChange={(n, mk) => vec('anchor', 0, n, anchor, mk)} />
          <NumField label="AY" title="Anchor Y" value={anchor[1]} onChange={(n, mk) => vec('anchor', 1, n, anchor, mk)} />
        </div>
      </Section>
      {common.includes('radius') && (
        <Section title="Corner radius">
          <div class="row">
            <KeyButton layers={layers} prop="radius" />
            <NumField label="R" min={0} value={v('radius')[0]} onChange={(n, mk) => set('radius', [n, n, n, n], mk)} />
            <span class="muted small">{v('radius').every(x => x === v('radius')[0]) ? '' : v('radius').map(x => Math.round(x)).join(' ')}</span>
          </div>
        </Section>
      )}
      {common.includes('fill') && (
        <Section title="Fill">
          <div class="row">
            <KeyButton layers={layers} prop="fill" />
            <ColorField value={v('fill')} onChange={(c, mk) => set('fill', c, mk)} />
          </div>
          {l.paints?.some(p => p.type !== 'solid') && <div class="muted small">gradient fill (from import)</div>}
        </Section>
      )}
      {common.includes('stroke') && (
        <Section title="Stroke">
          <div class="row">
            <KeyButton layers={layers} prop="stroke" />
            <ColorField value={v('stroke')} onChange={(c, mk) => set('stroke', c, mk)} />
          </div>
          <div class="row">
            <KeyButton layers={layers} prop="strokeWidth" />
            <NumField label="W" min={0} value={v('strokeWidth')[0]} onChange={(n, mk) => set('strokeWidth', [n], mk)} />
            <select value={l.strokeAlign ?? 'center'} onChange={e => setLayerField(store, ids, 'strokeAlign', (e.target as HTMLSelectElement).value as any)}>
              <option value="inside">Inside</option><option value="center">Center</option><option value="outside">Outside</option>
            </select>
          </div>
        </Section>
      )}
      {layers.length === 1 && l.type === 'text' && <TextPanel layer={l} />}
      {layers.length === 1 && l.type === 'group' && (
        <Section title="Frame">
          <label class="check"><input type="checkbox" checked={!!l.clip} onChange={e => setLayerField(store, ids, 'clip', (e.target as HTMLInputElement).checked, 'Clip content')} /> Clip content</label>
        </Section>
      )}
      {layers.length === 1 && l.type === 'precomp' && l.compRef && (
        <Section title="Composition" right={<button class="ghost" onClick={() => store.openComp(l.compRef!)}>Open ↗</button>}>
          <div class="row">
            <NumField label="Start" step={1 / store.comp.fps} value={l.startTime ?? 0} suffix="s" onChange={n => setLayerField(store, ids, 'startTime', n, 'Precomp start')} />
          </div>
          <div class="muted small">{store.project.comps[l.compRef]?.name}</div>
        </Section>
      )}
      {layers.length === 1 && (
        <Section title="Mask">
          <label class="check"><input type="checkbox" checked={!!l.mask} onChange={e => setLayerField(store, ids, 'mask', (e.target as HTMLInputElement).checked, 'Use as mask')} /> Use as mask (masks the layers above it in the same group)</label>
        </Section>
      )}
      <AnimatePanel ids={ids} />
      <Section title="Timing">
        <div class="row">
          <NumField label="In" step={1 / store.comp.fps} min={0} value={l.inPoint} suffix="s" onChange={n => setLayerField(store, ids, 'inPoint', n)} />
          <NumField label="Out" step={1 / store.comp.fps} min={0} value={Math.min(l.outPoint, store.comp.duration)} suffix="s" onChange={n => setLayerField(store, ids, 'outPoint', n >= store.comp.duration ? 1e9 : n)} />
        </div>
      </Section>
    </>
  );
}

function sizeChange(layers: Layer[], idx: number, n: number, mk?: string) {
  const store = st();
  for (const l of layers) {
    const t = store.time;
    const size = valueAt(l, 'size', t), anchor = valueAt(l, 'anchor', t);
    const ns = size.slice(); ns[idx] = n;
    // keep anchor at same relative spot
    const na = anchor.slice();
    if (size[idx] > 0) na[idx] = anchor[idx] / size[idx] * n;
    setProp(store, l.id, 'size', ns, { mergeKey: mk });
    if (!isAnimated(l, 'anchor')) setProp(store, l.id, 'anchor', na, { mergeKey: mk });
  }
}

function TextPanel({ layer }: { layer: Layer }) {
  const store = st();
  const t = layer.text!;
  const set = (patch: Partial<TextData>) => store.transact('Edit text', tx => { tx.set(layer, 'text', { ...layer.text!, ...patch }); tx.touch(layer.id); });
  return (
    <Section title="Text">
      <textarea class="text-edit" value={t.content} onInput={e => set({ content: (e.target as HTMLTextAreaElement).value })} onKeyDown={e => e.stopPropagation()} rows={3} />
      <div class="row">
        <input class="font-input" value={t.fontFamily} onChange={e => set({ fontFamily: (e.target as HTMLInputElement).value })} onKeyDown={e => e.stopPropagation()} />
        <select value={String(t.fontWeight)} onChange={e => set({ fontWeight: +(e.target as HTMLSelectElement).value })}>
          {[100, 200, 300, 400, 500, 600, 700, 800, 900].map(w => <option value={w}>{w}</option>)}
        </select>
      </div>
      <div class="row">
        <NumField label="Size" min={1} value={t.fontSize} onChange={n => set({ fontSize: n })} />
        <NumField label="LH" step={0.01} min={0.5} value={t.lineHeight} onChange={n => set({ lineHeight: n })} />
        <NumField label="LS" step={0.1} value={t.letterSpacing} onChange={n => set({ letterSpacing: n })} />
      </div>
      <div class="row seg">
        {(['left', 'center', 'right'] as const).map(a => <button class={t.align === a ? 'on' : ''} onClick={() => set({ align: a })}>{a}</button>)}
      </div>
    </Section>
  );
}

// ---------------- color ----------------
function ColorField({ value, onChange }: { value: number[]; onChange: (c: number[], mk?: string) => void }) {
  const hex = '#' + value.slice(0, 3).map(c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('');
  const mk = useRef('color' + Math.random());
  return (
    <div class="color-field">
      <input type="color" value={hex} onInput={e => {
        const h = (e.target as HTMLInputElement).value;
        onChange([parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, value[3]], mk.current);
      }} onChange={() => (mk.current = 'color' + Math.random())} />
      <input class="hex" value={hex.slice(1).toUpperCase()} onKeyDown={e => e.stopPropagation()} onChange={e => {
        const h = (e.target as HTMLInputElement).value.replace('#', '');
        if (/^[0-9a-f]{6}$/i.test(h)) onChange([parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, value[3]]);
      }} />
      <NumField label="A" min={0} max={100} value={Math.round(value[3] * 100)} suffix="%" onChange={(n, k) => onChange([value[0], value[1], value[2], n / 100], k)} />
    </div>
  );
}

// ---------------- composition ----------------
function CompPanel() {
  const store = st();
  const c = store.comp;
  return (
    <Section title="Composition">
      <div class="row">
        <NumField label="W" min={1} value={c.width} onChange={n => setCompSettings(store, { width: Math.round(n) })} />
        <NumField label="H" min={1} value={c.height} onChange={n => setCompSettings(store, { height: Math.round(n) })} />
      </div>
      <div class="row">
        <NumField label="FPS" min={1} max={240} value={c.fps} onChange={n => setCompSettings(store, { fps: Math.round(n) })} />
        <NumField label="Dur" min={0.1} step={0.1} value={c.duration} suffix="s" onChange={n => setCompSettings(store, { duration: n })} />
      </div>
      <div class="row">
        <span class="muted small" style={{ width: '70px' }}>Background</span>
        <ColorField value={c.background} onChange={col => setCompSettings(store, { background: col as any })} />
      </div>
      <div class="muted small hint">
        Tip: copy layers in Figma and press ⌘V here. Drop .json (Lottie), .aep, .svg or images onto the canvas.
      </div>
    </Section>
  );
}

// ---------------- easing editor ----------------
function EasePanel() {
  const store = st();
  const keys = [...store.keySelection];
  // pick the first selected key that has a following segment
  let seg: { layerId: string; key: PropKey; i: number } | null = null;
  for (const k of keys) {
    const p = parseKeyId(k);
    const kf = store.layer(p.layerId)?.props[p.key]?.kf;
    if (kf && p.index < kf.length - 1) { seg = { layerId: p.layerId, key: p.key, i: p.index }; break; }
    if (kf && p.index > 0 && !seg) seg = { layerId: p.layerId, key: p.key, i: p.index - 1 };
  }
  const kf = seg ? store.layer(seg.layerId)!.props[seg.key]!.kf! : null;
  const a = kf && seg ? kf[seg.i] : null, b = kf && seg ? kf[seg.i + 1] : null;
  const cur: [number, number, number, number] = a && b ? (a.interp === 'linear' ? [0, 0, 1, 1] : [a.out[0], a.out[1], b.in[0], b.in[1]]) : [0.333, 0, 0.667, 1];
  const active = EASE_PRESETS.find(p => p.v.every((x, i) => Math.abs(x - cur[i]) < 1e-3));
  return (
    <Section title={`Easing · ${keys.length} key${keys.length > 1 ? 's' : ''}`} right={seg && <span class="insp-type">{PROP_DEFS[seg.key].label}</span>}>
      {a && b && seg && a.interp === 'spring' && <SpringView bounce={a.bounce ?? 0.3} onChange={v => setSpring(store, keys, v)} />}
      {a && b && seg && a.interp !== 'hold' && a.interp !== 'spring' && (
        <CurveEditor value={cur} onChange={(v, mk) => setSegmentHandles(store, seg!.layerId, seg!.key, seg!.i, [v[0], v[1]], [v[2], v[3]], mk)} />
      )}
      {a?.interp === 'hold' && <div class="muted small">Hold keyframe (no interpolation)</div>}
      <div class="ease-group">Springs</div>
      <div class="ease-presets">
        {SPRING_PRESETS.map(p => (
          <button class={'ease-chip' + (a?.interp === 'spring' && Math.abs((a.bounce ?? 0.3) - p.bounce) < 1e-3 ? ' on' : '')} onClick={() => setSpring(store, keys, p.bounce)}>
            <MiniSpring bounce={p.bounce} />
            <span>{p.name}</span>
          </button>
        ))}
      </div>
      <div class="ease-group">Curves</div>
      <div class="ease-presets">
        {EASE_PRESETS.map(p => (
          <button class={'ease-chip' + (a?.interp !== 'spring' && active?.name === p.name ? ' on' : '')} title={p.v.join(', ')} onClick={() => setEase(store, keys, p.name)}>
            <MiniCurve v={p.v} />
            <span>{p.name}</span>
          </button>
        ))}
      </div>
      <div class="row small muted">cubic-bezier({cur.map(x => Math.round(x * 100) / 100).join(', ')})</div>
    </Section>
  );
}

function MiniSpring({ bounce }: { bounce: number }) {
  const s = 18, p = 2;
  let d = '';
  for (let i = 0; i <= 24; i++) {
    const x = i / 24, y = springAt(bounce, x);
    d += `${i ? 'L' : 'M'}${(p + x * (s - 2 * p)).toFixed(1)} ${(s - p - y * (s - 2 * p) * 0.7 - (s - 2 * p) * 0.15).toFixed(1)}`;
  }
  return <svg width={s} height={s}><path d={d} fill="none" stroke="currentColor" stroke-width="1.4" /></svg>;
}

function SpringView({ bounce, onChange }: { bounce: number; onChange: (b: number) => void }) {
  const W = 236, H = 120, pad = 14;
  let d = '';
  for (let i = 0; i <= 120; i++) {
    const x = i / 120, y = springAt(bounce, x);
    d += `${i ? 'L' : 'M'}${(pad + x * (W - 2 * pad)).toFixed(1)} ${(H - pad - (y / 1.5) * (H - 2 * pad)).toFixed(1)}`;
  }
  return (
    <div>
      <svg class="curve" width={W} height={H}>
        <line x1={pad} x2={W - pad} y1={H - pad - (1 / 1.5) * (H - 2 * pad)} y2={H - pad - (1 / 1.5) * (H - 2 * pad)} class="curve-box" />
        <path d={d} class="curve-path" />
      </svg>
      <div class="row">
        <span class="muted small">Bounce</span>
        <input type="range" min="0" max="0.9" step="0.01" value={bounce} style={{ flex: 1 }} onChange={e => onChange(+(e.target as HTMLInputElement).value)} />
        <span class="small">{Math.round(bounce * 100)}%</span>
      </div>
    </div>
  );
}

function MiniCurve({ v }: { v: number[] }) {
  const s = 18, p = 2;
  const X = (x: number) => p + x * (s - 2 * p), Y = (y: number) => s - p - y * (s - 2 * p) * 0.7 - (s - 2 * p) * 0.15;
  return <svg width={s} height={s}><path d={`M${X(0)} ${Y(0)} C${X(v[0])} ${Y(v[1])} ${X(v[2])} ${Y(v[3])} ${X(1)} ${Y(1)}`} fill="none" stroke="currentColor" stroke-width="1.4" /></svg>;
}

function CurveEditor({ value, onChange }: { value: [number, number, number, number]; onChange: (v: [number, number, number, number], mk?: string) => void }) {
  const W = 236, H = 180, pad = 18;
  // y range shows overshoot room
  const ymin = Math.min(-0.25, value[1] - 0.1, value[3] - 0.1), ymax = Math.max(1.25, value[1] + 0.1, value[3] + 0.1);
  const X = (x: number) => pad + x * (W - 2 * pad);
  const Y = (y: number) => H - pad - ((y - ymin) / (ymax - ymin)) * (H - 2 * pad);
  const svg = useRef<SVGSVGElement>(null);
  const [preview, setPreview] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => { setPreview(((now - start) / 1200) % 1.4); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const drag = (which: 0 | 1) => (e: PointerEvent) => {
    e.preventDefault();
    const el = svg.current!;
    const r = el.getBoundingClientRect();
    const mk = 'curve' + Math.random();
    (e.target as Element).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x = Math.min(1, Math.max(0, (ev.clientX - r.left - pad) / (W - 2 * pad)));
      const y = ymin + ((H - pad - (ev.clientY - r.top)) / (H - 2 * pad)) * (ymax - ymin);
      const v = value.slice() as [number, number, number, number];
      v[which * 2] = Math.round(x * 1000) / 1000;
      v[which * 2 + 1] = Math.round(y * 1000) / 1000;
      onChange(v, mk);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // preview dot along eased progress
  const p = Math.min(1, preview);
  const ease = bez(value);
  const py = ease(p);
  return (
    <svg ref={svg} class="curve" width={W} height={H}>
      <rect x={X(0)} y={Y(1)} width={X(1) - X(0)} height={Y(0) - Y(1)} class="curve-box" />
      <line x1={X(0)} y1={Y(0)} x2={X(value[0])} y2={Y(value[1])} class="curve-arm" />
      <line x1={X(1)} y1={Y(1)} x2={X(value[2])} y2={Y(value[3])} class="curve-arm" />
      <path d={`M${X(0)} ${Y(0)} C${X(value[0])} ${Y(value[1])} ${X(value[2])} ${Y(value[3])} ${X(1)} ${Y(1)}`} class="curve-path" />
      <circle cx={X(value[0])} cy={Y(value[1])} r="6" class="curve-handle" onPointerDown={drag(0) as any} />
      <circle cx={X(value[2])} cy={Y(value[3])} r="6" class="curve-handle" onPointerDown={drag(1) as any} />
      <circle cx={X(p)} cy={Y(py)} r="3" class="curve-dot" />
      <rect x={W - 12} y={Y(py) - 4} width="8" height="8" rx="2" class="curve-dot" />
    </svg>
  );
}

import { cubicBezier } from '../core/easing';
function bez(v: number[]) { return cubicBezier(v[0], v[1], v[2], v[3]); }

// ---------------- align / animate ----------------
const vpBounds = (id: string) => (globalThis as any).viewport?.boundsOf([id]) ?? null;
const parentInv = (id: string) => {
  const l = st().layer(id);
  const w = l?.parent ? editor.renderer.worldMatrix(l.parent) : null;
  return invert(w ?? [1, 0, 0, 1, 0, 0]);
};

function AlignBar({ ids }: { ids: string[] }) {
  const store = st();
  const btn = (how: Align, title: string, icon: string) => (
    <button class="ghost icon" title={title + (ids.length === 1 ? ' (to composition)' : '')} onClick={() => alignLayers(store, ids, how, vpBounds, parentInv)}>{icon}</button>
  );
  return (
    <div class="align-bar">
      {btn('left', 'Align left', '⇤')}{btn('hcenter', 'Align horizontal centers', '↔')}{btn('right', 'Align right', '⇥')}
      {btn('top', 'Align top', '⤒')}{btn('vcenter', 'Align vertical centers', '↕')}{btn('bottom', 'Align bottom', '⤓')}
      <button class="ghost icon" disabled={ids.length < 3} title="Distribute horizontally" onClick={() => distributeLayers(store, ids, 'x', vpBounds, parentInv)}>⋯</button>
      <button class="ghost icon" disabled={ids.length < 3} title="Distribute vertically" onClick={() => distributeLayers(store, ids, 'y', vpBounds, parentInv)}>⋮</button>
    </div>
  );
}

function AnimatePanel({ ids }: { ids: string[] }) {
  const store = st();
  const [dur, setDur] = useState(0.6);
  const [stagger, setStagger] = useState(0.08);
  const apply = (name: string) => {
    try { applyPreset(store, ids, name, { duration: dur, stagger: ids.length > 1 ? stagger : 0 }); (globalThis as any).timeline?.expand(ids[0], true); }
    catch (e: any) { toast(e.message, 'error'); }
  };
  return (
    <Section title="Animate" right={<span class="insp-type">at playhead</span>}>
      <div class="preset-grid">
        {ANIM_PRESETS.map(p => <button class={'preset ' + p.kind} title={p.kind === 'out' ? 'ends at the playhead' : 'starts at the playhead'} onClick={() => apply(p.name)}>{p.name}</button>)}
      </div>
      <div class="row">
        <NumField label="Dur" step={0.05} min={0.05} value={dur} suffix="s" onChange={setDur} />
        {ids.length > 1 && <NumField label="Stagger" step={0.01} min={0} value={stagger} suffix="s" onChange={setStagger} />}
      </div>
    </Section>
  );
}
