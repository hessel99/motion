// music analysis on synthetic signals with known ground truth: click tracks at 87 / 120 / 174 bpm,
// swing, silence before the music, a build into a drop, other sample rates, added noise. beats are
// scored with the mir_eval-style F-measure (±70 ms) and at ±1 frame of 60 fps.
import { describe, it, expect } from 'vitest';
import { synthTrack, MUSIC_120, type TrackSpec } from '../src/audio/synth-track';
import { analyzeAudio, beatFMeasure, barTimes, envAt, fft } from '../src/audio/analysis';
import { encodeWav, decodeWav16 } from '../src/audio/wav';

const FRAME = 1 / 60;

function run(spec: TrackSpec, mutate?: (x: Float32Array, sr: number) => void) {
  const tr = synthTrack(spec);
  if (mutate) mutate(tr.samples, tr.sr);
  const a = analyzeAudio(tr.samples, tr.sr);
  return { tr, a, f: beatFMeasure(tr.beats, a.beats).f, fFrame: beatFMeasure(tr.beats, a.beats, FRAME).f, down: beatFMeasure(tr.downbeats, barTimes(a)).f };
}

describe('audio analysis: tempo and beats', () => {
  for (const bpm of [87, 120, 174]) {
    it(`click track at ${bpm} bpm`, () => {
      const r = run({ bpm, sections: [{ kind: 'click', bars: 16 }] });
      expect(Math.abs(r.a.bpm - bpm)).toBeLessThan(0.5);
      expect(r.a.steady).toBe(true);
      expect(r.f).toBeGreaterThanOrEqual(0.98);
      expect(r.fFrame).toBeGreaterThanOrEqual(0.95);
      expect(r.down).toBeGreaterThanOrEqual(0.9);
    });
  }

  it('swung 8ths do not move the quarter-note grid', () => {
    const r = run({ bpm: 96, swing: 1, sections: [{ kind: 'outro', bars: 8 }, { kind: 'drop', bars: 8 }] });
    expect(Math.abs(r.a.bpm - 96)).toBeLessThan(0.5);
    expect(r.f).toBeGreaterThanOrEqual(0.97);
    expect(r.fFrame).toBeGreaterThanOrEqual(0.9);
  });

  it('silence before the music: no beats in the silence, grid exact after', () => {
    const r = run({ bpm: 140, lead: 3.3, sections: [{ kind: 'intro', bars: 4 }, { kind: 'drop', bars: 8 }] });
    expect(r.a.firstSound).toBeGreaterThan(3.25);
    expect(r.a.beats[0]).toBeGreaterThan(3.25);
    expect(r.f).toBeGreaterThanOrEqual(0.97);
    expect(r.fFrame).toBeGreaterThanOrEqual(0.95);
  });

  it('a build into a drop: tempo, beats, bars, the drop as a section and an accent', () => {
    const r = run(MUSIC_120);
    expect(Math.abs(r.a.bpm - 120)).toBeLessThan(0.3);
    expect(r.a.meter).toBe(4);
    expect(r.f).toBeGreaterThanOrEqual(0.98);
    expect(r.fFrame).toBeGreaterThanOrEqual(0.95);
    expect(r.down).toBeGreaterThanOrEqual(0.9);
    const drop = r.a.sections.find(s => s.label === 'drop');
    expect(drop).toBeTruthy();
    expect(Math.abs(drop!.t0 - 16)).toBeLessThan(FRAME);
    expect(r.a.sections[0].label).toBe('build');
    // the drop's first hit is among the strongest accents, within a frame
    const top = Array.from(r.a.accents).map((t, i) => ({ t, s: r.a.accentStrength[i] })).sort((x, y) => y.s - x.s).slice(0, 3);
    expect(top.some(x => Math.abs(x.t - 16) < FRAME)).toBe(true);
    // low band louder in the drop than in the build
    expect(envAt(r.a.low, r.a.envRate, 17) + envAt(r.a.low, r.a.envRate, 18)).toBeGreaterThan(envAt(r.a.low, r.a.envRate, 3) + envAt(r.a.low, r.a.envRate, 4));
  });

  it('a full arrangement: intro, build, drop, breakdown, drop, outro', () => {
    const r = run({ bpm: 128, sections: [{ kind: 'intro', bars: 8 }, { kind: 'build', bars: 8 }, { kind: 'drop', bars: 16 }, { kind: 'breakdown', bars: 8 }, { kind: 'drop', bars: 8 }, { kind: 'outro', bars: 4 }] });
    expect(r.f).toBeGreaterThanOrEqual(0.98);
    const labels = r.a.sections.map(s => s.label);
    expect(labels).toEqual(['intro', 'build', 'drop', 'breakdown', 'drop', 'outro']);
    for (const [i, t] of r.tr.sections.map(s => s.t).entries()) expect(Math.abs(r.a.sections[i].t0 - t)).toBeLessThan(0.05);
  });

  it('48 kHz and added noise (−26 dB)', () => {
    let seed = 3;
    const r = run({ bpm: 110, sr: 48000, sections: [{ kind: 'intro', bars: 2 }, { kind: 'drop', bars: 10 }] }, x => {
      for (let i = 0; i < x.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; x[i] += ((seed / 4294967296) * 2 - 1) * 0.05; }
    });
    expect(Math.abs(r.a.bpm - 110)).toBeLessThan(0.5);
    expect(r.f).toBeGreaterThanOrEqual(0.95);
  });

  it('a 3-minute song analyses in well under 2 s', () => {
    const tr = synthTrack({ bpm: 124, sections: [{ kind: 'intro', bars: 16 }, { kind: 'build', bars: 16 }, { kind: 'drop', bars: 32 }, { kind: 'breakdown', bars: 16 }, { kind: 'drop', bars: 16 }] });
    expect(tr.duration).toBeGreaterThan(180);
    analyzeAudio(tr.samples.subarray(0, tr.sr * 5), tr.sr); // warm up the jit
    const t0 = performance.now();
    const a = analyzeAudio(tr.samples, tr.sr);
    const ms = performance.now() - t0;
    expect(beatFMeasure(tr.beats, a.beats).f).toBeGreaterThan(0.98);
    expect(ms).toBeLessThan(2000);
    // compact: envelopes are bytes at 120 Hz
    expect(a.amp.BYTES_PER_ELEMENT).toBe(1);
    expect(a.amp.length).toBeCloseTo(a.duration * 120, -1);
  });
});

describe('audio analysis: building blocks', () => {
  it('fft matches a direct dft', () => {
    const n = 64, re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.7) + (i % 5) * 0.1;
    const x = Float64Array.from(re);
    fft(re, im);
    for (const k of [0, 3, 17, 40]) {
      let r = 0, j = 0;
      for (let i = 0; i < n; i++) { r += x[i] * Math.cos((2 * Math.PI * k * i) / n); j -= x[i] * Math.sin((2 * Math.PI * k * i) / n); }
      expect(re[k]).toBeCloseTo(r, 9); expect(im[k]).toBeCloseTo(j, 9);
    }
  });

  it('wav round trip', () => {
    const x = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.5);
    const d = decodeWav16(encodeWav([x, x], 22050))!;
    expect(d.sr).toBe(22050);
    expect(d.samples.length).toBe(1000);
    expect(Math.abs(d.samples[123] - x[123])).toBeLessThan(1e-4);
  });

  it('beat F-measure', () => {
    expect(beatFMeasure([1, 2, 3, 4], [1.01, 2.02, 3, 4]).f).toBe(1);
    expect(beatFMeasure([1, 2, 3, 4], [1.5, 2.5]).f).toBe(0);
    expect(beatFMeasure([1, 2, 3, 4], [1, 2]).f).toBeCloseTo(2 / 3, 5);
  });
});
