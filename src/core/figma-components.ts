// figma components -> motion components. a figma paste makes linked-copy components (core/components.ts:
// a main in the "Components" composition, pasted instances linked to it). promoting one makes it an
// animated component (core/motion-components.ts): the main moves into its own composition, its figma
// properties (text, boolean) become exposed properties, mains of the same component set with the
// same layer structure become its variants, and every linked instance becomes an instance with the
// values it had. later pastes of that figma component arrive as motion instances (design-import.ts).

import { createLayer, uid, createComp, type Composition, type ExposedProp, type Layer, type Project, type PropKey, type Variant, type VariantLayerOv } from './model';
import type { Store, Tx } from './store';
import { instancesOf } from './components';
import { diffFromBase, VARIANT_KEYS } from './motion-components';

const firstV = (l: Layer, k: PropKey) => { const p = l.props[k]; return p ? (p.kf?.length ? p.kf[0].v : p.v) : undefined; };

/** pairs of layers (a, b) in two trees with the same structure, by tree position; null when they differ */
function pairTrees(P: Project, a: string, b: string, out: [string, string][] = []): [string, string][] | null {
  const A = P.layers[a], B = P.layers[b];
  if (!A || !B || A.type !== B.type || A.children.length !== B.children.length) return null;
  out.push([a, b]);
  for (let i = 0; i < A.children.length; i++) if (!pairTrees(P, A.children[i], B.children[i], out)) return null;
  return out;
}

function snapOf(l: Layer) {
  const s: { props?: Partial<Record<PropKey, number[]>>; text?: string; fontSize?: number; visible?: boolean } = {};
  for (const k of VARIANT_KEYS) { const v = firstV(l, k); if (v) (s.props ??= {})[k] = v.slice(); }
  if (l.text) { s.text = l.text.content; s.fontSize = l.text.fontSize; }
  s.visible = l.visible;
  return s;
}

/** the layers of an instance (linked copy) by the main layer they mirror */
function linkedMap(P: Project, root: string): Map<string, Layer> {
  const m = new Map<string, Layer>();
  const walk = (id: string) => { const l = P.layers[id]; if (!l) return; if (l.link) m.set(l.link.main, l); l.children.forEach(walk); };
  walk(root);
  return m;
}

function removeFromParent(tx: Tx, P: Project, id: string) {
  const l = P.layers[id];
  if (l.parent) { const p = P.layers[l.parent]; tx.set(p, 'children', p.children.filter(c => c !== id)); return; }
  for (const c of Object.values(P.comps)) if (c.root.includes(id)) tx.set(c, 'root', c.root.filter(x => x !== id));
}

function deleteTree(tx: Tx, P: Project, id: string) {
  const walk = (x: string) => { const l = P.layers[x]; if (!l) return; l.children.forEach(walk); tx.del(P.layers, x); };
  walk(id);
}

/** a precomp instance where `old` (a layer tree) was: same parent, index and box */
function instanceInPlace(tx: Tx, P: Project, old: Layer, comp: Composition, name: string): Layer {
  const pos = firstV(old, 'position') ?? [0, 0], an = firstV(old, 'anchor') ?? [0, 0];
  const x = pos[0] - an[0], y = pos[1] - an[1];
  const l = createLayer('precomp', { name, w: comp.width, h: comp.height, x, y });
  l.compRef = comp.id; l.startTime = 0; l.inst = {};
  l.parent = old.parent;
  tx.set(P.layers, l.id, l);
  if (old.parent) { const p = P.layers[old.parent]; tx.set(p, 'children', p.children.map(c => (c === old.id ? l.id : c))); }
  else for (const c of Object.values(P.comps)) if (c.root.includes(old.id)) tx.set(c, 'root', c.root.map(r => (r === old.id ? l.id : r)));
  return l;
}

/** make a (figma) linked-copy component an animated component. returns the new composition */
export function promoteToMotionComponent(store: Store, mainId: string): Composition {
  const P = store.project;
  const info = P.components?.[mainId];
  const main = P.layers[mainId];
  if (!info || !main) throw new Error('not a main component');
  // variants: other mains of the same figma component set with the same structure
  const siblings = info.figmaSet ? Object.entries(P.components!).filter(([id, c]) => id !== mainId && c.figmaSet?.key === info.figmaSet!.key && P.layers[id]) : [];
  const groupOf = (vals: Record<string, string>) => Object.keys(vals).join(', ') || 'Variant';
  const nameOf = (vals: Record<string, string>) => Object.values(vals).join(', ');
  let comp!: Composition;
  store.transact(`Make ${info.name} an animated component`, tx => {
    const size = firstV(main, 'size') ?? [100, 100];
    comp = createComp({ name: info.figmaSet?.name ?? info.name, width: Math.max(1, Math.round(size[0])), height: Math.max(1, Math.round(size[1])), fps: store.comp.fps, duration: store.comp.duration, background: [0, 0, 0, 0] });
    const props: ExposedProp[] = (info.figmaProps ?? []).map(fp => ({
      id: 'f' + fp.id.replace(/[^a-z0-9]/gi, ''), name: fp.name.replace(/#[\d:]+$/, ''), kind: (fp.type === 'BOOL' || fp.type === 'BOOLEAN' ? 'toggle' : 'text') as ExposedProp['kind'],
      targets: fp.targets.filter(t => P.layers[t.layer] && (t.field === 'text' ? !!P.layers[t.layer].text : t.field === 'visible')),
    })).filter(p => p.targets.length);
    const variants: Variant[] = [];
    const vByMain = new Map<string, Variant>();
    for (const [sid, sc] of siblings) {
      const pairs = pairTrees(P, mainId, sid);
      if (!pairs) continue;
      const ov: Record<string, VariantLayerOv> = {};
      for (const [a, b] of pairs) {
        // the sibling's values measured against the main's (the root's place does not count)
        const base = snapOf(P.layers[a]);
        if (a === mainId) { delete base.props?.position; delete base.props?.anchor; }
        const d = diffFromBase({ ...P.layers[b], props: a === mainId ? { ...P.layers[b].props, position: undefined, anchor: undefined } : P.layers[b].props } as Layer, base);
        if (d) ov[a] = d;
      }
      const v: Variant = { id: uid('v'), name: nameOf(sc.figmaSet!.values), group: groupOf(sc.figmaSet!.values), ov };
      const ssz = firstV(P.layers[sid], 'size');
      if (ssz && (Math.round(ssz[0]) !== comp.width || Math.round(ssz[1]) !== comp.height)) { v.width = Math.round(ssz[0]); v.height = Math.round(ssz[1]); }
      variants.push(v);
      vByMain.set(sid, v);
    }
    comp.component = { figmaKey: info.figmaKey, ...(props.length ? { props } : {}), ...(variants.length ? { variants } : {}), description: 'from Figma' };
    tx.set(P.comps, comp.id, comp);
    // instances (of the main and of the variant mains) -> motion instances with their values
    const convert = (m: string, v?: Variant) => {
      for (const r of instancesOf(P, m)) {
        const old = P.layers[r];
        const map = linkedMap(P, r);
        const vals: Record<string, string | boolean> = {};
        for (const p of props) {
          const t = p.targets[0];
          // variant mains mirror the main by tree position
          const pairs = v ? pairTrees(P, mainId, m) : null;
          const mirror = pairs ? pairs.find(([a]) => a === t.layer)?.[1] : t.layer;
          const il = mirror ? map.get(mirror) : undefined;
          if (!il) continue;
          const mv = t.field === 'text' ? P.layers[t.layer].text?.content : P.layers[t.layer].visible;
          const iv = t.field === 'text' ? il.text?.content : il.visible;
          if (iv !== undefined && iv !== mv) vals[p.id] = iv;
        }
        const nl = instanceInPlace(tx, P, old, comp, old.name);
        if (Object.keys(vals).length) nl.inst!.props = vals;
        if (v) { nl.inst!.variants = { [v.group]: v.id }; if (v.width && v.height) { nl.props.size!.v = [v.width, v.height]; nl.props.anchor!.v = [v.width / 2, v.height / 2]; } }
        deleteTree(tx, P, r);
      }
    };
    convert(mainId);
    for (const [sid] of siblings) if (vByMain.has(sid)) convert(sid, vByMain.get(sid));
    // the main moves into the component; variant mains are now variants: drop them
    removeFromParent(tx, P, mainId);
    tx.set(main, 'parent', null);
    const an = firstV(main, 'anchor') ?? [0, 0];
    if (main.props.position && !main.props.position.kf?.length) tx.set(main.props.position, 'v', [an[0], an[1]]);
    tx.set(comp, 'root', [mainId]);
    tx.del(P.components!, mainId);
    for (const [sid] of siblings) if (vByMain.has(sid)) { removeFromParent(tx, P, sid); deleteTree(tx, P, sid); tx.del(P.components!, sid); }
    tx.structure();
    tx.comp();
  });
  store.emit('components');
  store.emit('comps');
  return comp;
}

/** paste: a pasted figma instance of a promoted component becomes a motion instance (inside the paste transaction) */
export function pasteAsMotionInstance(tx: Tx, P: Project, comp: Composition, layer: Layer, values?: Record<string, string | boolean>): Layer {
  const nl = instanceInPlace(tx, P, layer, comp, layer.name);
  const vals: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(values ?? {})) { const p = comp.component?.props?.find(x => x.id === 'f' + k.replace(/[^a-z0-9]/gi, '')); if (p) vals[p.id] = v; }
  if (Object.keys(vals).length) nl.inst!.props = vals;
  deleteTree(tx, P, layer.id);
  return nl;
}
