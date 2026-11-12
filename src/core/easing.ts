// cubic-bezier timing functions (same math as css cubic-bezier / lottie / after effects
// after conversion). x1,x2 are clamped to [0,1] so the curve is a function of time.
// solving uses a precomputed sample table + newton-raphson + bisection fallback.

const SAMPLES = 11;
const STEP = 1 / (SAMPLES - 1);

export interface Ease {
  (x: number): number;
  x1: number; y1: number; x2: number; y2: number;
}

const cache = new Map<string, Ease>();

export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
  x1 = Math.min(1, Math.max(0, x1));
  x2 = Math.min(1, Math.max(0, x2));
  const key = `${x1},${y1},${x2},${y2}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let f: Ease;
  if (x1 === y1 && x2 === y2) {
    f = ((x: number) => x) as Ease;
  } else {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (s: number) => ((ax * s + bx) * s + cx) * s;
    const sy = (s: number) => ((ay * s + by) * s + cy) * s;
    const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
    const table = new Float64Array(SAMPLES);
    for (let i = 0; i < SAMPLES; i++) table[i] = sx(i * STEP);

    const solve = (x: number) => {
      let i = 1;
      while (i < SAMPLES - 1 && table[i] <= x) i++;
      i--;
      const dist = (x - table[i]) / (table[i + 1] - table[i] || 1);
      let s = (i + dist) * STEP;
      const slope = dx(s);
      if (slope >= 0.001) {
        for (let n = 0; n < 4; n++) {
          const d = dx(s);
          if (d === 0) break;
          s -= (sx(s) - x) / d;
        }
        return s;
      }
      if (slope === 0) return s;
      let lo = i * STEP, hi = lo + STEP;
      for (let n = 0; n < 12; n++) {
        s = (lo + hi) / 2;
        const v = sx(s) - x;
        if (Math.abs(v) < 1e-7) break;
        if (v > 0) hi = s; else lo = s;
      }
      return s;
    };
    f = ((x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : sy(solve(x)))) as Ease;
  }
  f.x1 = x1; f.y1 = y1; f.x2 = x2; f.y2 = y2;
  cache.set(key, f);
  return f;
}

export interface EasePreset { name: string; v: [number, number, number, number]; group: string }

/** presets (css + common motion design curves). values = out handle (x1,y1) of first kf, in handle (x2,y2) of next kf */
export const EASE_PRESETS: EasePreset[] = [
  { group: 'basic', name: 'Linear', v: [0, 0, 1, 1] },
  { group: 'basic', name: 'Easy Ease', v: [0.333, 0, 0.667, 1] },
  { group: 'basic', name: 'Ease In', v: [0.42, 0, 1, 1] },
  { group: 'basic', name: 'Ease Out', v: [0, 0, 0.58, 1] },
  { group: 'basic', name: 'Ease In Out', v: [0.42, 0, 0.58, 1] },
  { group: 'sine', name: 'Sine In', v: [0.12, 0, 0.39, 0] },
  { group: 'sine', name: 'Sine Out', v: [0.61, 1, 0.88, 1] },
  { group: 'sine', name: 'Sine In Out', v: [0.37, 0, 0.63, 1] },
  { group: 'quad', name: 'Quad In', v: [0.11, 0, 0.5, 0] },
  { group: 'quad', name: 'Quad Out', v: [0.5, 1, 0.89, 1] },
  { group: 'quad', name: 'Quad In Out', v: [0.45, 0, 0.55, 1] },
  { group: 'cubic', name: 'Cubic In', v: [0.32, 0, 0.67, 0] },
  { group: 'cubic', name: 'Cubic Out', v: [0.33, 1, 0.68, 1] },
  { group: 'cubic', name: 'Cubic In Out', v: [0.65, 0, 0.35, 1] },
  { group: 'quart', name: 'Quart In', v: [0.5, 0, 0.75, 0] },
  { group: 'quart', name: 'Quart Out', v: [0.25, 1, 0.5, 1] },
  { group: 'quart', name: 'Quart In Out', v: [0.76, 0, 0.24, 1] },
  { group: 'expo', name: 'Expo In', v: [0.7, 0, 0.84, 0] },
  { group: 'expo', name: 'Expo Out', v: [0.16, 1, 0.3, 1] },
  { group: 'expo', name: 'Expo In Out', v: [0.87, 0, 0.13, 1] },
  { group: 'back', name: 'Back In', v: [0.36, 0, 0.66, -0.56] },
  { group: 'back', name: 'Back Out', v: [0.34, 1.56, 0.64, 1] },
  { group: 'back', name: 'Back In Out', v: [0.68, -0.6, 0.32, 1.6] },
  { group: 'motion', name: 'Snappy', v: [0.2, 0.9, 0.1, 1] },
  { group: 'motion', name: 'Gentle', v: [0.4, 0.1, 0.2, 1] },
];

/** convert after effects temporal ease (speed in units/sec, influence %) to normalized bezier handles.
 *  dv = value change across the segment (for multi-dim use the spatial distance), dt = seconds. */
export function aeEaseToBezier(outSpeed: number, outInfluence: number, inSpeed: number, inInfluence: number, dv: number, dt: number) {
  const x1 = Math.min(1, Math.max(0, outInfluence / 100));
  const x2 = 1 - Math.min(1, Math.max(0, inInfluence / 100));
  const avg = dt > 0 ? dv / dt : 0;
  let y1: number, y2: number;
  if (Math.abs(avg) < 1e-9) {
    y1 = 0; y2 = 1;
  } else {
    y1 = (outSpeed / avg) * x1;
    y2 = 1 - (inSpeed / avg) * (1 - x2);
  }
  return { x1, y1, x2, y2 };
}

/** inverse: normalized bezier handles to after effects speed/influence */
export function bezierToAeEase(x1: number, y1: number, x2: number, y2: number, dv: number, dt: number) {
  const avg = dt > 0 ? dv / dt : 0;
  return {
    outInfluence: x1 * 100,
    outSpeed: x1 > 0 ? (y1 / x1) * avg : 0,
    inInfluence: (1 - x2) * 100,
    inSpeed: 1 - x2 > 0 ? ((1 - y2) / (1 - x2)) * avg : 0,
  };
}

/** spring easing sampled to a function (used by presets that bake a spring into keyframes) */
export function springEase(stiffness = 170, damping = 26, mass = 1) {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  return (t: number, duration: number) => {
    const tt = t * duration;
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * w0 * tt) * (Math.cos(wd * tt) + ((zeta * w0) / wd) * Math.sin(wd * tt));
    }
    return 1 - Math.exp(-w0 * tt) * (1 + w0 * tt);
  };
}
