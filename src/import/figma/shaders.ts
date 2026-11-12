// figma clipboard: shader paints and shader effects -> motion shader refs (core/shaders.ts).
// loaded by ./index.ts (convertShaderPaint / convertShaderEffect hooks of convert.ts).
//
// the clipboard encoding of shaders is read schema-agnostically: the shader's identity (uuid +
// build sha), its source files (main.ts with defineProperties, features.json) and the param values
// are searched for in the paint / effect object (and json strings inside it). when the source is in
// the paste, the shader is embedded in the document (self-contained); without it the layer keeps a
// reference and renders a placeholder, with an import warning.
//
// the asset travels inline on the ref (`asset`) until the paste is inserted: hoistShaderAssets()
// then moves it into project.shaders (one entry per shader + version).

import type { Effect, Layer, Paint, Prop } from '../../core/model';
import { initialProps, makeShaderAsset, shaderAssetKey, type ShaderAsset, type ShaderKind, type ShaderRef } from '../../core/shaders';
import type { ShaderHookContext } from './convert';
import type { Store } from '../../core/store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;

interface Found { id?: string; version?: string; name?: string; main?: string; features?: string; files: Record<string, string>; values?: Record<string, unknown> }

function tryJson(s: string): unknown { try { return JSON.parse(s); } catch { return undefined; } }

/** walk an object (and json strings inside it) collecting what looks like shader data */
export function findShaderData(x: unknown): Found {
  const f: Found = { files: {} };
  const seen = new Set<unknown>();
  const visit = (v: unknown, key: string, depth: number) => {
    if (depth > 8 || v == null) return;
    if (typeof v === 'string') {
      if (!f.main && v.includes('defineProperties') && /export\s+function\s+render/.test(v)) { f.main = v; return; }
      if (!f.features && v.includes('"isAnimated"')) { f.features = v; return; }
      if (!f.id && UUID.test(v) && /shader|id|guid|key|asset/i.test(key)) f.id = v;
      else if (!f.version && SHA.test(v)) f.version = v;
      else if (!f.name && /^(name|shaderName|title)$/i.test(key) && v.length < 120) f.name = v;
      else if (v.length > 1 && (v[0] === '{' || v[0] === '[')) { const j = tryJson(v); if (j && typeof j === 'object') visit(j, key, depth + 1); }
      return;
    }
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (v instanceof Uint8Array) return;
    if (Array.isArray(v)) {
      // files: [{ filename / name, source / content }]
      for (const e of v) {
        const r = e as Record<string, unknown>;
        const fn = (r?.filename ?? r?.name ?? r?.path) as unknown, src = (r?.source ?? r?.content ?? r?.text ?? r?.code) as unknown;
        if (typeof fn === 'string' && typeof src === 'string' && /\.(ts|js|json|md|wgsl)$/.test(fn)) f.files[fn] = src;
      }
      // params: [{ name / key, value }]
      if (/param|propert|value|uniform|input/i.test(key) && v.length && v.every(e => e && typeof e === 'object' && ('value' in (e as object)) && typeof ((e as Record<string, unknown>).name ?? (e as Record<string, unknown>).key) === 'string')) {
        f.values ??= {};
        for (const e of v as Record<string, unknown>[]) f.values[String(e.name ?? e.key)] = e.value;
      }
      v.forEach((e, i) => visit(e, key + '[' + i + ']', depth + 1));
      return;
    }
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const c = o[k];
      if (!f.values && /^(params|parameters|properties|propertyValues|values|uniforms|inputs)$/i.test(k)) {
        const m = typeof c === 'string' ? tryJson(c) : c;
        if (m && typeof m === 'object' && !Array.isArray(m)) { f.values = m as Record<string, unknown>; continue; }
      }
      visit(c, k, depth + 1);
    }
  };
  visit(x, '', 0);
  if (f.main) f.files['main.ts'] ??= f.main;
  if (f.features) f.files['features.json'] ??= f.features;
  return f;
}

function usedSlots(layer: Layer): Set<string> {
  const s = new Set<string>();
  for (const k of Object.keys(layer.props)) if (k.startsWith('sh:')) s.add(k.slice(3, k.indexOf(':', 3)));
  for (const p of layer.paints ?? []) if (p.shader) s.add(p.shader.slot);
  for (const r of layer.shaderEffects ?? []) s.add(r.slot);
  return s;
}

/** a ref (with its params as props on the layer) from a figma shader paint / effect */
export function shaderRefFromFigma(raw: unknown, kind: ShaderKind, ctx: { layer: Layer; warn(m: string): void }): ShaderRef | null {
  const f = findShaderData(raw);
  if (!f.id && !f.files['main.ts']) { ctx.warn(`shader ${kind}: no shader id or source in the clipboard (skipped)`); return null; }
  const asset: ShaderAsset = makeShaderAsset({ id: f.id ?? `local-${hash(f.files['main.ts'] ?? '')}`, name: f.name, kind, version: f.version, files: f.files });
  if (!f.files['main.ts']) ctx.warn(`shader "${asset.name}": its source is not in the clipboard (placeholder; add it from the library)`);
  const used = usedSlots(ctx.layer);
  const p = kind === 'fill' ? 'f' : 'e';
  let i = 0;
  while (used.has(p + i)) i++;
  const slot = p + i;
  // values: authored form keyed by param key (unknown keys are ignored)
  const vals: Record<string, unknown> = {};
  for (const d of asset.params) {
    const v = f.values?.[d.key];
    if (v !== undefined) vals[d.key] = v && typeof v === 'object' && 'value' in (v as object) && Object.keys(v as object).length <= 3 ? (v as { value: unknown }).value : v;
  }
  for (const [k, prop] of Object.entries(initialProps(asset, slot, vals))) (ctx.layer.props as Record<string, Prop>)[k] = prop;
  const ref: ShaderRef & { asset?: ShaderAsset } = { slot, shader: shaderAssetKey(asset), asset };
  return ref;
}

export function convertShaderPaint(paint: any, ctx: ShaderHookContext): Paint | null {
  const ref = shaderRefFromFigma(paint, 'fill', ctx);
  if (!ref) return null;
  const out: Paint = { type: 'shader', shader: ref };
  const op = typeof paint?.opacity === 'number' ? paint.opacity : 1;
  if (op < 1) out.opacity = op;
  if (paint?.visible === false) ref.enabled = false;
  return out;
}

/** shader effects live in layer.shaderEffects (not in the generic effect list): returns null */
export function convertShaderEffect(effect: any, ctx: ShaderHookContext): Effect | null {
  const ref = shaderRefFromFigma(effect, 'effect', ctx);
  if (!ref) return null;
  if (effect?.visible === false) ref.enabled = false;
  ctx.layer.shaderEffects = [...(ctx.layer.shaderEffects ?? []), ref];
  return null;
}

/** move the shader assets that pasted layers carry inline into project.shaders (call right after
 *  inserting them, inside the same undo step) */
export function hoistShaderAssets(store: Store, layerIds: string[]) {
  const refs: (ShaderRef & { asset?: ShaderAsset })[] = [];
  for (const id of layerIds) {
    const l = store.project.layers[id];
    if (!l) continue;
    for (const p of l.paints ?? []) if (p.shader && (p.shader as { asset?: ShaderAsset }).asset) refs.push(p.shader);
    for (const r of l.shaderEffects ?? []) if ((r as { asset?: ShaderAsset }).asset) refs.push(r);
  }
  if (!refs.length) return;
  store.transact('Add shaders', tx => {
    const P = store.project;
    if (!P.shaders) tx.set(P, 'shaders', {});
    for (const r of refs) {
      const a = r.asset!;
      const cur = P.shaders![r.shader];
      // a pasted copy with source beats a source-less reference already in the library
      if (!cur || (!cur.files['main.ts'] && a.files['main.ts'])) tx.set(P.shaders!, r.shader, a);
      tx.set(r, 'asset', undefined);
    }
    for (const id of layerIds) tx.touch(id);
  });
}

function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); }
