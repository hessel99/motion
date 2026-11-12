// timing math for the rhythm patterns (tempo "breath" dial, stagger + groove knobs, magnetic
// snapping). pure functions over keyframe arrays; the ui wraps them in undoable transactions.

import type { Keyframe, Layer, PathKey, PropKey } from '../../core/model';

/** start/end of all keyframes of a layer (props + path shape keys), null when not animated */
export function layerSpan(l: Layer): [number, number] | null {
  let a = Infinity, b = -Infinity;
  for (const k in l.props) {
    const kf = l.props[k as PropKey]?.kf;
    if (!kf?.length) continue;
    if (kf[0].t < a) a = kf[0].t;
    if (kf[kf.length - 1].t > b) b = kf[kf.length - 1].t;
  }
  if (l.pathKf?.length) { a = Math.min(a, l.pathKf[0].t); b = Math.max(b, l.pathKf[l.pathKf.length - 1].t); }
  return a <= b ? [a, b] : null;
}

/** scale key times around a pivot (factor > 0 keeps the order, so key indices stay valid) */
export function retime<K extends Keyframe | PathKey>(kf: K[], pivot: number, factor: number): K[] {
  return kf.map(k => ({ ...k, t: Math.max(0, pivot + (k.t - pivot) * factor) }));
}

export function shift<K extends Keyframe | PathKey>(kf: K[], dt: number): K[] {
  return kf.map(k => ({ ...k, t: Math.max(0, k.t + dt) }));
}

/** groove shape of a cascade: u in 0..1 (layer index / last), g in -1..1.
 *  g > 0: the cascade starts fast and slows down (offsets bunch up at the end).
 *  g < 0: it starts slow and speeds up. g = 0: even spacing. */
export function grooveShape(u: number, g: number): number {
  const p = 1 + 2.5 * Math.abs(g);
  if (g > 0) return 1 - Math.pow(1 - u, p);
  if (g < 0) return Math.pow(u, p);
  return u;
}

/** start offsets for n layers: the last starts at stagger * (n - 1) */
export function staggerOffsets(n: number, stagger: number, groove = 0): number[] {
  const out: number[] = [];
  const total = stagger * Math.max(0, n - 1);
  for (let i = 0; i < n; i++) out.push(n < 2 ? 0 : total * grooveShape(i / (n - 1), groove));
  return out;
}

/** infer (stagger, groove) from layer start times sorted ascending */
export function detectStagger(starts: number[]): { stagger: number; groove: number } {
  const n = starts.length;
  if (n < 2) return { stagger: 0, groove: 0 };
  const total = starts[n - 1] - starts[0];
  const stagger = total / (n - 1);
  if (n < 3 || total < 1e-6) return { stagger, groove: 0 };
  let best = 0, bd = Infinity;
  for (let gi = -20; gi <= 20; gi++) {
    const g = gi / 20;
    let d = 0;
    for (let i = 0; i < n; i++) { const e = (starts[i] - starts[0]) / total - grooveShape(i / (n - 1), g); d += e * e; }
    if (d < bd - 1e-12) { bd = d; best = g; }
  }
  return { stagger, groove: best };
}

/** magnetic snap: nearest target within `radius`, else t unchanged */
export function snapTo(t: number, targets: readonly number[], radius: number): number {
  let best = t, bd = radius;
  for (const x of targets) { const d = Math.abs(x - t); if (d <= bd) { bd = d; best = x; } }
  return best;
}

export const roundToFrame = (t: number, fps: number) => Math.round(t * fps) / fps;
