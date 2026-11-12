// components: a main component (any layer + its subtree, keyed in Project.components) and instances
// (real layer copies whose layers carry `link`). instances are ordinary layers for the renderer, the
// timeline and every exporter, so they cost nothing extra and animate like anything else.
//
// - the main's animation (keyframes, expressions, text animators) is part of what an instance copies,
//   so "animate the logo once, reuse it everywhere" works. the instance root adds its own place
//   (dx, dy: offset from the main's position, also applied to position keys) and its own delay (dt:
//   shifts every key of the instance), so every instance can start at a different time.
// - an edit on an instance layer makes that property an override (`link.ov`), figma style: later
//   changes of the main skip overridden fields. moving an instance changes its offset, not an override.
// - propagation runs inside the same transaction as the edit (componentTxHook, called by
//   Store.transact), so changing the main and every instance following is ONE undo step.
// - figma paste: pasted instances link to a main component made from the figma component (the paste
//   carries its definition), and their differences from it become overrides.
//
// precomps vs components: a precomp layer shows another composition with its own timeline (one place
// to edit, time-remapped as a whole, no per-instance changes). a component instance is a live copy in
// this timeline: every layer of it can be selected, keyframed and overridden, and still follows the main.

import { PROP_KEYS, uid, type ComponentInfo, type InstanceLink, type Layer, type Project, type Prop, type PropKey } from './model';
import type { Store, Tx } from './store';

/** layer fields (besides props) an instance copies from its main */
const FIELDS = ['paints', 'strokeAlign', 'geometry', 'geomSize', 'pathKf', 'shape', 'trimOn', 'strokeGeometry', 'text', 'textAnim', 'imageRef', 'volume', 'compRef', 'startTime', 'blend', 'clip', 'mask', 'visible', 'inPoint', 'outPoint'] as const;
type Field = (typeof FIELDS)[number];
/** human labels for overrides */
export const FIELD_LABELS: Record<string, string> = { text: 'text', paints: 'gradient', geometry: 'shape', pathKf: 'shape animation', textAnim: 'text animation', visible: 'visibility', imageRef: 'image', inPoint: 'in point', outPoint: 'out point' };

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function deepEq(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-7;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return (a ?? undefined) === (b ?? undefined);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i])) return false; return true; }
  for (const k in a) if (a[k] !== undefined && !deepEq(a[k], b[k])) return false;
  for (const k in b) if (b[k] !== undefined && a[k] === undefined) return false;
  return true;
}

interface RootInfo { dx: number; dy: number; dt: number }
const rootInfo = (l: Layer): RootInfo => ({ dx: l.link?.dx ?? 0, dy: l.link?.dy ?? 0, dt: l.link?.dt ?? 0 });

function shiftProp(p: Prop, dt: number, dx: number, dy: number): Prop {
  const c = clone(p);
  if (dx || dy) {
    c.v = [c.v[0] + dx, c.v[1] + dy];
    if (c.kf) for (const k of c.kf) k.v = [k.v[0] + dx, k.v[1] + dy];
  }
  if (dt && c.kf) for (const k of c.kf) k.t += dt;
  return c;
}

/** the value an instance layer should have for `f`, given its main layer */
function expected(main: Layer, f: string, R: RootInfo, isRoot: boolean): any {
  if ((PROP_KEYS as string[]).includes(f)) {
    const p = main.props[f as PropKey];
    if (!p) return undefined;
    return shiftProp(p, R.dt, isRoot && f === 'position' ? R.dx : 0, isRoot && f === 'position' ? R.dy : 0);
  }
  const v = (main as any)[f];
  if (v === undefined || !R.dt) return clone(v);
  switch (f as Field) {
    case 'pathKf': return (v as Layer['pathKf'])!.map(k => ({ ...clone(k), t: k.t + R.dt }));
    case 'textAnim': return { ...clone(v), start: v.start + R.dt };
    case 'inPoint': case 'startTime': return v + R.dt;
    case 'outPoint': return v >= 1e8 ? v : v + R.dt;
    default: return clone(v);
  }
}

function fieldsOf(main: Layer, inst: Layer): string[] {
  const s = new Set<string>(FIELDS);
  for (const k in main.props) s.add(k);
  for (const k in inst.props) s.add(k);
  return [...s];
}

function current(l: Layer, f: string): any {
  return (PROP_KEYS as string[]).includes(f) ? l.props[f as PropKey] : (l as any)[f];
}

// ---------------- lookups ----------------

export function isMain(project: Project, id: string) { return !!project.components?.[id]; }

/** main component (root id) whose subtree contains this layer */
export function mainOf(project: Project, id: string): string | null {
  const C = project.components;
  if (!C) return null;
  let cur: string | null = id;
  while (cur) { if (C[cur]) return cur; cur = project.layers[cur]?.parent ?? null; }
  return null;
}

/** instance root this layer belongs to (itself included) */
export function instanceRootOf(project: Project, id: string): string | null {
  const C = project.components;
  if (!C) return null;
  let cur: string | null = id;
  while (cur) {
    const l: Layer | undefined = project.layers[cur];
    if (!l?.link) return null; // instance members are linked all the way up to the root
    if (C[l.link.main]) return cur;
    cur = l.parent;
  }
  return null;
}

/** instance roots of a component */
export function instancesOf(project: Project, mainId: string): string[] {
  return Object.values(project.layers).filter(l => l.link?.main === mainId).map(l => l.id);
}

/** names of fields this instance layer overrides (empty if none) */
export function overridesOf(l: Layer): string[] { return l.link?.ov ?? []; }

// ---------------- the transaction hook ----------------

/** per main: its subtree's ids last time we looked (structure changes propagate only when this changes) */
const treeSig = new Map<string, string>();
function sigOf(project: Project, id: string): string {
  const out: string[] = [];
  const walk = (x: string) => { const l = project.layers[x]; if (!l) return; out.push(x + ':' + l.children.join(',')); for (const c of l.children) walk(c); };
  walk(id);
  return out.join('|');
}

/** override bookkeeping + propagation, inside the edit's own transaction (one undo step) */
export function componentTxHook(store: Store, tx: Tx) {
  const P = store.project;
  const C = P.components;
  if (!C) return;
  let any = false;
  for (const _ in C) { any = true; break; }
  if (!any) return;
  const L = P.layers;

  // a deleted main: its instances become plain layers
  if (tx.change.structure) {
    for (const id of Object.keys(C)) {
      if (L[id]) continue;
      tx.del(C, id);
      treeSig.delete(id);
      for (const r of instancesOf(P, id)) unlinkInstance(tx, P, r, id);
    }
  }

  // 1. edits on instance layers: record overrides (or a new offset for the instance root)
  const touched = [...tx.change.layers];
  for (const id of touched) {
    const l = L[id];
    if (!l?.link) continue;
    const rootId = instanceRootOf(P, id);
    const main = L[l.link.main];
    if (!rootId || !main) continue;
    updateOverrides(tx, P, l, main, rootId);
  }

  // 2. structure of a main changed: add / remove the matching layers in every instance
  if (tx.change.structure) {
    for (const mainId of Object.keys(C)) {
      if (!L[mainId]) continue;
      const sig = sigOf(P, mainId);
      const before = treeSig.get(mainId);
      treeSig.set(mainId, sig);
      if (before === undefined || before === sig) continue;
      for (const r of instancesOf(P, mainId)) syncTree(tx, P, mainId, r, rootInfo(L[r]), true);
    }
  }

  // 3. edits on main layers: copy into every instance (and on through nested components)
  let dirty = new Set<string>();
  for (const id of touched) if (L[id] && mainOf(P, id)) dirty.add(id);
  for (let pass = 0; pass < 6 && dirty.size; pass++) {
    const index = new Map<string, string[]>();
    for (const l of Object.values(L)) if (l.link) { let a = index.get(l.link.main); if (!a) index.set(l.link.main, (a = [])); a.push(l.id); }
    const next = new Set<string>();
    for (const m of dirty) {
      const main = L[m];
      if (!main) continue;
      for (const iid of index.get(m) ?? []) {
        const rootId = instanceRootOf(P, iid);
        if (!rootId) continue;
        if (pullMember(tx, L[iid], main, rootInfo(L[rootId]), rootId === iid) && mainOf(P, iid)) next.add(iid);
      }
    }
    dirty = next;
  }
}

function updateOverrides(tx: Tx, _P: Project, l: Layer, main: Layer, rootId: string) {
  const isRoot = rootId === l.id;
  let R = rootInfo(_P.layers[rootId]);
  const ov = new Set(l.link!.ov ?? []);
  let link: InstanceLink = l.link!;
  for (const f of fieldsOf(main, l)) {
    const cur = current(l, f);
    if (deepEq(cur, expected(main, f, R, isRoot))) { ov.delete(f); continue; }
    if (isRoot && f === 'position' && cur && main.props.position) {
      // moved, not overridden: keep following the main's motion from the new place
      const mp = main.props.position;
      const a = cur.kf?.length ? cur.kf[0].v : cur.v, b = mp.kf?.length ? mp.kf[0].v : mp.v;
      const d = { ...R, dx: a[0] - b[0], dy: a[1] - b[1] };
      if (deepEq(cur, expected(main, f, d, true))) {
        R = d;
        link = { ...link, dx: d.dx, dy: d.dy };
        ov.delete(f);
        continue;
      }
    }
    ov.add(f);
  }
  const list = [...ov].sort();
  if (!deepEq(list, link.ov ?? []) || link !== l.link) {
    const next: InstanceLink = { ...link };
    if (list.length) next.ov = list; else delete next.ov;
    tx.set(l, 'link', next);
  }
}

/** copy every non-overridden field of `main` into `inst`. returns whether anything changed */
function pullMember(tx: Tx, inst: Layer, main: Layer, R: RootInfo, isRoot: boolean): boolean {
  const ov = new Set(inst.link?.ov ?? []);
  let changed = false, flags = false;
  for (const f of fieldsOf(main, inst)) {
    if (ov.has(f)) continue;
    const exp = expected(main, f, R, isRoot);
    if (deepEq(current(inst, f), exp)) continue;
    if ((PROP_KEYS as string[]).includes(f)) {
      if (exp === undefined) tx.del(inst.props, f as PropKey); else tx.set(inst.props, f as PropKey, exp);
    } else if (exp === undefined) tx.del(inst, f as keyof Layer);
    else tx.set(inst, f as keyof Layer, exp);
    changed = true;
    if (f === 'visible' || f === 'clip' || f === 'mask' || f === 'startTime' || f === 'trimOn' || f === 'compRef') flags = true;
  }
  if (changed) tx.touch(inst.id);
  if (flags) tx.recompile();
  return changed;
}

/** make an instance subtree match its main's children (new layers cloned, removed ones deleted) */
function syncTree(tx: Tx, P: Project, mainId: string, instId: string, R: RootInfo, isRoot: boolean) {
  const L = P.layers;
  const main = L[mainId], inst = L[instId];
  if (!main || !inst) return;
  if (!isRoot) pullMember(tx, inst, main, R, false);
  const byMain = new Map<string, string>();
  for (const c of inst.children) { const m = L[c]?.link?.main; if (m) byMain.set(m, c); }
  const next: string[] = [];
  for (const mc of main.children) {
    let ic = byMain.get(mc);
    if (ic) { byMain.delete(mc); syncTree(tx, P, mc, ic, R, false); }
    else ic = cloneInto(tx, P, mc, instId, R, false);
    next.push(ic);
  }
  // linked layers whose main layer is gone: remove. layers added only to this instance: keep on top
  for (const c of inst.children) {
    if (next.includes(c)) continue;
    const cl = L[c];
    if (cl?.link && !L[cl.link.main]) { for (const d of [c, ...descendantsOf(P, c)]) tx.del(L, d); continue; }
    if (cl?.link && byMain.has(cl.link.main)) { for (const d of [c, ...descendantsOf(P, c)]) tx.del(L, d); continue; }
    next.push(c);
  }
  if (!deepEq(next, inst.children)) { tx.set(inst, 'children', next); tx.structure(); }
}

function descendantsOf(P: Project, id: string): string[] {
  const out: string[] = [];
  const walk = (ids: string[]) => { for (const c of ids) { out.push(c); walk(P.layers[c]?.children ?? []); } };
  walk(P.layers[id]?.children ?? []);
  return out;
}

/** clone main layer `mainId` (and its subtree) as instance layers under `parent`. returns the new id */
function cloneInto(tx: Tx, P: Project, mainId: string, parent: string | null, R: RootInfo, isRoot: boolean): string {
  const main = P.layers[mainId];
  const copy: Layer = clone(main);
  copy.id = uid();
  copy.parent = parent;
  delete copy.sceneKey; // the instance is not the layer build_scene keyed
  copy.link = isRoot ? { main: mainId, ...(R.dx ? { dx: R.dx } : {}), ...(R.dy ? { dy: R.dy } : {}), ...(R.dt ? { dt: R.dt } : {}) } : { main: mainId };
  for (const f of fieldsOf(main, copy)) {
    const exp = expected(main, f, R, isRoot);
    if ((PROP_KEYS as string[]).includes(f)) { if (exp) copy.props[f as PropKey] = exp; }
    else if (exp !== undefined) (copy as any)[f] = exp;
  }
  tx.set(P.layers, copy.id, copy);
  copy.children = main.children.map(c => cloneInto(tx, P, c, copy.id, R, false));
  tx.touch(copy.id);
  tx.structure();
  return copy.id;
}

function unlinkInstance(tx: Tx, P: Project, rootId: string, _mainId?: string) {
  const ids = [rootId, ...descendantsOf(P, rootId)];
  for (const id of ids) {
    const l = P.layers[id];
    if (!l?.link) continue;
    // nested instances of OTHER components keep their own link
    if (id !== rootId && P.components?.[l.link.main]) continue;
    tx.del(l, 'link');
    tx.touch(id);
  }
}

// ---------------- commands ----------------

/** turn a layer (with its subtree) into a main component */
export function createComponent(store: Store, id: string, name?: string, extra: Partial<ComponentInfo> = {}): ComponentInfo {
  const P = store.project;
  const l = P.layers[id];
  if (!l) throw new Error(`no layer with id "${id}"`);
  if (P.components?.[id]) return P.components[id];
  if (l.link) throw new Error('this layer is an instance: detach it first to make it a component');
  const info: ComponentInfo = { name: name?.trim() || l.name, ...extra };
  store.transact(`Create component ${info.name}`, tx => {
    if (!P.components) tx.set(P, 'components', {});
    tx.set(P.components!, id, info);
    tx.change.meta = true;
    tx.touch(id);
  });
  treeSig.set(id, sigOf(P, id));
  store.emit('components');
  return info;
}

/** add an instance of a main component. default place: the active composition, next to the main
 *  (offset by 40px) when it is in the same composition */
export function createInstance(store: Store, mainId: string, opts: { x?: number; y?: number; parent?: string | null; delay?: number; select?: boolean } = {}): Layer {
  const P = store.project;
  const main = P.layers[mainId];
  if (!main || !P.components?.[mainId]) throw new Error('no such component');
  const mp = main.props.position?.kf?.length ? main.props.position.kf[0].v : main.props.position?.v ?? [0, 0];
  const sameComp = store.comp.root.includes(mainId) || (!!main.parent && store.drawOrder().includes(mainId));
  let dx = sameComp ? 40 : 0, dy = sameComp ? 40 : 0;
  if (opts.x !== undefined) dx = opts.x - mp[0];
  if (opts.y !== undefined) dy = opts.y - mp[1];
  const R = { dx, dy, dt: opts.delay ?? 0 };
  let id = '';
  store.transact(`Add ${P.components[mainId].name} instance`, tx => {
    const parent = opts.parent ?? null;
    id = cloneInto(tx, P, mainId, parent, R, true);
    const l = P.layers[id];
    l.name = P.components![mainId].name;
    if (parent) { const p = P.layers[parent]; tx.set(p, 'children', [...p.children, id]); }
    else {
      const comp = store.comp;
      const root = comp.root.slice();
      // right above the main when it is a top-level layer here, else on top
      const at = root.indexOf(mainId);
      root.splice(at >= 0 ? at + 1 : root.length, 0, id);
      tx.set(comp, 'root', root);
    }
  });
  if (opts.select !== false) store.select([id]);
  return P.layers[id];
}

/** turn an instance back into plain layers (keeps how it looks now) */
export function detachInstance(store: Store, id: string) {
  const P = store.project;
  const root = instanceRootOf(P, id);
  if (!root) return;
  store.transact('Detach instance', tx => unlinkInstance(tx, P, root));
}

/** drop overrides (all of them, or one field) on an instance layer and its subtree, and copy the main's values back */
export function resetOverrides(store: Store, id: string, field?: string) {
  const P = store.project;
  const rootId = instanceRootOf(P, id);
  if (!rootId) return;
  const ids = field ? [id] : [id, ...descendantsOf(P, id)];
  store.transact(field ? `Reset ${FIELD_LABELS[field] ?? field}` : 'Reset instance', tx => {
    const R = rootInfo(P.layers[rootId]);
    for (const x of ids) {
      const l = P.layers[x];
      if (!l?.link?.ov) continue;
      const main = P.layers[l.link.main];
      if (!main) continue;
      const ov = field ? l.link.ov.filter(f => f !== field) : [];
      const next: InstanceLink = { ...l.link };
      if (ov.length) next.ov = ov; else delete next.ov;
      tx.set(l, 'link', next);
      pullMember(tx, l, main, R, x === rootId);
      tx.touch(x);
    }
  });
}

/** per-instance delay: every key of the instance shifts by `dt` seconds relative to the main */
export function setInstanceDelay(store: Store, id: string, dt: number, mergeKey?: string) {
  const P = store.project;
  const rootId = instanceRootOf(P, id);
  if (!rootId) return;
  store.transact('Instance delay', tx => {
    const r = P.layers[rootId];
    const next: InstanceLink = { ...r.link! };
    if (dt) next.dt = dt; else delete next.dt;
    tx.set(r, 'link', next);
    const R = rootInfo(r);
    for (const x of [rootId, ...descendantsOf(P, rootId)]) {
      const l = P.layers[x];
      const main = l?.link ? P.layers[l.link.main] : undefined;
      if (main && (x === rootId || !P.components?.[l!.link!.main])) pullMember(tx, l!, main, R, x === rootId);
    }
  }, mergeKey);
}

export function renameComponent(store: Store, id: string, name: string) {
  const c = store.project.components?.[id];
  if (!c || !name.trim()) return;
  store.transact('Rename component', tx => { tx.set(c, 'name', name.trim()); tx.change.meta = true; });
  store.emit('components');
}

/** stop being a component: instances become plain layers */
export function removeComponent(store: Store, id: string) {
  const P = store.project;
  if (!P.components?.[id]) return;
  store.transact('Remove component', tx => {
    for (const r of instancesOf(P, id)) unlinkInstance(tx, P, r, id);
    tx.del(P.components!, id);
    tx.change.meta = true;
  });
  treeSig.delete(id);
  store.emit('components');
}

// ---------------- paste / import ----------------

/** link freshly inserted layers as an instance of a main (layers matched by position in the tree).
 *  differences from the main become overrides. used by figma paste. */
export function linkAsInstance(tx: Tx, P: Project, mainId: string, instRootId: string) {
  const L = P.layers;
  const main = L[mainId], inst = L[instRootId];
  if (!main || !inst) return;
  const a = main.props.position, b = inst.props.position;
  const av = a?.kf?.length ? a.kf[0].v : a?.v ?? [0, 0], bv = b?.kf?.length ? b.kf[0].v : b?.v ?? [0, 0];
  const R: RootInfo = { dx: bv[0] - av[0], dy: bv[1] - av[1], dt: 0 };
  const walk = (m: Layer, i: Layer, isRoot: boolean) => {
    const link: InstanceLink = isRoot ? { main: m.id, ...(R.dx ? { dx: R.dx } : {}), ...(R.dy ? { dy: R.dy } : {}) } : { main: m.id };
    const ov: string[] = [];
    for (const f of fieldsOf(m, i)) {
      const cur = current(i, f), exp = expected(m, f, R, isRoot);
      if (deepEq(cur, exp)) continue;
      // the main is animated here and the pasted design is a still: take the main's animation
      const mp = m.props[f as PropKey];
      if (mp?.kf?.length && !cur?.kf?.length) {
        const v0 = isRoot && f === 'position' ? [mp.kf[0].v[0] + R.dx, mp.kf[0].v[1] + R.dy] : mp.kf[0].v;
        if (!cur || deepEq(cur.v, v0) || mp.kf.some(k => deepEq(isRoot && f === 'position' ? [k.v[0] + R.dx, k.v[1] + R.dy] : k.v, cur.v))) continue;
      }
      ov.push(f);
    }
    if (ov.length) link.ov = ov.sort();
    tx.set(i, 'link', link);
    pullMember(tx, i, m, R, isRoot);
    tx.touch(i.id);
    const n = Math.min(m.children.length, i.children.length);
    for (let k = 0; k < n; k++) {
      const mc = L[m.children[k]], ic = L[i.children[k]];
      if (mc && ic && mc.type === ic.type) walk(mc, ic, false);
    }
  };
  walk(main, inst, true);
}

/** remember a main's tree right after creating it outside createComponent (paste, file load) */
export function rememberTree(P: Project, mainId: string) { treeSig.set(mainId, sigOf(P, mainId)); }
