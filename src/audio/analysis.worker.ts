// runs the music analysis off the main thread. input: mono samples (transferred), output: the
// analysis with its typed arrays transferred back.
import { analyzeAudio } from './analysis';

self.onmessage = (e: MessageEvent<{ id: number; samples: Float32Array; sr: number; bpm?: number }>) => {
  const { id, samples, sr, bpm } = e.data;
  try {
    const a = analyzeAudio(samples, sr, { bpm });
    const transfer = [a.beats, a.beatStrength, a.onsets, a.onsetStrength, a.accents, a.accentStrength, a.amp, a.low, a.mid, a.high].map(x => x.buffer);
    (self as any).postMessage({ id, analysis: a }, transfer);
  } catch (err: any) {
    (self as any).postMessage({ id, error: String(err?.message ?? err) });
  }
};
