// synthesized sound effects: every sound is a small recipe rendered sample by sample (seeded noise,
// oscillators, simple filters, a Schroeder reverb), so it is deterministic, license-free and tweakable.
// a FAMILY is one character shared by every sound type (pitch, brightness, softness, length, noise vs
// tone, reverb, stereo width, wave shape): choosing a sound you like = choosing its family, and the
// whole video then sounds coherent. pure DSP: runs in the page, workers and node tests.

export const SFX_TYPES = ['whoosh', 'swish', 'pop', 'click', 'tap', 'ding', 'impact', 'riser', 'sweep', 'glitch', 'sparkle', 'key', 'bubble', 'notify', 'hit'] as const;
export type SfxType = typeof SFX_TYPES[number];

export interface SfxFamily {
  id: string;
  name: string;
  /** for whom / what brand traits */
  hint: string;
  /** pitch multiplier (1 = neutral) */
  pitch: number;
  /** 0 dark .. 1 bright */
  bright: number;
  /** 0 snappy attack .. 1 soft attack */
  soft: number;
  /** length multiplier */
  length: number;
  /** 0 tonal .. 1 noisy */
  noise: number;
  /** 0 dry .. 1 big room */
  reverb: number;
  /** 0 mono .. 1 wide */
  width: number;
  wave: 'sine' | 'triangle' | 'square';
  /** 0..1 bit crush / sample-rate reduction */
  crush: number;
  /** woody resonant body (organic) 0..1 */
  body: number;
  /** output gain */
  gain: number;
}

export const SFX_FAMILIES: SfxFamily[] = [
  { id: 'soft-warm', name: 'Soft & warm', hint: 'friendly, human, wellness, lifestyle', pitch: 0.8, bright: 0.3, soft: 0.8, length: 1.1, noise: 0.35, reverb: 0.3, width: 0.45, wave: 'sine', crush: 0, body: 0.2, gain: 0.8 },
  { id: 'crisp-ui', name: 'Crisp UI', hint: 'product, SaaS, fintech, clean interfaces', pitch: 1.25, bright: 0.85, soft: 0.05, length: 0.7, noise: 0.25, reverb: 0.06, width: 0.2, wave: 'sine', crush: 0, body: 0, gain: 0.85 },
  { id: 'playful', name: 'Playful bubbly', hint: 'kids, games, fun consumer brands', pitch: 1.45, bright: 0.6, soft: 0.25, length: 0.9, noise: 0.2, reverb: 0.15, width: 0.35, wave: 'triangle', crush: 0, body: 0, gain: 0.85 },
  { id: 'cinematic', name: 'Cinematic', hint: 'trailers, launches, bold reveals', pitch: 0.6, bright: 0.5, soft: 0.45, length: 1.6, noise: 0.6, reverb: 0.65, width: 0.9, wave: 'sine', crush: 0, body: 0, gain: 0.95 },
  { id: 'glitchy-tech', name: 'Glitchy tech', hint: 'cyber, gaming, dev tools, retro digital', pitch: 1.0, bright: 0.9, soft: 0.05, length: 0.8, noise: 0.5, reverb: 0.12, width: 0.6, wave: 'square', crush: 0.65, body: 0, gain: 0.7 },
  { id: 'minimal-luxury', name: 'Minimal luxury', hint: 'fashion, premium, editorial, calm', pitch: 1.0, bright: 0.45, soft: 0.6, length: 1.2, noise: 0.25, reverb: 0.4, width: 0.55, wave: 'sine', crush: 0, body: 0, gain: 0.6 },
  { id: 'organic-wooden', name: 'Organic wooden', hint: 'natural, craft, food, sustainability', pitch: 0.9, bright: 0.4, soft: 0.2, length: 0.9, noise: 0.3, reverb: 0.12, width: 0.3, wave: 'triangle', crush: 0, body: 0.9, gain: 0.85 },
];

export function findFamily(id: string): SfxFamily {
  const n = String(id ?? '').toLowerCase().replace(/[^a-z]+/g, '');
  return SFX_FAMILIES.find(f => f.id.replace(/-/g, '') === n || f.name.toLowerCase().replace(/[^a-z]+/g, '') === n || n.length > 3 && f.name.toLowerCase().replace(/[^a-z]+/g, '').startsWith(n)) ?? SFX_FAMILIES[1];
}

// ---------------------------------------------------------------- dsp helpers
function rng(seed: number) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function hashStr(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

/** state-variable filter, one sample per call (cutoff in Hz, q ≥ 0.5): returns [lp, bp, hp] via out */
class Svf {
  lp = 0; bp = 0;
  run(x: number, fc: number, q: number, sr: number): number {
    // the chamberlin svf is stable for f < ~1: cutoffs up to ~sr/6
    const f = 2 * Math.sin(Math.PI * Math.min(0.16, Math.max(0, fc) / sr));
    if (q < 0.5) q = 0.5;
    const hp = x - this.lp - this.bp / q;
    this.bp += f * hp; this.lp += f * this.bp;
    return hp;
  }
}
const osc = (wave: SfxFamily['wave'], ph: number) => {
  const p = ph - Math.floor(ph);
  if (wave === 'sine') return Math.sin(2 * Math.PI * p);
  if (wave === 'triangle') return 1 - 4 * Math.abs(p - 0.5);
  return p < 0.5 ? 0.7 : -0.7;
};

/** Schroeder reverb (4 combs + 2 allpasses), deterministic, slightly different per channel */
function reverb(x: Float32Array, sr: number, amount: number, size: number, right: boolean): Float32Array {
  if (amount <= 0.01) return x;
  const combs = [1557, 1617, 1491, 1422].map(d => Math.round((d + (right ? 23 : 0)) * size * sr / 44100));
  const aps = [225, 556].map(d => Math.round(d * sr / 44100));
  const n = x.length, wet = new Float32Array(n), fb = 0.72 + 0.12 * Math.min(1, size);
  for (const d of combs) { const buf = new Float32Array(d); let i = 0, lp = 0; for (let k = 0; k < n; k++) { const y = buf[i]; lp = y * 0.6 + lp * 0.4; buf[i] = x[k] + lp * fb; i = (i + 1) % d; wet[k] += y * 0.25; } }
  for (const d of aps) { const buf = new Float32Array(d); let i = 0; for (let k = 0; k < n; k++) { const b = buf[i], y = -wet[k] + b; buf[i] = wet[k] + b * 0.5; i = (i + 1) % d; wet[k] = y; } }
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = x[k] * (1 - amount * 0.4) + wet[k] * amount * 0.8;
  return out;
}

export interface SfxRender { L: Float32Array; R: Float32Array; sr: number; duration: number }

/** render one sound. intensity 0..1 (bigger / faster moves → louder, longer, lower). deterministic */
export function renderSfx(type: SfxType, fam: SfxFamily, intensity = 0.5, sr = 44100, variant = 0): SfxRender {
  const I = Math.max(0, Math.min(1, intensity));
  const rand = rng(hashStr(`${type}|${fam.id}|${Math.round(I * 8)}|${variant}`));
  const P = fam.pitch * (1 + (rand() - 0.5) * 0.04);
  const base: Record<SfxType, number> = { whoosh: 0.45, swish: 0.3, pop: 0.12, click: 0.03, tap: 0.09, ding: 1.1, impact: 0.55, riser: 1.6, sweep: 0.5, glitch: 0.3, sparkle: 0.7, key: 0.05, bubble: 0.11, notify: 0.7, hit: 1.0 };
  const len = base[type] * fam.length * (type === 'click' || type === 'key' ? 1 : 0.8 + 0.4 * I);
  const tail = fam.reverb * (type === 'click' || type === 'key' ? 0.15 : 0.6) + 0.02;
  const n = Math.ceil((len + tail) * sr), body = Math.ceil(len * sr);
  const x = new Float32Array(n);
  const svf = new Svf(), svf2 = new Svf(), bodyF = new Svf();
  const att = (k: number, a: number) => Math.min(1, k / Math.max(1, a * sr));
  const dec = (k: number, d: number) => Math.exp(-k / (d * sr));
  const bright = 300 + fam.bright * 7000;
  let ph = 0, ph2 = 0;
  for (let k = 0; k < body; k++) {
    const t = k / sr, p = k / body, w = rand() * 2 - 1;
    let v = 0;
    switch (type) {
      case 'whoosh': case 'swish': case 'sweep': case 'riser': {
        // band-passed noise whose centre sweeps; swell envelope peaking late (whoosh) or early (swish)
        const peak = type === 'swish' ? 0.25 : type === 'riser' ? 0.97 : type === 'sweep' ? 0.7 : 0.62;
        const env = p < peak ? Math.pow(p / peak, 1.5 + fam.soft) : Math.pow(1 - (p - peak) / (1 - peak), 2);
        const fc = type === 'riser' || type === 'sweep' ? 200 + bright * p * p : 250 + bright * 0.8 * Math.sin(Math.PI * Math.min(1, p / (peak * 1.6)));
        svf.run(w, fc * (0.7 + 0.6 * P), 1.2 + 3 * (1 - fam.noise), sr);
        v = svf.bp * env * (0.9 + 0.4 * I);
        if (type === 'riser') { ph += (110 * P * (1 + 3 * p * p)) / sr; v += osc(fam.wave, ph) * env * 0.25 * (1 - fam.noise); }
        break;
      }
      case 'pop': case 'bubble': {
        const f0 = type === 'pop' ? 700 * P : 260 * P, f1 = type === 'pop' ? 180 * P : 900 * P;
        const f = f1 + (f0 - f1) * Math.exp(-t / (type === 'pop' ? 0.018 : 0.03));
        ph += f / sr;
        v = osc(fam.wave, ph) * att(k, 0.002 + fam.soft * 0.004) * dec(k, len * 0.35) + (k < sr * 0.004 ? w * 0.3 * fam.bright : 0);
        break;
      }
      case 'click': case 'key': {
        svf.run(w, 1500 + bright * 0.6, 2, sr);
        ph += (type === 'key' ? 2100 : 3200) * P / sr;
        v = (svf.bp * 1.2 + osc('sine', ph) * 0.3) * dec(k, type === 'key' ? 0.008 : 0.004);
        if (type === 'key') { ph2 += 180 * P / sr; v += Math.sin(2 * Math.PI * ph2) * 0.5 * dec(k, 0.015); }
        break;
      }
      case 'tap': {
        ph += (200 * P * (1 + 0.6 * Math.exp(-t / 0.01))) / sr;
        svf.run(w, 900 + bright * 0.3, 1.5, sr);
        v = (Math.sin(2 * Math.PI * ph) * 0.8 + svf.bp * 0.5 * dec(k, 0.01)) * att(k, 0.001 + fam.soft * 0.003) * dec(k, len * 0.3);
        break;
      }
      case 'ding': case 'notify': {
        const f = 880 * P * (type === 'notify' && t > len * 0.22 ? 1.5 : 1);
        const parts = [1, 2.76, 5.4], amps = [1, 0.4 * fam.bright + 0.1, 0.2 * fam.bright];
        for (let i = 0; i < 3; i++) v += Math.sin(2 * Math.PI * f * parts[i] * t) * amps[i] * dec(k, len * (0.45 / (i + 1)));
        v *= att(k, 0.002 + fam.soft * 0.01) * 0.5;
        if (type === 'notify' && Math.abs(t - len * 0.22) < 0.003) v *= 0.3;
        break;
      }
      case 'impact': case 'hit': {
        ph += (45 + 60 * P * Math.exp(-t / 0.05)) / sr;
        svf.run(w, 400 + bright * 0.5 * Math.exp(-t / 0.08), 0.8, sr);
        v = Math.sin(2 * Math.PI * ph) * dec(k, 0.18 + 0.15 * I) * 1.1 + svf.lp * dec(k, 0.06 + fam.noise * 0.1) * 0.9;
        if (type === 'hit') { svf2.run(w, 2000 + bright, 0.7, sr); v += svf2.bp * dec(k, len * 0.35) * 0.35; }
        v *= att(k, 0.0015 + fam.soft * 0.004);
        break;
      }
      case 'glitch': {
        const seg = Math.floor(t / 0.025);
        if (k % Math.round(0.025 * sr) === 0) ph2 = 150 + rand() * 1500 * P;
        ph += ph2 / sr;
        v = (seg % 3 === 2 ? w * 0.5 : osc('square', ph) * 0.6) * (rand() < 0.002 ? 0 : 1) * (1 - p * 0.6);
        break;
      }
      case 'sparkle': {
        // a few bright partials starting at seeded times
        for (let i = 0; i < 6; i++) {
          const st = (i / 6) * len * 0.6 + ((i * 37) % 7) * 0.004;
          if (t >= st) v += Math.sin(2 * Math.PI * (2400 + i * 517) * P * (t - st)) * Math.exp(-(t - st) / 0.08) * 0.25;
        }
        break;
      }
    }
    if (fam.body > 0 && type !== 'riser') { bodyF.run(v, 520 * P, 6, sr); v = v * (1 - fam.body * 0.5) + bodyF.bp * fam.body * 0.9; }
    x[k] = v;
  }
  // bit crush
  if (fam.crush > 0) { const q = Math.pow(2, 12 - fam.crush * 8), hold = 1 + Math.round(fam.crush * 5); let h = 0; for (let k = 0; k < n; k++) { if (k % hold === 0) h = Math.round(x[k] * q) / q; x[k] = h; } }
  // normalize to the family gain, scaled by intensity
  let pk = 0;
  for (let k = 0; k < n; k++) pk = Math.max(pk, Math.abs(x[k]));
  const g = pk > 0 ? (fam.gain * (0.55 + 0.45 * I)) / pk : 0;
  for (let k = 0; k < n; k++) x[k] *= g;
  // stereo: a short haas delay on R and per-channel reverb
  const d = Math.round(fam.width * 0.009 * sr);
  const r0 = new Float32Array(n);
  for (let k = 0; k < n; k++) r0[k] = x[k - d] ?? 0;
  const R = reverb(fam.width > 0 ? r0.map((v, k) => v * fam.width + x[k] * (1 - fam.width)) : x, sr, fam.reverb, 0.6 + fam.reverb, true);
  const L = reverb(x, sr, fam.reverb, 0.6 + fam.reverb, false);
  // a 2 ms fade at the end: no clicks
  const f = Math.min(n, Math.round(sr * 0.002));
  for (let k = 0; k < f; k++) { const a = k / f; L[n - 1 - k] *= a; R[n - 1 - k] *= a; }
  return { L, R, sr, duration: n / sr };
}

/** the sound types each family is auditioned with (a short "sentence": whoosh → pop → ding) */
export const AUDITION: SfxType[] = ['whoosh', 'pop', 'tap', 'ding'];

/** one buffer with a few sounds of a family in a row (preview / audition) */
export function renderAudition(fam: SfxFamily, types: SfxType[] = AUDITION, sr = 44100): SfxRender {
  const parts = types.map(t => renderSfx(t, fam, 0.6, sr));
  const gap = Math.round(0.12 * sr);
  const n = parts.reduce((a, p) => a + Math.round(Math.min(p.duration, 0.9) * sr) + gap, 0);
  const L = new Float32Array(n), R = new Float32Array(n);
  let o = 0;
  for (const p of parts) { const m = Math.min(p.L.length, Math.round(0.9 * sr)); L.set(p.L.subarray(0, m), o); R.set(p.R.subarray(0, m), o); o += m + gap; }
  return { L, R, sr, duration: n / sr };
}
