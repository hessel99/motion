// audio envelopes for the expression function audio('low' | 'mid' | 'high' | 'amp' | 'beat' | 'bar' |
// 'accent', smoothing?, threshold?). the active composition's music layer registers its analysis here
// (src/audio/analysis-store.ts); expressions read it allocation-free in the render loop (playback and
// export alike). smoothed variants are computed once per (band, smoothing) and cached.

export const AUDIO_BANDS = ['amp', 'low', 'mid', 'high', 'beat', 'bar', 'accent'] as const;
export type AudioBand = typeof AUDIO_BANDS[number];

export interface AudioEnvSource {
  /** comp time of buffer time 0 (layer start time) */
  t0: number;
  /** envelope sample rate (per second) */
  rate: number;
  /** 0..255 per band, same length */
  bands: Uint8Array[];
  /** the clip is audible within [from, to) comp time; outside it every band reads 0 */
  from: number;
  to: number;
  /** volume-independent: gain only scales the result (layer volume / mute) */
  gain: number;
}

let src: AudioEnvSource | null = null;
let version = 0;
const smoothed = new Map<number, Float32Array>();

export function setAudioEnv(s: AudioEnvSource | null) { src = s; version++; smoothed.clear(); }
export function audioEnvVersion() { return version; }
export function hasAudioEnv() { return src !== null; }

export function bandIndex(name: string): number {
  const i = (AUDIO_BANDS as readonly string[]).indexOf(String(name).toLowerCase());
  return i < 0 ? 0 : i;
}

/** one-pole attack (fast, 15 ms) / release (`smooth` seconds) follower over the whole envelope */
function smoothedBand(b: number, smooth: number): Float32Array | null {
  if (!src) return null;
  const q = Math.round(smooth * 100);
  const key = b * 10000 + q;
  let s = smoothed.get(key);
  if (s) return s;
  const raw = src.bands[b], rate = src.rate;
  s = new Float32Array(raw.length);
  const att = 1 - Math.exp(-1 / (0.015 * rate)), rel = 1 - Math.exp(-1 / (Math.max(0.01, q / 100) * rate));
  let y = 0;
  for (let i = 0; i < raw.length; i++) { const x = raw[i] / 255; y += (x - y) * (x > y ? att : rel); s[i] = y; }
  smoothed.set(key, s);
  return s;
}

/** level 0..1 of band b at comp time t. smooth: release time in seconds (0 = raw). threshold 0..1:
 *  levels below it read 0, the rest is rescaled to 0..1 */
export function audioLevel(b: number, t: number, smooth = 0, threshold = 0): number {
  const S = src;
  if (!S || t < S.from || t >= S.to) return 0;
  const x = (t - S.t0) * S.rate;
  let v: number;
  if (smooth > 0.005) {
    const a = smoothedBand(b, smooth);
    if (!a || x < 0 || x >= a.length - 1) return 0;
    const i = Math.floor(x), w = x - i;
    v = a[i] * (1 - w) + a[i + 1] * w;
  } else {
    const a = S.bands[b];
    if (!a || x < 0 || x >= a.length - 1) return 0;
    const i = Math.floor(x), w = x - i;
    v = (a[i] * (1 - w) + a[i + 1] * w) / 255;
  }
  if (threshold > 0) v = threshold >= 1 ? 0 : Math.max(0, (v - threshold) / (1 - threshold));
  return v * S.gain;
}
