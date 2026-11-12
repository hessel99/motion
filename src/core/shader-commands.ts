// undoable edits of shader fills / effects (inspector, agent tools, import). params are ordinary
// props (`sh:<slot>:<param>`), so value edits and keyframes also go through core/commands.ts.

import { defaultEase, type Keyframe, type Layer, type Paint, type Prop, type PropKey } from './model';
import { setPropTx } from './commands';
import type { Store, Tx } from './store';
import {
  findRef, flattenValue, initialProps, isDiscrete, newSlotId, propsOf, shaderAssetKey, shaderPropKey,
  type ShaderAsset, type ShaderKind, type ShaderParamDef, type ShaderRef,
} from './shaders';

/** put an asset into the document's shader library (inside a transaction). returns its key */
export function ensureShaderAsset(store: Store, tx: Tx, asset: ShaderAsset): string {
  const key = shaderAssetKey(asset);
  const p = store.project;
  if (!p.shaders) tx.set(p, 'shaders', {});
  if (!p.shaders![key]) tx.set(p.shaders!, key, asset);
  return key;
}

/** attach a shader (from the library, or a new asset) to layers as their fill or as an effect.
 *  `values`: initial params (authored form, e.g. { dotSize: 12, centerPos: { x: 50, y: 50 } }).
 *  returns the slot id per layer */
export function addShader(store: Store, ids: string[], shader: string | ShaderAsset, opts: { kind?: ShaderKind; values?: Record<string, unknown>; opacity?: number } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  store.transact('Add shader', tx => {
    const key = typeof shader === 'string' ? shader : ensureShaderAsset(store, tx, shader);
    const asset = store.project.shaders?.[key];
    if (!asset) throw new Error(`no shader "${key}" in this document`);
    const kind = opts.kind ?? asset.kind;
    if (kind === 'effect' && asset.kind !== 'effect') throw new Error(`"${asset.name}" is a fill shader: it can't be an effect`);
    for (const id of ids) {
      const l = store.layer(id);
      if (!l) continue;
      const slot = newSlotId(l, kind);
      const ref: ShaderRef = { slot, shader: key };
      for (const [k, p] of Object.entries(initialProps(asset, slot, opts.values))) tx.set(propsOf(l) as Record<string, Prop>, k, p);
      if (kind === 'fill') {
        const paint: Paint = { type: 'shader', shader: ref };
        if (opts.opacity !== undefined && opts.opacity < 1) paint.opacity = opts.opacity;
        tx.set(l, 'paints', [...(l.paints ?? []), paint]);
      } else tx.set(l, 'shaderEffects', [...(l.shaderEffects ?? []), ref]);
      tx.touch(id);
      out[id] = slot;
    }
  });
  return out;
}

/** detach a shader from a layer (its params go with it) */
export function removeShader(store: Store, id: string, slot: string) {
  const l = store.layer(id);
  if (!l || !findRef(l, slot)) return;
  store.transact('Remove shader', tx => removeShaderTx(tx, l, slot));
}

export function removeShaderTx(tx: Tx, l: Layer, slot: string) {
  if (l.paints?.some(p => p.shader?.slot === slot)) tx.set(l, 'paints', l.paints.filter(p => p.shader?.slot !== slot));
  if (l.shaderEffects?.some(r => r.slot === slot)) {
    const fx = l.shaderEffects.filter(r => r.slot !== slot);
    tx.set(l, 'shaderEffects', fx.length ? fx : undefined);
  }
  const pre = `sh:${slot}:`;
  for (const k of Object.keys(l.props)) if (k.startsWith(pre)) tx.del(propsOf(l) as Record<string, Prop>, k);
  tx.touch(l.id);
}

/** bypass / enable a shader */
export function setShaderEnabled(store: Store, id: string, slot: string, enabled: boolean) {
  const l = store.layer(id);
  const r = l && findRef(l, slot);
  if (!l || !r) return;
  store.transact(enabled ? 'Enable shader' : 'Bypass shader', tx => {
    if (r.kind === 'fill') tx.set(l, 'paints', l.paints!.map(p => (p.shader?.slot === slot ? { ...p, shader: { ...p.shader!, enabled } } : p)));
    else tx.set(l, 'shaderEffects', l.shaderEffects!.map(x => (x.slot === slot ? { ...x, enabled } : x)));
    tx.touch(id);
  });
}

/** move an effect up / down the chain */
export function moveShaderEffect(store: Store, id: string, slot: string, dir: -1 | 1) {
  const l = store.layer(id);
  const fx = l?.shaderEffects;
  if (!l || !fx) return;
  const i = fx.findIndex(r => r.slot === slot), j = i + dir;
  if (i < 0 || j < 0 || j >= fx.length) return;
  const next = fx.slice();
  [next[i], next[j]] = [next[j], next[i]];
  store.transact('Reorder effects', tx => { tx.set(l, 'shaderEffects', next); tx.touch(id); });
}

/** the schema entry and prop key of a param */
export function shaderParam(store: Store, l: Layer, slot: string, param: string): { def: ShaderParamDef; key: PropKey; asset: ShaderAsset } | null {
  const r = findRef(l, slot);
  const asset = r && store.project.shaders?.[r.ref.shader];
  const def = asset?.params.find(p => p.key === param || p.label.toLowerCase() === param.toLowerCase());
  if (!r || !asset || !def) return null;
  return { def, key: shaderPropKey(slot, def.key) as unknown as PropKey, asset };
}

/** value in any form (authored object, flat numbers, option label) -> flat numbers of the param */
export function toFlat(def: ShaderParamDef, value: unknown): number[] {
  if (Array.isArray(value) && value.every(x => typeof x === 'number')) return value.slice();
  // numbers: the value (string selects: the option index)
  if (typeof value === 'number') return [value];
  if (typeof value === 'string' && def.options?.length) {
    const o = def.options.find(x => String(x.value) === value || x.label.toLowerCase() === value.toLowerCase());
    if (!o) throw new Error(`"${value}" is not an option of ${def.label} (${def.options.map(x => x.label).join(', ')})`);
    return flattenValue(def, def.type === 'string' ? o.value : Number(o.value));
  }
  if (typeof value === 'string' && /^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) && (def.type === 'color')) {
    const h = value.replace('#', '');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).concat(h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
  }
  if (typeof value === 'object' && value && def.type === 'color-point' && !('color' in value)) throw new Error('color-point values look like { x, y, color: { r, g, b, a } }');
  return flattenValue(def, value);
}

/** set a param at the playhead (or `time`): keys it when the param is animated (like any prop) */
export function setShaderParam(store: Store, id: string, slot: string, param: string, value: unknown, opts: { time?: number; mergeKey?: string; forceKey?: boolean } = {}) {
  const l = store.layer(id);
  const sp = l && shaderParam(store, l, slot, param);
  if (!l || !sp) throw new Error(`no shader param "${param}" in slot ${slot}`);
  const v = toFlat(sp.def, value);
  const cur = propsOf(l)[sp.key];
  if (cur && cur.v.length !== v.length && sp.def.type !== 'gradient') throw new Error(`${sp.def.label} takes ${cur.v.length} numbers`);
  const t = opts.time ?? store.time;
  store.transact(`Change ${sp.def.label}`, tx => {
    setPropTx(tx, l, sp.key, v, t, !!opts.forceKey);
    if (isDiscrete(sp.def)) holdKeys(tx, l, sp.key);
  }, opts.mergeKey);
}

export interface ShaderKeyInput { t: number; v: unknown; ease?: string | [number, number, number, number]; interp?: Keyframe['interp'] }

/** replace a param's animation with these keyframes (agent: "animate dot size 4 -> 40 with ease out") */
export function setShaderParamKeys(store: Store, id: string, slot: string, param: string, keys: ShaderKeyInput[], easeOf: (e: string | [number, number, number, number] | undefined) => Pick<Keyframe, 'interp' | 'out' | 'in' | 'bounce'> = () => defaultEase()) {
  const l = store.layer(id);
  const sp = l && shaderParam(store, l, slot, param);
  if (!l || !sp) throw new Error(`no shader param "${param}" in slot ${slot}`);
  const discrete = isDiscrete(sp.def);
  const kf: Keyframe[] = keys.map(k => {
    const e = easeOf(k.ease);
    const kf: Keyframe = { t: k.t, v: toFlat(sp.def, k.v), interp: discrete ? 'hold' : k.interp ?? e.interp, out: [...e.out] as [number, number], in: [...e.in] as [number, number] };
    if (e.bounce !== undefined && kf.interp === 'spring') kf.bounce = e.bounce;
    return kf;
  }).sort((a, b) => a.t - b.t);
  if (kf.some(k => k.v.length !== kf[0].v.length)) throw new Error('every keyframe needs the same number of components (gradients: the same stop count)');
  store.transact(`Animate ${sp.def.label}`, tx => {
    const P = propsOf(l) as Record<string, Prop>;
    let p = P[sp.key];
    if (!p) { p = { v: kf[0]?.v.slice() ?? flattenValue(sp.def, undefined) }; tx.set(P, sp.key, p); }
    if (kf.length) tx.set(p, 'kf', kf); else tx.set(p, 'kf', undefined);
    tx.touch(id);
  });
}

/** discrete params (selects, booleans) never interpolate */
function holdKeys(tx: Tx, l: Layer, key: PropKey) {
  const p = l.props[key];
  if (!p?.kf?.some(k => k.interp !== 'hold')) return;
  tx.set(p, 'kf', p.kf.map(k => ({ ...k, interp: 'hold' as const })));
}
