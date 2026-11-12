// smart animate (figma style): two versions of the same design (e.g. two pasted figma frames,
// "before" and "after") become one animated layer tree. layers are matched by their name path
// inside the two roots; every property that differs gets a keyframe pair, layers that only
// exist in the end state fade in, layers only in the start state fade out. the end state's
// root is removed afterwards (one undo step).

import { EASE_PRESETS } from './easing';
import { defaultEase, PROP_DEFS, TRANSFORM_KEYS, TYPE_PROPS, type Keyframe, type Layer, type PathGeometry, type PathKey, type PropKey } from './model';
import type { Store } from './store';
import { deleteLayers, moveLayers, valueAt } from './commands';

export interface SmartAnimateOptions {
  /** start time (default: playhead) */
  t0?: number;
  duration?: number;
  /** ease preset name (EASE_PRESETS) or a spring bounce 0..1 */
  ease?: string;
  spring?: number;
  /** delete the end-state root afterwards (default true) */
  removeEnd?: boolean;
}

export interface SmartAnimateResult { matched: number; fadedIn: number; fadedOut: number; props: number }

/** name path key of every descendant: "Card/Title", duplicates among siblings get "#2", "#3" */
function index(store: Store, root: Layer): Map<string, Layer> {
  const out = new Map<string, Layer>();
  const walk = (l: Layer, prefix: string) => {
    const seen = new Map<string, number>();
    for (const id of l.children) {
      const c = store.layer(id);
      if (!c) continue;
      const n = (seen.get(c.name) ?? 0) + 1;
      seen.set(c.name, n);
      const key = prefix + (n > 1 ? `${c.name}#${n}` : c.name);
      out.set(key, c);
      walk(c, key + '/');
    }
  };
  walk(root, '');
  return out;
}

const differs = (a: number[], b: number[]) => a.length !== b.length || a.some((x, i) => Math.abs(x - b[i]) > 1e-4);

function sameStructure(a: PathGeometry[] | undefined, b: PathGeometry[] | undefined) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((g, i) => g.cmds.length === b[i].cmds.length && g.cmds.every((c, j) => c[0] === b[i].cmds[j][0]));
}

export function smartAnimate(store: Store, startId: string, endId: string, opts: SmartAnimateOptions = {}): SmartAnimateResult {
  const A = store.layer(startId), B = store.layer(endId);
  if (!A || !B) throw new Error('smart animate needs two layers');
  if (store.isAncestor(startId, endId) || store.isAncestor(endId, startId)) throw new Error('the two layers must not contain each other');
  const t0 = opts.t0 ?? store.time;
  const d = Math.max(1 / store.comp.fps, opts.duration ?? 0.6);
  const t1 = t0 + d;
  const ez = EASE_PRESETS.find(p => p.name.toLowerCase() === (opts.ease ?? 'Cubic Out').toLowerCase())?.v ?? [0.33, 1, 0.68, 1];
  const mkKey = (t: number, v: number[], first: boolean): Keyframe => {
    const k: Keyframe = { t, v: v.slice(), ...defaultEase() };
    if (opts.spring !== undefined) { if (first) { k.interp = 'spring'; k.bounce = opts.spring; } }
    else { if (first) k.out = [ez[0], ez[1]]; else k.in = [ez[2], ez[3]]; }
    return k;
  };
  const res: SmartAnimateResult = { matched: 0, fadedIn: 0, fadedOut: 0, props: 0 };
  const ia = index(store, A), ib = index(store, B);

  store.batch('Smart animate', () => {
    // layers that only exist at the end: move them into the matching parent of the start tree
    // (their local values are relative to that parent), hidden until they fade in
    const incoming: Layer[] = [];
    for (const [key, b] of ib) {
      if (ia.has(key)) continue;
      const pkey = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
      if (pkey && !ia.has(pkey)) continue; // its parent arrives too: moves along with it
      const parent = pkey ? ia.get(pkey)! : A;
      const bParent = b.parent ? store.layer(b.parent) : null;
      const idx = bParent ? bParent.children.indexOf(b.id) : 0;
      moveLayers(store, [b.id], parent.id, Math.min(idx, parent.children.length));
      incoming.push(b);
    }

    store.transact('Smart animate', tx => {
      const keyProp = (l: Layer, key: PropKey, from: number[], to: number[]) => {
        let p = l.props[key];
        if (!p) { p = { v: from.slice() }; tx.set(l.props, key, p); }
        const rest = (p.kf ?? []).filter(k => k.t < t0 - 1e-6 || k.t > t1 + 1e-6);
        tx.set(p, 'kf', [...rest, mkKey(t0, from, true), mkKey(t1, to, false)].sort((a, b) => a.t - b.t));
        tx.touch(l.id);
        res.props++;
      };
      const pairs: [Layer, Layer, boolean][] = [[A, B, true]];
      for (const [key, a] of ia) { const b = ib.get(key); if (b) pairs.push([a, b, false]); }
      for (const [a, b, isRoot] of pairs) {
        if (!isRoot) res.matched++;
        const keys = new Set<PropKey>([...TRANSFORM_KEYS, ...TYPE_PROPS[a.type]]);
        if (a.type !== b.type) for (const k of [...keys]) if (!TRANSFORM_KEYS.includes(k)) keys.delete(k);
        for (const key of keys) {
          // the roots stay where the start root is (frames are usually placed side by side)
          if (isRoot && (key === 'position' || key === 'anchor')) continue;
          if (!PROP_DEFS[key]) continue;
          const from = valueAt(a, key, t0), to = valueAt(b, key, b.props[key]?.kf?.length ? t1 : 0);
          if (differs(from, to)) keyProp(a, key, from, to);
        }
        // vector shape change with the same command structure: path morph keys
        if (a.type === 'path' && b.type === 'path' && a.geometry && b.geometry && JSON.stringify(a.geometry) !== JSON.stringify(b.geometry) && sameStructure(a.geometry, b.geometry)) {
          const pk = (t: number, g: PathGeometry[], first: boolean): PathKey => {
            const k = mkKey(t, [0], first);
            return { t, geometry: JSON.parse(JSON.stringify(g)), interp: k.interp === 'spring' ? 'bezier' : k.interp, out: k.out, in: k.in };
          };
          const rest = (a.pathKf ?? []).filter(k => k.t < t0 - 1e-6 || k.t > t1 + 1e-6);
          tx.set(a, 'pathKf', [...rest, pk(t0, a.geometry, true), pk(t1, b.geometry, false)].sort((x, y) => x.t - y.t));
          tx.touch(a.id);
          res.props++;
        }
      }
      // start-only layers fade out, end-only layers fade in
      for (const [key, a] of ia) {
        if (ib.has(key)) continue;
        const pkey = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
        if (pkey && !ib.has(pkey)) continue; // its parent fades already
        keyProp(a, 'opacity', valueAt(a, 'opacity', t0), [0]);
        res.fadedOut++;
      }
      for (const b of incoming) {
        keyProp(b, 'opacity', [0], valueAt(b, 'opacity', 0));
        res.fadedIn++;
      }
    });
    if (opts.removeEnd ?? true) deleteLayers(store, [B.id]);
  });
  return res;
}
