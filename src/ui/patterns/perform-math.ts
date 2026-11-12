// gesture recording -> clean keyframes.
// a performed motion is a dense list of (t, x, y) samples. we keep the few samples that matter
// (Ramer-Douglas-Peucker in space-time, so stops and speed changes survive, jitter doesn't),
// give each key smooth spatial tangents (Catmull-Rom), and fit each segment's temporal ease to
// how the hand actually moved along it (progress over time -> cubic bezier). result: a handful
// of keys a motion designer would have set by hand, with the timing of a real gesture.

import type { Keyframe } from '../../core/model';
import { bezierY, type Bez } from './feel';

export interface Sample { t: number; x: number; y: number }

/** indices of the samples to keep. timeScale converts seconds to px so time counts as distance */
export function simplify(s: Sample[], tol: number, timeScale: number): number[] {
  if (s.length <= 2) return s.map((_, i) => i);
  const keep = new Uint8Array(s.length);
  keep[0] = keep[s.length - 1] = 1;
  const stack: [number, number][] = [[0, s.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = s[a], B = s[b];
    const dx = B.x - A.x, dy = B.y - A.y, dt = (B.t - A.t) * timeScale;
    const L2 = dx * dx + dy * dy + dt * dt;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const P = s[i];
      const px = P.x - A.x, py = P.y - A.y, pt = (P.t - A.t) * timeScale;
      const u = L2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy + pt * dt) / L2)) : 0;
      const ex = px - u * dx, ey = py - u * dy, et = pt - u * dt;
      const d = Math.sqrt(ex * ex + ey * ey + et * et);
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) if (keep[i]) out.push(i);
  return out;
}

/** least-squares cubic bezier ease through target progress samples y(x_i), x_i = (i+.5)/n */
export function fitBezier(target: ArrayLike<number>): Bez {
  const n = target.length;
  const v: Bez = [1 / 3, 1 / 3, 2 / 3, 2 / 3];
  const err = () => { let d = 0; for (let i = 0; i < n; i++) { const e = bezierY(v, (i + 0.5) / n) - target[i]; d += e * e; } return d; };
  let bd = err();
  const lo = [0, -1, 0, -1], hi = [1, 2, 1, 2];
  for (let step = 0.2; step > 0.003; step /= 2) {
    let improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let j = 0; j < 4; j++) for (const sgn of [-1, 1]) {
        const prev = v[j];
        v[j] = Math.min(hi[j], Math.max(lo[j], prev + sgn * step));
        const d = err();
        if (d < bd - 1e-10) { bd = d; improved = true; } else v[j] = prev;
      }
    }
  }
  return v.map(x => Math.round(x * 1000) / 1000) as Bez;
}

export interface BuildOpts { fps: number; tol?: number; minGap?: number }

const N = 16;
const target = new Float64Array(N);
/** fit the temporal ease of samples a..b (progress along the drawn path over time).
 *  returns the ease, the worst miss in px and the sample where it happens */
function fitSegment(s: Sample[], a: number, b: number): { v: Bez | null; err: number; at: number } {
  const cum: number[] = [0];
  for (let i = a + 1; i <= b; i++) cum.push(cum[cum.length - 1] + Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y));
  const total = cum[cum.length - 1], T0 = s[a].t, T1 = s[b].t;
  if (total < 0.5 || T1 - T0 < 1e-6) return { v: null, err: 0, at: -1 };
  let j = a;
  for (let n = 0; n < N; n++) {
    const tt = T0 + ((n + 0.5) / N) * (T1 - T0);
    while (j < b - 1 && s[j + 1].t < tt) j++;
    const u = (tt - s[j].t) / ((s[j + 1].t - s[j].t) || 1);
    target[n] = (cum[j - a] + (cum[j + 1 - a] - cum[j - a]) * Math.max(0, Math.min(1, u))) / total;
  }
  const v = fitBezier(target);
  let err = 0, at = -1;
  for (let i = a + 1; i < b; i++) {
    const e = Math.abs(bezierY(v, (s[i].t - T0) / (T1 - T0)) - cum[i - a] / total) * total;
    if (e > err) { err = e; at = i; }
  }
  return { v, err, at };
}

/** turn a performance into position keyframes (values in the samples' space) */
/** drop the still parts at both ends of a recording: the pickup lag before the hand starts
 *  moving (times are re-based so the motion starts at 0) and the hold before the release.
 *  `eps`: how far the pointer may drift and still count as still */
export function trimStill(s: Sample[], eps: number): Sample[] {
  if (s.length < 3) return s;
  const far = (a: Sample, b: Sample) => Math.hypot(a.x - b.x, a.y - b.y) > eps;
  let i = 0;
  while (i < s.length - 1 && !far(s[i + 1], s[0])) i++;
  let j = s.length - 1;
  while (j > i && !far(s[j - 1], s[s.length - 1])) j--;
  if (j <= i) return [s[0]]; // never moved
  const t0 = s[i].t;
  return s.slice(i, j + 1).map(p => ({ t: p.t - t0, x: p.x, y: p.y }));
}

export function buildKeys(s: Sample[], o: BuildOpts): Keyframe[] {
  if (!s.length) return [];
  const frame = 1 / o.fps, tol = o.tol ?? 10, gap = o.minGap ?? 3 * frame;
  // a still hand reports the same pointer position, so "still" means no movement at all (any
  // threshold would also eat the slow start of a genuinely eased gesture)
  s = trimStill(s, 1e-6);
  // 1. where the path bends (space only: catmull-rom tangents carry the curvature)
  const base = simplify(s, tol * 2.5, 0);
  // 2. where the timing changes more than one bezier ease can express (stops, sudden pushes)
  const idx: number[] = [];
  const refine = (a: number, b: number, depth: number) => {
    const f = fitSegment(s, a, b);
    if (depth < 12 && f.err > tol && f.at > 0 && s[f.at].t - s[a].t >= gap && s[b].t - s[f.at].t >= gap) {
      refine(a, f.at, depth + 1); idx.push(f.at); refine(f.at, b, depth + 1);
    }
  };
  idx.push(base[0]);
  for (let k = 0; k < base.length - 1; k++) { refine(base[k], base[k + 1], 0); idx.push(base[k + 1]); }
  // 3. keys at least `gap` apart, always keep first + last
  const kept: number[] = [idx[0]];
  for (let n = 1; n < idx.length - 1; n++) if (s[idx[n]].t - s[kept[kept.length - 1]].t >= gap && s[idx[idx.length - 1]].t - s[idx[n]].t >= gap) kept.push(idx[n]);
  if (idx.length > 1) kept.push(idx[idx.length - 1]);
  const keys: Keyframe[] = kept.map(i => ({
    t: Math.round(s[i].t / frame) * frame, v: [s[i].x, s[i].y], interp: 'bezier', out: [1 / 3, 1 / 3], in: [2 / 3, 2 / 3],
  }));
  for (let k = keys.length - 1; k > 0; k--) if (keys[k].t - keys[k - 1].t < frame / 2) { keys.splice(k, 1); kept.splice(k, 1); }
  // spatial tangents: catmull-rom, a sixth of the neighbour chord on each side
  for (let k = 1; k < keys.length - 1; k++) {
    const p = keys[k - 1].v, q = keys[k + 1].v;
    const tx = (q[0] - p[0]) / 6, ty = (q[1] - p[1]) / 6;
    if (Math.hypot(tx, ty) > 0.5) { keys[k].sOut = [tx, ty]; keys[k].sIn = [-tx, -ty]; }
  }
  // 4. the temporal ease of each final segment
  for (let k = 0; k < keys.length - 1; k++) {
    const f = fitSegment(s, kept[k], kept[k + 1]);
    if (!f.v) { keys[k].interp = 'linear'; continue; }
    keys[k].out = [f.v[0], f.v[1]];
    keys[k + 1].in = [f.v[2], f.v[3]];
  }
  return keys;
}
