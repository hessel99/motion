// music analysis for audio layers: tempo, beat grid, downbeats / bars (meter guess), onsets with
// strength, accents (the strongest hits), sections (intro / build / drop / breakdown / outro from a
// novelty curve over bar-synchronous spectral features), and amplitude + low / mid / high envelopes.
//
// pure typed-array DSP with no DOM or WebAudio: runs in a Web Worker (analysis.worker.ts) and in node
// tests. one pass of a 1024-point STFT (hop ~11 ms at ~22 kHz) feeds everything; onset times are then
// refined in the time domain (1 ms energy envelope) and a stable tempo is fitted as a straight grid,
// so beats land within a few milliseconds on steady music.

export type SectionLabel = 'intro' | 'build' | 'drop' | 'breakdown' | 'main' | 'outro';
export interface Section { t0: number; t1: number; label: SectionLabel; energy: number }

export const ENV_RATE = 120;
export const ANALYSIS_VERSION = 3;

export interface AudioAnalysis {
  version: number;
  /** seconds of buffer time analysed */
  duration: number;
  bpm: number;
  /** beats per bar (3 or 4) */
  meter: number;
  /** true when the beats are a straight fitted grid (steady tempo) */
  steady: boolean;
  /** beat times (buffer seconds) and their strength 0..1 */
  beats: Float32Array;
  beatStrength: Float32Array;
  /** index into beats of the first downbeat (beats[i] with (i - downbeat) % meter == 0 start bars) */
  downbeat: number;
  onsets: Float32Array;
  onsetStrength: Float32Array;
  accents: Float32Array;
  accentStrength: Float32Array;
  sections: Section[];
  /** first / last audible moment */
  firstSound: number;
  lastSound: number;
  /** envelopes sampled at ENV_RATE per second, 0..255 */
  envRate: number;
  amp: Uint8Array;
  low: Uint8Array;
  mid: Uint8Array;
  high: Uint8Array;
  /** analysis time in ms (informational) */
  ms: number;
}

// ---------------------------------------------------------------- fft
const fftCache = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>();
function fftTables(n: number) {
  let t = fftCache.get(n);
  if (t) return t;
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), rev = new Uint32Array(n);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  fftCache.set(n, (t = { cos, sin, rev }));
  return t;
}
/** in-place complex radix-2 fft */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length, { cos, sin, rev } = fftTables(n);
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; } }
  // size 2 and 4 stages without multiplications, then twiddle-outer loops (one table read per j)
  for (let i = 0; i < n; i += 2) { const a = re[i], b = im[i]; re[i] = a + re[i + 1]; im[i] = b + im[i + 1]; re[i + 1] = a - re[i + 1]; im[i + 1] = b - im[i + 1]; }
  for (let i = 0; i < n; i += 4) {
    let tr = re[i + 2], ti = im[i + 2];
    re[i + 2] = re[i] - tr; im[i + 2] = im[i] - ti; re[i] += tr; im[i] += ti;
    tr = im[i + 3]; ti = -re[i + 3]; // * -i
    re[i + 3] = re[i + 1] - tr; im[i + 3] = im[i + 1] - ti; re[i + 1] += tr; im[i + 1] += ti;
  }
  for (let size = 8; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let j = 0, k = 0; j < half; j++, k += step) {
      const wr = cos[k], wi = sin[k];
      for (let a = j; a < n; a += size) {
        const b = a + half, xr = re[b], xi = im[b];
        const tr = xr * wr - xi * wi, ti = xr * wi + xi * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

// ---------------------------------------------------------------- helpers
function normMax(a: Float32Array): Float32Array {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  if (m > 0) for (let i = 0; i < a.length; i++) a[i] /= m;
  return a;
}
function percentile(a: ArrayLike<number>, p: number): number {
  if (!a.length) return 0;
  const s = Float32Array.from(a as ArrayLike<number>).sort();
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}
/** moving average over ±w (prefix sums) */
function movingMean(a: Float32Array, w: number): Float32Array {
  const n = a.length, ps = new Float64Array(n + 1), out = new Float32Array(n);
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + a[i];
  for (let i = 0; i < n; i++) { const lo = Math.max(0, i - w), hi = Math.min(n, i + w + 1); out[i] = (ps[hi] - ps[lo]) / (hi - lo); }
  return out;
}
const quant = (a: Float32Array): Uint8Array => {
  const s = percentile(a, 0.98) || 1, out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.min(255, Math.round((a[i] / s) * 255));
  return out;
};

// ---------------------------------------------------------------- analysis
export function analyzeAudio(input: Float32Array, srIn: number, opts: { bpm?: number } = {}): AudioAnalysis {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  // 1. decimate to ~22 kHz (box filter): everything we look at is below 8 kHz
  const dec = Math.max(1, Math.floor(srIn / 20000)), sr = srIn / dec;
  const m = Math.floor(input.length / dec);
  const y = new Float32Array(m);
  for (let i = 0, j = 0; i < m; i++) { let s = 0; for (let k = 0; k < dec; k++) s += input[j++]; y[i] = s / dec; }
  const duration = m / sr;

  // 2. fine energy envelope: 1 ms blocks (time-domain onset refinement, amplitude envelope)
  const blk = Math.max(1, Math.round(sr * 0.001)), blkSec = blk / sr, nb = Math.floor(m / blk);
  const fe = new Float32Array(nb);
  for (let b = 0, i = 0; b < nb; b++) { let s = 0; for (let k = 0; k < blk; k++, i++) s += y[i] * y[i]; fe[b] = s / blk; }

  // 3. stft: band energies, 24 log bands, spectral flux (total and low band)
  const N = 1024, H = 256, hopSec = H / sr, half = N / 2;
  const F = Math.max(0, Math.floor((m - N) / H) + 1);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const binHz = sr / N;
  const NB = 24, bandOf = new Int8Array(half + 1).fill(-1);
  const fLo = 50, fHi = Math.min(9000, sr / 2);
  for (let k = 1; k <= half; k++) { const f = k * binHz; if (f >= fLo && f < fHi) bandOf[k] = Math.min(NB - 1, Math.floor((Math.log(f / fLo) / Math.log(fHi / fLo)) * NB)); }
  const kLow = Math.max(2, Math.round(150 / binHz)), kMid = Math.round(2500 / binHz);
  const eLow = new Float32Array(F), eMid = new Float32Array(F), eHigh = new Float32Array(F);
  const flux = new Float32Array(F), fluxLow = new Float32Array(F);
  const spec = new Float32Array(F * NB);
  // flux filterbank: 40 log bands 30 Hz .. nyquist (a log per band, not per bin), mean power per bin
  const NF = 40, fbOf = new Uint8Array(half + 1), fbCnt = new Float64Array(NF);
  const fbHi = sr / 2, fbLo = 30;
  for (let k = 1; k <= half; k++) { const f = Math.max(fbLo, k * binHz); const b = Math.min(NF - 1, Math.floor((Math.log(f / fbLo) / Math.log(fbHi / fbLo)) * NF)); fbOf[k] = b; fbCnt[b]++; }
  let lowFb = 0;
  while (lowFb < NF && fbLo * Math.pow(fbHi / fbLo, (lowFb + 1) / NF) <= 300) lowFb++;
  const fb = new Float64Array(NF);
  const re = new Float64Array(N), im = new Float64Array(N), prev = new Float32Array(NF), cur = new Float32Array(NF);
  const pw = new Float64Array((half + 1) * 2); // power spectra of the two frames of a pair
  const scale2 = (4 / N) ** 2;
  const frame = (f: number, P: Float64Array, off: number) => {
    let el = 0, em = 0, eh = 0, fl = 0, ft = 0;
    fb.fill(0);
    for (let k = 1; k <= half; k++) {
      const p = P[off + k] * scale2;
      fb[fbOf[k]] += p;
      if (k < kLow) el += p; else if (k < kMid) em += p; else eh += p;
      const b = bandOf[k];
      if (b >= 0) spec[f * NB + b] += p;
    }
    for (let b = 0; b < NF; b++) {
      if (!fbCnt[b]) continue;
      const L = Math.log(1 + 300 * Math.sqrt(fb[b] / fbCnt[b]));
      const d = L - prev[b];
      cur[b] = L;
      if (d > 0) { ft += d; if (b < lowFb) fl += d; }
    }
    eLow[f] = Math.sqrt(el); eMid[f] = Math.sqrt(em); eHigh[f] = Math.sqrt(eh);
    if (f > 0) { flux[f] = ft; fluxLow[f] = fl; }
    prev.set(cur);
  };
  // two real frames per complex fft (A in re, B in im), separated with the conjugate symmetry
  for (let f = 0; f < F; f += 2) {
    const oa = f * H, ob = (f + 1) * H, two = f + 1 < F;
    for (let i = 0; i < N; i++) { re[i] = y[oa + i] * win[i]; im[i] = two ? y[ob + i] * win[i] : 0; }
    fft(re, im);
    for (let k = 1; k <= half; k++) {
      const zr = re[k], zi = im[k], cr = re[(N - k) & (N - 1)], ci = -im[(N - k) & (N - 1)];
      const ar = (zr + cr) / 2, ai = (zi + ci) / 2, br = (zi - ci) / 2, bi = (cr - zr) / 2;
      pw[k] = ar * ar + ai * ai; pw[half + 1 + k] = br * br + bi * bi;
    }
    frame(f, pw, 0);
    if (two) frame(f + 1, pw, half + 1);
  }
  for (let i = 0; i < spec.length; i++) spec[i] = Math.log(1e-8 + spec[i]);
  // frame f's flux peaks when a hit enters the window's centre region; empirically ~N/2 - H after o
  const frameT = (f: number) => (f * H + N / 2 - H * 0.75) / sr;

  // audible range (-45 dB under the loudest 10 ms)
  let feMax = 0;
  for (let i = 0; i < nb; i++) if (fe[i] > feMax) feMax = fe[i];
  const thr = feMax * 3e-5;
  let fs = 0, ls = nb - 1;
  while (fs < nb && fe[fs] < thr) fs++;
  while (ls > 0 && fe[ls] < thr) ls--;
  const firstSound = Math.min(duration, fs * blkSec), lastSound = Math.max(firstSound, (ls + 1) * blkSec);

  // 4. onsets: peaks of the normalized flux over a local mean, refined in the time domain
  const O = normMax(Float32Array.from(flux));
  const OL = normMax(Float32Array.from(fluxLow));
  const mean = movingMean(O, Math.round(0.4 / hopSec));
  const lfe = new Float32Array(nb);
  for (let i = 0; i < nb; i++) lfe[i] = Math.log(1e-10 + fe[i]);
  const refine = (t: number): number => {
    const a = Math.max(2, Math.floor((t - 0.05) / blkSec)), b = Math.min(nb - 1, Math.ceil((t + 0.03) / blkSec));
    let best = -Infinity, bi = -1;
    for (let k = a; k <= b; k++) { const d = lfe[k] - lfe[k - 2]; if (d > best) { best = d; bi = k; } }
    return bi < 0 || best < 1 ? t : (bi - 1) * blkSec;
  };
  const onsetT: number[] = [], onsetS: number[] = [], onsetF: number[] = [];
  const minGap = Math.round(0.05 / hopSec);
  for (let f = 1; f < F - 1; f++) {
    const v = O[f];
    if (v < 0.04 || v < mean[f] + 0.06) continue;
    let peak = true;
    for (let d = 1; d <= 3 && peak; d++) { if ((f - d >= 0 && O[f - d] > v) || (f + d < F && O[f + d] >= v)) peak = false; }
    if (!peak) continue;
    if (onsetF.length && f - onsetF[onsetF.length - 1] < minGap) {
      if (v > onsetS[onsetS.length - 1]) { onsetF[onsetF.length - 1] = f; onsetS[onsetS.length - 1] = v; }
      continue;
    }
    onsetF.push(f); onsetS.push(v);
  }
  for (const f of onsetF) onsetT.push(refine(frameT(f)));
  // a sound that starts with the file (trimmed loops) is an onset too: the stft can't see a rise there
  if (feMax > 0 && (!onsetT.length || onsetT[0] > firstSound + 0.04)) {
    let pk = 0;
    for (let k = fs; k < Math.min(nb, fs + 30); k++) pk = Math.max(pk, fe[k]);
    if (pk > feMax * 0.05) { onsetT.unshift(firstSound); onsetS.unshift(Math.min(1, Math.sqrt(pk / feMax))); onsetF.unshift(0); }
  }

  // 5. tempo: autocorrelation of an onset envelope that favors the low band (kicks), harmonics summed
  const Ot = new Float32Array(F);
  for (let f = 0; f < F; f++) Ot[f] = O[f] + 1.5 * OL[f];
  const otMean = movingMean(Ot, Math.round(0.25 / hopSec));
  for (let f = 0; f < F; f++) Ot[f] = Math.max(0, Ot[f] - otMean[f]);
  const lagMax = Math.min(F - 1, Math.ceil(3.2 / hopSec));
  const ac = new Float32Array(lagMax + 2);
  for (let L = 1; L <= lagMax; L++) { let s = 0; for (let f = L; f < F; f++) s += Ot[f] * Ot[f - L]; ac[L] = s / (F - L); }
  const acAt = (x: number) => { const i = Math.floor(x); if (i < 1 || i + 1 > lagMax) return 0; return Math.max(ac[i], ac[i + 1]); };
  let period = 0.5;
  if (opts.bpm && opts.bpm > 0) period = 60 / opts.bpm;
  else if (lagMax > 10) {
    const Lfast = Math.max(2, Math.floor(60 / 200 / hopSec)), Lslow = Math.min(Math.floor(lagMax / 3), Math.ceil(60 / 60 / hopSec));
    let best = -1, bestL = Math.round(0.5 / hopSec);
    for (let L = Lfast; L <= Lslow; L++) {
      if (!(ac[L] >= ac[L - 1] && ac[L] >= ac[L + 1])) continue;
      const bpm = 60 / (L * hopSec);
      const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
      const s = (ac[L] + 0.5 * acAt(2 * L) + 0.25 * acAt(3 * L)) * prior;
      if (s > best) { best = s; bestL = L; }
    }
    // a strong pulse at half the period means the faster tempo (e.g. 174 vs 87)
    const halfL = bestL / 2;
    if (60 / (halfL * hopSec) <= 200 && Math.max(acAt(halfL - 0.5), acAt(halfL)) >= 0.6 * ac[bestL]) bestL = Math.round(halfL);
    // parabolic peak refinement
    const a = ac[bestL - 1], b = ac[bestL], c = ac[bestL + 1], den = a - 2 * b + c;
    const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    period = (bestL + off) * hopSec;
  }

  // 6. beat tracking: dynamic programming (Ellis 2007) on the normalized tempo envelope
  let sd = 0;
  for (let f = 0; f < F; f++) sd += Ot[f] * Ot[f];
  sd = Math.sqrt(sd / Math.max(1, F)) || 1;
  const P = period / hopSec;
  const C = new Float32Array(F), back = new Int32Array(F).fill(-1);
  const alpha = 100;
  for (let f = 0; f < F; f++) {
    const lo = Math.max(0, Math.floor(f - 2 * P)), hi = Math.floor(f - P / 2);
    let bestV = 0, bestI = -1;
    for (let tt = lo; tt <= hi; tt++) {
      const r = Math.log((f - tt) / P);
      const v = C[tt] - alpha * r * r;
      if (bestI < 0 || v > bestV) { bestV = v; bestI = tt; }
    }
    C[f] = Ot[f] / sd + (bestI >= 0 ? Math.max(0, bestV) : 0);
    back[f] = bestI >= 0 && bestV > 0 ? bestI : -1;
  }
  let endF = -1, endV = -Infinity;
  for (let f = Math.max(0, Math.floor(F - P)); f < F; f++) if (C[f] > endV) { endV = C[f]; endF = f; }
  const dpFrames: number[] = [];
  for (let f = endF; f >= 0; f = back[f]) dpFrames.push(f);
  dpFrames.reverse();
  let dpBeats = dpFrames.map(frameT).filter(t => t >= firstSound - period * 0.3 && t <= lastSound + period * 0.1);

  // 7. snap beats to refined onsets and fit a straight grid when the tempo is steady
  const nearestOnset = (t: number, tol: number) => {
    let bi = -1, bd = tol;
    // binary search would do; onsets are few hundred to a few thousand
    let lo = 0, hi = onsetT.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (onsetT[mid] < t - tol) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < onsetT.length && onsetT[i] <= t + tol; i++) { const d = Math.abs(onsetT[i] - t) / (0.5 + onsetS[i]); if (d < bd) { bd = d; bi = i; } }
    return bi;
  };
  let steady = false;
  let beats: number[] = dpBeats;
  if (dpBeats.length >= 6) {
    const pts: { i: number; t: number }[] = [];
    const t00 = dpBeats[0];
    for (const b of dpBeats) {
      const oi = nearestOnset(b, 0.07);
      if (oi >= 0) pts.push({ i: Math.round((b - t00) / period), t: onsetT[oi] });
    }
    let a = t00, slope = period, use = pts;
    for (let it = 0; it < 4 && use.length >= 4; it++) {
      let si = 0, st = 0, sii = 0, sit = 0;
      for (const p of use) { si += p.i; st += p.t; sii += p.i * p.i; sit += p.i * p.t; }
      const n = use.length, den = n * sii - si * si;
      if (den <= 0) break;
      slope = (n * sit - si * st) / den; a = (st - slope * si) / n;
      const tol = it < 2 ? 0.05 : 0.03;
      use = pts.filter(p => Math.abs(a + slope * p.i - p.t) < tol);
    }
    let rss = 0;
    for (const p of use) rss += (a + slope * p.i - p.t) ** 2;
    const rms = use.length ? Math.sqrt(rss / use.length) : 1;
    if (use.length >= Math.max(4, dpBeats.length * 0.45) && rms < 0.02 && Math.abs(slope / period - 1) < 0.08) {
      steady = true;
      period = slope;
      // first / last grid beat around where the dp found beats (not inside leading silence)
      const i0 = Math.ceil((firstSound - 0.03 - a) / slope), i1 = Math.floor((Math.min(lastSound, dpBeats[dpBeats.length - 1] + period) - a) / slope + 0.3);
      beats = [];
      for (let i = i0; i <= i1; i++) { const t = a + slope * i; if (t >= -0.03 && t <= duration) beats.push(Math.max(0, t)); }
    } else {
      beats = dpBeats.map(b => { const oi = nearestOnset(b, 0.05); return oi >= 0 ? onsetT[oi] : b; });
      if (dpBeats.length > 1) period = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
    }
    // no beats ringing out into decay tails or before the music starts
    const hasHit = (t: number) => { const oi = nearestOnset(t, 0.07); return oi >= 0 && onsetS[oi] >= 0.15; };
    while (beats.length > 4 && !hasHit(beats[beats.length - 1])) beats.pop();
    while (beats.length > 4 && !hasHit(beats[0])) beats.shift();
  }
  const frameOf = (t: number) => Math.max(0, Math.min(F - 1, Math.round((t * sr - N / 2 + H * 0.75) / H)));
  const peakNear = (a: Float32Array, t: number) => { const f = frameOf(t); let v = 0; for (let d = -2; d <= 2; d++) { const g = f + d; if (g >= 0 && g < F && a[g] > v) v = a[g]; } return v; };
  const beatStrength = normMax(Float32Array.from(beats, t => peakNear(O, t) + peakNear(OL, t)));

  // 8. meter + downbeat: kicks, harmonic change and accents line up on bar starts
  const nBeats = beats.length;
  const specMean = (ta: number, tb: number, out: Float32Array) => {
    out.fill(0);
    const fa = frameOf(ta), fb = Math.max(fa + 1, frameOf(tb));
    for (let f = fa; f < fb; f++) for (let b = 0; b < NB; b++) out[b] += spec[f * NB + b];
    for (let b = 0; b < NB; b++) out[b] /= fb - fa;
    return out;
  };
  const kz = new Float32Array(nBeats), hz = new Float32Array(nBeats);
  { const A = new Float32Array(NB), B = new Float32Array(NB);
    for (let i = 0; i < nBeats; i++) {
      kz[i] = peakNear(OL, beats[i]);
      if (i > 0 && i + 1 < nBeats) {
        specMean(beats[i - 1], beats[i], A); specMean(beats[i], beats[i + 1], B);
        let d = 0; for (let b = 0; b < NB; b++) d += (A[b] - B[b]) ** 2;
        hz[i] = Math.sqrt(d / NB);
      }
    } }
  const z = (a: Float32Array) => { let s = 0, s2 = 0; for (const v of a) { s += v; s2 += v * v; } const mu = s / (a.length || 1), sdv = Math.sqrt(Math.max(1e-9, s2 / (a.length || 1) - mu * mu)); return Float32Array.from(a, v => (v - mu) / sdv); };
  const K = z(kz), Hh = z(hz), Ac = z(beatStrength);
  let meter = 4, downbeat = 0;
  if (nBeats >= 8) {
    let bestS = -Infinity, best4 = -Infinity, best3 = -Infinity, p4 = 0, p3 = 0;
    for (const mtr of [4, 3]) for (let p = 0; p < mtr; p++) {
      let on = 0, no = 0, off = 0, nf = 0;
      for (let i = 0; i < nBeats; i++) { const v = 0.4 * K[i] + 0.4 * Hh[i] + 0.2 * Ac[i]; if (((i - p) % mtr + mtr) % mtr === 0) { on += v; no++; } else { off += v; nf++; } }
      const s = on / Math.max(1, no) - off / Math.max(1, nf);
      if (mtr === 4 && s > best4) { best4 = s; p4 = p; }
      if (mtr === 3 && s > best3) { best3 = s; p3 = p; }
      bestS = Math.max(bestS, s);
    }
    if (best3 > best4 * 1.3 + 0.1) { meter = 3; downbeat = p3; } else { meter = 4; downbeat = p4; }
  }

  // 9. envelopes at ENV_RATE
  const ne = Math.max(1, Math.ceil(duration * ENV_RATE));
  const ampF = new Float32Array(ne), lowF = new Float32Array(ne), midF = new Float32Array(ne), highF = new Float32Array(ne);
  const bPer = 1 / ENV_RATE / blkSec;
  for (let e = 0; e < ne; e++) {
    const a = Math.floor(e * bPer), b = Math.min(nb, Math.max(a + 1, Math.floor((e + 1) * bPer)));
    let s = 0; for (let k = a; k < b; k++) s += fe[k];
    ampF[e] = Math.sqrt(s / Math.max(1, b - a));
    const ft = (e / ENV_RATE) * sr, fr = Math.max(0, Math.min(F - 1, (ft - N / 2) / H)), f0 = Math.floor(fr), f1 = Math.min(F - 1, f0 + 1), w = fr - f0;
    if (F) { lowF[e] = eLow[f0] * (1 - w) + eLow[f1] * w; midF[e] = eMid[f0] * (1 - w) + eMid[f1] * w; highF[e] = eHigh[f0] * (1 - w) + eHigh[f1] * w; }
  }

  // 10. sections: novelty between neighbouring bars of spectral + energy features
  const sections = findSections({ beats, meter, downbeat, steady, duration, firstSound, lastSound, spec, NB, frameOf, ampF, lowF, onsetT });

  // 11. accents: strongest onsets, louder when they jump out of quieter audio, a beat apart
  const ampAt = (t: number) => ampF[Math.max(0, Math.min(ne - 1, Math.round(t * ENV_RATE)))];
  const ampMax = percentile(ampF, 0.98) || 1;
  const cand = onsetT.map((t, i) => {
    let before = 0, after = 0;
    for (let d = 1; d <= 12; d++) { before = Math.max(before, ampAt(t - 0.02 - d / ENV_RATE)); after = Math.max(after, ampAt(t + d / ENV_RATE)); }
    const jump = Math.max(0, Math.log10((after + 1e-6) / (before + 1e-6))) * 20;
    const sectionStart = sections.some(s => Math.abs(s.t0 - t) < 0.06) ? 0.5 : 0;
    return { t, s: onsetS[i] * (0.6 + Math.min(1.2, after / ampMax)) * (1 + Math.min(2, jump / 6)) + sectionStart };
  });
  const maxAcc = Math.max(4, Math.min(64, Math.round(duration / 1.5)));
  const picked: { t: number; s: number }[] = [];
  const space = Math.min(0.45, period * 0.9);
  for (const c of cand.slice().sort((a, b) => b.s - a.s)) {
    if (picked.length >= maxAcc) break;
    if (picked.every(p => Math.abs(p.t - c.t) >= space)) picked.push(c);
  }
  picked.sort((a, b) => a.t - b.t);
  const accS = normMax(Float32Array.from(picked, p => p.s));

  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return {
    version: ANALYSIS_VERSION, duration, bpm: Math.round((60 / period) * 100) / 100, meter, steady,
    beats: Float32Array.from(beats), beatStrength, downbeat,
    onsets: Float32Array.from(onsetT), onsetStrength: Float32Array.from(onsetS),
    accents: Float32Array.from(picked, p => p.t), accentStrength: accS,
    sections, firstSound, lastSound,
    envRate: ENV_RATE, amp: quant(ampF), low: quant(lowF), mid: quant(midF), high: quant(highF), ms,
  };
}

function findSections(a: {
  beats: number[]; meter: number; downbeat: number; steady: boolean; duration: number; firstSound: number; lastSound: number;
  spec: Float32Array; NB: number; frameOf: (t: number) => number; ampF: Float32Array; lowF: Float32Array; onsetT: number[];
}): Section[] {
  const { beats, meter, downbeat, NB, spec, frameOf, ampF, lowF } = a;
  // units: bars (when there is a beat grid with bars ≥ 1 s), else 2 s blocks
  const bounds: number[] = [];
  const barLen = beats.length > 1 ? ((beats[beats.length - 1] - beats[0]) / (beats.length - 1)) * meter : 0;
  if (beats.length >= meter * 4 && barLen >= 1) {
    if (downbeat > 0 && beats[0] > a.firstSound + 0.2) bounds.push(a.firstSound);
    else if (downbeat > 0) bounds.push(beats[0]);
    for (let i = downbeat; i < beats.length; i += meter) bounds.push(beats[i]);
    // the last bar runs to the end of the sound (decay tails are not a section of their own)
    const last = bounds[bounds.length - 1] + barLen;
    if (a.lastSound > last + barLen * 0.75) bounds.push(last);
    bounds.push(Math.min(a.duration, Math.max(last, a.lastSound)));
  } else {
    for (let t = a.firstSound; t < a.lastSound; t += 2) bounds.push(t);
    bounds.push(a.lastSound);
  }
  const U = bounds.length - 1;
  if (U < 2) return [{ t0: a.firstSound, t1: a.lastSound, label: 'main', energy: 1 }];
  // features: 24 log bands, loudness, onset density, and the low band (kicks / bass: what makes a drop)
  // three times so it weighs like a few spectral bands
  const D = NB + 5;
  const feat = new Float32Array(U * D), rmsU = new Float32Array(U), lowU = new Float32Array(U);
  const ampAt = (t: number) => ampF[Math.max(0, Math.min(ampF.length - 1, Math.round(t * ENV_RATE)))];
  for (let u = 0; u < U; u++) {
    const fa = frameOf(bounds[u]), fb = Math.max(fa + 1, frameOf(bounds[u + 1]));
    for (let f = fa; f < fb; f++) for (let b = 0; b < NB; b++) feat[u * D + b] += spec[f * NB + b] / (fb - fa);
    let s = 0, sl = 0, n = 0;
    const uEnd = Math.min(bounds[u + 1], bounds[u] + (barLen >= 1 ? barLen : 2) * 1.01); // decay tails don't dilute the last bar
    for (let t = bounds[u]; t < uEnd; t += 1 / ENV_RATE) { const v = ampAt(t), w = lowF[Math.max(0, Math.min(lowF.length - 1, Math.round(t * ENV_RATE)))]; s += v * v; sl += w * w; n++; }
    const rms = Math.sqrt(s / Math.max(1, n)), low = Math.sqrt(sl / Math.max(1, n));
    let dens = 0;
    for (const t of a.onsetT) if (t >= bounds[u] && t < bounds[u + 1]) dens++;
    dens /= Math.max(0.5, bounds[u + 1] - bounds[u]);
    feat[u * D + NB] = Math.log10(1e-6 + rms) * 3;
    feat[u * D + NB + 1] = dens / 4;
    feat[u * D + NB + 2] = feat[u * D + NB + 3] = feat[u * D + NB + 4] = Math.log10(1e-6 + low) * 3;
    rmsU[u] = rms; lowU[u] = low;
  }
  const rMax = Math.max(...rmsU) || 1, lMax = Math.max(...lowU) || 1;
  const energy = Float32Array.from(rmsU, (r, u) => 0.5 * (r / rMax) + 0.5 * (lowU[u] / lMax));
  // z-normalize each dimension
  for (let d = 0; d < D; d++) {
    let s = 0, s2 = 0;
    for (let u = 0; u < U; u++) { const v = feat[u * D + d]; s += v; s2 += v * v; }
    const mu = s / U, sdv = Math.sqrt(Math.max(1e-9, s2 / U - mu * mu));
    for (let u = 0; u < U; u++) feat[u * D + d] = (feat[u * D + d] - mu) / sdv;
  }
  const nov = new Float32Array(U + 1);
  for (let j = 1; j < U; j++) {
    const w = Math.min(4, j, U - j);
    let d2 = 0;
    for (let d = 0; d < D; d++) {
      let l = 0, r = 0;
      for (let k = 0; k < w; k++) { l += feat[(j - 1 - k) * D + d]; r += feat[(j + k) * D + d]; }
      d2 += ((l - r) / w) ** 2;
    }
    // plus the jump in energy (loudness + low end): drops and breakdowns are energy changes first
    let el = 0, er = 0;
    for (let k = 0; k < w; k++) { el += energy[j - 1 - k]; er += energy[j + k]; }
    nov[j] = (Math.sqrt(d2 / D) + 4 * Math.abs(er - el) / w) * (j % 4 === 0 ? 1.15 : 1);
  }
  let s = 0, s2 = 0;
  // stats without the first / last boundaries (leading silence, the decay tail)
  const ja = Math.min(2, U - 1), jb = Math.max(ja + 1, U - 1);
  for (let j = ja; j < jb; j++) { s += nov[j]; s2 += nov[j] * nov[j]; }
  const mu = s / (jb - ja), sdv = Math.sqrt(Math.max(0, s2 / (jb - ja) - mu * mu));
  const cuts: number[] = [];
  const order = Array.from({ length: U - 1 }, (_, i) => i + 1).sort((x, y) => nov[y] - nov[x]);
  const minLen = U >= 16 ? 4 : 2;
  for (const j of order) {
    if (nov[j] < mu + 0.4 * sdv || nov[j] < 0.5) break;
    if (j < 2 || U - j < 2) continue;
    if (cuts.every(c => Math.abs(c - j) >= minLen)) cuts.push(j);
    if (cuts.length >= 12) break;
  }
  cuts.sort((x, y) => x - y);
  const edges = [0, ...cuts, U];
  const raw = edges.slice(0, -1).map((e, i) => {
    const e1 = edges[i + 1];
    let es = 0, slopeN = 0, slopeD = 0;
    const mid = (e + e1 - 1) / 2;
    for (let u = e; u < e1; u++) { es += energy[u]; slopeN += (u - mid) * energy[u]; slopeD += (u - mid) ** 2; }
    return { t0: bounds[e], t1: bounds[e1], e: es / (e1 - e), slope: slopeD ? slopeN / slopeD : 0 };
  });
  const eMax = Math.max(...raw.map(r => r.e)) || 1;
  const out: Section[] = raw.map(r => ({ t0: r.t0, t1: r.t1, label: 'main' as SectionLabel, energy: Math.round((r.e / eMax) * 100) / 100 }));
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const E = out[i].energy, prev = out[i - 1]?.energy, next = out[i + 1]?.energy;
    const rising = (raw[i].slope * Math.max(1, edges[i + 1] - edges[i])) / eMax > 0.05;
    if (E >= 0.8 && prev !== undefined && prev < E - 0.15) out[i].label = 'drop';
    else if (i === n - 1 && n > 2 && prev !== undefined && E < prev - 0.1) out[i].label = 'outro';
    else if (i > 0 && E < 0.35 && prev !== undefined && prev > E + 0.2) out[i].label = 'breakdown';
    else if (next !== undefined && next >= 0.8 && next > E + 0.15 && (E >= 0.4 || rising)) out[i].label = 'build';
    else if (i === 0 && n > 1 && E < 0.75) out[i].label = 'intro';
    else if (i === n - 1 && n > 2 && prev !== undefined && E < prev - 0.1) out[i].label = 'outro';
    else if (i > 0 && E < 0.5) out[i].label = 'breakdown';
  }
  // neighbours that read the same (label and energy) are one section
  const merged: Section[] = [];
  for (const sct of out) {
    const p = merged[merged.length - 1];
    if (p && p.label === sct.label && Math.abs(p.energy - sct.energy) < 0.12) { p.energy = Math.round(((p.energy * (p.t1 - p.t0) + sct.energy * (sct.t1 - sct.t0)) / (sct.t1 - p.t0)) * 100) / 100; p.t1 = sct.t1; }
    else merged.push({ ...sct });
  }
  return merged;
}

// ---------------------------------------------------------------- queries (buffer time)

/** bar start times */
export function barTimes(a: AudioAnalysis): number[] {
  const out: number[] = [];
  for (let i = a.downbeat; i < a.beats.length; i += a.meter) out.push(a.beats[i]);
  return out;
}

/** envelope value 0..1 of band at buffer time t (linear interpolation) */
export function envAt(env: Uint8Array, rate: number, t: number): number {
  const x = t * rate;
  if (!(x >= 0) || x >= env.length - 1) return x >= env.length - 1 && env.length ? env[env.length - 1] / 255 : 0;
  const i = Math.floor(x), w = x - i;
  return (env[i] * (1 - w) + env[i + 1] * w) / 255;
}

/** beat F-measure (mir_eval style: ±tol, one-to-one matching) */
export function beatFMeasure(ref: ArrayLike<number>, est: ArrayLike<number>, tol = 0.07): { f: number; p: number; r: number } {
  if (!ref.length || !est.length) return { f: 0, p: 0, r: 0 };
  const used = new Uint8Array(est.length);
  let hit = 0;
  for (let i = 0; i < ref.length; i++) {
    let bj = -1, bd = tol;
    for (let j = 0; j < est.length; j++) { const d = Math.abs(est[j] - ref[i]); if (!used[j] && d <= bd) { bd = d; bj = j; } }
    if (bj >= 0) { used[bj] = 1; hit++; }
  }
  const p = hit / est.length, r = hit / ref.length;
  return { f: p + r ? (2 * p * r) / (p + r) : 0, p, r };
}
