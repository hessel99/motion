// key moments of a composition: keyframe times (+ markers) clustered into the beats a viewer
// perceives. used by the director storyboard and the score transport (prev / next key).
import { editor } from '../../app/editor';
import type { Layer } from '../../core/model';

function allLayers(ids: string[], out: Layer[] = []) {
  const s = editor.store;
  for (const id of ids) { const l = s.layer(id); if (l) { out.push(l); allLayers(l.children, out); } }
  return out;
}

/** sorted key + marker times of the selection (else of every layer in the comp) */
export function keyTimes(selectionOnly = true) {
  const s = editor.store;
  const layers = selectionOnly && s.selection.length ? allLayers(s.selection) : allLayers(s.comp.root);
  const times = new Set<number>();
  for (const l of layers) for (const p of Object.values(l.props)) p?.kf?.forEach(f => times.add(f.t));
  for (const m of s.comp.markers ?? []) if (m.t <= s.comp.duration) times.add(m.t);
  return [...times].sort((a, b) => a - b);
}

export function jumpKey(dir: -1 | 1) {
  const s = editor.store;
  const ts = keyTimes();
  const t = dir < 0 ? [...ts].reverse().find(x => x < s.time - 1e-6) : ts.find(x => x > s.time + 1e-6);
  if (t !== undefined) s.setTime(t);
}

export interface Moment {
  t: number;
  /** names of the layers that have a key at this moment (for the caption) */
  layers: string[];
  ids: string[];
  label?: string;
}

/** clustered key moments: the start, every settle / hit of the animation, markers (labelled) */
export function keyMoments(max = 10): Moment[] {
  const s = editor.store;
  const dur = s.comp.duration;
  const gap = Math.max(0.08, dur / 50);
  const hits: { t: number; name: string; id: string }[] = [];
  for (const l of allLayers(s.comp.root)) {
    for (const p of Object.values(l.props)) p?.kf?.forEach(f => { if (f.t >= 0 && f.t <= dur) hits.push({ t: f.t, name: l.name, id: l.id }); });
  }
  hits.sort((a, b) => a.t - b.t);
  const out: Moment[] = [{ t: 0, layers: [], ids: [] }];
  let start = 0;
  for (const h of hits) {
    const last = out[out.length - 1];
    // keys close together are one beat; the card shows where the beat lands (its last key).
    // a beat never spans more than 2 gaps, so a long run of keys is not swallowed whole
    if (h.t - last.t <= gap && h.t - start <= 2 * gap) { last.t = h.t; if (!last.ids.includes(h.id)) { last.ids.push(h.id); last.layers.push(h.name); } }
    else { out.push({ t: h.t, layers: [h.name], ids: [h.id] }); start = h.t; }
  }
  for (const m of s.comp.markers ?? []) {
    if (m.t > dur) continue;
    const near = out.find(o => Math.abs(o.t - m.t) <= gap);
    if (near) near.label = m.label || near.label; else out.push({ t: m.t, layers: [], ids: [], label: m.label || 'Marker' });
  }
  out.sort((a, b) => a.t - b.t);
  if (out[0].t > 0.05) out.unshift({ t: 0, layers: [], ids: [] });
  if (out.length <= max) return out;
  // too many: keep the start, the end and evenly spread moments
  const keep: Moment[] = [];
  for (let i = 0; i < max; i++) keep.push(out[Math.round((i * (out.length - 1)) / (max - 1))]);
  return keep;
}
