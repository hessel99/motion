import { useEffect, useRef, useState } from 'preact/hooks';
import { editor } from '../app/editor';
import {
  addKeyframe, deleteKeyframes, isAnimated, keyId, parseKeyId, setCompSettings, setEase, setLayerField, setProp,
  setSegmentHandles, toggleAnimated, valueAt, setSpring, setExpr, renameComp,
} from '../core/commands';
import { checkExpr, EXPR_PROPS } from '../core/expr';
import { starGeometry } from '../core/shapes';
import { EASE_PRESETS, SPRING_PRESETS, springAt } from '../core/easing';
import { BLEND_MODES, PROP_DEFS, propDef, TYPE_PROPS, type Layer, type PropKey, type TextData } from '../core/model';
import { ShaderPanel } from './ShaderPanel';
import { useChannels } from './hooks';
import { alignLayers, distributeLayers, setTextAnim, TEXT_ANIM_PRESETS, type Align } from '../core/presets';
import { invert } from './viewport-controller';
import { toast } from '../app/actions';
import { AudioInspector } from './audio/AudioInspector';
import { Button, Checkbox, ColorSwatch, FieldRow, NumField, Section, Segmented, Slider, Toggle } from './ui';
import { ComponentBox, LinkButton, LinkedChip, sharedLink } from './LinkControls';
import { ComponentPanel, ExposeSection, InstancePanel } from './ComponentPanels';
import { instanceComp } from '../core/motion-components';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal,
  AlignStartVertical, AlignVerticalDistributeCenter, ArrowUpRight, Blend, ChevronLeft, ChevronRight, Minus,
  RotateCw, X, Clock, Gauge, SquareRoundCorner, ALargeSmall,
} from './chrome/icons';

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

// NumField lives in ./ui with the other primitives; re-exported for existing imports
export { NumField };

// ---------------- keyframe toggle ----------------
export function KeyButton(props: { layers: Layer[]; prop: PropKey }) {
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
    <button type="button" class={'keybtn' + (animated ? ' animated' : '') + (atKey ? ' at' : '')} title={animated ? 'Add/remove keyframe (alt: stop animating)' : 'Animate this property'} aria-label={(atKey ? 'Remove keyframe: ' : 'Add keyframe: ') + propDef(props.prop).label} onClick={click}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z" /><circle class="keybtn-dot" cx="5" cy="5" r="1.3" /></svg>
    </button>
  );
}

/** keyframe navigation of one property, after effects style: previous key, add / remove a key
 *  at the playhead (the diamond), next key. the arrows show once the property is animated */
export function KeyNav(props: { layers: Layer[]; prop: PropKey }) {
  const store = st();
  const animated = props.layers.some(l => isAnimated(l, props.prop));
  const t = store.time;
  let prev = -Infinity, next = Infinity;
  if (animated) for (const l of props.layers) for (const k of l.props[props.prop]?.kf ?? []) {
    if (k.t < t - 1e-6 && k.t > prev) prev = k.t;
    if (k.t > t + 1e-6 && k.t < next) next = k.t;
  }
  const label = propDef(props.prop).label;
  return (
    <span class={'keynav' + (animated ? ' animated' : '')}>
      <button type="button" class="keynav-step" disabled={!animated || prev === -Infinity} aria-label={`Previous ${label} keyframe`} title="Previous keyframe" onClick={() => store.setTime(prev)}><ChevronLeft size={12} /></button>
      <KeyButton layers={props.layers} prop={props.prop} />
      <button type="button" class="keynav-step" disabled={!animated || next === Infinity} aria-label={`Next ${label} keyframe`} title="Next keyframe" onClick={() => store.setTime(next)}><ChevronRight size={12} /></button>
    </span>
  );
}

/** one animatable property: its name, its value fields, then key navigation (‹ ◆ ›) */
export function PropRow(props: { layers: Layer[]; prop: PropKey; label: string; children: any }) {
  const animated = props.layers.some(l => isAnimated(l, props.prop));
  return (
    <div class={'field-row prop-row' + (animated ? ' animated' : '')}>
      <span class="field-row-label">{props.label}</span>
      <span class="field-row-fields">{props.children}</span>
      <span class="field-row-trail"><KeyNav layers={props.layers} prop={props.prop} /></span>
    </div>
  );
}

// ---------------- layer panel ----------------
function LayerPanel({ layers }: { layers: Layer[] }) {
  if (layers.every(x => x.type === 'audio')) return <AudioInspector layers={layers} />;
  return <VisualLayerPanel layers={layers} />;
}

function VisualLayerPanel({ layers }: { layers: Layer[] }) {
  const store = st();
  const l = layers[0];
  const t = store.time;
  const ids = layers.map(x => x.id);
  const set = (key: PropKey, v: number[], mk?: string) => store.batch('insp', () => { for (const x of layers) setProp(store, x.id, key, v, { mergeKey: mk }); });
  const v = (key: PropKey) => valueAt(l, key, t);
  const pos = v('position'), size = v('size'), scale = v('scale'), anchor = v('anchor');
  const rot = v('rotation')[0], opa = v('opacity')[0];
  const types = new Set(layers.map(x => x.type));
  const common = [...types].reduce<PropKey[]>((acc, ty, i) => (i === 0 ? TYPE_PROPS[ty] : acc.filter(p => TYPE_PROPS[ty].includes(p))), []);
  const vec = (key: PropKey, idx: number, val: number, cur: number[], mk?: string) => { const n = cur.slice(); n[idx] = val; set(key, n, mk); };
  // per-layer vector set keeps other layers' components
  const vecMulti = (key: PropKey, idx: number, val: number, mk?: string) => store.batch('insp', () => {
    for (const x of layers) { const n = valueAt(x, key, t); n[idx] = val; setProp(store, x.id, key, n, { mergeKey: mk }); }
  });
  // a stroke is "there" when it has a width, a key or a linked style; otherwise the section offers "+"
  const hasStroke = common.includes('stroke') && layers.some(x => valueAt(x, 'strokeWidth', t)[0] > 0 || isAnimated(x, 'strokeWidth') || isAnimated(x, 'stroke') || !!sharedLink([x], 'stroke'));
  const addStroke = () => store.batch('stroke', () => {
    for (const x of layers) {
      const c = valueAt(x, 'stroke', t);
      setProp(store, x.id, 'stroke', c[3] > 0 ? c : [0, 0, 0, 1]);
      setProp(store, x.id, 'strokeWidth', [2]);
    }
  }, 'Add stroke');
  const removeStroke = () => store.batch('stroke', () => { for (const x of layers) setProp(store, x.id, 'strokeWidth', [0]); }, 'Remove stroke');
  return (
    <>
      {layers.length === 1 && instanceComp(store.project, l) && <InstancePanel layer={l} />}
      {layers.length === 1 && store.comp.component && <ExposeSection layer={l} />}
      <Section title="Position">
        <PropRow layers={layers} prop="position" label="Position">
          <NumField label="X" title="Position X" value={pos[0]} onChange={(n, mk) => vecMulti('position', 0, n, mk)} />
          <NumField label="Y" title="Position Y" value={pos[1]} onChange={(n, mk) => vecMulti('position', 1, n, mk)} />
        </PropRow>
        <PropRow layers={layers} prop="rotation" label="Rotation">
          <NumField label={<RotateCw size={13} />} title="Rotation" value={rot} suffix="°" onChange={(n, mk) => set('rotation', [n], mk)} />
        </PropRow>
        <PropRow layers={layers} prop="anchor" label="Anchor">
          <NumField label="X" title="Anchor X" value={anchor[0]} onChange={(n, mk) => vec('anchor', 0, n, anchor, mk)} />
          <NumField label="Y" title="Anchor Y" value={anchor[1]} onChange={(n, mk) => vec('anchor', 1, n, anchor, mk)} />
        </PropRow>
      </Section>
      <Section title="Layout">
        {common.includes('size') && (
          <PropRow layers={layers} prop="size" label="Size">
            <NumField label="W" title="Width" min={0} value={size[0]} onChange={(n, mk) => sizeChange(layers, 0, n, mk)} />
            <NumField label="H" title="Height" min={0} value={size[1]} onChange={(n, mk) => sizeChange(layers, 1, n, mk)} />
          </PropRow>
        )}
        <PropRow layers={layers} prop="scale" label="Scale">
          <NumField label="X" title="Scale X" value={scale[0]} suffix="%" onChange={(n, mk) => vecMulti('scale', 0, n, mk)} />
          <NumField label="Y" title="Scale Y" value={scale[1]} suffix="%" onChange={(n, mk) => vecMulti('scale', 1, n, mk)} />
        </PropRow>
        {layers.length === 1 && l.type === 'group' && (
          <FieldRow label="Clip"><Checkbox checked={!!l.clip} onChange={on => setLayerField(store, ids, 'clip', on, 'Clip content')}>Clip content</Checkbox></FieldRow>
        )}
      </Section>
      <Section title="Appearance">
        {sharedLink(layers, 'opacity')
          ? <FieldRow label="Opacity"><LinkedChip layers={layers} prop="opacity" /></FieldRow>
          : <PropRow layers={layers} prop="opacity" label="Opacity">
              <NumField label={<Blend size={13} />} title="Opacity" value={opa} min={0} max={100} suffix="%" onChange={(n, mk) => set('opacity', [n], mk)} />
            </PropRow>}
        {common.includes('radius') && (
          <FieldRow label="Radius" trail={<KeyButton layers={layers} prop="radius" />}>
            {sharedLink(layers, 'radius') ? <LinkedChip layers={layers} prop="radius" /> : <>
              <NumField label={<SquareRoundCorner size={13} />} title="Corner radius" min={0} value={v('radius')[0]} hint={v('radius').every(x => x === v('radius')[0]) ? undefined : v('radius').map(x => Math.round(x)).join(' ')} onChange={(n, mk) => set('radius', [n, n, n, n], mk)} />
              <LinkButton layers={layers} prop="radius" />
            </>}
          </FieldRow>
        )}
        <FieldRow label="Blend">
          <select class="grow" aria-label="Blend mode" value={l.blend ?? 'normal'} onChange={e => setLayerField(store, ids, 'blend', (e.target as HTMLSelectElement).value as any, 'Blend mode')}>
            {BLEND_MODES.map(m => <option value={m}>{m[0].toUpperCase() + m.slice(1).replace(/([A-Z])/g, ' $1').toLowerCase()}</option>)}
          </select>
        </FieldRow>
        {layers.length === 1 && (
          <FieldRow label="Mask" title="Masks the layers above it in the same group">
            <Checkbox checked={!!l.mask} onChange={on => setLayerField(store, ids, 'mask', on, 'Use as mask')}>Use as mask</Checkbox>
          </FieldRow>
        )}
      </Section>
      {layers.length === 1 && l.shape && <ShapeParams layer={l} />}
      {common.includes('fill') && (
        <Section title="Fill">
          {!(layers.length === 1 && l.paints?.some(p => p.type === 'linear' || p.type === 'radial')) && (
            sharedLink(layers, 'fill')
              ? <FieldRow trail={<KeyButton layers={layers} prop="fill" />}><LinkedChip layers={layers} prop="fill" /></FieldRow>
              : <FieldRow trail={<KeyButton layers={layers} prop="fill" />}><ColorField value={v('fill')} onChange={(c, mk) => set('fill', c, mk)} /><LinkButton layers={layers} prop="fill" /></FieldRow>
          )}
          {layers.length === 1 && l.type !== 'text' && <GradientEditor layer={l} />}
        </Section>
      )}
      {common.includes('stroke') && (
        <Section title="Stroke" onAdd={hasStroke ? undefined : addStroke} addLabel="Add stroke" onRemove={hasStroke ? removeStroke : undefined} removeLabel="Remove stroke">
          {hasStroke && <>
            {sharedLink(layers, 'stroke')
              ? <FieldRow trail={<KeyButton layers={layers} prop="stroke" />}><LinkedChip layers={layers} prop="stroke" /></FieldRow>
              : <FieldRow trail={<KeyButton layers={layers} prop="stroke" />}><ColorField value={v('stroke')} onChange={(c, mk) => set('stroke', c, mk)} /><LinkButton layers={layers} prop="stroke" /></FieldRow>}
            <FieldRow trail={<KeyButton layers={layers} prop="strokeWidth" />}>
              {sharedLink(layers, 'strokeWidth') ? <LinkedChip layers={layers} prop="strokeWidth" /> : <NumField label={<Minus size={13} />} title="Stroke width" min={0} value={v('strokeWidth')[0]} onChange={(n, mk) => set('strokeWidth', [n], mk)} />}
              <select aria-label="Stroke position" value={l.strokeAlign ?? 'center'} onChange={e => setLayerField(store, ids, 'strokeAlign', (e.target as HTMLSelectElement).value as any)}>
                <option value="inside">Inside</option><option value="center">Center</option><option value="outside">Outside</option>
              </select>
            </FieldRow>
          </>}
        </Section>
      )}
      {layers.length === 1 && l.type !== 'audio' && <ShaderPanel layer={l} />}
      {layers.length === 1 && l.type === 'text' && <TextPanel layer={l} />}
      {layers.every(x => x.type === 'path') && (
        <Section title="Trim paths" right={<Toggle checked={!!l.trimOn} label={<span class="sr-only">Trim paths</span>} onChange={on => setLayerField(store, ids, 'trimOn', on, 'Trim paths')} />}>
          {l.trimOn && (
            <>
              <FieldRow label="Range">
                <NumField label="S" title="Start" min={0} max={100} value={v('trimStart')[0]} suffix="%" onChange={(n, mk) => set('trimStart', [n], mk)} />
                <KeyButton layers={layers} prop="trimStart" />
                <NumField label="E" title="End" min={0} max={100} value={v('trimEnd')[0]} suffix="%" onChange={(n, mk) => set('trimEnd', [n], mk)} />
                <KeyButton layers={layers} prop="trimEnd" />
              </FieldRow>
              <FieldRow label="Offset" trail={<KeyButton layers={layers} prop="trimOffset" />}>
                <NumField label={<RotateCw size={13} />} title="Offset" value={v('trimOffset')[0]} suffix="°" onChange={(n, mk) => set('trimOffset', [n], mk)} />
              </FieldRow>
            </>
          )}
        </Section>
      )}
      {layers.every(x => x.type === 'text') && <TextAnimPanel layers={layers} />}
      {layers.length === 1 && l.type === 'precomp' && l.compRef && !instanceComp(store.project, l) && (
        <Section title="Composition" right={<Button variant="ghost" size="sm" onClick={() => store.openComp(l.compRef!)}>Open <ArrowUpRight size={14} /></Button>}>
          <FieldRow label="Start">
            <NumField label={<Clock size={13} />} title="Start offset" step={1 / store.comp.fps} value={l.startTime ?? 0} suffix="s" onChange={(n, mk) => store.transact('Precomp start', tx => { for (const id of ids) { const x = store.layer(id); if (x) { tx.set(x, 'startTime', n); tx.touch(id); } } tx.structure(); }, mk)} />
          </FieldRow>
          <div class="muted small">{store.project.comps[l.compRef]?.name}</div>
        </Section>
      )}
      {common.includes('shadowColor') && <EffectsPanel layers={layers} />}
      <Section title="Timing">
        <FieldRow label="Visible">
          <NumField label="In" title="Visible from" step={1 / store.comp.fps} min={0} value={l.inPoint} suffix="s" onChange={n => setLayerField(store, ids, 'inPoint', n)} />
          <NumField label="Out" title="Visible until" step={1 / store.comp.fps} min={0} value={Math.min(l.outPoint, store.comp.duration)} suffix="s" onChange={n => setLayerField(store, ids, 'outPoint', n >= store.comp.duration ? 1e9 : n)} />
        </FieldRow>
      </Section>
      <ExprPanel layers={layers} />
      {layers.length === 1 && <ComponentBox layer={l} />}
    </>
  );
}

/** effect parameters (animatable props; the first effect of each type, see core/model.ts Effect) */
const EFFECT_GROUPS: { title: string; keys: PropKey[]; add: [PropKey, number[]][] }[] = [
  { title: 'Drop shadow', keys: ['shadowColor', 'shadowOffset', 'shadowBlur', 'shadowSpread'], add: [['shadowColor', [0, 0, 0, 0.25]], ['shadowOffset', [0, 4]], ['shadowBlur', [12]], ['shadowSpread', [0]]] },
  { title: 'Inner shadow', keys: ['innerShadowColor', 'innerShadowOffset', 'innerShadowBlur', 'innerShadowSpread'], add: [['innerShadowColor', [0, 0, 0, 0.25]], ['innerShadowOffset', [0, 2]], ['innerShadowBlur', [4]], ['innerShadowSpread', [0]]] },
  { title: 'Layer blur', keys: ['blur'], add: [['blur', [8]]] },
  { title: 'Background blur', keys: ['backgroundBlur'], add: [['backgroundBlur', [16]]] },
  { title: 'Noise', keys: ['noiseColor', 'noiseSize', 'noiseDensity'], add: [['noiseColor', [0, 0, 0, 0.25]], ['noiseSize', [1]], ['noiseDensity', [50]]] },
];
function EffectsPanel({ layers }: { layers: Layer[] }) {
  const store = st();
  const l = layers[0];
  const t = store.time;
  const set = (key: PropKey, v: number[], mk?: string) => store.batch('insp', () => { for (const x of layers) setProp(store, x.id, key, v, { mergeKey: mk }); });
  const has = (g: (typeof EFFECT_GROUPS)[number]) => g.keys.some(k => l.props[k]) || l.effects?.some(e => e.type === effectTypeOf(g.title));
  const shown = EFFECT_GROUPS.filter(has);
  const extra = (l.effects ?? []).filter((e, i, a) => a.findIndex(x => x.type === e.type) !== i).length;
  return (
    <Section title="Effects" right={<select value="" aria-label="Add effect" onChange={e => { const g = EFFECT_GROUPS.find(x => x.title === (e.target as HTMLSelectElement).value); if (g) store.batch('fx', () => { for (const [k, v] of g.add) if (!l.props[k]) set(k, v); }); (e.target as HTMLSelectElement).value = ''; }}>
      <option value="">Add…</option>
      {EFFECT_GROUPS.filter(g => !has(g)).map(g => <option value={g.title}>{g.title}</option>)}
    </select>}>
      {shown.map(g => (
        <>
          <div class="muted small">{g.title}</div>
          {g.keys.filter(k => l.props[k]).map(k => {
            const def = PROP_DEFS[k], v = valueAt(l, k, t);
            return (
              <div class="row">
                <KeyButton layers={layers} prop={k} />
                {def.unit === 'color' ? <ColorField value={v} onChange={(c, mk) => set(k, c, mk)} />
                  : def.dim === 2 ? <><NumField label="X" value={v[0]} onChange={(n, mk) => set(k, [n, v[1]], mk)} /><NumField label="Y" value={v[1]} onChange={(n, mk) => set(k, [v[0], n], mk)} /></>
                  : <NumField label={def.label.replace(/^(Inner )?Shadow |^Noise /, '')} min={(def as any).min} max={(def as any).max} value={v[0]} suffix={def.unit === 'px' ? '' : def.unit} onChange={(n, mk) => set(k, [n], mk)} />}
              </div>
            );
          })}
        </>
      ))}
      {extra > 0 && <div class="muted small">{extra} more effect{extra > 1 ? 's' : ''} from Figma (not animatable)</div>}
    </Section>
  );
}
function effectTypeOf(title: string) {
  return title === 'Drop shadow' ? 'dropShadow' : title === 'Inner shadow' ? 'innerShadow' : title === 'Layer blur' ? 'layerBlur' : title === 'Background blur' ? 'backgroundBlur' : 'noise';
}

function sizeChange(layers: Layer[], idx: number, n: number, mk?: string) {
  const store = st();
  store.batch('size', () => sizeChangeInner(layers, idx, n, mk));
}
function sizeChangeInner(layers: Layer[], idx: number, n: number, mk?: string) {
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
        <NumField label={<ALargeSmall size={14} />} title="Font size" min={1} value={t.fontSize} onChange={n => set({ fontSize: n })} />
        <NumField label="↕" title="Line height" step={0.01} min={0.5} value={t.lineHeight} onChange={n => set({ lineHeight: n, lineHeightAuto: undefined })} />
        <NumField label="↔" title="Letter spacing" step={0.1} value={t.letterSpacing} onChange={n => set({ letterSpacing: n })} />
      </div>
      <Segmented class="row" label="Text align" value={t.align} options={(['left', 'center', 'right'] as const).map(a => ({ value: a, label: a[0].toUpperCase() + a.slice(1) }))} onChange={a => set({ align: a })} />
    </Section>
  );
}

// ---------------- color ----------------
// ---------------- star / polygon parameters ----------------
function ShapeParams({ layer }: { layer: Layer }) {
  const store = st();
  const sh = layer.shape!;
  const set = (patch: Partial<NonNullable<Layer['shape']>>, mk?: string) => store.transact('Shape', tx => {
    const cur = store.layer(layer.id);
    if (!cur?.shape) return;
    const next = { ...cur.shape, ...patch };
    const gs = cur.geomSize ?? [100, 100];
    tx.set(cur, 'shape', next);
    tx.set(cur, 'geometry', starGeometry(next.kind, next.points, next.inner, gs[0], gs[1]));
    tx.touch(layer.id);
  }, mk);
  return (
    <Section title={sh.kind === 'star' ? 'Star' : 'Polygon'}>
      <div class="row">
        <NumField label={sh.kind === 'star' ? 'Points' : 'Sides'} min={3} max={100} value={sh.points} onChange={(n, mk) => set({ points: Math.round(n) }, mk)} />
        {sh.kind === 'star' && <NumField label="Inner" min={1} max={100} value={Math.round(sh.inner * 100)} suffix="%" onChange={(n, mk) => set({ inner: n / 100 }, mk)} />}
      </div>
    </Section>
  );
}

// ---------------- gradient fill ----------------
type GradPaint = { type: 'linear' | 'radial'; stops: { pos: number; color: [number, number, number, number] }[]; transform?: number[]; opacity?: number };

/** fill type (solid / linear / radial), angle and color stops. gradients are static (not keyframed) */
function GradientEditor({ layer }: { layer: Layer }) {
  const store = st();
  const g = layer.paints?.find(p => p.type === 'linear' || p.type === 'radial') as GradPaint | undefined;
  const kind = g?.type ?? 'solid';
  const write = (paint: GradPaint | null, mk?: string) => store.transact(paint ? 'Gradient' : 'Solid fill', tx => {
    const cur = store.layer(layer.id);
    if (!cur) return;
    tx.set(cur, 'paints', paint ? [{ ...paint, stops: paint.stops.slice() }] : undefined); // stop order is free (canvas sorts), so a dragged stop keeps its row
    tx.touch(layer.id);
  }, mk);
  const setKind = (k: string) => {
    if (k === 'solid') return write(null);
    const fill = valueAt(layer, 'fill', store.time) as [number, number, number, number];
    const stops = g?.stops ?? [{ pos: 0, color: fill }, { pos: 1, color: [fill[0] * 0.35, fill[1] * 0.35, fill[2] * 0.35, fill[3]] as [number, number, number, number] }];
    write({ type: k as 'linear' | 'radial', stops, transform: g?.transform ?? [1, 0, 0, 1, 0, 0] });
  };
  // linear angle: rotation of the unit gradient space around its center
  const m = g?.transform ?? [1, 0, 0, 1, 0, 0];
  const angle = Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI * 10) / 10;
  const setAngle = (deg: number, mk?: string) => {
    const r = deg * Math.PI / 180, c = Math.cos(r), s2 = Math.sin(r);
    write({ ...g!, transform: [c, s2, -s2, c, 0.5 - (c * 0.5 - s2 * 0.5), 0.5 - (s2 * 0.5 + c * 0.5)] }, mk);
  };
  const setStop = (i: number, patch: Partial<GradPaint['stops'][number]>, mk?: string) => write({ ...g!, stops: g!.stops.map((s3, j) => (j === i ? { ...s3, ...patch } : s3)) }, mk);
  return (
    <>
      <div class="row fill-kind">
        <Segmented size="sm" label="Fill type" value={kind} options={[{ value: 'solid', label: 'Solid' }, { value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }]} onChange={setKind} />
        {kind === 'linear' && <NumField label={<RotateCw size={13} />} value={angle} suffix="°" onChange={setAngle} title="Gradient angle" />}
      </div>
      {g && (
        <>
          <div class="grad-preview" style={{ background: `linear-gradient(90deg, ${g.stops.map(s3 => `rgba(${s3.color[0] * 255 | 0},${s3.color[1] * 255 | 0},${s3.color[2] * 255 | 0},${s3.color[3]}) ${Math.round(s3.pos * 100)}%`).join(', ')})` }} />
          {g.stops.map((s3, i) => (
            <div class="row grad-stop">
              <NumField label="%" min={0} max={100} value={Math.round(s3.pos * 1000) / 10} onChange={(n, mk) => setStop(i, { pos: n / 100 }, mk)} />
              <ColorField value={s3.color} onChange={(c, mk) => setStop(i, { color: c as any }, mk)} />
              <button type="button" class="ghost icon" title="Remove stop" aria-label="Remove stop" disabled={g.stops.length <= 2} onClick={() => write({ ...g, stops: g.stops.filter((_, j) => j !== i) })}><Minus /></button>
            </div>
          ))}
          <div class="row"><button type="button" class="ghost" onClick={() => {
            // new stop in the middle of the widest gap, with the blended color
            const st2 = g.stops.slice().sort((a, b) => a.pos - b.pos);
            let k = 0; for (let j = 1; j < st2.length - 1; j++) if (st2[j + 1].pos - st2[j].pos > st2[k + 1].pos - st2[k].pos) k = j;
            const a = st2[k], b = st2[k + 1];
            write({ ...g, stops: [...st2, { pos: (a.pos + b.pos) / 2, color: a.color.map((x, d) => (x + b.color[d]) / 2) as any }] });
          }}>+ Add stop</button></div>
        </>
      )}
    </>
  );
}

export function ColorField({ value, onChange }: { value: number[]; onChange: (c: number[], mk?: string) => void }) {
  const hex = '#' + value.slice(0, 3).map(c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('');
  const mk = useRef('color' + Math.random());
  return (
    <div class="color-field">
      <ColorSwatch value={hex} alpha={value[3]} onInput={h => {
        onChange([parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, value[3]], mk.current);
      }} onChange={() => (mk.current = 'color' + Math.random())} />
      <input class="hex" aria-label="Hex color" spellcheck={false} value={hex.slice(1).toUpperCase()} onKeyDown={e => {
        e.stopPropagation();
        const inp = e.target as HTMLInputElement;
        if (e.key === 'Escape') { inp.value = hex.slice(1).toUpperCase(); inp.blur(); } // revert, no change event
        if (e.key === 'Enter') inp.blur(); // commits through onChange, frees the shortcuts
      }} onChange={e => {
        const inp = e.target as HTMLInputElement;
        let h = inp.value.trim().replace('#', '');
        if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, c => c + c); // css shorthand f00 -> ff0000
        if (/^[0-9a-f]{6}$/i.test(h)) onChange([parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, value[3]]);
        else { inp.value = hex.slice(1).toUpperCase(); toast('Use a hex color like FF0000 or F00', 'error'); }
      }} />
      <NumField label="A" min={0} max={100} value={Math.round(value[3] * 100)} suffix="%" onChange={(n, k) => onChange([value[0], value[1], value[2], n / 100], k)} />
    </div>
  );
}

// ---------------- composition ----------------
const SIZE_PRESETS: [string, number, number][] = [
  ['Landscape · 1920×1080', 1920, 1080], ['Square · 1080×1080', 1080, 1080], ['Portrait · 1080×1920', 1080, 1920],
  ['Feed · 1080×1350', 1080, 1350], ['HD · 1280×720', 1280, 720], ['4K · 3840×2160', 3840, 2160], ['Icon · 512×512', 512, 512],
];

/** nothing selected: the composition's settings (name, size, frame rate, duration, background).
 *  exporting lives in one place: the Export button (top right, ⌘E) */
function CompPanel() {
  const store = st();
  const c = store.comp;
  const preset = SIZE_PRESETS.find(p => p[1] === c.width && p[2] === c.height);
  return (
    <>
      {c.component && <ComponentPanel comp={c} />}
      <Section title="Composition">
        <FieldRow label="Name">
          <input class="grow name-input" aria-label="Composition name" value={c.name} spellcheck={false}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onChange={e => { const v = (e.target as HTMLInputElement).value.trim(); if (v && v !== c.name) renameComp(store, c.id, v); }} />
        </FieldRow>
        <FieldRow label="Size">
          <select class="grow" aria-label="Size preset" value={preset ? `${preset[1]}x${preset[2]}` : 'custom'}
            onChange={e => { const [w, h] = (e.target as HTMLSelectElement).value.split('x').map(Number); if (w && h) setCompSettings(store, { width: w, height: h }); }}>
            {!preset && <option value="custom">Custom</option>}
            {SIZE_PRESETS.map(p => <option value={`${p[1]}x${p[2]}`}>{p[0]}</option>)}
          </select>
        </FieldRow>
        <FieldRow label="">
          <NumField label="W" title="Width" min={1} value={c.width} onChange={n => setCompSettings(store, { width: Math.round(n) })} />
          <NumField label="H" title="Height" min={1} value={c.height} onChange={n => setCompSettings(store, { height: Math.round(n) })} />
        </FieldRow>
        <FieldRow label="Timing">
          <NumField label={<Gauge size={13} />} title="Frame rate" min={1} max={240} value={c.fps} hint="fps" onChange={n => setCompSettings(store, { fps: Math.round(n) })} />
          <NumField label={<Clock size={13} />} title="Duration" min={0.1} step={0.1} value={c.duration} suffix="s" onChange={n => setCompSettings(store, { duration: n })} />
        </FieldRow>
      </Section>
      <Section title="Background">
        <FieldRow><ColorField value={c.background} onChange={col => setCompSettings(store, { background: col as any })} /></FieldRow>
      </Section>
    </>
  );
}

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
    <Section title={`Easing · ${keys.length} keyframe${keys.length > 1 ? 's' : ''}`} right={<span class="row" style={{ margin: 0 }}>{seg && <span class="insp-type">{propDef(seg.key).label}</span>}</span>}>
      {a && b && seg && a.interp === 'spring' && <SpringView bounce={a.bounce ?? 0.3} onChange={v => setSpring(store, keys, v)} />}
      {a && b && seg && a.interp !== 'hold' && a.interp !== 'spring' && (
        <CurveEditor value={cur} onChange={(v, mk) => setSegmentHandles(store, seg!.layerId, seg!.key, seg!.i, [v[0], v[1]], [v[2], v[3]], mk)} />
      )}
      {a && b && seg && a.interp === 'bezier' && (
        <div class="row" title="After Effects style influence: how far each handle reaches into the segment">
          <NumField label="Out" min={0.1} max={100} suffix="%" value={Math.round(cur[0] * 1000) / 10} onChange={(n, mk) => setSegmentHandles(store, seg!.layerId, seg!.key, seg!.i, [n / 100, cur[1]], [cur[2], cur[3]], mk)} />
          <NumField label="In" min={0.1} max={100} suffix="%" value={Math.round((1 - cur[2]) * 1000) / 10} onChange={(n, mk) => setSegmentHandles(store, seg!.layerId, seg!.key, seg!.i, [cur[0], cur[1]], [1 - n / 100, cur[3]], mk)} />
        </div>
      )}
      {a?.interp === 'hold' && <div class="muted small">Hold keyframe (no interpolation)</div>}
      <div class="ease-group label-xs">Springs</div>
      <div class="ease-presets">
        {SPRING_PRESETS.map(p => (
          <button class={'ease-chip' + (a?.interp === 'spring' && Math.abs((a.bounce ?? 0.3) - p.bounce) < 1e-3 ? ' on' : '')} onClick={() => setSpring(store, keys, p.bounce)}>
            <MiniSpring bounce={p.bounce} />
            <span>{p.name}</span>
          </button>
        ))}
      </div>
      <div class="ease-group label-xs">Curves</div>
      <div class="ease-presets">
        {EASE_PRESETS.map(p => (
          <button class={'ease-chip' + (a?.interp !== 'spring' && active?.name === p.name ? ' on' : '')} title={p.v.join(', ')} onClick={() => setEase(store, keys, p.name)}>
            <MiniCurve v={p.v} />
            <span>{p.name}</span>
          </button>
        ))}
      </div>
      {/* footer: what the segment really is (a spring's handles are meaningless) */}
      {a?.interp === 'spring' ? <div class="row small muted">spring · bounce {Math.round((a.bounce ?? 0.3) * 100)}%</div>
        : a?.interp === 'hold' ? null
        : <div class="row small muted">cubic-bezier({cur.map(x => Math.round(x * 100) / 100).join(', ')})</div>}
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
        <span class="field-label">Bounce</span>
        <Slider label="Bounce" min={0} max={0.9} step={0.01} value={bounce} style={{ flex: 1 }} onChange={onChange} />
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
  // y range shows overshoot room. it is frozen while a handle is dragged, so the handle stays
  // under the cursor (it is re-fitted on release)
  const frozen = useRef<[number, number] | null>(null);
  const [, refit] = useState(0);
  const fit: [number, number] = [Math.min(-0.25, value[1] - 0.1, value[3] - 0.1), Math.max(1.25, value[1] + 0.1, value[3] + 0.1)];
  const [ymin, ymax] = frozen.current ?? fit;
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
    // keep extra room so the handle can be pulled beyond the current range
    const r0: [number, number] = [Math.min(ymin, -1), Math.max(ymax, 2)];
    frozen.current = r0;
    refit(n => n + 1);
    (e.target as Element).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x = Math.min(1, Math.max(0, (ev.clientX - r.left - pad) / (W - 2 * pad)));
      const y = Math.min(r0[1], Math.max(r0[0], r0[0] + ((H - pad - (ev.clientY - r.top)) / (H - 2 * pad)) * (r0[1] - r0[0])));
      const v = value.slice() as [number, number, number, number];
      v[which * 2] = Math.round(x * 1000) / 1000;
      v[which * 2 + 1] = Math.round(y * 1000) / 1000;
      onChange(v, mk);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); frozen.current = null; refit(n => n + 1); };
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

// ---------------- align ----------------
const vpBounds = (id: string) => (globalThis as any).viewport?.boundsOf([id]) ?? null;
const parentInv = (id: string) => {
  const l = st().layer(id);
  const w = l?.parent ? editor.renderer.worldMatrix(l.parent) : null;
  return invert(w ?? [1, 0, 0, 1, 0, 0]);
};

export function AlignBar({ ids }: { ids: string[] }) {
  const store = st();
  const btn = (how: Align, title: string, Icon: typeof AlignStartVertical) => (
    <button class="ghost icon" title={title + (ids.length === 1 ? ' (to composition)' : '')} aria-label={title} onClick={() => alignLayers(store, ids, how, vpBounds, parentInv)}><Icon /></button>
  );
  return (
    <div class="align-bar">
      {btn('left', 'Align left', AlignStartVertical)}{btn('hcenter', 'Align horizontal centers', AlignCenterVertical)}{btn('right', 'Align right', AlignEndVertical)}
      {btn('top', 'Align top', AlignStartHorizontal)}{btn('vcenter', 'Align vertical centers', AlignCenterHorizontal)}{btn('bottom', 'Align bottom', AlignEndHorizontal)}
      <button class="ghost icon" disabled={ids.length < 3} title="Distribute horizontally" aria-label="Distribute horizontally" onClick={() => distributeLayers(store, ids, 'x', vpBounds, parentInv)}><AlignHorizontalDistributeCenter /></button>
      <button class="ghost icon" disabled={ids.length < 3} title="Distribute vertically" aria-label="Distribute vertically" onClick={() => distributeLayers(store, ids, 'y', vpBounds, parentInv)}><AlignVerticalDistributeCenter /></button>
    </div>
  );
}

function TextAnimPanel({ layers }: { layers: Layer[] }) {
  const store = st();
  const ids = layers.map(l => l.id);
  const ta = layers[0].textAnim;
  const upd = (patch: any, mk?: string) => setTextAnim(store, ids, { ...ta!, ...patch, from: { ...ta!.from, ...(patch.from ?? {}) } }, mk);
  return (
    <Section title="Text animation" right={ta && <button class="ghost" onClick={() => setTextAnim(store, ids, undefined)}>Remove</button>}>
      <div class="preset-grid">
        {TEXT_ANIM_PRESETS.map(p => <button class={'preset ' + (p.anim.mode === 'out' ? 'out' : 'in')} title={p.anim.mode === 'out' ? 'Animates the text out' : 'Animates the text in'} onClick={() => setTextAnim(store, ids, { ...p.anim, start: store.time - layers[0].inPoint })}>{p.name}</button>)}
      </div>
      {ta && (
        <>
          <div class="row">
            <select value={ta.by} onChange={e => upd({ by: (e.target as HTMLSelectElement).value })}>
              <option value="char">by letter</option><option value="word">by word</option><option value="line">by line</option>
            </select>
            <select value={ta.order ?? 'forward'} onChange={e => upd({ order: (e.target as HTMLSelectElement).value })}>
              <option value="forward">forward</option><option value="backward">backward</option><option value="center">from center</option><option value="random">random</option>
            </select>
            <select value={ta.mode} onChange={e => upd({ mode: (e.target as HTMLSelectElement).value })}>
              <option value="in">in</option><option value="out">out</option>
            </select>
          </div>
          <div class="row">
            <NumField label="Start" step={0.05} value={ta.start} suffix="s" onChange={(n, mk) => upd({ start: n }, mk)} />
            <NumField label="Dur" step={0.05} min={0.01} value={ta.duration} suffix="s" onChange={(n, mk) => upd({ duration: n }, mk)} />
            <NumField label="Stag" step={0.01} min={0} value={ta.stagger} suffix="s" onChange={(n, mk) => upd({ stagger: n }, mk)} />
          </div>
          <div class="row">
            <NumField label="Op" min={0} max={100} value={ta.from.opacity} suffix="%" onChange={(n, mk) => upd({ from: { opacity: n } }, mk)} />
            <NumField label="X" value={ta.from.dx} onChange={(n, mk) => upd({ from: { dx: n } }, mk)} />
            <NumField label="Y" value={ta.from.dy} onChange={(n, mk) => upd({ from: { dy: n } }, mk)} />
          </div>
          <div class="row">
            <NumField label="Scale" value={ta.from.scale} suffix="%" onChange={(n, mk) => upd({ from: { scale: n } }, mk)} />
            <NumField label="Rot" value={ta.from.rotation} suffix="°" onChange={(n, mk) => upd({ from: { rotation: n } }, mk)} />
          </div>
          <div class="row">
            <select value={ta.ease} onChange={e => upd({ ease: (e.target as HTMLSelectElement).value })} style={{ flex: 1 }}>
              {['spring:0.2', 'spring:0.5', ...EASE_PRESETS.map(p => p.name)].map(n => <option value={n}>{n.startsWith('spring') ? `Spring (bounce ${n.split(':')[1]})` : n}</option>)}
            </select>
          </div>
        </>
      )}
    </Section>
  );
}

const EXPR_SUGGEST: Partial<Record<PropKey, string[]>> = {
  position: ['wiggle(2, 20)', "loopOut('cycle')", 'value + [Math.sin(time * 3) * 50, 0]'],
  rotation: ['time * 90', 'wiggle(1, 10)', "loopOut('pingpong')"],
  scale: ['value * (1 + Math.sin(time * 4) * 0.05)', 'wiggle(3, 5)'],
  opacity: ['50 + Math.sin(time * 6) * 50', "loopOut('cycle')"],
};

function ExprPanel({ layers }: { layers: Layer[] }) {
  const store = st();
  const l = layers[0];
  const ids = layers.map(x => x.id);
  const keys = [...TRANSFORM_KEYS_LOCAL, ...TYPE_PROPS[l.type]].filter((k, i, a) => a.indexOf(k) === i && EXPR_PROPS.includes(k));
  const withExpr = keys.filter(k => l.props[k]?.expr !== undefined);
  const add = (e: Event) => {
    const k = (e.target as HTMLSelectElement).value as PropKey;
    (e.target as HTMLSelectElement).value = '';
    if (k) setExpr(store, ids, k, EXPR_SUGGEST[k]?.[0] ?? 'value');
  };
  return (
    <Section title="Expressions" right={
      <select class="expr-add" value="" onChange={add} aria-label="Add expression">
        <option value="">Add…</option>
        {keys.filter(k => !withExpr.includes(k)).map(k => <option value={k}>{propDef(k).label}</option>)}
      </select>
    }>
      {withExpr.length === 0 && <div class="muted small">e.g. wiggle(2, 20), time * 90, loopOut('cycle')</div>}
      {withExpr.map(k => <ExprRow key={k} ids={ids} k={k} src={l.props[k]!.expr!} />)}
    </Section>
  );
}

function ExprRow({ ids, k, src }: { ids: string[]; k: PropKey; src: string }) {
  const store = st();
  const [text, setText] = useState(src);
  // follow outside changes (undo, agent, chips) but never while the user is typing: the store
  // lags behind the keystrokes (invalid partial input isn't committed) and would overwrite them
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(src); }, [src]);
  const err = checkExpr(text, propDef(k).dim);
  const mk = useRef('expr' + Math.random());
  return (
    <div class="expr-row">
      <div class="row small"><span>{propDef(k).label}</span><span style={{ flex: 1 }} /><button type="button" class="ghost icon btn-sm" title="Remove expression" aria-label="Remove expression" onClick={() => setExpr(store, ids, k, undefined)}><X size={14} /></button></div>
      <textarea class={'expr-edit' + (err ? ' bad' : '')} rows={2} value={text} spellcheck={false}
        onInput={e => { const v = (e.target as HTMLTextAreaElement).value; setText(v); if (!checkExpr(v, propDef(k).dim)) setExpr(store, ids, k, v, mk.current); }}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; mk.current = 'expr' + Math.random(); }}
        onKeyDown={e => e.stopPropagation()} />
      {err && <div class="expr-err">{err}</div>}
      <div class="expr-chips">{(EXPR_SUGGEST[k] ?? []).map(sug => <button class="ghost small" onClick={() => setExpr(store, ids, k, sug)}>{sug}</button>)}</div>
    </div>
  );
}
const TRANSFORM_KEYS_LOCAL: PropKey[] = ['anchor', 'position', 'scale', 'rotation', 'opacity'];
