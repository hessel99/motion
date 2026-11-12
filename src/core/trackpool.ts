// all animated tracks of a scene packed into ONE contiguous Float64Array, laid out in
// evaluation order. playback walks memory linearly, which made evaluation ~3x faster than
// individual Track objects for big scenes (it was cache-miss bound, see bench/eval-bench.ts).
//
// per track record in `data` starting at offset o:
//   [n, dim, last, flags, times(n), values(n*dim), lut(n) (lut index or -1/-2), ...]
// lut index -1 = linear, -2 = hold. luts live in one shared Float32Array (deduplicated).
// tracks with spatial (curved motion path) tangents fall back to a Track object.

import { easeLUT, springLUT, EASE_LUT_N } from './easing';
import { Track } from './evaluate';
import type { Prop } from './model';

const STRIDE = EASE_LUT_N + 2;

export class TrackPool {
  data = new Float64Array(4096);
  used = 0;
  luts = new Float32Array(STRIDE * 16);
  private lutCount = 0;
  private lutIndex = new Map<Float32Array, number>();
  private fallback: Track[] = [];

  reset() {
    this.used = 0;
    this.fallback.length = 0;
  }

  private ensure(n: number) {
    if (this.used + n <= this.data.length) return;
    const next = new Float64Array(Math.max(this.data.length * 2, this.used + n + 1024));
    next.set(this.data.subarray(0, this.used));
    this.data = next;
  }

  // params -> lut index memo with a numeric hash: building string keys for every keyframe
  // (easeLUT's cache) was a large part of compiling big scenes
  private memo = new Map<number, number>();
  private memoParams: number[] = [];

  private lut(x1: number, y1: number, x2: number, y2: number, spring?: number): number {
    const sp = spring ?? -1;
    const hk = hash5(x1, y1, x2, y2, sp);
    const m = this.memo.get(hk);
    if (m !== undefined) {
      const P = this.memoParams, o = m * 5;
      if (P[o] === x1 && P[o + 1] === y1 && P[o + 2] === x2 && P[o + 3] === y2 && P[o + 4] === sp) return this.memoIndex[m];
    }
    const idx = this.lutSlow(x1, y1, x2, y2, spring);
    if (m === undefined) {
      this.memo.set(hk, this.memoIndex.length);
      this.memoIndex.push(idx);
      this.memoParams.push(x1, y1, x2, y2, sp);
    }
    return idx;
  }
  private memoIndex: number[] = [];

  private lutSlow(x1: number, y1: number, x2: number, y2: number, spring?: number): number {
    const t = spring !== undefined ? springLUT(spring) : easeLUT(x1, y1, x2, y2);
    let i = this.lutIndex.get(t);
    if (i !== undefined) return i;
    i = this.lutCount++;
    if ((i + 1) * STRIDE > this.luts.length) {
      const next = new Float32Array(this.luts.length * 2);
      next.set(this.luts);
      this.luts = next;
    }
    this.luts.set(t, i * STRIDE);
    this.lutIndex.set(t, i);
    return i;
  }

  /** returns a handle: >= 0 pool offset, < -1 fallback track (-(index+2)) */
  add(prop: Prop, dim: number, spatial: boolean): number {
    const kf = prop.kf!;
    const n = kf.length;
    if (spatial && dim === 2) {
      for (let i = 0; i < n; i++) {
        const k = kf[i];
        if ((k.sOut && (k.sOut[0] || k.sOut[1])) || (k.sIn && (k.sIn[0] || k.sIn[1]))) {
          this.fallback.push(new Track(prop, dim, true));
          return -(this.fallback.length - 1) - 2;
        }
      }
    }
    const size = 4 + n + n * dim + n;
    this.ensure(size);
    const D = this.data, o = this.used;
    D[o] = n; D[o + 1] = dim; D[o + 2] = 0; D[o + 3] = 0;
    const to = o + 4, vo = to + n, lo = vo + n * dim;
    for (let i = 0; i < n; i++) {
      const k = kf[i];
      D[to + i] = k.t;
      for (let d = 0; d < dim; d++) D[vo + i * dim + d] = k.v[d] ?? 0;
      if (i === n - 1) D[lo + i] = -1;
      else if (k.interp === 'hold') D[lo + i] = -2;
      else if (k.interp === 'linear') D[lo + i] = -1;
      else D[lo + i] = this.lut(k.out[0], k.out[1], kf[i + 1].in[0], kf[i + 1].in[1], k.interp === 'spring' ? k.bounce ?? 0.3 : undefined);
    }
    this.used += size;
    return o;
  }

  eval(h: number, t: number, out: Float64Array, off: number): void {
    if (h < 0) { this.fallback[-h - 2].eval(t, out, off); return; }
    const D = this.data;
    const n = D[h], dim = D[h + 1];
    const to = h + 4, vo = to + n;
    if (t <= D[to]) { for (let d = 0; d < dim; d++) out[off + d] = D[vo + d]; return; }
    if (t >= D[to + n - 1]) { const b = vo + (n - 1) * dim; for (let d = 0; d < dim; d++) out[off + d] = D[b + d]; return; }
    let i = D[h + 2];
    if (!(D[to + i] <= t && t < D[to + i + 1])) {
      if (i + 2 < n && D[to + i + 1] <= t && t < D[to + i + 2]) i++;
      else {
        let lo = 0, hi = n - 2;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (D[to + mid] <= t) lo = mid; else hi = mid - 1; }
        i = lo;
      }
      D[h + 2] = i;
    }
    const a = vo + i * dim;
    const li = D[vo + n * dim + i];
    if (li === -2) { for (let d = 0; d < dim; d++) out[off + d] = D[a + d]; return; }
    const t0 = D[to + i];
    let p = (t - t0) / (D[to + i + 1] - t0);
    if (li >= 0) {
      const L = this.luts, base = li * STRIDE;
      const x = p * EASE_LUT_N, j = x | 0;
      p = L[base + j] + (L[base + j + 1] - L[base + j]) * (x - j);
    }
    const b = a + dim;
    for (let d = 0; d < dim; d++) out[off + d] = D[a + d] + (D[b + d] - D[a + d]) * p;
  }
}

const hf = new Float64Array(1), hi = new Int32Array(hf.buffer);
function hash5(a: number, b: number, c: number, d: number, e: number) {
  let h = 0x811c9dc5;
  hf[0] = a; h = Math.imul(Math.imul(h ^ hi[0], 0x01000193) ^ hi[1], 0x01000193);
  hf[0] = b; h = Math.imul(Math.imul(h ^ hi[0], 0x01000193) ^ hi[1], 0x01000193);
  hf[0] = c; h = Math.imul(Math.imul(h ^ hi[0], 0x01000193) ^ hi[1], 0x01000193);
  hf[0] = d; h = Math.imul(Math.imul(h ^ hi[0], 0x01000193) ^ hi[1], 0x01000193);
  hf[0] = e; h = Math.imul(Math.imul(h ^ hi[0], 0x01000193) ^ hi[1], 0x01000193);
  return h;
}
