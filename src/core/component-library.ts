// team libraries for motion components: publish components (with the components they nest, their
// images and the styles they link) as one json file; another project imports it, and later
// re-reads it: a review lists what changed ("Title card: 2 layers changed, new property Subtitle,
// 6 instances") and applying it is one undo step. instances keep their values (property and
// variant ids are stable across files).

import { uid, type Asset, type Composition, type Layer, type Project, type PropKey, type Token } from './model';
import type { Store } from './store';
import { compLayers, componentComps } from './motion-components';

export interface LibraryComponent { key: string; rev: string; comp: Composition; layers: Layer[] }
export interface LibraryFile {
  format: 'motion-library';
  version: 1;
  id: string;
  name: string;
  published: number;
  components: LibraryComponent[];
  assets: Record<string, Asset>;
  tokens?: Token[];
}

/** small stable hash (FNV-1a, hex) */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** content revision of a component: its layers, timing and definition, independent of layer ids */
export function componentRev(P: Project, comp: Composition): string {
  const layers = compLayers(P, comp);
  const idx = new Map(layers.map((l, i) => [l.id, 'L' + i]));
  const norm = (v: string) => idx.get(v) ?? v;
  const body = JSON.stringify({
    w: comp.width, h: comp.height, fps: comp.fps, d: comp.duration, bg: comp.background, root: comp.root.map(norm),
    def: { ...comp.component, lib: undefined, editing: undefined },
    layers: layers.map(l => ({ ...l, collapsed: undefined, locked: undefined, sceneKey: undefined })),
  });
  // layer ids also appear in property targets and variant differences
  return hash(body.replace(/"l_[a-z0-9]+"/g, m => JSON.stringify(norm(JSON.parse(m)))));
}

/** components plus every component they nest (a library must be self-contained) */
function withNested(P: Project, ids: string[]): Composition[] {
  const out: Composition[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const c = P.comps[id];
    if (!c) return;
    for (const l of compLayers(P, c)) if (l.type === 'precomp' && l.compRef && P.comps[l.compRef]?.component) visit(l.compRef);
    out.push(c);
  };
  ids.forEach(visit);
  return out;
}

/** a library file with the given components (default: all of them) */
export function exportLibrary(P: Project, opts: { name: string; id?: string; comps?: string[] }): LibraryFile {
  const comps = withNested(P, opts.comps ?? componentComps(P).map(c => c.id)).filter(c => c.component);
  const assets: Record<string, Asset> = {};
  const tokens = new Map<string, Token>();
  const components = comps.map(c => {
    const layers = compLayers(P, c).map(l => JSON.parse(JSON.stringify(l)) as Layer);
    for (const l of layers) {
      for (const ref of [l.imageRef, ...(l.paints ?? []).map(p => p.imageRef)]) if (ref && P.assets[ref]) assets[ref] = P.assets[ref];
      for (const k in l.props) {
        const p = l.props[k as PropKey];
        for (const t of [p?.bind, ...(p?.kf ?? []).map(f => f.tok)]) if (t && P.tokens?.items[t]) tokens.set(t, P.tokens.items[t]);
      }
    }
    const comp: Composition = JSON.parse(JSON.stringify({ ...c, component: { ...c.component, editing: undefined, lib: undefined } }));
    return { key: c.component?.lib?.key ?? c.id, rev: componentRev(P, c), comp, layers };
  });
  return { format: 'motion-library', version: 1, id: opts.id ?? 'lib:' + opts.name.trim().toLowerCase().replace(/\s+/g, '-'), name: opts.name.trim(), published: Date.now(), components, assets, ...(tokens.size ? { tokens: [...tokens.values()] } : {}) };
}

export function parseLibrary(text: string): LibraryFile {
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error('not a json file'); }
  if (j?.format !== 'motion-library' || !Array.isArray(j.components)) throw new Error('not a Motion component library');
  return j as LibraryFile;
}

export interface LibraryChange {
  key: string;
  name: string;
  status: 'new' | 'changed' | 'same' | 'removed';
  /** local composition (changed / same / removed) */
  local?: string;
  instances: number;
  /** the local copy was edited since it came from the library: updating replaces those edits */
  editedHere?: boolean;
  /** what changed, in words */
  notes: string[];
}

/** what importing / updating from a library would do (pure: the review dialog shows this) */
export function planLibrary(P: Project, lib: LibraryFile): LibraryChange[] {
  const local = new Map<string, Composition>();
  for (const c of componentComps(P)) if (c.component?.lib?.id === lib.id) local.set(c.component.lib.key, c);
  const count = (id: string) => Object.values(P.layers).filter(l => l.type === 'precomp' && l.compRef === id).length;
  const out: LibraryChange[] = [];
  for (const lc of lib.components) {
    const c = local.get(lc.key);
    if (!c) { out.push({ key: lc.key, name: lc.comp.name, status: 'new', instances: 0, notes: [] }); continue; }
    local.delete(lc.key);
    const cur = componentRev(P, c);
    const editedHere = cur !== c.component!.lib!.rev;
    if (lc.rev === c.component!.lib!.rev && !editedHere) { out.push({ key: lc.key, name: c.name, status: 'same', local: c.id, instances: count(c.id), notes: [] }); continue; }
    if (lc.rev === c.component!.lib!.rev) { out.push({ key: lc.key, name: c.name, status: 'same', local: c.id, instances: count(c.id), editedHere, notes: ['edited here (the library has not changed)'] }); continue; }
    out.push({ key: lc.key, name: lc.comp.name, status: 'changed', local: c.id, instances: count(c.id), editedHere, notes: diffNotes(P, c, lc) });
  }
  for (const [key, c] of local) out.push({ key, name: c.name, status: 'removed', local: c.id, instances: count(c.id), notes: ['no longer in the library: kept here'] });
  return out;
}

function diffNotes(P: Project, c: Composition, lc: LibraryComponent): string[] {
  const n: string[] = [];
  if (c.name !== lc.comp.name) n.push(`renamed to ${lc.comp.name}`);
  if (c.width !== lc.comp.width || c.height !== lc.comp.height) n.push(`size ${c.width}×${c.height} → ${lc.comp.width}×${lc.comp.height}`);
  if (Math.abs(c.duration - lc.comp.duration) > 1e-6) n.push(`duration ${c.duration}s → ${lc.comp.duration}s`);
  const a = new Set((c.component?.props ?? []).map(p => p.name)), b = new Set((lc.comp.component?.props ?? []).map(p => p.name));
  for (const x of b) if (!a.has(x)) n.push(`new property ${x}`);
  for (const x of a) if (!b.has(x)) n.push(`property ${x} removed`);
  const va = new Set((c.component?.variants ?? []).map(v => v.name)), vb = new Set((lc.comp.component?.variants ?? []).map(v => v.name));
  for (const x of vb) if (!va.has(x)) n.push(`new variant ${x}`);
  for (const x of va) if (!vb.has(x)) n.push(`variant ${x} removed`);
  const la = compLayers(P, c).length, lb = lc.layers.length;
  if (la !== lb) n.push(`${lb > la ? lb - la + ' layers added' : la - lb + ' layers removed'}`);
  if (!n.length) n.push('animation or look changed');
  return n;
}

/** import new components and update changed ones (keys: only these; default all new + changed). one undo step */
export function applyLibrary(store: Store, lib: LibraryFile, plan: LibraryChange[], keys?: string[]): { added: number; updated: number } {
  const P = store.project;
  const pick = new Set(keys ?? plan.filter(c => c.status === 'new' || c.status === 'changed').map(c => c.key));
  const res = { added: 0, updated: 0 };
  // library key -> local comp id (also for components not picked: nested refs must resolve)
  const compId = new Map<string, string>();
  for (const c of plan) if (c.local) compId.set(c.key, c.local);
  for (const lc of lib.components) if (!compId.has(lc.key) && pick.has(lc.key)) compId.set(lc.key, uid('c'));
  // source comp id (inside the library) -> key
  const srcKey = new Map(lib.components.map(lc => [lc.comp.id, lc.key]));
  store.transact(`Library ${lib.name}`, tx => {
    for (const [id, a] of Object.entries(lib.assets ?? {})) if (!P.assets[id]) { tx.set(P.assets, id, a); tx.change.assets = true; }
    for (const lc of lib.components) {
      if (!pick.has(lc.key)) continue;
      const id = compId.get(lc.key)!;
      const old = P.comps[id];
      if (old) for (const l of compLayers(P, old)) tx.del(P.layers, l.id);
      // fresh layer ids (two libraries may share ids), remapped everywhere they are referenced
      const ids = new Map(lc.layers.map(l => [l.id, uid()]));
      const m = (x: string) => ids.get(x) ?? x;
      for (const src of lc.layers) {
        const l: Layer = JSON.parse(JSON.stringify(src));
        l.id = m(l.id); l.parent = l.parent ? m(l.parent) : null; l.children = l.children.map(m);
        if (l.type === 'precomp' && l.compRef) { const k = srcKey.get(l.compRef); const to = k ? compId.get(k) : undefined; if (to) l.compRef = to; }
        tx.set(P.layers, l.id, l);
      }
      const def = JSON.parse(JSON.stringify(lc.comp.component ?? {}));
      for (const p of def.props ?? []) p.targets = p.targets.map((t: { layer: string; field: string }) => ({ ...t, layer: m(t.layer) }));
      for (const v of def.variants ?? []) v.ov = Object.fromEntries(Object.entries(v.ov ?? {}).map(([k, o]) => [m(k), o]));
      delete def.editing;
      def.lib = { id: lib.id, name: lib.name, key: lc.key, rev: lc.rev, at: Date.now() };
      const comp: Composition = { ...JSON.parse(JSON.stringify(lc.comp)), id, root: lc.comp.root.map(m), component: def };
      tx.set(P.comps, id, comp);
      if (old) res.updated++; else res.added++;
    }
    // linked styles the components use: add the missing ones (existing styles keep their values)
    if (lib.tokens?.length) {
      if (!P.tokens) tx.set(P, 'tokens', { items: {}, modes: ['Default'], mode: 'Default' });
      for (const t of lib.tokens) if (!P.tokens!.items[t.id]) tx.set(P.tokens!.items, t.id, t);
    }
    // instances follow the new definition: drop values of properties that no longer exist
    for (const l of Object.values(P.layers)) {
      if (l.type !== 'precomp' || !l.compRef || !l.inst?.props) continue;
      const def = P.comps[l.compRef]?.component;
      if (!def?.lib || def.lib.id !== lib.id) continue;
      const keep = Object.fromEntries(Object.entries(l.inst.props).filter(([k]) => def.props?.some(p => p.id === k)));
      if (Object.keys(keep).length !== Object.keys(l.inst.props).length) tx.set(l, 'inst', { ...l.inst, props: keep });
      tx.touch(l.id);
    }
    tx.structure();
    tx.comp();
  });
  store.emit('comps');
  store.emit('components');
  return res;
}

/** words for a plan: "2 components changed, 1 new" */
export function summarizeLibrary(plan: LibraryChange[]): string {
  const n = (s: LibraryChange['status']) => plan.filter(c => c.status === s).length;
  const parts: string[] = [];
  if (n('changed')) parts.push(`${n('changed')} changed`);
  if (n('new')) parts.push(`${n('new')} new`);
  if (n('removed')) parts.push(`${n('removed')} removed`);
  return parts.length ? parts.join(', ') : 'everything is up to date';
}

