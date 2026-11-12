// high level editing operations shared by the ui, keyboard shortcuts and ai agent tools.

import { evalProp } from './evaluate';
import { EASE_PRESETS } from './easing';
import {
  createComp, createLayer, defaultEase, PROP_DEFS, uid,
  type Keyframe, type Layer, type LayerType, type Prop, type PropKey, type Interp,
} from './model';
import type { Store, Tx } from './store';

const EPS = 1e-6;

/** editor modes that affect editing commands */
export const editMode = { autoKey: false };

export function propDim(key: PropKey) { return PROP_DEFS[key].dim; }

export function valueAt(layer: Layer, key: PropKey, t: number): number[] {
  const def = PROP_DEFS[key];
  return evalProp(layer.props[key], t, def.dim, def.default as unknown as number[]);
}

export function isAnimated(layer: Layer, key: PropKey) {
  return !!layer.props[key]?.kf?.length;
}

function clampValue(key: PropKey, v: number[]): number[] {
  const def = PROP_DEFS[key] as { min?: number; max?: number };
  if (def.min === undefined && def.max === undefined) return v;
  return v.map(x => Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, x)));
}

// ---------------- layers ----------------

export function addLayer(store: Store, type: LayerType, init: Parameters<typeof createLayer>[1] = {}, parent: string | null = null, index?: number): Layer {
  const layer = createLayer(type, init);
  store.transact(`Add ${type}`, tx => insertLayer(store, tx, layer, parent, index));
  return layer;
}

/** insert a fully built layer (and optionally its pre-built descendants already in `extra`) */
export function insertLayer(store: Store, tx: Tx, layer: Layer, parent: string | null, index?: number, extra: Layer[] = []) {
  const P = store.project;
  for (const l of extra) tx.set(P.layers, l.id, l);
  tx.set(P.layers, layer.id, layer);
  layer.parent = parent;
  if (parent) {
    const p = P.layers[parent];
    const ch = p.children.slice();
    ch.splice(index ?? ch.length, 0, layer.id);
    tx.set(p, 'children', ch);
  } else {
    const comp = store.comp;
    const root = comp.root.slice();
    root.splice(index ?? root.length, 0, layer.id);
    tx.set(comp, 'root', root);
  }
  tx.structure();
  tx.touch(layer.id);
}

export function deleteLayers(store: Store, ids: string[]) {
  const P = store.project;
  // drop ids whose ancestor is also being deleted
  const set = new Set(ids);
  const roots = ids.filter(id => P.layers[id] && !ids.some(o => o !== id && store.isAncestor(o, id)));
  if (!roots.length) return;
  store.transact('Delete', tx => {
    for (const id of roots) {
      const l = P.layers[id];
      if (l.parent) {
        const p = P.layers[l.parent];
        tx.set(p, 'children', p.children.filter(c => c !== id));
      } else {
        tx.set(store.comp, 'root', store.comp.root.filter(c => c !== id));
      }
      for (const d of [id, ...store.descendants(id)]) tx.del(P.layers, d);
    }
    tx.structure();
  });
  store.select(store.selection.filter(id => !set.has(id) && P.layers[id]));
}

/** deep clone layers (with descendants) giving fresh ids. returns new root ids. */
export function cloneLayers(store: Store, ids: string[], offset = 0) {
  const P = store.project;
  const map = new Map<string, Layer>();
  const cloneRec = (id: string, parent: string | null): Layer => {
    const src = P.layers[id];
    const copy: Layer = JSON.parse(JSON.stringify(src));
    copy.id = uid();
    copy.parent = parent;
    map.set(copy.id, copy);
    copy.children = src.children.map(c => cloneRec(c, copy.id).id);
    return copy;
  };
  const created: string[] = [];
  ids = ids.filter(id => P.layers[id] && !ids.some(o => o !== id && store.isAncestor(o, id)));
  store.transact('Duplicate', tx => {
    for (const id of ids) {
      const src = P.layers[id];
      if (!src) continue;
      const copy = cloneRec(id, src.parent);
      copy.name = src.name + ' copy';
      if (offset) offsetPosition(copy, offset, offset);
      const extra = [...map.values()].filter(l => l !== copy);
      const sib = src.parent ? P.layers[src.parent].children : store.comp.root;
      insertLayer(store, tx, copy, src.parent, sib.indexOf(id) + 1, extra);
      map.clear();
      created.push(copy.id);
    }
  });
  store.select(created);
  return created;
}

function offsetPosition(l: Layer, dx: number, dy: number) {
  const p = l.props.position;
  if (!p) return;
  p.v = [p.v[0] + dx, p.v[1] + dy];
  if (p.kf) for (const k of p.kf) k.v = [k.v[0] + dx, k.v[1] + dy];
}

export function renameLayer(store: Store, id: string, name: string) {
  const l = store.layer(id);
  if (!l || l.name === name) return;
  store.transact('Rename', tx => { tx.set(l, 'name', name); tx.touch(id); });
}

export function setLayerField<K extends keyof Layer>(store: Store, ids: string[], key: K, value: Layer[K], label = 'Edit') {
  store.transact(label, tx => {
    for (const id of ids) {
      const l = store.layer(id);
      if (!l) continue;
      tx.set(l, key, value);
      tx.touch(id);
    }
    if (key === 'visible' || key === 'clip' || key === 'mask' || key === 'startTime') tx.structure();
  });
}

/** move layers to a new parent/index (drag in layer list). index counts in the target sibling list. */
export function moveLayers(store: Store, ids: string[], parent: string | null, index: number) {
  const P = store.project;
  ids = ids.filter(id => P.layers[id] && id !== parent && !(parent && store.isAncestor(id, parent)));
  ids = ids.filter(id => !ids.some(o => o !== id && store.isAncestor(o, id)));
  const order = new Map(store.drawOrder().map((id, i) => [id, i]));
  ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  if (!ids.length) return;
  store.transact('Move layers', tx => {
    const targetList = () => (parent ? P.layers[parent].children : store.comp.root);
    // compensate index for items removed before it in the same list
    let idx = index;
    for (const id of ids) {
      const l = P.layers[id];
      if (l.parent === parent) {
        const pos = targetList().indexOf(id);
        if (pos < index) idx--;
      }
    }
    for (const id of ids) {
      const l = P.layers[id];
      if (l.parent) tx.set(P.layers[l.parent], 'children', P.layers[l.parent].children.filter(c => c !== id));
      else tx.set(store.comp, 'root', store.comp.root.filter(c => c !== id));
    }
    const list = targetList().slice();
    list.splice(Math.max(0, Math.min(list.length, idx)), 0, ...ids);
    if (parent) tx.set(P.layers[parent], 'children', list); else tx.set(store.comp, 'root', list);
    for (const id of ids) tx.set(P.layers[id], 'parent', parent);
    tx.structure();
  });
}

/** bring forward / send backward in draw order (within siblings) */
export function reorder(store: Store, ids: string[], dir: 'up' | 'down' | 'top' | 'bottom') {
  store.transact('Reorder', tx => {
    for (const id of ids) {
      const l = store.layer(id);
      if (!l) continue;
      const list = store.siblings(l).slice();
      const i = list.indexOf(id);
      list.splice(i, 1);
      const j = dir === 'up' ? Math.min(list.length, i + 1) : dir === 'down' ? Math.max(0, i - 1) : dir === 'top' ? list.length : 0;
      list.splice(j, 0, id);
      if (l.parent) tx.set(store.project.layers[l.parent], 'children', list); else tx.set(store.comp, 'root', list);
    }
    tx.structure();
  });
}

/** wrap layers into a new group positioned at their common bounding box */
export function groupLayers(store: Store, ids: string[], bounds: { x: number; y: number; w: number; h: number }) {
  if (!ids.length) return;
  const first = store.layer(ids[0])!;
  const parent = first.parent;
  if (ids.some(id => store.layer(id)?.parent !== parent)) throw new Error('select layers with the same parent to group them');
  return store.batch('group', () => groupLayersInner(store, ids, bounds, first, parent));
}

function groupLayersInner(store: Store, ids: string[], bounds: { x: number; y: number; w: number; h: number }, first: Layer, parent: string | null) {
  const siblings = store.siblings(first);
  const sameParent = ids.filter(id => store.layer(id)?.parent === parent);
  const index = Math.max(...sameParent.map(id => siblings.indexOf(id)));
  const group = createLayer('group', { name: 'Group', x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
  store.transact('Group', tx => {
    insertLayer(store, tx, group, parent, index + 1);
    // children positions are in group-local space: shift by group origin
    for (const id of sameParent) {
      const l = store.layer(id)!;
      shiftLayerPosition(tx, l, -bounds.x, -bounds.y);
    }
  });
  moveLayers(store, sameParent, group.id, 0);
  store.select([group.id]);
  return group;
}

export function ungroup(store: Store, groupId: string) {
  store.batch('ungroup', () => ungroupInner(store, groupId));
}

function ungroupInner(store: Store, groupId: string) {
  const g = store.layer(groupId);
  if (!g || !g.children.length) return;
  const kids = g.children.slice();
  const pos = valueAt(g, 'position', store.time);
  const anc = valueAt(g, 'anchor', store.time);
  const parent = g.parent;
  const idx = store.siblings(g).indexOf(groupId);
  moveLayers(store, kids, parent, idx + 1);
  store.transact('Ungroup', tx => {
    for (const id of kids) shiftLayerPosition(tx, store.layer(id)!, pos[0] - anc[0], pos[1] - anc[1]);
  });
  deleteLayers(store, [groupId]);
  store.select(kids);
}

function shiftLayerPosition(tx: Tx, l: Layer, dx: number, dy: number) {
  const p = l.props.position;
  if (!p) return;
  tx.set(p, 'v', [p.v[0] + dx, p.v[1] + dy]);
  if (p.kf) tx.set(p, 'kf', p.kf.map(k => ({ ...k, v: [k.v[0] + dx, k.v[1] + dy] })));
  tx.touch(l.id);
}

// ---------------- properties & keyframes ----------------

/**
 * set a property value the after effects way: if the property is animated, create or
 * update a keyframe at the current time, otherwise change the static value.
 */
export function setProp(store: Store, id: string, key: PropKey, value: number[], opts: { mergeKey?: string; time?: number; forceKey?: boolean } = {}) {
  const l = store.layer(id);
  if (!l) return;
  const t = opts.time ?? store.time;
  const v = clampValue(key, value);
  store.transact(`Change ${PROP_DEFS[key].label}`, tx => setPropTx(tx, l, key, v, t, !!opts.forceKey), opts.mergeKey);
}

export function setPropTx(tx: Tx, l: Layer, key: PropKey, value: number[], t: number, forceKey = false) {
  let p = l.props[key];
  if (!p) {
    p = { v: (PROP_DEFS[key].default as unknown as number[]).slice() };
    tx.set(l.props, key, p);
  }
  if ((p.kf && p.kf.length) || forceKey || editMode.autoKey) {
    tx.set(p, 'kf', upsertKey(p.kf ?? [], t, value));
  } else {
    tx.set(p, 'v', value.slice());
  }
  tx.touch(l.id);
}

function upsertKey(kf: Keyframe[], t: number, v: number[]): Keyframe[] {
  const out = kf.map(k => ({ ...k }));
  const i = out.findIndex(k => Math.abs(k.t - t) < EPS);
  if (i >= 0) {
    out[i] = { ...out[i], v: v.slice() };
    return out;
  }
  const prev = [...out].reverse().find(k => k.t < t);
  const ease = prev ? { interp: prev.interp, out: prev.out, in: prev.in, bounce: prev.bounce } : defaultEase();
  out.push({ t, v: v.slice(), interp: ease.interp, out: [...ease.out] as [number, number], in: [...ease.in] as [number, number], ...((ease as any).bounce !== undefined ? { bounce: (ease as any).bounce } : {}) });
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** stopwatch toggle: start animating (key at current time) or remove all keyframes */
export function toggleAnimated(store: Store, ids: string[], key: PropKey) {
  store.transact('Toggle animation', tx => {
    for (const id of ids) {
      const l = store.layer(id);
      if (!l) continue;
      const cur = valueAt(l, key, store.time);
      const p = l.props[key] ?? { v: cur };
      if (!l.props[key]) tx.set(l.props, key, p);
      if (p.kf && p.kf.length) {
        tx.set(p, 'v', cur);
        tx.set(p, 'kf', undefined);
      } else {
        tx.set(p, 'kf', [{ t: store.time, v: cur, ...defaultEase() }]);
      }
      tx.touch(id);
    }
  });
}

/** add a keyframe at the current time with the current value */
export function addKeyframe(store: Store, ids: string[], key: PropKey, t = store.time) {
  store.transact('Add keyframe', tx => {
    for (const id of ids) {
      const l = store.layer(id);
      if (!l) continue;
      const cur = valueAt(l, key, t);
      setPropTx(tx, l, key, cur, t, true);
    }
  });
}

export function keyId(layerId: string, key: PropKey, index: number) { return `${layerId}|${key}|${index}`; }
export function parseKeyId(k: string) {
  const [layerId, key, index] = k.split('|');
  return { layerId, key: key as PropKey, index: +index };
}

/** group a key selection into {layer, prop, indices} */
function groupKeySel(store: Store, keys: Iterable<string>) {
  const map = new Map<string, { layer: Layer; key: PropKey; prop: Prop; idx: Set<number> }>();
  for (const k of keys) {
    const { layerId, key, index } = parseKeyId(k);
    const layer = store.layer(layerId);
    const prop = layer?.props[key];
    if (!layer || !prop?.kf?.[index]) continue;
    const mk = layerId + '|' + key;
    let g = map.get(mk);
    if (!g) map.set(mk, (g = { layer, key, prop, idx: new Set() }));
    g.idx.add(index);
  }
  return [...map.values()];
}

export function deleteKeyframes(store: Store, keys: Iterable<string>) {
  const groups = groupKeySel(store, keys);
  if (!groups.length) return;
  store.transact('Delete keyframes', tx => {
    for (const g of groups) {
      const kf = g.prop.kf!;
      const rest = kf.filter((_, i) => !g.idx.has(i));
      if (rest.length === 0) {
        tx.set(g.prop, 'v', kf[0].v.slice());
        tx.set(g.prop, 'kf', undefined);
      } else tx.set(g.prop, 'kf', rest);
      tx.touch(g.layer.id);
    }
  });
  store.keySelection.clear();
  store.emit('keys');
}

/** shift selected keyframes in time. returns the new key selection ids. */
export function moveKeyframes(store: Store, keys: Iterable<string>, dt: number, mergeKey?: string) {
  const groups = groupKeySel(store, keys);
  const newSel = new Set<string>();
  store.transact('Move keyframes', tx => {
    for (const g of groups) {
      const kf = g.prop.kf!.map((k, i) => ({ k: { ...k }, sel: g.idx.has(i) }));
      for (const e of kf) if (e.sel) e.k.t = Math.max(0, e.k.t + dt);
      // moved keys replace unselected ones at the same time
      const moved = kf.filter(e => e.sel);
      const kept = kf.filter(e => !e.sel && !moved.some(m => Math.abs(m.k.t - e.k.t) < EPS));
      const all = [...kept, ...moved].sort((a, b) => a.k.t - b.k.t);
      tx.set(g.prop, 'kf', all.map(e => e.k));
      all.forEach((e, i) => { if (e.sel) newSel.add(keyId(g.layer.id, g.key, i)); });
      tx.touch(g.layer.id);
    }
  }, mergeKey);
  store.keySelection = newSel;
  store.emit('keys');
  return newSel;
}

export interface KeySnapshot { groups: { layerId: string; key: PropKey; orig: Keyframe[]; sel: Set<number> }[]; minT: number }

/** remember selected keys + their props at drag start (drags apply a TOTAL offset to this snapshot) */
export function snapshotKeys(store: Store, keys: Iterable<string>): KeySnapshot {
  const groups = groupKeySel(store, keys).map(g => ({ layerId: g.layer.id, key: g.key, orig: g.prop.kf!.map(k => ({ ...k })), sel: new Set(g.idx) }));
  let minT = Infinity;
  for (const g of groups) for (const i of g.sel) minT = Math.min(minT, g.orig[i].t);
  return { groups, minT: isFinite(minT) ? minT : 0 };
}

/** move snapshot keys by dt (relative to the snapshot, so crossing other keys never deletes them mid-drag) */
export function moveKeysFrom(store: Store, snap: KeySnapshot, dt: number, mergeKey?: string) {
  dt = Math.max(-snap.minT, dt);
  const newSel = new Set<string>();
  store.transact('Move keyframes', tx => {
    for (const g of snap.groups) {
      const l = store.layer(g.layerId);
      const p = l?.props[g.key];
      if (!l || !p) continue;
      const moved = g.orig.map((k, i) => ({ k: { ...k, t: g.sel.has(i) ? k.t + dt : k.t }, sel: g.sel.has(i) }));
      const movedTimes = moved.filter(e => e.sel).map(e => e.k.t);
      const kept = moved.filter(e => e.sel || !movedTimes.some(t => Math.abs(t - e.k.t) < EPS));
      kept.sort((a, b) => a.k.t - b.k.t);
      tx.set(p, 'kf', kept.map(e => e.k));
      kept.forEach((e, i) => { if (e.sel) newSel.add(keyId(g.layerId, g.key, i)); });
      tx.touch(g.layerId);
    }
  }, mergeKey);
  store.keySelection = newSel;
  store.emit('keys');
}

/** apply an ease to selected keyframes (affects the segment leaving each selected key and the arriving handle) */
export function setEase(store: Store, keys: Iterable<string>, bez: [number, number, number, number] | string, interp: Interp = 'bezier') {
  let v: [number, number, number, number];
  if (typeof bez === 'string') {
    const p = EASE_PRESETS.find(p => p.name.toLowerCase() === bez.toLowerCase());
    if (!p) throw new Error(`unknown ease preset "${bez}"`);
    v = p.v;
    if (p.name === 'Linear') interp = 'linear';
  } else v = bez;
  const groups = groupKeySel(store, keys);
  store.transact('Set easing', tx => {
    tx.keepKeys = true;
    for (const g of groups) {
      const kf = g.prop.kf!.map(k => ({ ...k }));
      const idx = [...g.idx].sort((a, b) => a - b);
      // if only a single key selected apply to the segment leaving it (and arriving at it, if it is the last)
      for (const i of idx) {
        const k = kf[i];
        if (i < kf.length - 1) {
          k.interp = interp;
          k.out = [v[0], v[1]];
          kf[i + 1] = { ...kf[i + 1], in: [v[2], v[3]] };
        } else if (i > 0) {
          kf[i - 1] = { ...kf[i - 1], interp, out: [v[0], v[1]] };
          k.in = [v[2], v[3]];
        }
      }
      tx.set(g.prop, 'kf', kf);
      tx.touch(g.layer.id);
    }
  });
}

/** spring easing on selected keyframes (segment leaving each key) */
export function setSpring(store: Store, keys: Iterable<string>, bounce: number) {
  const groups = groupKeySel(store, keys);
  store.transact('Set spring', tx => {
    tx.keepKeys = true;
    for (const g of groups) {
      const kf = g.prop.kf!.map(k => ({ ...k }));
      for (const i of g.idx) {
        const j = i < kf.length - 1 ? i : i - 1;
        if (j < 0) continue;
        kf[j] = { ...kf[j], interp: 'spring', bounce };
      }
      tx.set(g.prop, 'kf', kf);
      tx.touch(g.layer.id);
    }
  });
}

export function setInterp(store: Store, keys: Iterable<string>, interp: Interp) {
  const groups = groupKeySel(store, keys);
  store.transact('Set interpolation', tx => {
    tx.keepKeys = true;
    for (const g of groups) {
      const kf = g.prop.kf!.map((k, i) => (g.idx.has(i) ? { ...k, interp } : k));
      tx.set(g.prop, 'kf', kf);
      tx.touch(g.layer.id);
    }
  });
}

/** set raw bezier handles of a single segment (graph editor) */
export function setSegmentHandles(store: Store, layerId: string, key: PropKey, i: number, out: [number, number], inn: [number, number], mergeKey?: string) {
  const l = store.layer(layerId);
  const p = l?.props[key];
  if (!l || !p?.kf || i >= p.kf.length - 1) return;
  store.transact('Edit curve', tx => {
    tx.keepKeys = true;
    const kf = p.kf!.map(k => ({ ...k }));
    kf[i].interp = 'bezier';
    kf[i].out = [Math.min(1, Math.max(0, out[0])), out[1]];
    kf[i + 1].in = [Math.min(1, Math.max(0, inn[0])), inn[1]];
    tx.set(p, 'kf', kf);
    tx.touch(layerId);
  }, mergeKey);
}

/** all keyframe times of a layer (for timeline summary row) */
export function layerKeyTimes(l: Layer): number[] {
  const s = new Set<number>();
  for (const k in l.props) for (const kf of l.props[k as PropKey]?.kf ?? []) s.add(kf.t);
  return [...s].sort((a, b) => a - b);
}

export function setCompSettings(store: Store, patch: Partial<{ width: number; height: number; fps: number; duration: number; name: string; background: [number, number, number, number] }>) {
  store.transact('Composition settings', tx => {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) tx.set(store.comp, k as any, v as any);
    tx.comp();
  });
  if (store.time > store.comp.duration) store.setTime(store.comp.duration);
}

export function setProjectName(store: Store, name: string) {
  store.transact('Rename file', tx => { tx.set(store.project, 'name', name); tx.change.meta = true; });
}

// ---------------- compositions ----------------

export function newComposition(store: Store, init: Partial<{ name: string; width: number; height: number; fps: number; duration: number }> = {}) {
  const cur = store.comp;
  const comp = createComp({ name: init.name ?? `Comp ${Object.keys(store.project.comps).length + 1}`, width: init.width ?? cur.width, height: init.height ?? cur.height, fps: init.fps ?? cur.fps, duration: init.duration ?? cur.duration, background: [...cur.background] as any });
  store.transact('New composition', tx => { tx.set(store.project.comps, comp.id, comp); tx.comp(); });
  store.emit('comps');
  return comp;
}

/** comps that (directly or through nesting) contain a precomp layer of `compId` */
function compUses(store: Store, outer: string, inner: string, seen = new Set<string>()): boolean {
  if (outer === inner) return true;
  if (seen.has(outer)) return false;
  seen.add(outer);
  const P = store.project;
  const walk = (ids: string[]): boolean => ids.some(id => {
    const l = P.layers[id];
    if (!l) return false;
    if (l.type === 'precomp' && l.compRef && compUses(store, l.compRef, inner, seen)) return true;
    return walk(l.children);
  });
  return walk(P.comps[outer]?.root ?? []);
}

/** add a precomp layer of `compId` to the active comp (refuses cycles) */
export function addPrecompLayer(store: Store, compId: string) {
  const comp = store.project.comps[compId];
  if (!comp) throw new Error('no such composition');
  if (compUses(store, compId, store.comp.id)) throw new Error('that would nest a composition inside itself');
  const cur = store.comp;
  const l = createLayer('precomp', { name: comp.name, w: comp.width, h: comp.height, x: (cur.width - comp.width) / 2, y: (cur.height - comp.height) / 2 });
  l.compRef = compId;
  l.startTime = 0;
  store.transact('Add precomp', tx => insertLayer(store, tx, l, null));
  store.select([l.id]);
  return l;
}

/** after effects "pre-compose": move the selected top-level layers into a new comp, replaced by one precomp layer */
export function precompose(store: Store, ids: string[], name?: string) {
  const P = store.project;
  const cur = store.comp;
  // only layers directly in the active comp root (keeps the math simple and predictable)
  const roots = cur.root.filter(id => ids.includes(id));
  if (!roots.length) throw new Error('select top-level layers to pre-compose');
  const comp = createComp({ name: name ?? `${P.layers[roots[roots.length - 1]].name} comp`, width: cur.width, height: cur.height, fps: cur.fps, duration: cur.duration, background: [0, 0, 0, 0] });
  const pc = createLayer('precomp', { name: comp.name, w: cur.width, h: cur.height, x: 0, y: 0 });
  pc.compRef = comp.id;
  pc.startTime = 0;
  const index = cur.root.indexOf(roots[roots.length - 1]);
  store.transact('Pre-compose', tx => {
    comp.root = roots.slice();
    tx.set(P.comps, comp.id, comp);
    const rest = cur.root.filter(id => !roots.includes(id));
    const at = rest.length - (cur.root.length - 1 - index);
    rest.splice(Math.max(0, at), 0, pc.id);
    tx.set(P.layers, pc.id, pc);
    pc.parent = null;
    tx.set(cur, 'root', rest);
    tx.structure();
    tx.comp();
  });
  store.select([pc.id]);
  store.emit('comps');
  return { comp, layer: pc };
}

export function renameComp(store: Store, id: string, name: string) {
  const c = store.project.comps[id];
  if (!c) return;
  store.transact('Rename composition', tx => { tx.set(c, 'name', name); tx.comp(); });
  store.emit('comps');
}
