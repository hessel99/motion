// compiled keyframe tracks. this is the hot path during playback, so:
//  - all data lives in typed arrays
//  - the last used segment is cached (playback moves forward => O(1) lookup)
//  - no allocation per evaluation (results are written into a caller supplied array)

import { cubicBezier, type Ease } from './easing';
import type { Keyframe, Prop } from './model';

const INTERP_BEZIER = 0, INTERP_LINEAR = 1, INTERP_HOLD = 2;
const ARC_SAMPLES = 32;

interface SpatialSeg {
  // cubic control points, flattened [p0x,p0y,p1x,p1y,p2x,p2y,p3x,p3y]
  cp: Float64Array;
  // cumulative arc length at ARC_SAMPLES+1 sample params (normalized 0..1)
  arc: Float64Array;
}

export class Track {
  readonly n: number;
  readonly dim: number;
  readonly times: Float64Array;
  readonly vals: Float64Array;
  readonly interps: Uint8Array;
  readonly eases: (Ease | null)[];
  readonly spatial: (SpatialSeg | null)[] | null;
  private last = 0;

  constructor(prop: Prop, dim: number, spatial = false) {
    const kf = prop.kf && prop.kf.length ? prop.kf : null;
    if (!kf) {
      this.n = 1;
      this.dim = dim;
      this.times = new Float64Array([0]);
      this.vals = new Float64Array(dim);
      for (let d = 0; d < dim; d++) this.vals[d] = prop.v[d] ?? 0;
      this.interps = new Uint8Array(1);
      this.eases = [null];
      this.spatial = null;
      return;
    }
    const n = kf.length;
    this.n = n;
    this.dim = dim;
    this.times = new Float64Array(n);
    this.vals = new Float64Array(n * dim);
    this.interps = new Uint8Array(n);
    this.eases = new Array(n);
    let hasSpatial = false;
    for (let i = 0; i < n; i++) {
      const k = kf[i];
      this.times[i] = k.t;
      for (let d = 0; d < dim; d++) this.vals[i * dim + d] = k.v[d] ?? 0;
      this.interps[i] = k.interp === 'hold' ? INTERP_HOLD : k.interp === 'linear' ? INTERP_LINEAR : INTERP_BEZIER;
      if (i < n - 1) {
        const nx = kf[i + 1];
        this.eases[i] = this.interps[i] === INTERP_BEZIER ? cubicBezier(k.out[0], k.out[1], nx.in[0], nx.in[1]) : null;
        if (spatial && dim === 2 && (nonZero(k.sOut) || nonZero(nx.sIn))) hasSpatial = true;
      } else this.eases[i] = null;
    }
    this.spatial = hasSpatial ? buildSpatial(kf) : null;
  }

  get animated() { return this.n > 1; }

  /** writes the value at time t into out[off..off+dim] */
  eval(t: number, out: Float64Array | number[], off = 0): void {
    const n = this.n, dim = this.dim, times = this.times, vals = this.vals;
    if (n === 1 || t <= times[0]) {
      for (let d = 0; d < dim; d++) out[off + d] = vals[d];
      return;
    }
    if (t >= times[n - 1]) {
      const b = (n - 1) * dim;
      for (let d = 0; d < dim; d++) out[off + d] = vals[b + d];
      return;
    }
    // find segment i with times[i] <= t < times[i+1], starting from the cached one
    let i = this.last;
    if (i >= n - 1 || times[i] > t) {
      if (i > 0 && times[i - 1] <= t && t < times[i]) i = i - 1;
      else i = bsearch(times, t);
    } else if (t >= times[i + 1]) {
      if (i + 2 < n && t < times[i + 2]) i = i + 1;
      else i = bsearch(times, t);
    }
    this.last = i;
    const a = i * dim;
    const interp = this.interps[i];
    if (interp === INTERP_HOLD) {
      for (let d = 0; d < dim; d++) out[off + d] = vals[a + d];
      return;
    }
    const t0 = times[i], t1 = times[i + 1];
    let p = (t - t0) / (t1 - t0);
    if (interp === INTERP_BEZIER) p = this.eases[i]!(p);
    const sp = this.spatial ? this.spatial[i] : null;
    if (sp) {
      evalSpatial(sp, p, out, off);
      return;
    }
    const b = a + dim;
    for (let d = 0; d < dim; d++) out[off + d] = vals[a + d] + (vals[b + d] - vals[a + d]) * p;
  }

  /** scalar convenience (allocates nothing) */
  eval1(t: number): number {
    this.eval(t, scratch, 0);
    return scratch[0];
  }
}

const scratch = new Float64Array(16);

function nonZero(v?: number[]) {
  return !!v && (v[0] !== 0 || v[1] !== 0);
}

function bsearch(times: Float64Array, t: number): number {
  let lo = 0, hi = times.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function buildSpatial(kf: Keyframe[]): (SpatialSeg | null)[] {
  const segs: (SpatialSeg | null)[] = [];
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i], b = kf[i + 1];
    const so = a.sOut ?? [0, 0], si = b.sIn ?? [0, 0];
    if (!nonZero(so) && !nonZero(si)) { segs.push(null); continue; }
    const cp = new Float64Array([
      a.v[0], a.v[1],
      a.v[0] + so[0], a.v[1] + so[1],
      b.v[0] + si[0], b.v[1] + si[1],
      b.v[0], b.v[1],
    ]);
    const arc = new Float64Array(ARC_SAMPLES + 1);
    let px = cp[0], py = cp[1], len = 0;
    const o = [0, 0];
    for (let s = 1; s <= ARC_SAMPLES; s++) {
      cubicAt(cp, s / ARC_SAMPLES, o, 0);
      len += Math.hypot(o[0] - px, o[1] - py);
      arc[s] = len;
      px = o[0]; py = o[1];
    }
    if (len > 0) for (let s = 0; s <= ARC_SAMPLES; s++) arc[s] /= len;
    segs.push({ cp, arc });
  }
  return segs;
}

function cubicAt(cp: Float64Array, s: number, out: Float64Array | number[], off: number) {
  const u = 1 - s, uu = u * u, ss = s * s;
  const w0 = uu * u, w1 = 3 * uu * s, w2 = 3 * u * ss, w3 = ss * s;
  out[off] = w0 * cp[0] + w1 * cp[2] + w2 * cp[4] + w3 * cp[6];
  out[off + 1] = w0 * cp[1] + w1 * cp[3] + w2 * cp[5] + w3 * cp[7];
}

/** p = eased progress along the path (by arc length). overshoot extrapolates along end tangents. */
function evalSpatial(sp: SpatialSeg, p: number, out: Float64Array | number[], off: number) {
  const cp = sp.cp, arc = sp.arc;
  if (p <= 0 || p >= 1) {
    // linear extrapolation along the chord for overshooting eases
    const s = p <= 0 ? 0 : 1;
    cubicAt(cp, s, out, off);
    if (p !== s) {
      const dx = cp[6] - cp[0], dy = cp[7] - cp[1];
      out[off] += dx * (p - s);
      out[off + 1] += dy * (p - s);
    }
    return;
  }
  // arc-length lookup
  let lo = 0, hi = ARC_SAMPLES;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arc[mid] <= p) lo = mid; else hi = mid;
  }
  const seg = arc[hi] - arc[lo];
  const s = (lo + (seg > 0 ? (p - arc[lo]) / seg : 0)) / ARC_SAMPLES;
  cubicAt(cp, s, out, off);
}

/** one-off evaluation for ui code (compiles a temporary track) */
export function evalProp(prop: Prop | undefined, t: number, dim: number, fallback: readonly number[]): number[] {
  if (!prop) return fallback.slice();
  if (!prop.kf || prop.kf.length === 0) return prop.v.slice(0, dim);
  const tr = new Track(prop, dim, dim === 2);
  const out = new Array(dim).fill(0);
  tr.eval(t, out, 0);
  return out;
}
