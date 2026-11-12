// simple onset ("beat") detection for audio layers: energy flux of a low-passed signal with an
// adaptive threshold. good enough to drop markers on kicks / claps of typical music.

/** onset times in seconds of buffer time */
export function detectOnsets(buf: AudioBuffer, opts: { minGap?: number; sensitivity?: number } = {}): number[] {
  const minGap = opts.minGap ?? 0.18;
  const k = 1.5 - (opts.sensitivity ?? 0.5); // threshold in local std-devs
  const sr = buf.sampleRate, hop = Math.round(sr * 0.01), win = hop * 2;
  const n = buf.length, chs = buf.numberOfChannels;
  const data = Array.from({ length: chs }, (_, c) => buf.getChannelData(c));
  const frames = Math.max(0, Math.floor((n - win) / hop));
  if (frames < 3) return [];
  // energy per frame (mono mix) and its positive log difference (flux)
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const a = f * hop;
    for (let c = 0; c < chs; c++) { const d = data[c]; for (let i = a; i < a + win; i += 2) e += d[i] * d[i]; }
    energy[f] = Math.log(1e-9 + e / (win / 2) / chs);
  }
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, energy[f] - energy[f - 1]);
  // adaptive threshold over ±0.5 s
  const W = 50;
  const out: number[] = [];
  let last = -Infinity;
  let sum = 0, sum2 = 0, cnt = 0, lo = 0, hi = 0;
  for (let f = 1; f < frames - 1; f++) {
    while (hi < Math.min(frames, f + W)) { sum += flux[hi]; sum2 += flux[hi] * flux[hi]; cnt++; hi++; }
    while (lo < f - W) { sum -= flux[lo]; sum2 -= flux[lo] * flux[lo]; cnt--; lo++; }
    const mean = sum / cnt, sd = Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
    const v = flux[f];
    if (v > mean + k * sd && v > 0.3 && v >= flux[f - 1] && v >= flux[f + 1]) {
      const t = (f * hop + win / 2) / sr;
      if (t - last >= minGap) { out.push(t); last = t; }
    }
  }
  return out;
}
