// procedural, royalty-free test music: drum patterns (kick / snare / hats / crash), bass, pad and a
// riser, rendered sample-exact from a section plan. deterministic (seeded noise), so tests, the eval
// harness and screenshots all hear the same track and know its ground truth (beats, bars, drop).

export type SectionKind = 'click' | 'intro' | 'build' | 'drop' | 'breakdown' | 'outro';

export interface TrackSpec {
  bpm: number;
  sections: { kind: SectionKind; bars: number }[];
  sr?: number;
  /** seconds of silence before the first beat */
  lead?: number;
  /** 0 = straight 8ths, 1 = triplet swing (off-beat 8ths at 2/3 of the beat) */
  swing?: number;
  /** beats per bar (default 4) */
  meter?: number;
  seed?: number;
}

export interface SynthTrack {
  samples: Float32Array;
  sr: number;
  duration: number;
  /** ground truth, seconds */
  beats: number[];
  downbeats: number[];
  sections: { kind: SectionKind; t: number }[];
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export function synthTrack(spec: TrackSpec): SynthTrack {
  const sr = spec.sr ?? 44100, bpm = spec.bpm, meter = spec.meter ?? 4, lead = spec.lead ?? 0;
  const beat = 60 / bpm, bar = beat * meter;
  const bars = spec.sections.reduce((a, s) => a + s.bars, 0);
  const duration = lead + bars * bar + 1.5; // tail for decays
  const n = Math.ceil(duration * sr);
  const out = new Float32Array(n);
  const rand = rng(spec.seed ?? 7);
  const noise = new Float32Array(sr * 2);
  for (let i = 0; i < noise.length; i++) noise[i] = rand() * 2 - 1;
  const swingAt = 0.5 + (spec.swing ?? 0) * (2 / 3 - 0.5);

  const at = (t: number) => Math.round(t * sr);
  const kick = (t: number, g = 1) => {
    const s0 = at(t), len = Math.floor(sr * 0.32);
    let ph = 0;
    for (let i = 0; i < len && s0 + i < n; i++) {
      const tt = i / sr, f = 45 + 95 * Math.exp(-tt / 0.03);
      ph += (2 * Math.PI * f) / sr;
      out[s0 + i] += g * 0.9 * Math.sin(ph) * Math.exp(-tt / 0.12) + (i < 40 ? g * 0.4 * (1 - i / 40) : 0);
    }
  };
  const snare = (t: number, g = 1) => {
    const s0 = at(t), len = Math.floor(sr * 0.2);
    let prev = 0, ph = 0;
    for (let i = 0; i < len && s0 + i < n; i++) {
      const tt = i / sr, w = noise[(s0 + i) % noise.length];
      const hp = w - prev; prev = w;
      ph += (2 * Math.PI * 185) / sr;
      out[s0 + i] += g * (0.45 * hp * Math.exp(-tt / 0.06) + 0.35 * Math.sin(ph) * Math.exp(-tt / 0.04));
    }
  };
  const hat = (t: number, g = 1, decay = 0.03) => {
    const s0 = at(t), len = Math.floor(sr * decay * 5);
    let p1 = 0, p2 = 0;
    for (let i = 0; i < len && s0 + i < n; i++) {
      const w = noise[(s0 * 3 + i * 7) % noise.length];
      const hp = w - 2 * p1 + p2; p2 = p1; p1 = w;
      out[s0 + i] += g * 0.12 * hp * Math.exp(-(i / sr) / decay);
    }
  };
  const crash = (t: number, g = 1) => {
    const s0 = at(t), len = Math.floor(sr * 1.4);
    let prev = 0;
    for (let i = 0; i < len && s0 + i < n; i++) {
      const w = noise[(s0 * 5 + i * 3) % noise.length], hp = w - prev; prev = w;
      out[s0 + i] += g * 0.22 * hp * Math.exp(-(i / sr) / 0.45);
    }
  };
  const click = (t: number, g = 1) => {
    const s0 = at(t), len = Math.floor(sr * 0.02);
    for (let i = 0; i < len && s0 + i < n; i++) out[s0 + i] += g * 0.8 * Math.sin((2 * Math.PI * 1500 * i) / sr) * Math.exp(-(i / sr) / 0.004);
  };
  const tone = (t: number, dur: number, f: number, g: number, harm = 3, att = 0.005) => {
    const s0 = at(t), len = Math.floor(sr * dur);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const tt = i / sr, env = Math.min(1, tt / att) * Math.exp(-tt / (dur * 0.6));
      let v = 0;
      for (let h = 1; h <= harm; h++) v += Math.sin((2 * Math.PI * f * h * i) / sr) / h;
      out[s0 + i] += g * env * v;
    }
  };
  const pad = (t: number, dur: number, g: number, root: number) => {
    const s0 = at(t), len = Math.floor(sr * dur);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const tt = i / sr, env = Math.min(1, tt / 0.4, (dur - tt) / 0.4);
      out[s0 + i] += g * env * (Math.sin(2 * Math.PI * root * tt) + Math.sin(2 * Math.PI * root * 1.25 * tt) * 0.7 + Math.sin(2 * Math.PI * root * 1.5 * tt) * 0.6) * 0.33;
    }
  };
  const riser = (t: number, dur: number, g: number) => {
    const s0 = at(t), len = Math.floor(sr * dur);
    let prev = 0, ph = 0;
    for (let i = 0; i < len && s0 + i < n; i++) {
      const p = i / len, w = noise[(s0 + i * 11) % noise.length], hp = w - prev; prev = w;
      ph += (2 * Math.PI * (200 + 1800 * p * p)) / sr;
      out[s0 + i] += g * p * p * (0.08 * hp + 0.05 * Math.sin(ph));
    }
  };

  const beats: number[] = [], downbeats: number[] = [], sections: SynthTrack['sections'] = [];
  const roots = [55, 55 * 1.335, 55 * 1.5, 55 * 1.19];
  let b0 = 0;
  for (const sec of spec.sections) {
    const tSec = lead + b0 * bar;
    sections.push({ kind: sec.kind, t: tSec });
    if (sec.kind === 'build') riser(tSec, sec.bars * bar, 1);
    for (let k = 0; k < sec.bars; k++) {
      const barIdx = b0 + k, tb = lead + barIdx * bar, root = roots[barIdx % 4];
      downbeats.push(tb);
      if (sec.kind === 'intro' || sec.kind === 'breakdown') pad(tb, bar, sec.kind === 'intro' ? 0.12 : 0.16, root * 4);
      for (let j = 0; j < meter; j++) {
        const t = tb + j * beat;
        beats.push(t);
        const off = t + swingAt * beat;
        switch (sec.kind) {
          case 'click': click(t, j === 0 ? 1 : 0.6); break;
          case 'intro': if (j === 0) kick(t, 0.7); hat(t, 0.5); hat(off, 0.35); break;
          case 'build': {
            // kick on every beat, snare roll that doubles every quarter of the build
            kick(t, 0.75);
            const q = Math.min(3, Math.floor((k / sec.bars) * 4)), per = [1, 2, 4, 8][q];
            for (let r = 0; r < per; r++) snare(t + (r * beat) / per, (0.3 + 0.35 * ((k * meter + j) / (sec.bars * meter))) / Math.sqrt(per / 2 + 0.5));
            hat(off, 0.4);
            break;
          }
          case 'drop':
            kick(t, 1);
            if (j === 0) { crash(t, 1); tone(t, bar, root, 0.45); }
            if (j % 2 === 1) snare(t, 0.9);
            hat(t, 0.5); hat(off, 0.6); hat(t + beat * 0.25, 0.3); hat(t + beat * 0.75, 0.3);
            tone(off, beat * 0.45, root * 2, 0.12);
            break;
          case 'breakdown': if (j === 0) hat(t, 0.3, 0.08); break;
          case 'outro': if (j % 2 === 0) kick(t, 0.6); hat(off, 0.3); break;
        }
      }
    }
    b0 += sec.bars;
  }
  // gentle limiter
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.95) { const g = 0.95 / peak; for (let i = 0; i < n; i++) out[i] *= g; }
  return { samples: out, sr, duration, beats, downbeats, sections };
}

/** the eval / smoke-test track: 120 bpm, an 8-bar build into a 4-bar drop (24 s) */
export const MUSIC_120: TrackSpec = { bpm: 120, sections: [{ kind: 'build', bars: 8 }, { kind: 'drop', bars: 4 }] };
/** a short sting: 2-bar build, drop at 4 s, 2 bars of drop (8 s) */
export const STING_120: TrackSpec = { bpm: 120, sections: [{ kind: 'build', bars: 2 }, { kind: 'drop', bars: 2 }] };
export const TRACKS: Record<string, TrackSpec> = { music120: MUSIC_120, sting120: STING_120 };
