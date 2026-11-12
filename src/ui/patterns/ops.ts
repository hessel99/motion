// document operations behind the patterns: undoable tempo / stagger edits (drag = one undo step
// through a merge key) and the transient ease preview used by hover swatches (renderer-side
// overrides, never written into the document).

import { parseKeyId } from '../../core/commands';
import type { Interp, Keyframe, PathKey, PropKey } from '../../core/model';
import type { Store } from '../../core/store';
import { layerSpan, retime, shift, snapTo, staggerOffsets } from './timing';

// ---------------- ease application (mirror of commands.setEase / setSpring) ----------------

export type EaseSpec = { kind: 'bezier'; v: [number, number, number, number] } | { kind: 'linear' } | { kind: 'spring'; bounce: number };

/** the new keyframe array for a property after applying `ease` to the selected key indices.
 *  same rules as setEase/setSpring: a selected key eases the segment leaving it (the last key:
 *  the segment arriving at it). */
export function easedKeys(kf: Keyframe[], idx: Iterable<number>, ease: EaseSpec): Keyframe[] {
  const out = kf.map(k => ({ ...k }));
  for (const i of [...idx].sort((a, b) => a - b)) {
    const j = i < out.length - 1 ? i : i - 1;
    if (j < 0) continue;
    if (ease.kind === 'spring') { out[j] = { ...out[j], interp: 'spring', bounce: ease.bounce }; continue; }
    const v = ease.kind === 'linear' ? [0, 0, 1, 1] : ease.v;
    const interp: Interp = ease.kind === 'linear' ? 'linear' : 'bezier';
    out[j] = { ...out[j], interp, out: [v[0], v[1]] };
    out[j + 1] = { ...out[j + 1], in: [v[2], v[3]] };
  }
  return out;
}

/** undoable: apply an ease to the selected keys. a merge key folds a whole drag / knob turn
 *  into one undo step (commands.setEase has no merge key) */
export function applyEase(store: Store, keys: Iterable<string>, ease: EaseSpec, mergeKey?: string) {
  const groups = groupKeys(store, keys);
  if (!groups.length) return;
  store.transact(ease.kind === 'spring' ? 'Set spring' : 'Set easing', tx => {
    tx.keepKeys = true;
    for (const g of groups) {
      const prop = store.layer(g.layerId)!.props[g.key]!;
      tx.set(prop, 'kf', easedKeys(prop.kf!, g.idx, ease));
      tx.touch(g.layerId);
    }
  }, mergeKey);
}

/** group key ids into props: `${layerId}|${prop}` -> indices */
export function groupKeys(store: Store, keys: Iterable<string>) {
  const m = new Map<string, { layerId: string; key: PropKey; idx: number[] }>();
  for (const k of keys) {
    const p = parseKeyId(k);
    if (!store.layer(p.layerId)?.props[p.key]?.kf?.[p.index]) continue;
    const id = p.layerId + '|' + p.key;
    let g = m.get(id);
    if (!g) m.set(id, (g = { layerId: p.layerId, key: p.key, idx: [] }));
    g.idx.push(p.index);
  }
  return [...m.values()];
}

/** the time range covered by the segments the selected keys ease */
export function easedRange(store: Store, keys: Iterable<string>): [number, number] | null {
  let a = Infinity, b = -Infinity;
  for (const g of groupKeys(store, keys)) {
    const kf = store.layer(g.layerId)!.props[g.key]!.kf!;
    for (const i of g.idx) {
      const j = i < kf.length - 1 ? i : i - 1;
      if (j < 0) continue;
      a = Math.min(a, kf[j].t); b = Math.max(b, kf[j + 1].t);
    }
  }
  return a < b ? [a, b] : null;
}

/**
 * transient preview of an ease: the eased keyframes go into the store's preview overrides
 * (`store.previewProps`, evaluated by the renderer instead of the document prop), never into
 * the document. autosave / serialize, undo and agent tools only ever see the real keys. the
 * playhead loops over the eased segments. the preview ends itself on any real document change
 * or undo/redo ('doc' / 'history'), because its overrides were computed from the old keys.
 */
export class EasePreview {
  private overridden: { layerId: string; key: PropKey }[] = [];
  private t0 = 0;
  private range: [number, number] | null = null;
  private start = 0;
  private off: (() => void)[] = [];
  active = false;
  /** called whenever the preview ends (also when it ends itself on a document change) */
  onEnd: (() => void) | null = null;
  constructor(private store: Store) {}

  begin(keys: Iterable<string>, ease: EaseSpec) {
    const store = this.store;
    const list = [...keys];
    const groups = groupKeys(store, list);
    if (!groups.length) { this.end(); return; }
    if (this.active) this.clearOverrides(); else this.t0 = store.time;
    this.range = easedRange(store, list);
    for (const g of groups) {
      const prop = store.layer(g.layerId)!.props[g.key]!;
      store.setPreviewProp(g.layerId, g.key, { ...prop, kf: easedKeys(prop.kf!, g.idx, ease) });
      this.overridden.push({ layerId: g.layerId, key: g.key });
    }
    if (!this.active) {
      this.start = performance.now();
      const stop = () => this.end();
      this.off = [store.on('doc', stop), store.on('history', stop)];
    }
    this.active = true;
  }

  /** advance the looping playhead (call once per animation frame while active) */
  tick(now: number) {
    if (!this.active || !this.range) return;
    const [a, b] = this.range;
    const pre = 0.12, post = 0.45;
    const len = b - a + pre + post;
    const t = a - pre + (((now - this.start) / 1000) % len);
    this.store.time = Math.max(0, Math.min(this.store.comp.duration, Math.max(a, Math.min(b, t))));
    this.store.emit('tick');
  }

  private clearOverrides() {
    for (const o of this.overridden) this.store.setPreviewProp(o.layerId, o.key, undefined);
    this.overridden.length = 0;
  }

  end() {
    if (!this.active) return;
    this.active = false;
    for (const f of this.off) f();
    this.off = [];
    this.clearOverrides();
    this.store.setTime(this.t0);
    this.onEnd?.();
  }
}

// ---------------- timing snapshot (tempo / stagger) ----------------

export interface TimingSnap {
  layers: { id: string; props: [PropKey, Keyframe[]][]; pathKf?: PathKey[]; span: [number, number] }[];
  /** all animated layers: earliest key / latest key */
  span: [number, number];
}

/** capture the keyframes of animated layers, ordered by start time (ties: given order) */
export function snapshotTiming(store: Store, ids: string[]): TimingSnap | null {
  const layers: TimingSnap['layers'] = [];
  for (const id of ids) {
    const l = store.layer(id);
    const span = l && layerSpan(l);
    if (!l || !span) continue;
    const props: [PropKey, Keyframe[]][] = [];
    for (const k in l.props) { const kf = l.props[k as PropKey]?.kf; if (kf?.length) props.push([k as PropKey, kf]); }
    layers.push({ id, props, pathKf: l.pathKf, span });
  }
  if (!layers.length) return null;
  layers.sort((a, b) => a.span[0] - b.span[0]);
  return { layers, span: [Math.min(...layers.map(l => l.span[0])), Math.max(...layers.map(l => l.span[1]))] };
}

export interface SnapOpts { targets?: readonly number[]; radius?: number; mergeKey?: string }

/** the longest tempo duration that keeps the selection inside the composition */
export function maxTempo(store: Store, snap: TimingSnap) {
  return Math.max(1 / store.comp.fps, store.comp.duration - snap.span[0]);
}

/** stretch the whole selection so it lasts `duration` seconds (pivot = first key). magnetic:
 *  the end lands on a marker/beat when close. the end never goes past the composition end.
 *  returns the duration actually applied. */
export function applyTempo(store: Store, snap: TimingSnap, duration: number, o: SnapOpts = {}): number {
  const [a, b] = snap.span;
  const len = b - a;
  if (len < 1e-6) return 0;
  const maxEnd = a + maxTempo(store, snap);
  let end = a + Math.max(1 / store.comp.fps, Math.min(duration, maxEnd - a));
  if (o.targets?.length) end = snapTo(end, o.targets, o.radius ?? 0.1);
  end = Math.min(end, maxEnd);
  if (end - a < 1e-6) return 0;
  const f = (end - a) / len;
  store.transact('Tempo', tx => {
    tx.keepKeys = true;
    for (const s of snap.layers) {
      const l = store.layer(s.id);
      if (!l) continue;
      for (const [k, kf] of s.props) { const p = l.props[k]; if (p) tx.set(p, 'kf', retime(kf, a, f)); }
      if (s.pathKf) tx.set(l, 'pathKf', retime(s.pathKf, a, f));
      tx.touch(s.id);
    }
  }, o.mergeKey);
  return end - a;
}

/** cascade the layers: layer i starts at first + offset_i (stagger seconds between layers,
 *  groove bends the cascade). each layer keeps its own internal timing. */
export function applyStagger(store: Store, snap: TimingSnap, stagger: number, groove: number, o: SnapOpts = {}) {
  const n = snap.layers.length;
  if (n < 2) return;
  const base = snap.layers[0].span[0];
  const fps = store.comp.fps;
  // magnet: snap the cascade as a whole (its last start lands on a marker), never each layer on
  // its own. per-layer snapping bent the spacing, so the knobs read it back as a groove change
  // (with the magnet on, ArrowUp on Stagger changed Groove instead)
  let st = Math.max(0, stagger);
  const unit = staggerOffsets(n, 1, groove)[n - 1];
  if (o.targets?.length && st > 0 && unit > 1e-9) {
    const last = snapTo(base + st * unit, o.targets, o.radius ?? 0.1);
    if (last > base) st = (last - base) / unit;
  }
  const offs = staggerOffsets(n, st, groove);
  store.transact('Stagger', tx => {
    tx.keepKeys = true;
    snap.layers.forEach((s, i) => {
      const l = store.layer(s.id);
      if (!l) return;
      let start = base + offs[i];
      start = Math.round(start * fps) / fps;
      const dt = start - s.span[0];
      for (const [k, kf] of s.props) { const p = l.props[k]; if (p) tx.set(p, 'kf', shift(kf, dt)); }
      if (s.pathKf) tx.set(l, 'pathKf', shift(s.pathKf, dt));
      tx.touch(s.id);
    });
  }, o.mergeKey);
}
