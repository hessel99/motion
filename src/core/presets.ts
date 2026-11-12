// one-click animation presets + alignment helpers (shared by inspector, menus and agent tools)

import type { Store } from './store';
import { setPropTx, valueAt } from './commands';
import { defaultEase, type Keyframe, type PropKey } from './model';
import { EASE_PRESETS } from './easing';

export interface AnimPreset {
  name: string;
  kind: 'in' | 'out' | 'loop';
  /** keyframes relative to the layer's current values: f(current) -> [time offset, value][] per prop */
  build: (cur: Record<PropKey, number[]>, d: number) => Partial<Record<PropKey, { t: number; v: number[]; ease?: string; spring?: number }[]>>;
}

const ease = (name: string) => EASE_PRESETS.find(p => p.name === name)!.v;

export const ANIM_PRESETS: AnimPreset[] = [
  { name: 'Fade in', kind: 'in', build: (c, d) => ({ opacity: [{ t: 0, v: [0], ease: 'Ease Out' }, { t: d, v: c.opacity }] }) },
  { name: 'Slide up', kind: 'in', build: (c, d) => ({
    position: [{ t: 0, v: [c.position[0], c.position[1] + 80], ease: 'Expo Out' }, { t: d, v: c.position }],
    opacity: [{ t: 0, v: [0], ease: 'Ease Out' }, { t: d * 0.6, v: c.opacity }],
  }) },
  { name: 'Slide in left', kind: 'in', build: (c, d) => ({
    position: [{ t: 0, v: [c.position[0] - 160, c.position[1]], ease: 'Expo Out' }, { t: d, v: c.position }],
    opacity: [{ t: 0, v: [0], ease: 'Ease Out' }, { t: d * 0.6, v: c.opacity }],
  }) },
  { name: 'Pop', kind: 'in', build: (c, d) => ({
    scale: [{ t: 0, v: [0, 0], spring: 0.45 }, { t: d * 1.4, v: c.scale }],
    opacity: [{ t: 0, v: [0], ease: 'Ease Out' }, { t: d * 0.3, v: c.opacity }],
  }) },
  { name: 'Zoom in', kind: 'in', build: (c, d) => ({
    scale: [{ t: 0, v: [c.scale[0] * 1.6, c.scale[1] * 1.6], ease: 'Expo Out' }, { t: d, v: c.scale }],
    opacity: [{ t: 0, v: [0], ease: 'Ease Out' }, { t: d * 0.5, v: c.opacity }],
  }) },
  { name: 'Spin in', kind: 'in', build: (c, d) => ({
    rotation: [{ t: 0, v: [c.rotation[0] - 180], ease: 'Back Out' }, { t: d, v: c.rotation }],
    scale: [{ t: 0, v: [0, 0], ease: 'Back Out' }, { t: d, v: c.scale }],
  }) },
  { name: 'Fade out', kind: 'out', build: (c, d) => ({ opacity: [{ t: -d, v: c.opacity, ease: 'Ease In' }, { t: 0, v: [0] }] }) },
  { name: 'Slide down out', kind: 'out', build: (c, d) => ({
    position: [{ t: -d, v: c.position, ease: 'Expo In' }, { t: 0, v: [c.position[0], c.position[1] + 80] }],
    opacity: [{ t: -d * 0.5, v: c.opacity, ease: 'Ease In' }, { t: 0, v: [0] }],
  }) },
  { name: 'Shrink out', kind: 'out', build: (c, d) => ({ scale: [{ t: -d, v: c.scale, ease: 'Back In' }, { t: 0, v: [0, 0] }] }) },
  { name: 'Pulse', kind: 'loop', build: (c, d) => ({
    scale: [{ t: 0, v: c.scale, ease: 'Sine In Out' }, { t: d / 2, v: [c.scale[0] * 1.1, c.scale[1] * 1.1], ease: 'Sine In Out' }, { t: d, v: c.scale }],
  }) },
  { name: 'Wiggle rotate', kind: 'loop', build: (c, d) => ({
    rotation: [0, 0.25, 0.5, 0.75, 1].map((f, i) => ({ t: d * f, v: [c.rotation[0] + (i % 2 ? (i === 1 ? 8 : -8) : 0)], ease: 'Sine In Out' })),
  }) },
];

/**
 * apply a preset to layers at the playhead. "in" presets end at the playhead+duration (start at playhead),
 * "out" presets end at the playhead. stagger offsets each layer (selection order).
 */
export function applyPreset(store: Store, ids: string[], presetName: string, opts: { duration?: number; stagger?: number } = {}) {
  const preset = ANIM_PRESETS.find(p => p.name.toLowerCase() === presetName.toLowerCase());
  if (!preset) throw new Error(`unknown preset "${presetName}". presets: ${ANIM_PRESETS.map(p => p.name).join(', ')}`);
  const d = opts.duration ?? 0.6;
  const stagger = opts.stagger ?? 0;
  const t0 = store.time;
  store.transact(`Preset: ${preset.name}`, tx => {
    ids.forEach((id, n) => {
      const l = store.layer(id);
      if (!l) return;
      const base = t0 + n * stagger;
      const cur = {} as Record<PropKey, number[]>;
      for (const k of ['position', 'scale', 'rotation', 'opacity', 'anchor'] as PropKey[]) cur[k] = valueAt(l, k, base);
      const tracks = preset.build(cur, d);
      for (const [key, frames] of Object.entries(tracks) as [PropKey, { t: number; v: number[]; ease?: string; spring?: number }[]][]) {
        let p = l.props[key];
        if (!p) { p = { v: cur[key].slice() }; tx.set(l.props, key, p); }
        // keep the whole preset window after 0 (e.g. "out" presets with the playhead at the start)
        const shift = Math.max(0, -(base + Math.min(...frames.map(f => f.t))));
        const incoming: Keyframe[] = frames.map(f => {
          const e = f.ease ? ease(f.ease) : null;
          const k: Keyframe = { t: base + f.t + shift, v: f.v.slice(), ...defaultEase() };
          if (f.spring !== undefined) { k.interp = 'spring'; k.bounce = f.spring; }
          else if (e) { k.out = [e[0], e[1]]; }
          return k;
        });
        // the arriving handle of each key comes from the previous key's ease
        frames.forEach((f, i) => { if (i > 0) { const pe = frames[i - 1].ease ? ease(frames[i - 1].ease!) : null; if (pe) incoming[i].in = [pe[2], pe[3]]; } });
        const rest = (p.kf ?? []).filter(k => !incoming.some(n2 => Math.abs(n2.t - k.t) < 1e-6) && (k.t < incoming[0].t - 1e-6 || k.t > incoming[incoming.length - 1].t + 1e-6));
        tx.set(p, 'kf', [...rest, ...incoming].sort((a, b) => a.t - b.t));
      }
      tx.touch(id);
    });
  });
  void setPropTx;
}

// ---------------- align / distribute ----------------

export type Align = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/**
 * align layers by their comp-space bounds. one layer aligns to the composition, several align to their
 * common bounds. bounds come from the renderer (rotation aware); positions move in parent space.
 */
export function alignLayers(store: Store, ids: string[], how: Align, bounds: (id: string) => number[] | null, parentInv: (id: string) => number[]) {
  const boxes = ids.map(id => ({ id, b: bounds(id) })).filter(x => x.b) as { id: string; b: number[] }[];
  if (!boxes.length) return;
  const comp = store.comp;
  const all = boxes.length === 1 ? [0, 0, comp.width, comp.height] : [Math.min(...boxes.map(x => x.b[0])), Math.min(...boxes.map(x => x.b[1])), Math.max(...boxes.map(x => x.b[2])), Math.max(...boxes.map(x => x.b[3]))];
  store.transact('Align', tx => {
    for (const { id, b } of boxes) {
      let dx = 0, dy = 0;
      if (how === 'left') dx = all[0] - b[0];
      if (how === 'right') dx = all[2] - b[2];
      if (how === 'hcenter') dx = (all[0] + all[2]) / 2 - (b[0] + b[2]) / 2;
      if (how === 'top') dy = all[1] - b[1];
      if (how === 'bottom') dy = all[3] - b[3];
      if (how === 'vcenter') dy = (all[1] + all[3]) / 2 - (b[1] + b[3]) / 2;
      const inv = parentInv(id);
      const l = store.layer(id)!;
      const p = valueAt(l, 'position', store.time);
      setPropTx(tx, l, 'position', [p[0] + inv[0] * dx + inv[2] * dy, p[1] + inv[1] * dx + inv[3] * dy], store.time);
    }
  });
}

export function distributeLayers(store: Store, ids: string[], axis: 'x' | 'y', bounds: (id: string) => number[] | null, parentInv: (id: string) => number[]) {
  const boxes = ids.map(id => ({ id, b: bounds(id) })).filter(x => x.b) as { id: string; b: number[] }[];
  if (boxes.length < 3) return;
  const a0 = axis === 'x' ? 0 : 1, a1 = axis === 'x' ? 2 : 3;
  boxes.sort((p, q) => p.b[a0] - q.b[a0]);
  const total = boxes.reduce((s, x) => s + (x.b[a1] - x.b[a0]), 0);
  const span = boxes[boxes.length - 1].b[a1] - boxes[0].b[a0];
  const gap = (span - total) / (boxes.length - 1);
  let cursor = boxes[0].b[a0];
  store.transact('Distribute', tx => {
    for (const { id, b } of boxes) {
      const d = cursor - b[a0];
      cursor += b[a1] - b[a0] + gap;
      const inv = parentInv(id);
      const l = store.layer(id)!;
      const p = valueAt(l, 'position', store.time);
      const dx = axis === 'x' ? d : 0, dy = axis === 'y' ? d : 0;
      setPropTx(tx, l, 'position', [p[0] + inv[0] * dx + inv[2] * dy, p[1] + inv[1] * dx + inv[3] * dy], store.time);
    }
  });
}

// ---------------- text animation presets ----------------
import type { TextAnim } from './model';

export const TEXT_ANIM_PRESETS: { name: string; anim: Omit<TextAnim, 'start'> }[] = [
  { name: 'Fade up', anim: { by: 'word', duration: 0.6, stagger: 0.08, ease: 'Expo Out', mode: 'in', from: { opacity: 0, dx: 0, dy: 40, scale: 100, rotation: 0 } } },
  { name: 'Typewriter', anim: { by: 'char', duration: 0.01, stagger: 0.05, ease: 'Linear', mode: 'in', from: { opacity: 0, dx: 0, dy: 0, scale: 100, rotation: 0 } } },
  { name: 'Pop letters', anim: { by: 'char', duration: 0.5, stagger: 0.03, ease: 'spring:0.5', mode: 'in', from: { opacity: 0, dx: 0, dy: 0, scale: 0, rotation: 0 } } },
  { name: 'Slide words', anim: { by: 'word', duration: 0.7, stagger: 0.1, ease: 'Expo Out', mode: 'in', from: { opacity: 0, dx: -60, dy: 0, scale: 100, rotation: 0 } } },
  { name: 'Drop lines', anim: { by: 'line', duration: 0.8, stagger: 0.15, ease: 'Back Out', mode: 'in', from: { opacity: 0, dx: 0, dy: -60, scale: 100, rotation: 0 } } },
  { name: 'Spin letters', anim: { by: 'char', duration: 0.6, stagger: 0.04, ease: 'Back Out', mode: 'in', from: { opacity: 0, dx: 0, dy: 20, scale: 60, rotation: -90 } } },
  { name: 'Center burst', anim: { by: 'char', duration: 0.5, stagger: 0.04, ease: 'Expo Out', mode: 'in', order: 'center', from: { opacity: 0, dx: 0, dy: 0, scale: 220, rotation: 0 } } },
  { name: 'Fade out words', anim: { by: 'word', duration: 0.4, stagger: 0.06, ease: 'Ease In', mode: 'out', from: { opacity: 0, dx: 0, dy: -30, scale: 100, rotation: 0 } } },
];

export function setTextAnim(store: Store, ids: string[], anim: TextAnim | undefined, mergeKey?: string) {
  store.transact(anim ? 'Text animation' : 'Remove text animation', tx => {
    for (const id of ids) {
      const l = store.layer(id);
      if (!l || l.type !== 'text') continue;
      tx.set(l, 'textAnim', anim ? structuredClone(anim) : undefined);
      tx.touch(id);
    }
  }, mergeKey);
}
