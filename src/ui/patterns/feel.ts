// "feel" space: a perceptual 3-parameter description of a cubic-bezier ease.
//
//   attack    0..1  lazy (eases in, slow start) .. balanced .. punchy (fast start, eases out)
//   smooth    0..1  mechanical (linear) .. silky (expo-strength easing)
//   overshoot 0..1  none .. strong (anticipation on lazy curves, overshoot on punchy ones)
//
// the mapping is a blend of well known curves, so every point of the feel pad is a curve a
// motion designer already knows: (attack, smooth) = (0,1) is Expo In, (0.5,1) Expo In Out,
// (1,1) Expo Out, smooth = 0 is linear. overshoot pushes the handles past 0 / 1 the same way
// Back In / Back Out / Back In Out do. pure functions, no allocation in the hot path except
// the returned tuple.

export interface Feel { attack: number; smooth: number; overshoot: number }
export type Bez = [number, number, number, number];

const LIN: Bez = [1 / 3, 1 / 3, 2 / 3, 2 / 3];
const EXPO_IN: Bez = [0.7, 0, 0.84, 0];
const EXPO_IO: Bez = [0.87, 0, 0.13, 1];
const EXPO_OUT: Bez = [0.16, 1, 0.3, 1];
/** how far overshoot pushes the handles past the 0..1 band at overshoot = 1 */
const ANTICIPATION = 0.6;
const OVERSHOOT = 0.9;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function feelToBezier(f: Feel, out: Bez = [0, 0, 0, 0]): Bez {
  const a = clamp01(f.attack), k = clamp01(f.smooth), o = clamp01(f.overshoot);
  const lo = a < 0.5 ? EXPO_IN : EXPO_IO, hi = a < 0.5 ? EXPO_IO : EXPO_OUT;
  const u = a < 0.5 ? a * 2 : (a - 0.5) * 2;
  for (let i = 0; i < 4; i++) {
    const base = lo[i] + (hi[i] - lo[i]) * u;
    out[i] = LIN[i] + (base - LIN[i]) * k;
  }
  out[1] -= ANTICIPATION * o * (1 - a);
  out[3] += OVERSHOOT * o * a;
  for (let i = 0; i < 4; i++) out[i] = r3(out[i]);
  return out;
}

// curves are compared by what they do (progress sampled over time), not by their handles:
// different handle layouts can produce the same motion (Back Out overshoots through y1, the
// feel family through y2)
const NS = 16;
const tmp: Bez = [0, 0, 0, 0];
const target = new Float64Array(NS);
let table: Float32Array | null = null; // lazily built grid of sampled feel curves
const GA = 20, GK = 20, GO = 10;
function sampleInto(v: Bez | number[], out: Float32Array | Float64Array, off: number) {
  for (let i = 0; i < NS; i++) out[off + i] = bezierY(v, (i + 0.5) / NS);
}
function dist(f: Feel) {
  feelToBezier(f, tmp);
  let d = 0;
  for (let i = 0; i < NS; i++) { const e = bezierY(tmp, (i + 0.5) / NS) - target[i]; d += e * e; }
  return d;
}

/** nearest feel for any bezier: grid search over sampled curves + coordinate refinement.
 *  curves outside the family land on the closest feel. */
export function bezierToFeel(v: Bez): Feel {
  // linear in any parametrisation: put it in the middle of the bottom edge
  if (Math.abs(v[0] - v[1]) < 1e-6 && Math.abs(v[2] - v[3]) < 1e-6) return { attack: 0.5, smooth: 0, overshoot: 0 };
  sampleInto(v, target, 0);
  const f: Feel = { attack: 0, smooth: 0, overshoot: 0 };
  if (!table) {
    table = new Float32Array((GA + 1) * (GK + 1) * (GO + 1) * NS);
    let off = 0;
    for (let ai = 0; ai <= GA; ai++) for (let ki = 0; ki <= GK; ki++) for (let oi = 0; oi <= GO; oi++, off += NS) {
      f.attack = ai / GA; f.smooth = ki / GK; f.overshoot = oi / GO;
      sampleInto(feelToBezier(f, tmp), table, off);
    }
  }
  const best: Feel = { attack: 0.5, smooth: 0.5, overshoot: 0 };
  let bd = Infinity, off = 0;
  for (let ai = 0; ai <= GA; ai++) for (let ki = 0; ki <= GK; ki++) for (let oi = 0; oi <= GO; oi++, off += NS) {
    let d = 0;
    for (let i = 0; i < NS && d < bd; i++) { const e = table[off + i] - target[i]; d += e * e; }
    if (d < bd) { bd = d; best.attack = ai / GA; best.smooth = ki / GK; best.overshoot = oi / GO; }
  }
  for (let step = 0.025; step > 0.002; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const key of ['attack', 'smooth', 'overshoot'] as const) {
        for (const s of [-step, step]) {
          const prev = best[key];
          best[key] = clamp01(prev + s);
          const d = dist(best);
          if (d < bd - 1e-12) { bd = d; improved = true; } else best[key] = prev;
        }
      }
    }
  }
  return best;
}

/** a short human name for a feel (shown under the pad) */
export function feelName(f: Feel): string {
  if (f.smooth < 0.12 && f.overshoot < 0.1) return 'Linear';
  const side = f.attack < 0.36 ? 'in' : f.attack > 0.64 ? 'out' : 'io';
  if (f.overshoot >= 0.25) return side === 'in' ? 'Wind-up' : side === 'out' ? 'Overshoot' : 'Elastic';
  const strong = f.smooth > 0.72;
  if (side === 'in') return strong ? 'Lazy' : 'Ease in';
  if (side === 'out') return strong ? 'Snappy' : 'Ease out';
  return strong ? 'Silky' : f.smooth < 0.4 ? 'Gentle' : 'Ease in out';
}

/** evaluate a bezier ease y(x) without caching (for drawing many different curves cheaply) */
export function bezierY(v: Bez | number[], x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const x1 = v[0], y1 = v[1], x2 = v[2], y2 = v[3];
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  // newton from s = x, bisection fallback
  let s = x;
  for (let n = 0; n < 6; n++) {
    const fx = ((ax * s + bx) * s + cx) * s - x;
    const d = (3 * ax * s + 2 * bx) * s + cx;
    if (Math.abs(fx) < 1e-6) return ((ay * s + by) * s + cy) * s;
    if (Math.abs(d) < 1e-6) break;
    s -= fx / d;
  }
  let lo = 0, hi = 1;
  s = x;
  for (let n = 0; n < 30; n++) {
    const fx = ((ax * s + bx) * s + cx) * s;
    if (Math.abs(fx - x) < 1e-6) break;
    if (fx < x) lo = s; else hi = s;
    s = (lo + hi) / 2;
  }
  return ((ay * s + by) * s + cy) * s;
}
