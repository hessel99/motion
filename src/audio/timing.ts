// the music of a composition in comp time: which audio layer leads (the first audible, non-sfx audio
// layer), its beats / bars / onsets / accents / sections shifted by the layer's start time and the
// user's grid nudge, the snap targets for the timeline, and the envelopes behind audio().

import type { Layer, Project } from '../core/model';
import { barTimes, type AudioAnalysis, type Section } from './analysis';
import { layerAnalysis } from './analysis-store';
import { setAudioEnv, audioEnvVersion } from '../core/audio-env';
import type { Store } from '../core/store';

export interface Music {
  layer: Layer;
  a: AudioAnalysis;
  /** comp time of buffer time 0 */
  start: number;
  /** comp-time shift of the beat grid (start + grid offset) */
  grid: number;
  /** audible range in comp time */
  from: number;
  to: number;
}

/** audio layers of a comp (root and groups; not inside precomps) */
export function audioLayers(project: Pick<Project, 'layers'>, root: string[]): Layer[] {
  const out: Layer[] = [];
  const walk = (ids: string[]) => { for (const id of ids) { const l = project.layers[id]; if (!l) continue; if (l.type === 'audio') out.push(l); else if (l.children.length) walk(l.children); } };
  walk(root);
  return out;
}

/** a clip with a beat to follow (not a one-shot sound or a short stinger) */
export function isMusic(a: AudioAnalysis): boolean { return a.duration >= 4 && a.beats.length >= 8; }

/** the leading music layer of the active comp with its analysis (null without one, or while analysing) */
export function music(store: Store): Music | null {
  const p = store.project;
  for (const l of audioLayers(p, store.comp.root)) {
    if (l.sfx || !l.visible) continue;
    const a = layerAnalysis(l, p.assets);
    if (!a || !isMusic(a)) continue;
    const start = l.startTime ?? 0;
    return { layer: l, a, start, grid: start + (l.audio?.gridOffset ?? 0), from: Math.max(l.inPoint, start), to: Math.min(l.outPoint, start + a.duration) };
  }
  return null;
}

/** the first non-sfx audio layer (analysed or not) */
export function musicLayer(store: Store): Layer | null {
  return audioLayers(store.project, store.comp.root).find(l => !l.sfx) ?? null;
}

const inRange = (m: Music, t: number) => t >= m.from - 1e-6 && t <= m.to + 1e-6;

export function beats(m: Music): number[] { const out: number[] = []; for (const b of m.a.beats) { const t = b + m.grid; if (inRange(m, t)) out.push(t); } return out; }
export function bars(m: Music): number[] {
  const a = m.a, shift = ((m.layer.audio?.barOffset ?? 0) % a.meter + a.meter) % a.meter;
  const out: number[] = [];
  for (let i = (a.downbeat + shift) % a.meter; i < a.beats.length; i += a.meter) { const t = a.beats[i] + m.grid; if (inRange(m, t)) out.push(t); }
  return out;
}
export function onsets(m: Music, minStrength = 0): { t: number; s: number }[] {
  const out: { t: number; s: number }[] = [];
  m.a.onsets.forEach((o, i) => { const t = o + m.start, s = m.a.onsetStrength[i]; if (s >= minStrength && inRange(m, t)) out.push({ t, s }); });
  return out;
}
export function accents(m: Music): { t: number; s: number }[] {
  const out: { t: number; s: number }[] = [];
  m.a.accents.forEach((o, i) => { const t = o + m.start; if (inRange(m, t)) out.push({ t, s: m.a.accentStrength[i] }); });
  return out;
}
export function sections(m: Music): Section[] {
  return m.a.sections.map(s => ({ ...s, t0: Math.max(m.from, s.t0 + m.start), t1: Math.min(m.to, s.t1 + m.start) })).filter(s => s.t1 > s.t0);
}
export function beatPeriod(m: Music): number { return 60 / m.a.bpm; }
export { barTimes };

// ---------------------------------------------------------------- snapping
let snapCache: { key: string; beats: Float64Array; bars: Float64Array; onsets: Float64Array } | null = null;
/** sorted comp times to snap to (cached until the music or its placement changes) */
export function snapTargets(store: Store): { beats: Float64Array; bars: Float64Array; onsets: Float64Array } | null {
  const m = music(store);
  if (!m) return null;
  const key = `${m.layer.id}|${m.grid}|${m.from}|${m.to}|${m.layer.audio?.barOffset ?? 0}|${m.a.beats.length}|${m.a.bpm}`;
  if (snapCache?.key === key) return snapCache;
  snapCache = { key, beats: Float64Array.from(beats(m)), bars: Float64Array.from(bars(m)), onsets: Float64Array.from(onsets(m, 0.25).map(o => o.t)) };
  return snapCache;
}

/** nearest target to t within maxDist seconds (bars win ties, then beats, then onsets), or null */
export function snapToMusic(store: Store, t: number, maxDist: number, kinds: { bars?: boolean; beats?: boolean; onsets?: boolean } = { bars: true, beats: true, onsets: true }): number | null {
  const s = snapTargets(store);
  if (!s) return null;
  let best: number | null = null, bd = maxDist;
  const scan = (arr: Float64Array, bias: number) => {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < t) lo = mid + 1; else hi = mid; }
    for (const i of [lo - 1, lo]) if (i >= 0 && i < arr.length) { const d = Math.abs(arr[i] - t) * bias; if (d < bd) { bd = d; best = arr[i]; } }
  };
  if (kinds.bars) scan(s.bars, 0.7);
  if (kinds.beats) scan(s.beats, 0.85);
  if (kinds.onsets) scan(s.onsets, 1);
  return best;
}

// ---------------------------------------------------------------- audio() envelopes
const pulses = new WeakMap<AudioAnalysis, Map<string, Uint8Array[]>>();
function pulseBands(a: AudioAnalysis, gridShift: number, barShift: number): Uint8Array[] {
  let m = pulses.get(a);
  if (!m) pulses.set(a, (m = new Map()));
  const key = `${gridShift}|${barShift}`;
  let p = m.get(key);
  if (p) return p;
  const n = a.amp.length, rate = a.envRate, period = 60 / a.bpm;
  const mk = (times: ArrayLike<number>, str: ArrayLike<number> | null, tau: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < times.length; i++) {
      const t0 = times[i], s = str ? str[i] : 1, i0 = Math.max(0, Math.ceil(t0 * rate));
      for (let k = i0; k < n; k++) { const v = s * Math.exp(-(k / rate - t0) / tau); if (v < 0.01) break; out[k] = Math.max(out[k], Math.round(v * 255)); }
    }
    return out;
  };
  const bt = Float64Array.from(a.beats, b => b + gridShift);
  const sh = ((barShift % a.meter) + a.meter) % a.meter;
  const br: number[] = [];
  for (let i = (a.downbeat + sh) % a.meter; i < bt.length; i += a.meter) br.push(bt[i]);
  p = [mk(bt, null, period * 0.3), mk(br, null, period * 0.6), mk(a.accents, a.accentStrength, period * 0.35)];
  if (m.size > 4) m.clear();
  m.set(key, p);
  return p;
}

let envKey = '';
/** (re)register the active comp's music for audio() expressions. cheap when nothing changed */
export function refreshAudioEnv(store: Store): boolean {
  const m = music(store);
  const key = m ? `${m.layer.id}|${m.start}|${m.grid}|${m.from}|${m.to}|${m.layer.audio?.barOffset ?? 0}|${m.a.bpm}|${m.a.beats.length}` : '';
  if (key === envKey) return false;
  envKey = key;
  if (!m) { setAudioEnv(null); return true; }
  const [beat, bar, accent] = pulseBands(m.a, m.grid - m.start, m.layer.audio?.barOffset ?? 0);
  setAudioEnv({ t0: m.start, rate: m.a.envRate, bands: [m.a.amp, m.a.low, m.a.mid, m.a.high, beat, bar, accent], from: m.from, to: m.to, gain: 1 });
  return true;
}
export { audioEnvVersion };
