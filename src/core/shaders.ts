// figma shaders (custom webgpu fills and effects) in the document model.
//
// a shader is a small module (main.ts + features.json, see the host contract in
// render/shader-worker.ts) that figma runs on a webgpu device. motion embeds the source of every
// shader a document uses in the document itself (project.shaders), so files stay self-contained,
// and runs it in a sandboxed worker.
//
// a layer uses a shader through a ShaderRef:
//  - as a fill: a paint { type: 'shader', shader: ref } in layer.paints
//  - as an effect: an entry of layer.shaderEffects (applied in order, bottom to top)
// every parameter of the shader is an ordinary animatable Prop stored in layer.props under the key
// `sh:<slot>:<param>` (keyframes, eases, expressions, undo, timeline rows and agent tools all work
// on it like on any other property). non-numeric parameters are flattened to numbers:
//
//   number                -> [n]
//   select (number)       -> [option value]          (discrete: hold keyframes)
//   select (string)       -> [option index]          (discrete)
//   boolean               -> [0 | 1]                 (discrete)
//   color                 -> [r, g, b, a]            (0..1)
//   point                 -> [x, y]
//   point-radius          -> [x, y, radius]
//   point-angle-radius    -> [x, y, radius, angle]
//   point-point-line      -> [x, y, x2, y2]
//   color-point           -> [x, y, r, g, b, a]
//   gradient              -> [n, pos0, r0, g0, b0, a0, pos1, ...] (keyframes keep the stop count)
//
// this file has no dom / gpu dependencies (it runs in node tests and in the worker).

import type { Layer, Paint, Project, Prop } from './model';

export type ShaderKind = 'fill' | 'effect';

/** features.json */
export interface ShaderFeatures {
  name?: string;
  version?: number;
  isAnimated?: boolean;
  usesMouse?: boolean;
  /** v3: the module reads frame.renderScale (renders crisp at any zoom) */
  renderScaleAware?: boolean;
}

export type ShaderParamType =
  | 'number' | 'string' | 'boolean' | 'color' | 'gradient'
  | 'point' | 'point-radius' | 'point-angle-radius' | 'point-point-line' | 'color-point'
  | (string & {});

export interface ShaderOption { value: number | string; label: string }

/** one entry of defineProperties(Effect, {...}), normalized */
export interface ShaderParamDef {
  key: string;
  type: ShaderParamType;
  label: string;
  description?: string;
  /** 'slider' | 'select' | 'input' | 'point' | ... (as authored) */
  control?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: ShaderOption[];
  /** as authored (object for points / colors / gradients) */
  defaultValue: unknown;
  /** 'canvas' | 'ui' | 'canvas_and_ui' (where figma shows the handle) */
  mode?: string;
  positionUnit?: string;
  radiusUnit?: string;
  minRadius?: number;
  maxRadius?: number;
}

/** a shader embedded in the document (project.shaders[key]) */
export interface ShaderAsset {
  /** figma shader id (uuid) or a local id */
  id: string;
  name: string;
  kind: ShaderKind;
  /** build version (figma commit sha) */
  version?: string;
  description?: string;
  owner?: string;
  features: ShaderFeatures;
  /** source files by name (main.ts, features.json, ...): the module runs from main.ts */
  files: Record<string, string>;
  /** parameter schema (from defineProperties) */
  params: ShaderParamDef[];
}

/** a layer's use of a shader (fill paint or effect) */
export interface ShaderRef {
  /** unique per layer: the params live in layer.props[`sh:${slot}:${param}`] */
  slot: string;
  /** key in project.shaders */
  shader: string;
  /** false = bypassed (default true) */
  enabled?: boolean;
  /** free-text string params (not animatable) */
  text?: Record<string, string>;
}

export type ShaderPropKey = `sh:${string}`;

export const SHADER_MAIN = 'main.ts';

// ------------------------------------------------------------------------------------------------
// prop keys

export function shaderPropKey(slot: string, param: string): ShaderPropKey { return `sh:${slot}:${param}`; }
export function isShaderPropKey(key: string): key is ShaderPropKey { return key.startsWith('sh:'); }
export function parseShaderPropKey(key: string): { slot: string; param: string } | null {
  if (!key.startsWith('sh:')) return null;
  const i = key.indexOf(':', 3);
  if (i < 0) return null;
  return { slot: key.slice(3, i), param: key.slice(i + 1) };
}

/** a layer's shader props as a plain record (layer.props is typed by the fixed prop keys) */
export function propsOf(layer: Layer): Record<string, Prop | undefined> {
  return layer.props as Record<string, Prop | undefined>;
}

// ------------------------------------------------------------------------------------------------
// layer queries

/** all shader refs of a layer: fills first (paint order), then effects */
export function shaderRefs(layer: Layer): { ref: ShaderRef; kind: ShaderKind; paint?: Paint }[] {
  const out: { ref: ShaderRef; kind: ShaderKind; paint?: Paint }[] = [];
  for (const p of layer.paints ?? []) if (p.type === 'shader' && p.shader) out.push({ ref: p.shader, kind: 'fill', paint: p });
  for (const r of layer.shaderEffects ?? []) out.push({ ref: r, kind: 'effect' });
  return out;
}

/** the shader fill that renders (topmost enabled shader paint), if any */
export function activeShaderFill(layer: Layer): { ref: ShaderRef; paint: Paint } | null {
  const ps = layer.paints;
  if (!ps) return null;
  for (let i = ps.length - 1; i >= 0; i--) {
    const p = ps[i];
    if (p.type === 'shader' && p.shader && p.shader.enabled !== false) return { ref: p.shader, paint: p };
  }
  return null;
}

export function activeShaderEffects(layer: Layer): ShaderRef[] {
  const fx = layer.shaderEffects;
  if (!fx || !fx.length) return EMPTY;
  let all = true;
  for (const r of fx) if (r.enabled === false) { all = false; break; }
  return all ? fx : fx.filter(r => r.enabled !== false);
}
const EMPTY: ShaderRef[] = [];

export function findRef(layer: Layer, slot: string): { ref: ShaderRef; kind: ShaderKind; paint?: Paint } | null {
  for (const r of shaderRefs(layer)) if (r.ref.slot === slot) return r;
  return null;
}

export function newSlotId(layer: Layer, kind: ShaderKind): string {
  const used = new Set(shaderRefs(layer).map(r => r.ref.slot));
  const p = kind === 'fill' ? 'f' : 'e';
  for (let i = 0; ; i++) if (!used.has(p + i)) return p + i;
}

// ------------------------------------------------------------------------------------------------
// parameter values <-> flat numbers

export function isDiscrete(def: ShaderParamDef): boolean {
  return def.type === 'boolean' || def.type === 'string' || (def.control === 'select' && !!def.options?.length);
}

/** labels of the components of a flattened param (inspector / timeline / agent) */
export function componentLabels(def: ShaderParamDef, dim?: number): string[] {
  switch (def.type) {
    case 'color': return ['r', 'g', 'b', 'a'];
    case 'point': return ['x', 'y'];
    case 'point-radius': return ['x', 'y', 'radius'];
    case 'point-angle-radius': return ['x', 'y', 'radius', 'angle'];
    case 'point-point-line': return ['x', 'y', 'x2', 'y2'];
    case 'color-point': return ['x', 'y', 'r', 'g', 'b', 'a'];
    case 'gradient': {
      const n = Math.max(0, Math.round(((dim ?? 1) - 1) / 5));
      const out = ['stops'];
      for (let i = 0; i < n; i++) out.push(`pos${i}`, `r${i}`, `g${i}`, `b${i}`, `a${i}`);
      return out;
    }
    default: return ['value'];
  }
}

function num(v: unknown, fb: number) { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function rec(v: unknown): Record<string, unknown> { return v && typeof v === 'object' ? v as Record<string, unknown> : {}; }

/** authored value (or default) -> flat numbers */
export function flattenValue(def: ShaderParamDef, value: unknown): number[] {
  const v = value === undefined ? def.defaultValue : value;
  switch (def.type) {
    case 'boolean': return [v ? 1 : 0];
    case 'string': {
      const s = typeof v === 'object' && v ? (v as { characters?: string }).characters : v;
      const i = def.options ? def.options.findIndex(o => o.value === s) : -1;
      return [Math.max(0, i)];
    }
    case 'color': { const c = rec(v); return [num(c.r, 0), num(c.g, 0), num(c.b, 0), num(c.a, 1)]; }
    case 'point': { const p = rec(v); return [num(p.x, 50), num(p.y, 50)]; }
    case 'point-radius': { const p = rec(v); return [num(p.x, 50), num(p.y, 50), num(p.radius, 50)]; }
    case 'point-angle-radius': { const p = rec(v); return [num(p.x, 50), num(p.y, 50), num(p.radius, 50), num(p.angle, 0)]; }
    case 'point-point-line': { const p = rec(v); return [num(p.x, 25), num(p.y, 50), num(p.x2, 75), num(p.y2, 50)]; }
    case 'color-point': { const p = rec(v), c = rec(p.color); return [num(p.x, 50), num(p.y, 50), num(c.r, 0), num(c.g, 0), num(c.b, 0), num(c.a, 1)]; }
    case 'gradient': {
      const stops = Array.isArray(rec(v).stops) ? rec(v).stops as unknown[] : [];
      const out = [stops.length];
      for (const s of stops) { const st = rec(s), c = rec(st.color); out.push(num(st.position, 0), num(c.r, 0), num(c.g, 0), num(c.b, 0), num(c.a, 1)); }
      return out;
    }
    default: return [num(v, num(def.defaultValue, 0))];
  }
}

/** flat numbers -> the value the module reads from frame.params */
export function unflattenValue(def: ShaderParamDef, f: ArrayLike<number>, off = 0, text?: string): unknown {
  const g = (i: number) => f[off + i];
  switch (def.type) {
    case 'boolean': return g(0) >= 0.5;
    case 'string': {
      if (!def.options?.length) return text ?? (typeof def.defaultValue === 'string' ? def.defaultValue : '');
      const i = Math.min(def.options.length - 1, Math.max(0, Math.round(g(0))));
      return def.options[i].value;
    }
    case 'color': return { r: g(0), g: g(1), b: g(2), a: g(3) };
    case 'point': return { x: g(0), y: g(1) };
    case 'point-radius': return { x: g(0), y: g(1), radius: g(2) };
    case 'point-angle-radius': return { x: g(0), y: g(1), radius: g(2), angle: g(3) };
    case 'point-point-line': return { x: g(0), y: g(1), x2: g(2), y2: g(3) };
    case 'color-point': return { x: g(0), y: g(1), color: { r: g(2), g: g(3), b: g(4), a: g(5) } };
    case 'gradient': {
      const n = Math.max(0, Math.round(g(0)));
      const stops = [];
      for (let i = 0; i < n; i++) { const o = 1 + i * 5; stops.push({ position: g(o), color: { r: g(o + 1), g: g(o + 2), b: g(o + 3), a: g(o + 4) } }); }
      return { stops };
    }
    default: {
      if (def.control === 'select' && def.options?.length) {
        // snap to the nearest option (keyframes between options hold anyway)
        let best = def.options[0].value, bd = Infinity;
        for (const o of def.options) { const d = Math.abs(Number(o.value) - g(0)); if (d < bd) { bd = d; best = o.value; } }
        return best;
      }
      return g(0);
    }
  }
}

/** number of flat components of a param's default value */
export function paramDim(def: ShaderParamDef): number { return flattenValue(def, undefined).length; }

/** the props a newly attached shader gets: defaults of every param (or `values`, authored form) */
export function initialProps(asset: ShaderAsset, slot: string, values?: Record<string, unknown>): Record<string, Prop> {
  const out: Record<string, Prop> = {};
  for (const def of asset.params) out[shaderPropKey(slot, def.key)] = { v: flattenValue(def, values?.[def.key]) };
  return out;
}

// ------------------------------------------------------------------------------------------------
// schema: parse defineProperties(Effect, {...}) without running the module
//
// the object literal is parsed by a tiny literal-only parser (objects, arrays, strings, numbers,
// booleans, null, comments). nothing of the (untrusted) module is executed on this thread. modules
// whose schema is not a plain literal get it from the sandboxed worker instead (describe job).

export function parseShaderSchema(src: string): ShaderParamDef[] | null {
  const m = /defineProperties\s*\(\s*[A-Za-z_$][\w$]*\s*,/.exec(src);
  if (!m) return null;
  try {
    const p = new LitParser(src, m.index + m[0].length);
    const obj = p.value();
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return normalizeSchema(obj as Record<string, unknown>);
  } catch { return null; }
}

export function normalizeSchema(obj: Record<string, unknown>): ShaderParamDef[] {
  const out: ShaderParamDef[] = [];
  for (const key of Object.keys(obj)) {
    const d = rec(obj[key]);
    const type = typeof d.type === 'string' ? d.type : 'number';
    const def: ShaderParamDef = { key, type, label: typeof d.label === 'string' ? d.label : key, defaultValue: d.defaultValue };
    if (typeof d.description === 'string') def.description = d.description;
    if (typeof d.control === 'string') def.control = d.control;
    for (const k of ['min', 'max', 'step', 'minRadius', 'maxRadius'] as const) if (typeof d[k] === 'number') def[k] = d[k] as number;
    const unit = d.unit ?? d.unitLabel;
    if (typeof unit === 'string') def.unit = unit;
    for (const k of ['mode', 'positionUnit', 'radiusUnit'] as const) if (typeof d[k] === 'string') def[k] = d[k] as string;
    if (Array.isArray(d.options)) def.options = d.options.map(o => { const r = rec(o); const value = typeof r.value === 'string' || typeof r.value === 'number' ? r.value : String(r.value); return { value, label: typeof r.label === 'string' ? r.label : String(value) }; });
    if (def.defaultValue === undefined) def.defaultValue = type === 'boolean' ? false : type === 'string' ? (def.options?.[0]?.value ?? '') : type === 'number' ? (def.min ?? 0) : undefined;
    out.push(def);
  }
  return out;
}

class LitParser {
  constructor(private s: string, private i: number) {}
  private ws() {
    const s = this.s;
    for (;;) {
      const c = s.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13) { this.i++; continue; }
      if (c === 47 && s[this.i + 1] === '/') { const e = s.indexOf('\n', this.i); this.i = e < 0 ? s.length : e; continue; }
      if (c === 47 && s[this.i + 1] === '*') { const e = s.indexOf('*/', this.i + 2); if (e < 0) throw new Error('comment'); this.i = e + 2; continue; }
      return;
    }
  }
  value(): unknown {
    this.ws();
    const s = this.s, c = s[this.i];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"' || c === "'" || c === '`') return this.string();
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(this.i, this.i + 40));
    if (m) { this.i += m[0].length; return Number(m[0]); }
    for (const [w, v] of [['true', true], ['false', false], ['null', null], ['undefined', undefined]] as const) {
      if (s.startsWith(w, this.i) && !/[\w$]/.test(s[this.i + w.length] ?? '')) { this.i += w.length; return v; }
    }
    throw new Error(`unexpected ${c} at ${this.i}`);
  }
  private string(): string {
    const s = this.s, q = s[this.i++];
    let out = '';
    while (this.i < s.length) {
      const c = s[this.i++];
      if (c === q) return out;
      if (q === '`' && c === '$' && s[this.i] === '{') throw new Error('template');
      if (c === '\\') {
        const e = s[this.i++];
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'u' ? String.fromCharCode(parseInt(s.slice(this.i, (this.i += 4)), 16)) : e;
      } else out += c;
    }
    throw new Error('string');
  }
  private key(): string {
    this.ws();
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.string();
    const m = /^[A-Za-z_$][\w$]*|^\d+/.exec(this.s.slice(this.i, this.i + 200));
    if (!m) throw new Error('key');
    this.i += m[0].length;
    return m[0];
  }
  private object(): Record<string, unknown> {
    this.i++;
    const out: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') { this.i++; return out; }
      const k = this.key();
      this.ws();
      if (this.s[this.i] !== ':') throw new Error('colon');
      this.i++;
      out[k] = this.value();
      this.ws();
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === '}') { this.i++; return out; }
      throw new Error('object');
    }
  }
  private array(): unknown[] {
    this.i++;
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') { this.i++; return out; }
      out.push(this.value());
      this.ws();
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === ']') { this.i++; return out; }
      throw new Error('array');
    }
  }
}

export function parseFeatures(json: string | undefined): ShaderFeatures {
  if (!json) return {};
  try { const f = JSON.parse(json); return f && typeof f === 'object' ? f : {}; } catch { return {}; }
}

/** build a library entry from shader files (figma clipboard, mcp, or a file the user adds) */
export function makeShaderAsset(init: { id: string; name?: string; kind: ShaderKind; version?: string; description?: string; owner?: string; files: Record<string, string>; params?: ShaderParamDef[] }): ShaderAsset {
  const features = parseFeatures(init.files['features.json']);
  const params = init.params ?? parseShaderSchema(init.files[SHADER_MAIN] ?? '') ?? [];
  return {
    id: init.id,
    name: init.name ?? features.name ?? 'Shader',
    kind: init.kind,
    version: init.version,
    description: init.description,
    owner: init.owner,
    features,
    files: { ...init.files },
    params,
  };
}

/** project.shaders key for an asset (same id + version = same entry) */
export function shaderAssetKey(a: { id: string; version?: string }): string {
  return a.version ? `${a.id}@${a.version.slice(0, 12)}` : a.id;
}

/** add (or find) an asset in the project's shader library. returns its key. mutates the project:
 *  call inside a transaction (tx.set) when the project is live; import builds new projects directly */
export function shaderAssetFor(project: Project, asset: ShaderAsset): { key: string; isNew: boolean } {
  const key = shaderAssetKey(asset);
  return { key, isNew: !project.shaders?.[key] };
}

/** human description of a param's value (agent tools, inspector tooltips) */
export function describeValue(def: ShaderParamDef, v: ArrayLike<number>): unknown {
  return unflattenValue(def, v);
}

// ------------------------------------------------------------------------------------------------
// labels / ranges for ui (timeline rows, inspector, graph)

export interface ShaderPropInfo {
  label: string;
  dim: number;
  unit: string;
  min?: number;
  max?: number;
  def: ShaderParamDef;
  asset: ShaderAsset;
  ref: ShaderRef;
  kind: ShaderKind;
}

export function shaderPropInfo(project: Project, layer: Layer, key: string): ShaderPropInfo | null {
  const k = parseShaderPropKey(key);
  if (!k) return null;
  const r = findRef(layer, k.slot);
  if (!r) return null;
  const asset = project.shaders?.[r.ref.shader];
  const def = asset?.params.find(p => p.key === k.param);
  if (!asset || !def) return null;
  const p = propsOf(layer)[key];
  return {
    label: `${asset.name} · ${def.label}`,
    dim: p?.v.length ?? paramDim(def),
    unit: def.type === 'color' || def.type === 'color-point' ? 'color' : def.unit ?? '',
    min: def.min, max: def.max, def, asset, ref: r.ref, kind: r.kind,
  };
}

/** prop keys of every param of a layer's shaders, in schema order */
export function shaderPropKeys(project: Project, layer: Layer): string[] {
  const out: string[] = [];
  for (const { ref } of shaderRefs(layer)) {
    const a = project.shaders?.[ref.shader];
    if (!a) continue;
    for (const d of a.params) out.push(shaderPropKey(ref.slot, d.key));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// render cache key: a stable hash of what a shader frame depends on

/** fnv-1a over float values (no allocation) */
export function hashFloats(h: number, a: ArrayLike<number>, n = a.length): number {
  for (let i = 0; i < n; i++) {
    let x = a[i];
    if (x === 0) x = 0; // -0
    // mix the float's integer and fractional parts (exact enough for change detection)
    const ip = Math.floor(x), fp = Math.round((x - ip) * 1e6);
    h = Math.imul(h ^ (ip | 0), 16777619);
    h = Math.imul(h ^ fp, 16777619);
    h = Math.imul(h ^ ((ip / 4294967296) | 0), 16777619);
  }
  return h >>> 0;
}
