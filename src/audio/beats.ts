// onsets / beats of an AudioBuffer. replaced by the full music analysis (analysis.ts: tempo, beat
// grid, bars, sections, accents, envelopes); kept as a small convenience wrapper over it.
import { analyzeAudio } from './analysis';

function mono(buf: AudioBuffer): Float32Array {
  const n = buf.length, ch = buf.numberOfChannels, out = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
  return out;
}

/** onset times in seconds of buffer time (strength ≥ 1 - sensitivity, default all clear onsets) */
export function detectOnsets(buf: AudioBuffer, opts: { minGap?: number; sensitivity?: number } = {}): number[] {
  const a = analyzeAudio(mono(buf), buf.sampleRate);
  const min = 1 - (opts.sensitivity ?? 0.85), gap = opts.minGap ?? 0;
  const out: number[] = [];
  a.onsets.forEach((t, i) => { if (a.onsetStrength[i] >= min && (!out.length || t - out[out.length - 1] >= gap)) out.push(t); });
  return out;
}

/** the beat grid (seconds of buffer time) */
export function detectBeats(buf: AudioBuffer): number[] { return Array.from(analyzeAudio(mono(buf), buf.sampleRate).beats); }
