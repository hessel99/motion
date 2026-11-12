// agent-generated variations (A/B/C). the agent builds one version of an animation, calls
// save_variation, builds the next, ... the user then previews each and picks one. a variation is a
// snapshot of the animation state (props, text animator, timing) of a set of layers; applying it
// is one undoable transaction.

import type { Store } from '../core/store';
import type { Layer } from '../core/model';

export interface VarLayerState {
  props: Layer['props'];
  textAnim?: Layer['textAnim'];
  pathKf?: Layer['pathKf'];
  inPoint: number;
  outPoint: number;
}

export interface Variation {
  id: string;
  label: string;
  note?: string;
  layers: Record<string, VarLayerState>;
  /** small filmstrip thumbnails (data urls), filled by the ui when a renderer exists */
  thumbs?: string[];
  createdAt: number;
}

const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

class VariationStore {
  list: Variation[] = [];
  /** id of the variation currently applied to the document */
  active: string | null = null;
  private fns = new Set<() => void>();
  on(fn: () => void) { this.fns.add(fn); return () => { this.fns.delete(fn); }; }
  emit() { this.fns.forEach(f => f()); }

  capture(store: Store, ids: string[], label: string, note?: string): Variation {
    const layers: Record<string, VarLayerState> = {};
    for (const id of ids) {
      const l = store.layer(id);
      if (!l) throw new Error(`no layer with id "${id}"`);
      layers[id] = { props: clone(l.props), textAnim: clone(l.textAnim), pathKf: clone(l.pathKf), inPoint: l.inPoint, outPoint: l.outPoint };
    }
    if (!Object.keys(layers).length) throw new Error('save_variation needs at least one layer id');
    const letter = String.fromCharCode(65 + (this.list.length % 26));
    const v: Variation = { id: 'v' + Math.random().toString(36).slice(2, 8), label: label?.trim() || `Variation ${letter}`, note, layers, createdAt: Date.now() };
    this.list.push(v);
    if (this.list.length > 24) this.list.shift();
    this.active = v.id;
    this.emit();
    return v;
  }

  apply(store: Store, id: string) {
    const v = this.list.find(x => x.id === id);
    if (!v) throw new Error(`no variation "${id}"`);
    store.transact(`Variation: ${v.label}`, tx => {
      for (const [lid, s] of Object.entries(v.layers)) {
        const l = store.layer(lid);
        if (!l) continue; // layer deleted since: skip
        tx.set(l, 'props', clone(s.props));
        if (s.textAnim) tx.set(l, 'textAnim', clone(s.textAnim)); else tx.del(l, 'textAnim');
        if (s.pathKf) tx.set(l, 'pathKf', clone(s.pathKf)); else tx.del(l, 'pathKf');
        tx.set(l, 'inPoint', s.inPoint);
        tx.set(l, 'outPoint', s.outPoint);
        tx.touch(lid);
      }
      tx.structure(); // whole tracks were swapped: let the renderer recompile
    });
    this.active = id;
    this.emit();
    return v;
  }

  /** time range covered by a variation's keys (for previewing it) */
  range(v: Variation): [number, number] {
    let a = Infinity, b = -Infinity;
    for (const s of Object.values(v.layers)) {
      for (const p of Object.values(s.props)) for (const k of p?.kf ?? []) { a = Math.min(a, k.t); b = Math.max(b, k.t); }
      if (s.textAnim) { a = Math.min(a, s.textAnim.start); b = Math.max(b, s.textAnim.start + s.textAnim.duration + s.textAnim.stagger * 20); }
    }
    return isFinite(a) ? [a, b] : [0, 0];
  }

  clear() { this.list = []; this.active = null; this.emit(); }
  load(list: Variation[]) { this.list = list; this.active = null; this.emit(); }
}

export const variations = new VariationStore();
