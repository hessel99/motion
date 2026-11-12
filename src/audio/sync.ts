// "sync to the music": retime existing animation so its important moments (moves starting, landing,
// reversing) hit beats / bars / accents / section starts, through one monotonic piecewise-linear time
// warp. keys never change order, eases keep their shape (handles are relative to segment time), the
// relative timing between layers is kept, and the whole edit is one undo step.
// also: patterns of beat times (place_on_beats) and musically sensible comp lengths.

import { PROP_DEFS, PROP_KEYS, uid, type Layer, type Marker, type PropKey } from '../core/model';
import type { Store, Tx } from '../core/store';
import { music, beats, bars, accents, sections, beatPeriod, type Music } from './timing';
import { refollowSfx } from './sfx-place';

export type SyncMode = 'beats' | 'bars' | 'accents' | 'sections';

export interface MotionEvent { t: number; w: number; kind: 'start' | 'land' | 'peak'; layer: string }
export interface SyncResult { anchors: { from: number; to: number; kind: string; target: string }[]; keys: number; layers: number; warp: (t: number) => number }

const EPS = 1e-6;

/** magnitude of a value change, roughly comparable across properties (1 ≈ a big move) */
function changeSize(key: PropKey, a: number[], b: number[], diag: number): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs((b[i] ?? 0) - (a[i] ?? 0)));
  switch (key) {
    case 'position': case 'anchor': { let s = 0; for (let i = 0; i < 2; i++) s += ((b[i] ?? 0) - (a[i] ?? 0)) ** 2; return Math.min(1.5, Math.sqrt(s) / (diag * 0.25)); }
    case 'scale': return Math.min(1.5, d / 60);
    case 'opacity': return Math.min(1, d / 80);
    case 'rotation': return Math.min(1.2, d / 90);
    case 'fill': case 'stroke': return Math.min(0.6, d * 0.8);
    case 'size': return Math.min(1.2, d / (diag * 0.2));
    case 'trimStart': case 'trimEnd': return Math.min(1, d / 80);
    case 'volume': return 0;
    default: return Math.min(0.6, d / 50);
  }
}

/** animated layers to sync: the ids (with descendants) or every non-audio layer of the active comp */
export function syncLayers(store: Store, ids?: string[]): Layer[] {
  const out: Layer[] = [];
  const seen = new Set<string>();
  const walk = (list: string[]) => { for (const id of list) { const l = store.layer(id); if (!l || seen.has(id)) continue; seen.add(id); if (l.type !== 'audio') out.push(l); walk(l.children); } };
  walk(ids?.length ? ids : store.comp.root);
  return out;
}

/** the moments that matter in the animation: moves starting, landing, reversing (overshoot peaks) */
export function motionEvents(store: Store, layers: Layer[]): MotionEvent[] {
  const c = store.comp, diag = Math.hypot(c.width, c.height);
  const raw: MotionEvent[] = [];
  for (const l of layers) {
    for (const k of PROP_KEYS) {
      const kf = l.props[k]?.kf;
      if (!kf || kf.length < 2) continue;
      const seg = (i: number) => (i < 0 || i >= kf.length - 1 ? 0 : kf[i].interp === 'hold' ? 0 : changeSize(k, kf[i].v, kf[i + 1].v, diag));
      for (let i = 0; i < kf.length; i++) {
        const before = seg(i - 1), after = seg(i);
        if (after > 0.02 && before <= 0.02) raw.push({ t: kf[i].t, w: after, kind: 'start', layer: l.id });
        else if (before > 0.02 && after <= 0.02) raw.push({ t: kf[i].t, w: before * 1.3, kind: 'land', layer: l.id });
        else if (before > 0.02 && after > 0.02 && PROP_DEFS[k].dim <= 2) {
          // direction reversal = an overshoot peak or a bounce contact
          let rev = false;
          for (let d = 0; d < kf[i].v.length; d++) { const x = kf[i].v[d] - kf[i - 1].v[d], y = kf[i + 1].v[d] - kf[i].v[d]; if (x * y < 0 && Math.abs(x) > 1e-6 && Math.abs(y) > 1e-6) rev = true; }
          if (rev) raw.push({ t: kf[i].t, w: Math.min(before, after) * 0.8, kind: 'peak', layer: l.id });
        }
      }
    }
    if (l.textAnim) raw.push({ t: l.inPoint + l.textAnim.start, w: 0.8, kind: 'start', layer: l.id });
    if (l.pathKf && l.pathKf.length > 1) { raw.push({ t: l.pathKf[0].t, w: 0.6, kind: 'start', layer: l.id }); raw.push({ t: l.pathKf[l.pathKf.length - 1].t, w: 0.6, kind: 'land', layer: l.id }); }
    if (l.inPoint > EPS && l.inPoint < c.duration) raw.push({ t: l.inPoint, w: 0.5, kind: 'start', layer: l.id });
  }
  // merge events within half a frame (one move on several properties is one event)
  raw.sort((a, b) => a.t - b.t);
  const out: MotionEvent[] = [];
  const tol = 0.5 / c.fps;
  for (const e of raw) {
    const p = out[out.length - 1];
    if (p && e.t - p.t <= tol) { p.w += e.w; if (e.kind === 'land' || (e.kind === 'start' && p.kind === 'peak')) p.kind = e.kind; }
    else out.push({ ...e });
  }
  return out;
}

export interface Target { t: number; s: number; label: string }

export function syncTargets(m: Music, mode: SyncMode): Target[] {
  const bt = beats(m), br = new Set(bars(m).map(t => t.toFixed(4)));
  const isBar = (t: number) => br.has(t.toFixed(4));
  switch (mode) {
    case 'beats': return bt.map((t, i) => ({ t, s: isBar(t) ? 1 : 0.7, label: isBar(t) ? 'bar' : 'beat ' + (i + 1) }));
    case 'bars': return bt.map(t => ({ t, s: isBar(t) ? 1 : 0.25, label: isBar(t) ? 'bar' : 'beat' }));
    case 'accents': {
      const acc = accents(m).map(a => ({ t: a.t, s: 0.5 + 0.5 * a.s, label: 'accent' }));
      return [...acc, ...bt.filter(t => isBar(t) && !acc.some(a => Math.abs(a.t - t) < 0.05)).map(t => ({ t, s: 0.45, label: 'bar' }))].sort((a, b) => a.t - b.t);
    }
    case 'sections': {
      const sec = sections(m).map(s => ({ t: s.t0, s: 1.2, label: s.label }));
      return [...sec, ...bt.filter(t => isBar(t) && !sec.some(a => Math.abs(a.t - t) < 0.05)).map(t => ({ t, s: 0.5, label: 'bar' }))].sort((a, b) => a.t - b.t);
    }
  }
}

/** monotonic assignment of events to targets (dp): maximize weighted hits, keep segment stretch in
 *  [minRatio, maxRatio], never reorder */
export function assignAnchors(events: MotionEvent[], targets: Target[], o: { maxShift: number; minGap: number; minRatio?: number; maxRatio?: number }): { e: number; target: Target }[] {
  const minR = o.minRatio ?? 0.6, maxR = o.maxRatio ?? 1.6;
  const E = events.length;
  if (!E || !targets.length) return [];
  // candidates per event: up to 4 nearest targets within maxShift
  const cand: Target[][] = events.map(ev => targets.filter(t => Math.abs(t.t - ev.t) <= o.maxShift).sort((a, b) => Math.abs(a.t - ev.t) - Math.abs(b.t - ev.t)).slice(0, 4));
  const gain = (i: number, c: Target) => {
    const ev = events[i], d = Math.abs(c.t - ev.t) / o.maxShift;
    return ev.w * (ev.kind === 'land' ? 1.2 : 1) * c.s * (1.15 - d * d);
  };
  // best[i][k]: best score of a chain ending with event i on its k-th candidate
  const best: number[][] = cand.map(c => c.map(() => -Infinity));
  const prev: [number, number][][] = cand.map(c => c.map(() => [-1, -1] as [number, number]));
  for (let i = 0; i < E; i++) {
    for (let k = 0; k < cand[i].length; k++) {
      const c = cand[i][k];
      let b = gain(i, c), p: [number, number] = [-1, -1];
      for (let j = 0; j < i; j++) {
        for (let q = 0; q < cand[j].length; q++) {
          if (best[j][q] === -Infinity) continue;
          const cj = cand[j][q], dOld = events[i].t - events[j].t, dNew = c.t - cj.t;
          if (dNew < o.minGap || dOld <= EPS) continue;
          const r = dNew / dOld;
          if (r < minR || r > maxR) continue;
          const v = best[j][q] + gain(i, c);
          if (v > b) { b = v; p = [j, q]; }
        }
      }
      best[i][k] = b; prev[i][k] = p;
    }
  }
  let bi = -1, bk = -1, bv = 0;
  for (let i = 0; i < E; i++) for (let k = 0; k < cand[i].length; k++) if (best[i][k] > bv) { bv = best[i][k]; bi = i; bk = k; }
  const chain: { e: number; target: Target }[] = [];
  while (bi >= 0) { chain.push({ e: bi, target: cand[bi][bk] }); [bi, bk] = prev[bi][bk]; }
  return chain.reverse();
}

/** piecewise-linear monotonic warp through (from → to) anchors; rigid shifts outside, never below 0 */
export function makeWarp(anchors: { from: number; to: number }[]): (t: number) => number {
  if (!anchors.length) return t => t;
  const A = anchors;
  const first = A[0], last = A[A.length - 1];
  return (t: number) => {
    if (t <= first.from) {
      // before the first anchor: shift, or compress into [0, first.to] if a shift would go below 0
      const d = first.to - first.from;
      if (first.from > EPS && first.to + (0 - first.from) < 0) return (t / first.from) * first.to;
      return Math.max(0, t + d);
    }
    if (t >= last.from) return t + (last.to - last.from);
    let lo = 0, hi = A.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (A[mid].from <= t) lo = mid; else hi = mid; }
    const a = A[lo], b = A[hi];
    return a.to + ((t - a.from) / (b.from - a.from)) * (b.to - a.to);
  };
}

/** apply a time warp to every timed thing of these layers (keys, path keys, text animators, in/out) */
export function warpLayers(tx: Tx, layers: Layer[], w: (t: number) => number): number {
  let keys = 0;
  for (const l of layers) {
    let touched = false;
    for (const k of PROP_KEYS) {
      const p = l.props[k];
      if (!p?.kf?.length) continue;
      tx.set(p, 'kf', p.kf.map(x => ({ ...x, t: w(x.t) })));
      keys += p.kf.length; touched = true;
    }
    if (l.pathKf?.length) { tx.set(l, 'pathKf', l.pathKf.map(x => ({ ...x, t: w(x.t) }))); touched = true; }
    const inP = l.inPoint > EPS ? w(l.inPoint) : l.inPoint;
    if (l.textAnim) {
      const a = l.textAnim, s0 = w(l.inPoint + a.start), s1 = w(l.inPoint + a.start + a.duration);
      tx.set(l, 'textAnim', { ...a, start: s0 - inP, duration: Math.max(0.01, s1 - s0) });
      touched = true;
    }
    if (l.inPoint > EPS) { tx.set(l, 'inPoint', inP); touched = true; }
    if (l.outPoint < 1e8) { tx.set(l, 'outPoint', Math.max(inP + 0.01, w(l.outPoint))); touched = true; }
    if (touched) tx.touch(l.id);
  }
  return keys;
}

/** plan a sync (no edit): events, anchors and the warp */
export function planSync(store: Store, o: { ids?: string[]; mode?: SyncMode; m?: Music | null } = {}): (SyncResult & { events: MotionEvent[]; layerList: Layer[] }) | null {
  const m = o.m ?? music(store);
  if (!m) return null;
  const mode = o.mode ?? 'beats';
  const layerList = syncLayers(store, o.ids);
  const events = motionEvents(store, layerList);
  const period = beatPeriod(m), bar = period * m.a.meter;
  const maxShift = mode === 'beats' ? period * 0.55 : mode === 'accents' ? period * 1.1 : mode === 'bars' ? bar * 0.55 : bar;
  const chain = assignAnchors(events, syncTargets(m, mode), { maxShift, minGap: 1 / store.comp.fps, minRatio: mode === 'beats' ? 0.6 : 0.5, maxRatio: mode === 'beats' ? 1.7 : 2.2 });
  const anchors = chain.map(c => ({ from: events[c.e].t, to: c.target.t, kind: events[c.e].kind, target: c.target.label }));
  return { anchors, keys: 0, layers: layerList.length, warp: makeWarp(anchors), events, layerList };
}

/** retime the animation to the music: one undo step. returns null without music or animation */
export function syncToMusic(store: Store, o: { ids?: string[]; mode?: SyncMode; label?: string } = {}): SyncResult | null {
  const plan = planSync(store, o);
  if (!plan || !plan.anchors.length) return plan ? { anchors: [], keys: 0, layers: plan.layers, warp: plan.warp } : null;
  let keys = 0;
  store.transact(o.label ?? 'Sync to music', tx => {
    keys = warpLayers(tx, plan.layerList, plan.warp);
    // the comp keeps covering the animation
    let end = 0;
    for (const l of plan.layerList) for (const k of PROP_KEYS) for (const f of l.props[k]?.kf ?? []) end = Math.max(end, f.t);
    if (end > store.comp.duration) { tx.set(store.comp, 'duration', Math.ceil(end * store.comp.fps) / store.comp.fps); tx.comp(); }
    refollowSfx(store, tx);
  });
  return { anchors: plan.anchors, keys, layers: plan.layers, warp: plan.warp };
}

// ---------------------------------------------------------------- patterns of musical times

export type BeatPattern = 'beat' | 'half-bar' | 'bar' | 'two-bars' | 'accents' | 'build';

/** times (comp) of a pattern within [from, to] */
export function patternTimes(m: Music, pattern: BeatPattern, from = -Infinity, to = Infinity, count = Infinity): number[] {
  const bt = beats(m), br = bars(m), within = (t: number) => t >= from - 1e-6 && t <= to + 1e-6;
  let out: number[];
  switch (pattern) {
    case 'beat': out = bt; break;
    case 'half-bar': { const step = Math.max(1, Math.round(m.a.meter / 2)); const b0 = bt.findIndex(t => Math.abs(t - (br[0] ?? t)) < 1e-6); out = bt.filter((_, i) => ((i - Math.max(0, b0)) % step + step) % step === 0); break; }
    case 'bar': out = br; break;
    case 'two-bars': out = br.filter((_, i) => i % 2 === 0); break;
    case 'accents': out = accents(m).map(a => a.t); break;
    case 'build': {
      // build-up acceleration toward `to` (or the next drop): bars, then beats, then half beats
      const drop = isFinite(to) ? to : (sections(m).find(s => s.label === 'drop')?.t0 ?? m.to);
      const p = beatPeriod(m), bar = p * m.a.meter;
      const t: number[] = [];
      let x = drop, step = p / 2;
      const n = isFinite(count) ? count : 16;
      // walk back from the drop: 4 half-beats, 4 beats, then bars
      for (let i = 0; i < n && x - step >= from - 1e-6; i++) { x -= step; t.push(x); if (i === 3) step = p; if (i === 7) step = bar; }
      out = t.reverse().map(v => { const near = bt.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), v); return Math.abs(near - v) < 0.02 ? near : v; });
      return out.filter(within).slice(0, n);
    }
  }
  return out.filter(within).slice(0, count);
}

/** markers on pattern times (replacing earlier markers named like these) */
export function markersOnBeats(store: Store, times: number[], label: string, replace = true) {
  store.transact('Markers on beats', tx => {
    const keep = replace ? (store.comp.markers ?? []).filter(m => !/^(beat|bar|accent|build|drop)\b/i.test(m.label)) : (store.comp.markers ?? []);
    const add: Marker[] = times.map((t, i) => ({ id: uid('m'), t: Math.round(t * 1e4) / 1e4, label: `${label} ${i + 1}` }));
    tx.set(store.comp, 'markers', [...keep, ...add].sort((a, b) => a.t - b.t));
    tx.comp();
  });
  store.emit('markers');
}

/** start each layer's animation (rigidly shifted) on successive pattern times */
export function distributeOnBeats(store: Store, layerIds: string[], times: number[], anchor: 'start' | 'land' = 'start'): { id: string; t: number }[] {
  const out: { id: string; t: number }[] = [];
  store.transact('Entrances on beats', tx => {
    layerIds.forEach((id, i) => {
      const l = store.layer(id);
      if (!l || i >= times.length) return;
      const list = syncLayers(store, [id]);
      let a = Infinity, firstLand = Infinity;
      for (const x of list) for (const k of PROP_KEYS) { const kf = x.props[k]?.kf; if (kf?.length) { a = Math.min(a, kf[0].t); if (kf.length > 1) firstLand = Math.min(firstLand, kf[1].t); } }
      for (const x of list) if (x.textAnim) a = Math.min(a, x.inPoint + x.textAnim.start);
      if (!isFinite(a)) return;
      const ref = anchor === 'land' && isFinite(firstLand) ? firstLand : a;
      let d = times[i] - ref;
      if (a + d < 0) d = -a;
      warpLayers(tx, list, t => t + d);
      out.push({ id, t: times[i] });
    });
    refollowSfx(store, tx);
  });
  return out;
}

/** comp lengths that suit the music: the whole song, or the next 4-bar phrase / bar end */
export function musicalLengths(m: Music, current: number): { full: number; phrase: number | null; bar: number | null } {
  const br = bars(m), bar = beatPeriod(m) * m.a.meter;
  const ends = br.map(t => t + bar);
  const full = Math.min(m.to, m.start + m.a.lastSound + 0.05);
  const bar1 = ends.find(t => t >= current - 1e-3) ?? null;
  const phrase = br.length ? ends.filter((_, i) => (i + 1) % 4 === 0).find(t => t >= current - 1e-3) ?? null : null;
  return { full, phrase, bar: bar1 };
}
