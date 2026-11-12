// motion components: a component is a COMPOSITION (layers + animation + timing + named ranges) marked with
// `Composition.component`; an instance is a precomp layer of it. design: docs/components-design.md.
//
// - instances are time-aware: `Layer.play` maps the instance's clock onto the component's (speed or
//   stretch to a duration, a named range such as "in" or "out", loop / ping-pong, reverse,
//   hold the first / last frame). startTime stays the start offset.
// - exposed properties (`ComponentDef.props`) are the knobs an instance has: text, colors, image
//   swap, numbers (opacity, rotation, an intensity, a delay), toggles, and properties of nested
//   instances. an instance stores only the values it changes (`Layer.inst.props`).
// - variants (`ComponentDef.variants`) are named sets of differences over the SAME layers and the
//   SAME animation: a 9:16 layout, a dark theme, a German text, a short cut (timing). variants of
//   different groups combine (Format x Theme). editing a variant applies it to the real layers and
//   records the differences when you leave it, so animation edits made there reach every variant.
// - cost: the renderer expands a component once per instance, but layers an instance does not
//   change are the same Layer objects for every instance, so they share compiled tracks (and, at the
//   same local time, evaluated values). only layers with a patched field are copied, shallowly, and
//   share every untouched Prop object (see InstanceResolver).
//
// the older layer-linked components (core/components.ts: live per-layer copies, figma style) stay for
// static design elements; `promoteToMotionComponent` turns one into a motion component.

import { insertLayer, precompose } from './commands';
import {
  createLayer, PROP_DEFS, uid,
  type BaseSnap, type ComponentDef, type Composition, type ExposedKind, type ExposedProp, type ExposedValue,
  type Keyframe, type Layer, type PlaySpec, type Project, type Prop, type PropKey, type Variant, type VariantLayerOv,
} from './model';
import type { Store, Tx } from './store';

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// ======================================================================================
// time
// ======================================================================================

/** a named range of a component */
export function findRange(comp: Composition, name: string | undefined) {
  if (!name) return undefined;
  const r = name.trim().toLowerCase();
  return (comp.component?.ranges ?? []).find(x => x.name.toLowerCase() === r);
}

/** seconds, or a range name (its start for `from`, its end for `to`) -> seconds inside `comp` */
function rangeTime(comp: Composition, ref: string | number | undefined, end: boolean): number | undefined {
  if (ref === undefined || ref === null || ref === '') return undefined;
  if (typeof ref === 'number') return ref;
  const n = Number(ref);
  if (ref.trim() !== '' && Number.isFinite(n)) return n;
  const r = findRange(comp, ref);
  return r ? (end ? r.to : r.from) : undefined;
}

/** the [from, to] part of the component an instance plays */
export function playRange(comp: Composition, play?: PlaySpec): [number, number] {
  const named = findRange(comp, play?.range);
  const a = Math.max(0, Math.min(comp.duration, rangeTime(comp, play?.from, false) ?? named?.from ?? 0));
  const b = Math.max(0, Math.min(comp.duration, rangeTime(comp, play?.to, true) ?? named?.to ?? comp.duration));
  return b > a ? [a, b] : [a, a];
}

/** playback rate of an instance (component seconds per instance second) */
export function playRate(comp: Composition, play?: PlaySpec): number {
  const [a, b] = playRange(comp, play);
  if (play?.duration && play.duration > 0) return Math.max(1e-6, (b - a) / play.duration);
  const s = play?.speed ?? 1;
  return s > 0 && Number.isFinite(s) ? s : 1;
}

/** seconds one pass of the instance lasts on its parent's timeline */
export function passLength(comp: Composition, play?: PlaySpec): number {
  const [a, b] = playRange(comp, play);
  return (b - a) / playRate(comp, play);
}

/** how long the instance shows on its parent's timeline from its start (Infinity: loops or holds forever) */
export function instanceSpan(comp: Composition, play?: PlaySpec): number {
  const pass = passLength(comp, play);
  if (play?.loop && play.loop !== 'none') return play.loops && play.loops > 0 ? pass * play.loops : Infinity;
  if (play?.hold === 'last' || play?.hold === 'both') return Infinity;
  return pass;
}

/** the component's local time for `u` seconds after the instance's start; NaN = not showing */
export function instanceTime(comp: Composition, play: PlaySpec | undefined, u: number): number {
  if (!play) return u >= 0 && u < comp.duration ? u : NaN; // plain precomp (after effects): its duration
  const [a, b] = playRange(comp, play);
  const len = b - a;
  const rate = playRate(comp, play);
  const pass = len / rate;
  const hold = play.hold ?? 'none';
  const end = b - Math.min(len, 1e-6); // the last frame: inside the range, so out points never hide it
  let p: number; // component seconds into the range
  if (u < 0) {
    if (hold !== 'first' && hold !== 'both') return NaN;
    p = 0;
  } else if (play.loop && play.loop !== 'none' && pass > 0) {
    const n = Math.floor(u / pass);
    if (play.loops && play.loops > 0 && n >= play.loops) {
      if (hold !== 'last' && hold !== 'both') return NaN;
      p = play.loop === 'pingpong' && play.loops % 2 === 0 ? 0 : len;
    } else {
      const f = (u - n * pass) * rate;
      p = play.loop === 'pingpong' && n % 2 === 1 ? len - f : f;
    }
  } else if (u >= pass) {
    if (hold !== 'last' && hold !== 'both') return NaN;
    p = len;
  } else p = u * rate;
  const local = play.reverse ? b - p : a + p;
  return Math.min(end, Math.max(a, local));
}

/** sample the mapping as linear segments (exporters: lottie time remap). [instance second, component second][] */
export function timeRemapKeys(comp: Composition, play: PlaySpec | undefined, span: number): [number, number][] {
  const out: [number, number][] = [];
  const pass = passLength(comp, play);
  const total = Math.min(span, instanceSpan(comp, play));
  if (!(pass > 0) || !Number.isFinite(total)) return [[0, instanceTime(comp, play, 0) || 0]];
  for (let n = 0; n * pass <= total + 1e-9 && out.length < 2000; n++) {
    const t0 = n * pass, t1 = Math.min(total, (n + 1) * pass);
    out.push([t0, instanceTime(comp, play, t0)]);
    out.push([t1, instanceTime(comp, play, Math.max(t0, t1 - 1e-6))]);
  }
  return out;
}

// ======================================================================================
// lookups
// ======================================================================================

export function componentComps(P: Project): Composition[] {
  return Object.values(P.comps).filter(c => !!c.component);
}

/** the component composition a layer is an instance of (precomp of a component comp) */
export function instanceComp(P: Project, l: Layer | undefined): Composition | undefined {
  if (!l || l.type !== 'precomp' || !l.compRef) return undefined;
  const c = P.comps[l.compRef];
  return c?.component ? c : undefined;
}

/** every instance layer of a component composition */
export function motionInstancesOf(P: Project, compId: string): Layer[] {
  return Object.values(P.layers).filter(l => l.type === 'precomp' && l.compRef === compId);
}

export function findComponent(P: Project, ref: string): Composition | undefined {
  if (P.comps[ref]?.component) return P.comps[ref];
  const r = String(ref).trim().toLowerCase();
  return componentComps(P).find(c => c.name.toLowerCase() === r);
}

export function findProp(def: ComponentDef | undefined, ref: string): ExposedProp | undefined {
  const list = def?.props ?? [];
  return list.find(p => p.id === ref) ?? list.find(p => p.name.toLowerCase() === String(ref).trim().toLowerCase());
}

export function findVariant(def: ComponentDef | undefined, ref: string): Variant | undefined {
  const list = def?.variants ?? [];
  const r = String(ref).trim().toLowerCase();
  return list.find(v => v.id === ref) ?? list.find(v => v.name.toLowerCase() === r) ?? list.find(v => `${v.group}=${v.name}`.toLowerCase() === r.replace(/\s*=\s*/, '='));
}

/** layers of a composition (whole subtrees) */
export function compLayers(P: Project, comp: Composition): Layer[] {
  const out: Layer[] = [];
  const walk = (ids: string[]) => { for (const id of ids) { const l = P.layers[id]; if (!l) continue; out.push(l); walk(l.children); } };
  walk(comp.root);
  return out;
}

// ======================================================================================
// exposed properties
// ======================================================================================

const firstV = (p: Prop | undefined) => (p ? (p.kf?.length ? p.kf[0].v : p.v) : undefined);

/** fields of a layer that can be exposed, with the kind of knob they make */
export function exposableFields(P: Project, l: Layer): { field: string; kind: ExposedKind; label: string }[] {
  const out: { field: string; kind: ExposedKind; label: string }[] = [];
  if (l.type === 'text' && l.text) out.push({ field: 'text', kind: 'text', label: 'Text' });
  if (l.type === 'image' || l.paints?.some(p => p.type === 'image')) out.push({ field: 'image', kind: 'image', label: 'Image' });
  if (l.props.fill && l.type !== 'image' && l.type !== 'precomp') out.push({ field: 'fill', kind: 'color', label: 'Fill color' });
  if (l.props.stroke && (l.props.strokeWidth?.v[0] ?? 0) > 0) out.push({ field: 'stroke', kind: 'color', label: 'Stroke color' });
  out.push({ field: 'visible', kind: 'toggle', label: 'Show / hide' });
  out.push({ field: 'opacity', kind: 'number', label: 'Opacity' });
  if (l.props.rotation?.kf?.length) out.push({ field: 'rotation', kind: 'number', label: 'Rotation amount' });
  if (l.props.scale?.kf?.length) out.push({ field: 'scale', kind: 'number', label: 'Scale amount' });
  out.push({ field: 'delay', kind: 'number', label: 'Delay' });
  const ic = instanceComp(P, l);
  for (const p of ic?.component?.props ?? []) out.push({ field: 'prop:' + p.id, kind: p.kind, label: `${ic!.name} · ${p.name}` });
  return out;
}

/** the value an exposed property has in the main (what an instance shows when it sets nothing) */
export function defaultValue(P: Project, prop: ExposedProp): ExposedValue {
  const t = prop.targets[0];
  const l = t ? P.layers[t.layer] : undefined;
  if (!l || !t) return prop.kind === 'toggle' ? true : prop.kind === 'number' ? 0 : '';
  return fieldValue(P, l, t.field) ?? '';
}

function fieldValue(P: Project, l: Layer, field: string): ExposedValue | undefined {
  switch (field) {
    case 'text': return l.text?.content;
    case 'image': return l.imageRef ?? l.paints?.find(p => p.type === 'image')?.imageRef;
    case 'visible': return l.visible;
    case 'delay': return 0;
    case 'fill': case 'stroke': return firstV(l.props[field])?.slice();
  }
  if (field.startsWith('prop:')) {
    const ic = instanceComp(P, l);
    const p = findProp(ic?.component, field.slice(5));
    if (!p) return undefined;
    return l.inst?.props?.[p.id] ?? defaultValue(P, p);
  }
  const p = l.props[field as PropKey];
  if (!p) return (PROP_DEFS as any)[field]?.default?.[0];
  if (p.kf?.length) return Math.max(...p.kf.map(k => Math.abs(k.v[0])));
  return p.v[0];
}

/** the value an instance shows for a property (its own, else the main's) */
export function instanceValue(P: Project, inst: Layer, prop: ExposedProp): ExposedValue {
  return inst.inst?.props?.[prop.id] ?? defaultValue(P, prop);
}

/** apply one exposed value to a (shallow-copied) layer */
function applyValue(l: Layer, field: string, v: ExposedValue) {
  switch (field) {
    case 'text':
      if (l.text) l.text = { ...l.text, content: String(v) };
      return;
    case 'image':
      if (typeof v !== 'string' || !v) return;
      if (l.type === 'image') l.imageRef = v;
      if (l.paints?.some(p => p.type === 'image')) l.paints = l.paints.map(p => (p.type === 'image' ? { ...p, imageRef: v } : p));
      return;
    case 'visible': l.visible = !!v; return;
    case 'delay': {
      const d = Number(v) || 0;
      if (!d) return;
      for (const k of Object.keys(l.props) as PropKey[]) { const p = l.props[k]; if (p?.kf?.length) l.props[k] = { ...p, kf: p.kf.map(f => ({ ...f, t: f.t + d })) }; }
      if (l.pathKf) l.pathKf = l.pathKf.map(f => ({ ...f, t: f.t + d }));
      if (l.textAnim) l.textAnim = { ...l.textAnim, start: l.textAnim.start + d };
      return;
    }
    case 'fill': case 'stroke': {
      const p = l.props[field];
      const c = Array.isArray(v) ? v : null;
      if (!p || !c) return;
      const rgba = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1];
      if (p.kf?.length) l.props[field] = { ...p, bind: undefined, kf: p.kf.map(k => ({ ...k, tok: undefined, v: [rgba[0], rgba[1], rgba[2], (k.v[3] ?? 1) * rgba[3]] })) };
      else l.props[field] = { ...p, bind: undefined, v: rgba };
      return;
    }
  }
  if (field.startsWith('prop:')) {
    const id = field.slice(5);
    l.inst = { ...(l.inst ?? {}), props: { ...(l.inst?.props ?? {}), [id]: v } };
    return;
  }
  const key = field as PropKey;
  const def = PROP_DEFS[key];
  if (!def) return;
  const n = Number(v);
  if (!Number.isFinite(n)) return;
  const p = l.props[key];
  if (p?.kf?.length) {
    const ref = Math.max(...p.kf.map(k => Math.abs(k.v[0])));
    const f = ref > 1e-9 ? n / ref : 1;
    // scale keeps its rest pose (100%): the swing around it is what scales
    const rest = key === 'scale' ? 100 : 0;
    if (key === 'scale') {
      const swing = Math.max(...p.kf.map(k => Math.abs(k.v[0] - rest)));
      const g = swing > 1e-9 ? (n - rest) / swing : 1;
      const peak = Math.max(...p.kf.map(k => k.v[0]));
      const g2 = Math.abs(peak - rest) > 1e-9 ? (n - rest) / (peak - rest) : g;
      l.props[key] = { ...p, kf: p.kf.map(k => ({ ...k, v: k.v.map(x => rest + (x - rest) * g2) })) };
    } else l.props[key] = { ...p, kf: p.kf.map(k => ({ ...k, tok: undefined, v: k.v.map(x => x * f) })) };
  } else l.props[key] = { ...(p ?? { v: [] }), bind: undefined, v: new Array(def.dim).fill(n) };
}

// ======================================================================================
// variants: differences over the same layers
// ======================================================================================

/** how each layout / look property differs in a variant */
const ADD_KEYS: PropKey[] = ['position', 'anchor', 'size', 'rotation'];
const MUL_KEYS: PropKey[] = ['scale'];
const SET_KEYS: PropKey[] = ['opacity', 'fill', 'stroke', 'strokeWidth', 'radius'];
export const VARIANT_KEYS: PropKey[] = [...ADD_KEYS, ...MUL_KEYS, ...SET_KEYS];
const opOf = (k: PropKey) => (ADD_KEYS.includes(k) ? 'add' : MUL_KEYS.includes(k) ? 'mul' : 'set');

const near = (a: number[] | undefined, b: number[] | undefined) => {
  if (!a || !b || a.length !== b.length) return a === b;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
  return true;
};

/** a prop with a variant difference applied (or undone: inverse) */
function opProp(p: Prop, key: PropKey, val: number[], inverse: boolean, base?: number[]): Prop {
  const op = opOf(key);
  if (op === 'set') {
    const to = inverse ? base : val;
    if (!to || p.kf?.length) return p; // replacing applies to still values
    return { ...p, bind: undefined, v: to.slice() };
  }
  const f = (x: number, i: number) => {
    const d = val[i] ?? (op === 'mul' ? 1 : 0);
    if (op === 'add') return inverse ? x - d : x + d;
    return inverse ? (Math.abs(d) > 1e-9 ? x / d : x) : x * d;
  };
  const kf = p.kf?.map((k: Keyframe) => ({ ...k, v: k.v.map(f) }));
  return { ...p, v: p.v.map(f), ...(kf ? { kf } : {}) };
}

/** snapshot of the variant-able fields of a layer */
function snapOf(l: Layer): BaseSnap {
  const s: BaseSnap = {};
  for (const k of VARIANT_KEYS) { const v = firstV(l.props[k]); if (v) (s.props ??= {})[k] = v.slice(); }
  if (l.text) { s.text = l.text.content; s.fontSize = l.text.fontSize; }
  s.visible = l.visible;
  return s;
}

/** differences of a layer from its base snapshot */
export function diffFromBase(l: Layer, base: BaseSnap): VariantLayerOv | null {
  const ov: VariantLayerOv = {};
  for (const k of VARIANT_KEYS) {
    const b = base.props?.[k], c = firstV(l.props[k]);
    if (!b || !c) continue;
    const op = opOf(k);
    if (op === 'add') { const d = c.map((x, i) => x - (b[i] ?? 0)); if (d.some(x => Math.abs(x) > 1e-6)) (ov.props ??= {})[k] = d; }
    else if (op === 'mul') { const m = c.map((x, i) => (Math.abs(b[i] ?? 0) > 1e-9 ? x / b[i] : 1)); if (m.some(x => Math.abs(x - 1) > 1e-6)) (ov.props ??= {})[k] = m; }
    else if (!near(c, b) && !l.props[k]?.kf?.length) (ov.props ??= {})[k] = c.slice();
  }
  if (l.text && base.text !== undefined && l.text.content !== base.text) ov.text = l.text.content;
  if (l.text && base.fontSize !== undefined && Math.abs(l.text.fontSize - base.fontSize) > 1e-6) ov.fontSize = l.text.fontSize;
  if (base.visible !== undefined && l.visible !== base.visible) ov.visible = l.visible;
  return ov.props || ov.text !== undefined || ov.fontSize !== undefined || ov.visible !== undefined ? ov : null;
}

/** apply (or undo, with the base snapshot) a variant difference to a shallow-copied layer */
function applyOv(l: Layer, ov: VariantLayerOv, inverse = false, base?: BaseSnap) {
  for (const k in ov.props ?? {}) {
    const key = k as PropKey, p = l.props[key];
    if (p) l.props[key] = opProp(p, key, ov.props![key]!, inverse, base?.props?.[key]);
  }
  if (l.text && (ov.text !== undefined || ov.fontSize !== undefined)) {
    const content = ov.text !== undefined ? (inverse ? base?.text ?? l.text.content : ov.text) : l.text.content;
    const fontSize = ov.fontSize !== undefined ? (inverse ? base?.fontSize ?? l.text.fontSize : ov.fontSize) : l.text.fontSize;
    l.text = { ...l.text, content, fontSize };
  }
  if (ov.visible !== undefined) l.visible = inverse ? base?.visible ?? l.visible : ov.visible;
}

/** chosen variants of an instance, in the component's group order */
export function chosenVariants(def: ComponentDef | undefined, inst: Layer['inst']): Variant[] {
  const pick = inst?.variants;
  if (!def?.variants?.length || !pick) return [];
  const ids = new Set(Object.values(pick));
  return def.variants.filter(v => ids.has(v.id) && pick[v.group] === v.id);
}

/** the size an instance of these variants has (last variant with a size wins), else the comp's */
export function variantSize(comp: Composition, vs: Variant[]): [number, number] {
  let w = comp.component?.editing ? comp.component.editing.size[0] : comp.width, h = comp.component?.editing ? comp.component.editing.size[1] : comp.height;
  for (const v of vs) if (v.width && v.height) { w = v.width; h = v.height; }
  return [w, h];
}

/** the timing an instance plays with: its variants' defaults, then its own */
export function effectivePlay(P: Project, l: Layer): PlaySpec | undefined {
  const c = instanceComp(P, l);
  const vs = c ? chosenVariants(c.component, l.inst) : [];
  let out: PlaySpec | undefined;
  for (const v of vs) if (v.play) out = { ...(out ?? {}), ...v.play };
  if (l.play) out = { ...(out ?? {}), ...l.play };
  return out;
}

// ======================================================================================
// resolving an instance's layers (renderer, exporters, agent descriptions)
// ======================================================================================

interface LayerPatch { base?: BaseSnap; inv?: VariantLayerOv; ovs: VariantLayerOv[]; vals: { field: string; v: ExposedValue }[] }
export interface InstancePlan { patches: Map<string, LayerPatch> }

/** what an instance changes, per layer of its component (null = nothing: share the main's layers) */
export function instancePlan(P: Project, inst: Layer, comp: Composition): InstancePlan | null {
  const def = comp.component;
  if (!def) return null;
  const patches = new Map<string, LayerPatch>();
  const get = (id: string) => { let x = patches.get(id); if (!x) patches.set(id, (x = { ovs: [], vals: [] })); return x; };
  const ed = def.editing;
  let live: Record<string, VariantLayerOv> | null = null;
  if (ed) {
    // the comp shows the variant being edited: undo its (live) differences first
    live = {};
    for (const id in ed.base) {
      const l = P.layers[id];
      if (!l) continue;
      const ov = diffFromBase(l, ed.base[id]);
      if (ov) { live[id] = ov; const x = get(id); x.base = ed.base[id]; x.inv = ov; }
    }
  }
  for (const v of chosenVariants(def, inst.inst)) {
    const ovs = ed && v.id === ed.variant ? live! : v.ov;
    for (const id in ovs) get(id).ovs.push(ovs[id]);
  }
  const vals = inst.inst?.props;
  if (vals) for (const p of def.props ?? []) {
    if (!(p.id in vals)) continue;
    for (const t of p.targets) get(t.layer).vals.push({ field: t.field, v: vals[p.id] });
  }
  return patches.size ? { patches } : null;
}

/** the layer as this instance shows it (a shallow copy sharing every untouched prop, or `l` itself) */
export function patchLayer(l: Layer, x: LayerPatch | undefined): Layer {
  if (!x) return l;
  const out: Layer = { ...l, props: { ...l.props } };
  if (x.inv) applyOv(out, x.inv, true, x.base);
  for (const ov of x.ovs) applyOv(out, ov);
  for (const { field, v } of x.vals) applyValue(out, field, v);
  return out;
}

/** caches patched layers so an unchanged instance hands the renderer the same objects every compile
 *  (incremental compiles reuse items by layer identity) */
export class InstanceResolver {
  private cache = new Map<string, { src: Layer; key: string; deps: unknown[]; out: Layer }>();
  private seen = new Set<string>();
  /** copies made in the last pass (stats / tests) */
  patched = 0;

  begin(changed?: Iterable<string>) {
    this.seen.clear(); this.patched = 0;
    // layers edited in place since the last pass (the renderer knows them): drop their copies
    if (changed) { const ids = new Set(changed); if (ids.size) for (const [k, e] of this.cache) if (ids.has(e.src.id)) this.cache.delete(k); }
  }
  /** drop entries not used since begin() */
  end() { for (const k of this.cache.keys()) if (!this.seen.has(k)) this.cache.delete(k); }

  resolve(chain: string, l: Layer, plan: InstancePlan | null): Layer {
    const x = plan?.patches.get(l.id);
    if (!x) return l;
    const ck = chain + '/' + l.id;
    this.seen.add(ck);
    const key = JSON.stringify(x);
    const deps = depsOf(l);
    const hit = this.cache.get(ck);
    if (hit && hit.src === l && hit.key === key && sameDeps(hit.deps, deps)) return hit.out;
    const out = patchLayer(l, x);
    this.cache.set(ck, { src: l, key, deps, out });
    this.patched++;
    return out;
  }
}

/** what a patched copy was made from (edits replace these objects through tx.set) */
function depsOf(l: Layer): unknown[] {
  const d: unknown[] = [l.props, l.text, l.imageRef, l.paints, l.visible, l.pathKf, l.textAnim, l.inst, l.play, l.children, l.inPoint, l.outPoint, l.effects, l.geometry];
  for (const k in l.props) { const p = l.props[k as PropKey]; d.push(p, p?.v, p?.kf, p?.expr); }
  return d;
}
function sameDeps(a: unknown[], b: unknown[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** a component's layers as one instance shows them (for exporters and descriptions; not cached) */
export function resolvedLayers(P: Project, inst: Layer): Map<string, Layer> {
  const comp = instanceComp(P, inst);
  const out = new Map<string, Layer>();
  if (!comp) return out;
  const plan = instancePlan(P, inst, comp);
  for (const l of compLayers(P, comp)) out.set(l.id, patchLayer(l, plan?.patches.get(l.id)));
  return out;
}

// ======================================================================================
// commands
// ======================================================================================

const touchInst = (tx: Tx, l: Layer) => { tx.touch(l.id); tx.recompile(); };

/** turn top-level layers of the active composition into a component (a new composition in their
 *  place, shown by one instance). ranges in / hold / out are guessed when the animation has a clear
 *  entrance and exit, so instances can play parts of it */
export function makeComponent(store: Store, ids: string[], opts: { name?: string; ranges?: boolean } = {}): { comp: Composition; layer: Layer } {
  const out = store.batch('make-component', () => {
    const { comp, layer } = precompose(store, ids, opts.name);
    const ranges = opts.ranges === false ? [] : guessRanges(store.project, comp);
    store.transact('Make component', tx => {
      tx.set(comp, 'name', opts.name?.trim() || comp.name.replace(/ comp$/, ''));
      tx.set(layer, 'name', comp.name);
      tx.set(comp, 'component', ranges.length ? { ranges } : {});
      tx.set(layer, 'inst', {});
      tx.comp();
      tx.touch(layer.id);
    });
    return { comp, layer };
  }, 'Make component');
  store.emit('components');
  store.emit('comps');
  return out;
}

/** mark an existing composition as a component (its precomp layers become instances) */
export function markComponent(store: Store, compId: string, on = true) {
  const c = store.project.comps[compId];
  if (!c || !!c.component === on) return;
  store.transact(on ? 'Make component' : 'Stop being a component', tx => {
    if (on) tx.set(c, 'component', {}); else tx.del(c, 'component');
    for (const l of motionInstancesOf(store.project, compId)) if (!on && l.inst) { tx.del(l, 'inst'); touchInst(tx, l); }
    tx.comp();
    tx.recompile();
  });
  store.emit('components');
  store.emit('comps');
}

/** the component's named ranges from its keyframes: "in" (entrance), "hold" (the still part) and
 *  "out" (exit), when the animation rests in between. empty when it never rests */
export function guessRanges(P: Project, comp: Composition): { name: string; from: number; to: number }[] {
  const times: number[] = [];
  for (const l of compLayers(P, comp)) {
    for (const k in l.props) for (const f of l.props[k as PropKey]?.kf ?? []) times.push(f.t);
    if (l.textAnim) { times.push(l.textAnim.start); }
  }
  if (times.length < 2) return [];
  times.sort((a, b) => a - b);
  // the longest still stretch between keys splits entrance from exit
  let best = 0, at = -1;
  for (let i = 1; i < times.length; i++) { const g = times[i] - times[i - 1]; if (g > best) { best = g; at = i; } }
  // an entrance before the rest and an exit after it
  if (at < 0 || best < 0.4 || best < comp.duration * 0.15 || times[at - 1] <= times[0] || times[at] >= times[times.length - 1]) return [];
  const fps = comp.fps, q = (t: number) => Math.round(t * fps) / fps;
  const a = q(times[at - 1]), b = q(times[at]);
  return [{ name: 'in', from: 0, to: a }, { name: 'hold', from: a, to: b }, { name: 'out', from: b, to: comp.duration }];
}

/** set the component's named ranges (replaces the list) */
export function setRanges(store: Store, compRef: string, ranges: { name: string; from: number; to: number }[]) {
  const comp = findComponent(store.project, compRef);
  if (!comp) throw new Error(`no component "${compRef}"`);
  const clean = ranges.map(r => ({ name: String(r.name).trim(), from: Math.max(0, Math.min(comp.duration, +r.from)), to: Math.max(0, Math.min(comp.duration, +r.to)) }))
    .filter(r => r.name && Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from);
  store.transact('Component ranges', tx => { if (clean.length) tx.set(comp.component!, 'ranges', clean); else tx.del(comp.component!, 'ranges'); tx.comp(); tx.recompile(); });
  store.emit('components');
}

/** add an instance of a component to the active composition (or under `parent`) */
export function addMotionInstance(store: Store, compRef: string, opts: {
  x?: number; y?: number; start?: number; play?: PlaySpec; props?: Record<string, ExposedValue>; variants?: Record<string, string>; parent?: string | null; name?: string; select?: boolean;
} = {}): Layer {
  const P = store.project;
  const comp = findComponent(P, compRef);
  if (!comp) throw new Error(`no component "${compRef}". components: ${componentComps(P).map(c => c.name).join(', ') || 'none (make_component first)'}`);
  if (comp.id === store.comp.id || usesComp(P, comp.id, store.comp.id)) throw new Error('a component cannot contain an instance of itself');
  const vs = chosenVariants(comp.component, { variants: opts.variants });
  const [w, h] = variantSize(comp, vs);
  const cur = store.comp;
  const l = createLayer('precomp', { name: opts.name ?? comp.name, w, h, x: (opts.x ?? cur.width / 2) - w / 2, y: (opts.y ?? cur.height / 2) - h / 2 });
  l.compRef = comp.id;
  l.startTime = opts.start ?? 0;
  l.inst = {};
  if (opts.variants && Object.keys(opts.variants).length) l.inst.variants = { ...opts.variants };
  if (opts.props) {
    const vals: Record<string, ExposedValue> = {};
    for (const [k, v] of Object.entries(opts.props)) {
      const p = findProp(comp.component, k);
      if (!p) throw new Error(`${comp.name} has no property "${k}". properties: ${(comp.component?.props ?? []).map(x => x.name).join(', ') || 'none'}`);
      vals[p.id] = v;
    }
    if (Object.keys(vals).length) l.inst.props = vals;
  }
  if (opts.play && Object.keys(opts.play).length) l.play = { ...opts.play };
  store.transact(`Add ${comp.name}`, tx => insertLayer(store, tx, l, opts.parent ?? null));
  if (opts.select !== false) store.select([l.id]);
  return l;
}

function usesComp(P: Project, outer: string, inner: string, seen = new Set<string>()): boolean {
  if (outer === inner) return true;
  if (seen.has(outer)) return false;
  seen.add(outer);
  const walk = (ids: string[]): boolean => ids.some(id => { const l = P.layers[id]; if (!l) return false; if (l.type === 'precomp' && l.compRef && usesComp(P, l.compRef, inner, seen)) return true; return walk(l.children); });
  return walk(P.comps[outer]?.root ?? []);
}

/** change the timing of instances (patch merges; a field set to undefined / null is removed) */
export function setPlay(store: Store, ids: string[], patch: Partial<Record<keyof PlaySpec, unknown>>, mergeKey?: string) {
  store.transact('Instance timing', tx => {
    for (const id of ids) {
      const l = store.project.layers[id];
      if (!l || l.type !== 'precomp') continue;
      const next: any = { ...(l.play ?? {}) };
      for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === null || v === '') delete next[k]; else next[k] = v; }
      if (next.speed === 1) delete next.speed;
      if (next.loop === 'none') delete next.loop;
      if (next.hold === 'none') delete next.hold;
      if (!next.reverse) delete next.reverse;
      if (Object.keys(next).length) tx.set(l, 'play', next); else tx.del(l, 'play');
      touchInst(tx, l);
    }
  }, mergeKey);
}

/** set exposed property values on instances (by property name or id). value null = back to the main's */
export function setInstanceProps(store: Store, ids: string[], values: Record<string, ExposedValue | null>, mergeKey?: string) {
  const P = store.project;
  store.transact('Instance property', tx => {
    for (const id of ids) {
      const l = P.layers[id];
      const comp = instanceComp(P, l);
      if (!l || !comp) throw new Error(`"${l?.name ?? id}" is not a component instance`);
      const props = { ...(l.inst?.props ?? {}) };
      for (const [k, v] of Object.entries(values)) {
        const p = findProp(comp.component, k);
        if (!p) throw new Error(`${comp.name} has no property "${k}". properties: ${(comp.component?.props ?? []).map(x => x.name).join(', ') || 'none (expose_property first)'}`);
        if (v === null || v === undefined) delete props[p.id];
        else props[p.id] = checkValue(p, v);
      }
      const inst = { ...(l.inst ?? {}) };
      if (Object.keys(props).length) inst.props = props; else delete inst.props;
      tx.set(l, 'inst', inst);
      touchInst(tx, l);
    }
  }, mergeKey);
}

function checkValue(p: ExposedProp, v: ExposedValue): ExposedValue {
  switch (p.kind) {
    case 'text': return String(v);
    case 'toggle': return !!v;
    case 'number': { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${p.name} needs a number`); return n; }
    case 'color': if (!Array.isArray(v) || v.length < 3) throw new Error(`${p.name} needs a color [r,g,b,a] (0..1)`); return v.slice(0, 4);
    case 'image': if (typeof v !== 'string') throw new Error(`${p.name} needs an image asset id`); return v;
  }
}

/** choose a variant (per group) on instances; variant null clears that group. resizes the
 *  instance to the variant's format */
export function setInstanceVariant(store: Store, ids: string[], group: string, variant: string | null) {
  const P = store.project;
  store.transact('Instance variant', tx => {
    for (const id of ids) {
      const l = P.layers[id];
      const comp = instanceComp(P, l);
      if (!l || !comp) continue;
      const v = variant ? findVariant(comp.component, variant) : undefined;
      if (variant && !v) throw new Error(`${comp.name} has no variant "${variant}". variants: ${(comp.component?.variants ?? []).map(x => `${x.group}=${x.name}`).join(', ') || 'none'}`);
      const vars = { ...(l.inst?.variants ?? {}) };
      if (v) vars[v.group] = v.id; else delete vars[group];
      const inst = { ...(l.inst ?? {}) };
      if (Object.keys(vars).length) inst.variants = vars; else delete inst.variants;
      tx.set(l, 'inst', inst);
      resizeInstance(tx, P, l, comp);
      touchInst(tx, l);
    }
  });
}

/** an instance's box follows its format (center kept) */
function resizeInstance(tx: Tx, P: Project, l: Layer, comp: Composition) {
  const [w, h] = variantSize(comp, chosenVariants(comp.component, l.inst));
  const s = l.props.size;
  if (!s || s.kf?.length || near(s.v, [w, h])) return;
  const old = s.v, a = l.props.anchor;
  tx.set(l.props, 'size', { ...s, v: [w, h] });
  if (a && !a.kf?.length) {
    const na = [old[0] ? a.v[0] / old[0] * w : w / 2, old[1] ? a.v[1] / old[1] * h : h / 2];
    tx.set(l.props, 'anchor', { ...a, v: na });
  }
}

/** swap which component instances show; values carry over by property name */
export function swapComponent(store: Store, ids: string[], compRef: string) {
  const P = store.project;
  const to = findComponent(P, compRef);
  if (!to) throw new Error(`no component "${compRef}"`);
  store.transact(`Swap to ${to.name}`, tx => {
    for (const id of ids) {
      const l = P.layers[id];
      const from = instanceComp(P, l);
      if (!l || !from || from.id === to.id) continue;
      if (usesComp(P, to.id, ownerCompOf(P, l.id) ?? '')) throw new Error('that would nest a component inside itself');
      const props: Record<string, ExposedValue> = {};
      for (const [pid, v] of Object.entries(l.inst?.props ?? {})) {
        const a = findProp(from.component, pid), b = a ? findProp(to.component, a.name) : undefined;
        if (b && b.kind === a!.kind) props[b.id] = v;
      }
      const vars: Record<string, string> = {};
      for (const vid of Object.values(l.inst?.variants ?? {})) {
        const a = (from.component?.variants ?? []).find(x => x.id === vid);
        const b = a ? (to.component?.variants ?? []).find(x => x.group === a.group && x.name === a.name) : undefined;
        if (b) vars[b.group] = b.id;
      }
      tx.set(l, 'compRef', to.id);
      tx.set(l, 'inst', { ...(Object.keys(props).length ? { props } : {}), ...(Object.keys(vars).length ? { variants: vars } : {}) });
      if (l.name === from.name) tx.set(l, 'name', to.name);
      resizeInstance(tx, P, l, to);
      tx.touch(l.id);
      tx.structure();
    }
  });
}

function ownerCompOf(P: Project, id: string): string | null {
  let cur: Layer | undefined = P.layers[id];
  while (cur?.parent) cur = P.layers[cur.parent];
  if (!cur) return null;
  return Object.values(P.comps).find(c => c.root.includes(cur!.id))?.id ?? null;
}

/** the component a layer lives in */
export function componentOfLayer(P: Project, id: string): Composition | undefined {
  const c = ownerCompOf(P, id);
  return c && P.comps[c]?.component ? P.comps[c] : undefined;
}

/** expose a layer field of a component as a property instances can set. returns the property */
export function exposeProperty(store: Store, compRef: string, def: { name: string; kind?: ExposedKind; targets: { layer: string; field: string }[]; min?: number; max?: number; step?: number; description?: string }): ExposedProp {
  const P = store.project;
  const comp = findComponent(P, compRef);
  if (!comp) throw new Error(`no component "${compRef}"`);
  if (!def.targets.length) throw new Error('expose needs at least one target layer field');
  const inComp = new Set(compLayers(P, comp).map(l => l.id));
  let kind = def.kind;
  for (const t of def.targets) {
    const l = P.layers[t.layer];
    if (!l || !inComp.has(t.layer)) throw new Error(`layer "${t.layer}" is not inside ${comp.name}`);
    const f = exposableFields(P, l).find(x => x.field === t.field);
    if (!f) throw new Error(`"${l.name}" has no exposable "${t.field}". options: ${exposableFields(P, l).map(x => x.field).join(', ')}`);
    kind ??= f.kind;
    if (f.kind !== kind) throw new Error(`"${l.name}" ${t.field} is a ${f.kind}, not a ${kind}`);
  }
  const name = def.name.trim() || 'Property';
  const existing = findProp(comp.component, name);
  const prop: ExposedProp = {
    id: existing?.id ?? uid('p'), name, kind: kind!, targets: def.targets.map(t => ({ layer: t.layer, field: t.field })),
    ...(def.min !== undefined ? { min: def.min } : {}), ...(def.max !== undefined ? { max: def.max } : {}), ...(def.step !== undefined ? { step: def.step } : {}),
    ...(def.description ? { description: def.description } : {}),
  };
  if (existing && existing.kind !== prop.kind) throw new Error(`${comp.name} already has a ${existing.kind} property "${name}"`);
  store.transact(`Expose ${name}`, tx => {
    const list = (comp.component!.props ?? []).filter(p => p.id !== prop.id);
    const at = existing ? (comp.component!.props ?? []).indexOf(existing) : list.length;
    list.splice(at, 0, existing ? { ...prop, targets: dedupe([...existing.targets, ...prop.targets]) } : prop);
    tx.set(comp.component!, 'props', list);
    tx.comp();
    tx.recompile();
  });
  store.emit('components');
  return findProp(comp.component, prop.id)!;
}

const dedupe = (ts: { layer: string; field: string }[]) => ts.filter((t, i) => ts.findIndex(u => u.layer === t.layer && u.field === t.field) === i);

export function updateProperty(store: Store, compId: string, propId: string, patch: Partial<Pick<ExposedProp, 'name' | 'min' | 'max' | 'step' | 'description'>>) {
  const comp = store.project.comps[compId];
  const p = findProp(comp?.component, propId);
  if (!comp || !p) return;
  store.transact('Rename property', tx => { tx.set(comp.component!, 'props', comp.component!.props!.map(x => (x.id === p.id ? { ...x, ...patch } : x))); tx.comp(); });
  store.emit('components');
}

/** remove an exposed property (instances drop their value for it) */
export function removeProperty(store: Store, compId: string, propId: string) {
  const P = store.project;
  const comp = P.comps[compId];
  const p = findProp(comp?.component, propId);
  if (!comp || !p) return;
  store.transact(`Remove ${p.name}`, tx => {
    tx.set(comp.component!, 'props', comp.component!.props!.filter(x => x.id !== p.id));
    for (const l of motionInstancesOf(P, compId)) {
      if (!l.inst?.props || !(p.id in l.inst.props)) continue;
      const props = { ...l.inst.props }; delete props[p.id];
      tx.set(l, 'inst', { ...l.inst, props });
      touchInst(tx, l);
    }
    tx.comp();
    tx.recompile();
  });
  store.emit('components');
}

// ---------------- variants ----------------

/** aspect ratio names for format variants */
export const FORMATS: { name: string; w: number; h: number }[] = [
  { name: '16:9', w: 1920, h: 1080 }, { name: '9:16', w: 1080, h: 1920 }, { name: '1:1', w: 1080, h: 1080 }, { name: '4:5', w: 1080, h: 1350 },
];

/** a full-bleed layer (background): it stretches to a new format instead of fitting */
function isBackdrop(l: Layer, W: number, H: number) {
  const s = firstV(l.props.size);
  return !!s && (l.type === 'rect' || l.type === 'image' || l.type === 'group' || l.type === 'precomp') && s[0] >= W * 0.95 && s[1] >= H * 0.95;
}

/** responsive layout for a new format: backgrounds stretch, the rest keeps its place relative to
 *  the center and scales uniformly to fit */
function layoutOv(P: Project, comp: Composition, W: number, H: number, W2: number, H2: number): Record<string, VariantLayerOv> {
  const out: Record<string, VariantLayerOv> = {};
  const s = Math.min(W2 / W, H2 / H);
  for (const id of comp.root) {
    const l = P.layers[id];
    const pos = firstV(l?.props.position);
    if (!l || !pos) continue;
    if (isBackdrop(l, W, H)) {
      const sz = firstV(l.props.size)!, an = firstV(l.props.anchor) ?? [0, 0];
      const fx = W2 / sz[0] * (sz[0] / W), fy = H2 / sz[1] * (sz[1] / H);
      const nsz = [sz[0] * fx, sz[1] * fy];
      const nan = [an[0] * fx, an[1] * fy];
      const npos = [pos[0] / W * W2, pos[1] / H * H2];
      out[id] = { props: { size: [nsz[0] - sz[0], nsz[1] - sz[1]], anchor: [nan[0] - an[0], nan[1] - an[1]], position: [npos[0] - pos[0], npos[1] - pos[1]] } };
      continue;
    }
    const np = [W2 / 2 + (pos[0] - W / 2) * s, H2 / 2 + (pos[1] - H / 2) * s];
    const ov: VariantLayerOv = { props: { position: [np[0] - pos[0], np[1] - pos[1]] } };
    if (Math.abs(s - 1) > 1e-6 && l.props.scale) ov.props!.scale = [s, s];
    out[id] = ov;
  }
  return out;
}

/** add a variant. format variants (width/height given, or a name like "9:16") get a responsive
 *  layout to start from; other groups start equal to the base */
export function addVariant(store: Store, compRef: string, opts: { name: string; group?: string; width?: number; height?: number; play?: PlaySpec }): Variant {
  const P = store.project;
  const comp = findComponent(P, compRef);
  if (!comp) throw new Error(`no component "${compRef}"`);
  if (comp.component!.editing) leaveVariant(store, comp.id);
  const name = opts.name.trim();
  if (!name) throw new Error('a variant needs a name');
  const fmt = FORMATS.find(f => f.name === name);
  let w = opts.width, h = opts.height;
  if (fmt && !w && !h) {
    // keep the short side: a 1920x1080 sting's 9:16 variant is 1080x1920, its 1:1 1080x1080
    const k = Math.min(comp.width, comp.height) / Math.min(fmt.w, fmt.h);
    w = Math.round(fmt.w * k); h = Math.round(fmt.h * k);
  }
  const group = opts.group?.trim() || (w || h ? 'Format' : 'Style');
  const existing = (comp.component!.variants ?? []).find(v => v.group === group && v.name === name);
  if (existing) return existing;
  const v: Variant = { id: uid('v'), name, group, ov: {} };
  if (w && h && (w !== comp.width || h !== comp.height)) { v.width = Math.round(w); v.height = Math.round(h); v.ov = layoutOv(P, comp, comp.width, comp.height, v.width, v.height); }
  if (opts.play) v.play = { ...opts.play };
  store.transact(`Add variant ${name}`, tx => { tx.set(comp.component!, 'variants', [...(comp.component!.variants ?? []), v]); tx.comp(); });
  store.emit('components');
  return v;
}

export function removeVariant(store: Store, compId: string, variantId: string) {
  const P = store.project;
  const comp = P.comps[compId];
  const v = findVariant(comp?.component, variantId);
  if (!comp || !v) return;
  if (comp.component!.editing?.variant === v.id) leaveVariant(store, compId);
  store.transact(`Remove variant ${v.name}`, tx => {
    tx.set(comp.component!, 'variants', comp.component!.variants!.filter(x => x.id !== v.id));
    for (const l of motionInstancesOf(P, compId)) {
      if (l.inst?.variants?.[v.group] !== v.id) continue;
      const vars = { ...l.inst.variants }; delete vars[v.group];
      tx.set(l, 'inst', { ...l.inst, variants: vars });
      resizeInstance(tx, P, l, comp);
      touchInst(tx, l);
    }
    tx.comp();
    tx.recompile();
  });
  store.emit('components');
}

export function updateVariant(store: Store, compId: string, variantId: string, patch: Partial<Pick<Variant, 'name' | 'group' | 'play'>>) {
  const comp = store.project.comps[compId];
  const v = findVariant(comp?.component, variantId);
  if (!comp || !v) return;
  store.transact('Edit variant', tx => {
    tx.set(comp.component!, 'variants', comp.component!.variants!.map(x => (x.id === v.id ? { ...x, ...patch } : x)));
    tx.comp(); tx.recompile();
  });
  store.emit('components');
}

/** show and edit a variant in the component's composition (null = back to the base). while a
 *  variant is shown, layout / look edits belong to it; keyframe timing and new layers belong to all */
export function editVariant(store: Store, compId: string, variantId: string | null) {
  const P = store.project;
  const comp = P.comps[compId];
  const def = comp?.component;
  if (!comp || !def) return;
  if ((def.editing?.variant ?? null) === variantId) return;
  const v = variantId ? findVariant(def, variantId) : undefined;
  if (variantId && !v) throw new Error(`no variant "${variantId}"`);
  store.transact(v ? `Edit variant ${v.name}` : 'Edit base', tx => {
    if (def.editing) leaveTx(tx, P, comp);
    if (v) {
      const base: Record<string, BaseSnap> = {};
      for (const l of compLayers(P, comp)) base[l.id] = snapOf(l);
      tx.set(def, 'editing', { variant: v.id, base, size: [comp.width, comp.height] });
      for (const [id, ov] of Object.entries(v.ov)) {
        const l = P.layers[id];
        if (!l) continue;
        const tmp: Layer = { ...l, props: { ...l.props } };
        applyOv(tmp, ov);
        writeBack(tx, l, tmp);
      }
      if (v.width && v.height) { tx.set(comp, 'width', v.width); tx.set(comp, 'height', v.height); }
    }
    tx.comp();
    tx.structure();
  });
  store.emit('components');
}

export function leaveVariant(store: Store, compId: string) { editVariant(store, compId, null); }

/** record the shown variant's differences and put the base back */
function leaveTx(tx: Tx, P: Project, comp: Composition) {
  const def = comp.component!, ed = def.editing!;
  const ovs: Record<string, VariantLayerOv> = {};
  for (const [id, base] of Object.entries(ed.base)) {
    const l = P.layers[id];
    if (!l) continue;
    const ov = diffFromBase(l, base);
    if (!ov) continue;
    ovs[id] = ov;
    const tmp: Layer = { ...l, props: { ...l.props } };
    applyOv(tmp, ov, true, base);
    writeBack(tx, l, tmp);
  }
  const sized = comp.width !== ed.size[0] || comp.height !== ed.size[1];
  tx.set(def, 'variants', (def.variants ?? []).map(x => (x.id === ed.variant ? { ...x, ov: ovs, ...(sized ? { width: comp.width, height: comp.height } : {}) } : x)));
  tx.set(comp, 'width', ed.size[0]);
  tx.set(comp, 'height', ed.size[1]);
  tx.del(def, 'editing');
}

/** write the fields a patch changed back into the real layer */
function writeBack(tx: Tx, l: Layer, tmp: Layer) {
  for (const k of VARIANT_KEYS) if (tmp.props[k] !== l.props[k]) tx.set(l.props, k, tmp.props[k]!);
  if (tmp.text !== l.text) tx.set(l, 'text', tmp.text!);
  if (tmp.visible !== l.visible) tx.set(l, 'visible', tmp.visible);
  tx.touch(l.id);
}

/** make a component of every format at once: adds the missing format variants */
export function addFormatVariants(store: Store, compRef: string, names = ['9:16', '1:1', '4:5']): Variant[] {
  const comp = findComponent(store.project, compRef);
  if (!comp) throw new Error(`no component "${compRef}"`);
  const ar = comp.width / comp.height;
  return store.batch('formats', () => names.filter(n => { const f = FORMATS.find(x => x.name === n); return !f || Math.abs(f.w / f.h - ar) > 0.01; }).map(n => addVariant(store, comp.id, { name: n })), 'Add format variants');
}

// ---------------- describing ----------------

/** compact description of a component (agent tools, library rows) */
export function describeComponent(P: Project, comp: Composition) {
  const def = comp.component ?? {};
  return {
    id: comp.id, name: comp.name, size: [comp.width, comp.height], duration: comp.duration,
    ranges: def.ranges ?? [],
    properties: (def.props ?? []).map(p => ({ name: p.name, kind: p.kind, default: defaultValue(P, p), targets: p.targets.map(t => `${P.layers[t.layer]?.name ?? t.layer}.${t.field}`) })),
    variants: (def.variants ?? []).map(v => ({ group: v.group, name: v.name, ...(v.width ? { size: [v.width, v.height] } : {}), ...(v.play ? { play: v.play } : {}), changes: Object.keys(v.ov).length })),
    instances: motionInstancesOf(P, comp.id).length,
    ...(def.editing ? { editingVariant: (def.variants ?? []).find(v => v.id === def.editing!.variant)?.name } : {}),
    ...(def.lib ? { library: def.lib.name } : {}),
  };
}

/** compact description of an instance */
export function describeInstance(P: Project, l: Layer) {
  const comp = instanceComp(P, l);
  if (!comp) return null;
  const play = effectivePlay(P, l);
  const span = instanceSpan(comp, play);
  return {
    component: comp.name,
    start: l.startTime ?? 0,
    plays: { range: playRange(comp, play), rate: Math.round(playRate(comp, play) * 1000) / 1000, length: Number.isFinite(span) ? Math.round(span * 1000) / 1000 : 'until out point', ...(play ?? {}) },
    values: Object.fromEntries((comp.component?.props ?? []).map(p => [p.name, instanceValue(P, l, p)])),
    variants: chosenVariants(comp.component, l.inst).map(v => `${v.group}=${v.name}`),
  };
}

export { clone as cloneJson };
