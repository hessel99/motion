// audio layers: decoded once per asset, played through WebAudio in sync with the playhead.
// the playback clock stays the editor's (frame accurate); audio is (re)scheduled on play,
// on loop wrap and whenever the playhead jumps while playing.

import type { Asset, Composition, Layer } from '../core/model';
import type { Editor } from '../app/editor';
import { valueAt } from '../core/commands';
import { onAnalysis } from './analysis-store';
import { refreshAudioEnv } from './timing';

const buffers = new Map<string, AudioBuffer | 'loading' | 'error'>();
const pending = new Map<string, Promise<AudioBuffer | null>>();
const peaksCache = new Map<string, Float32Array>();
let ctx: AudioContext | null = null;
let onDecoded: (() => void) | null = null;

function audioCtx() {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

export function getAudioBuffer(asset: Asset): AudioBuffer | null {
  const b = buffers.get(asset.id);
  if (b && b !== 'loading' && b !== 'error') return b;
  if (!b) {
    buffers.set(asset.id, 'loading');
    pending.set(asset.id, fetch(asset.data).then(r => r.arrayBuffer()).then(ab => audioCtx().decodeAudioData(ab))
      .then(buf => { buffers.set(asset.id, buf); onDecoded?.(); return buf; })
      .catch(() => { buffers.set(asset.id, 'error'); onDecoded?.(); return null; }));
  }
  return null;
}

/** waits for the decoded buffer (null if decoding failed) */
export async function loadAudioBuffer(asset: Asset): Promise<AudioBuffer | null> {
  return getAudioBuffer(asset) ?? (await pending.get(asset.id)) ?? null;
}

/** min/max peaks per bucket for waveform drawing (cached) */
export function audioPeaks(asset: Asset, buckets = 2048): Float32Array | null {
  const cached = peaksCache.get(asset.id);
  if (cached) return cached;
  const buf = getAudioBuffer(asset);
  if (!buf) return null;
  const ch = buf.getChannelData(0);
  const out = new Float32Array(buckets);
  const step = ch.length / buckets;
  for (let i = 0; i < buckets; i++) {
    let m = 0;
    const a = Math.floor(i * step), b = Math.min(ch.length, Math.floor((i + 1) * step));
    for (let j = a; j < b; j += 4) { const v = Math.abs(ch[j]); if (v > m) m = v; }
    out[i] = m;
  }
  peaksCache.set(asset.id, out);
  return out;
}

export function audioDuration(asset: Asset): number | null {
  const b = getAudioBuffer(asset);
  return b ? b.duration : null;
}

export function audioFailed(asset: Asset): boolean { return buffers.get(asset.id) === 'error'; }

/** drop decoded audio of assets that no longer exist (call after a project load / asset removal) */
export function pruneAudio(assets: Record<string, Asset>) {
  for (const id of [...buffers.keys()]) if (!assets[id]) { buffers.delete(id); pending.delete(id); peaksCache.delete(id); }
}

type ProjectLike = { layers: Record<string, Layer>; assets: Record<string, Asset>; comps: Record<string, Composition> };

/** one audible clip in root comp time: buffer time 0 is at `offset`, audible within [from, to).
 *  volume: static gain; tOff: comp time of the layer's own comp time 0 (precomps) */
export interface AudioClip { layer: Layer; asset: Asset; offset: number; from: number; to: number; volume: number; tOff: number }

/** the clip's volume keys and fades make its gain change over time */
export function clipAnimated(c: AudioClip): boolean {
  const a = c.layer.audio;
  return !!(c.layer.props.volume?.kf?.length || (a?.fadeIn ?? 0) > 0 || (a?.fadeOut ?? 0) > 0);
}

/** gain of a clip at comp time t (static volume × volume keys × fades); bufDur = decoded length */
export function clipGain(c: AudioClip, t: number, bufDur: number): number {
  const l = c.layer, a = l.audio;
  let g = c.volume;
  if (l.props.volume) g *= Math.max(0, valueAt(l, 'volume', t - c.tOff)[0]) / 100;
  const s = Math.max(c.from, c.offset), e = Math.min(c.to, c.offset + bufDur);
  if (a?.fadeIn && a.fadeIn > 0) g *= Math.min(1, Math.max(0, (t - s) / a.fadeIn));
  if (a?.fadeOut && a.fadeOut > 0) g *= Math.min(1, Math.max(0, (e - t) / a.fadeOut));
  return g;
}

/** sets a gain param for playing [from, to) (comp time) starting at context time `at`: a constant, or a
 *  100 Hz curve when the volume is keyed or faded */
export function scheduleGain(p: AudioParam, c: AudioClip, at: number, from: number, to: number, bufDur: number) {
  if (!clipAnimated(c)) { p.value = clipGain(c, from, bufDur); return; }
  const n = Math.max(2, Math.ceil((to - from) * 100) + 1);
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = clipGain(c, from + ((to - from) * i) / (n - 1), bufDur);
  p.value = curve[0];
  try { p.setValueCurveAtTime(curve, at, Math.max(1e-3, to - from)); } catch { p.value = curve[0]; }
}

/**
 * every visible audio layer reachable from the root list, through groups and precomps
 * (precomp start offset, the precomp layer's in/out points and the inner comp's duration).
 */
export function collectAudioClips(project: ProjectLike, root: string[]): AudioClip[] {
  const out: AudioClip[] = [];
  const walk = (ids: string[], tOff: number, lo: number, hi: number, gain: number, stack: string[]) => {
    for (const id of ids) {
      const l = project.layers[id];
      if (!l || !l.visible) continue;
      // layer in/out are in the time of the comp that holds it
      const a = Math.max(lo, l.inPoint + tOff), b = Math.min(hi, l.outPoint + tOff);
      if (b <= a) continue;
      if (l.type === 'audio') {
        const asset = l.imageRef ? project.assets[l.imageRef] : undefined;
        const v = gain * (l.volume ?? 1);
        if (asset && v > 0 && !l.audio?.mute) out.push({ layer: l, asset, offset: tOff + (l.startTime ?? 0), from: a, to: b, volume: v, tOff });
      } else if (l.type === 'precomp') {
        const c = l.compRef ? project.comps[l.compRef] : undefined;
        if (!c || stack.includes(c.id)) continue;
        const off = tOff + (l.startTime ?? 0);
        walk(c.root, off, a, Math.min(b, off + c.duration), gain, [...stack, c.id]);
      } else if (l.children.length) walk(l.children, tOff, a, b, gain, stack);
    }
  };
  walk(root, 0, -Infinity, Infinity, 1, []);
  return out;
}

/**
 * mixes the audible audio of the root comp for [t0, t1) into one stereo buffer, honoring
 * nesting, start time, in/out points and volume. returns null when there is no audible audio.
 */
export async function mixAudio(project: ProjectLike, root: string[], t0: number, t1: number, sampleRate = 48000): Promise<AudioBuffer | null> {
  const clips = collectAudioClips(project, root);
  const len = Math.max(1, Math.ceil((t1 - t0) * sampleRate));
  let oc: OfflineAudioContext | null = null;
  for (const c of clips) {
    const buf = await loadAudioBuffer(c.asset);
    if (!buf) continue;
    const from = Math.max(t0, c.from, c.offset);
    const to = Math.min(t1, c.to, c.offset + buf.duration);
    if (to <= from) continue;
    oc ??= new OfflineAudioContext(2, len, sampleRate);
    const src = oc.createBufferSource();
    src.buffer = buf;
    const gain = oc.createGain();
    scheduleGain(gain.gain, c, from - t0, from, to, buf.duration);
    src.connect(gain).connect(oc.destination);
    src.start(from - t0, from - c.offset, to - from);
  }
  return oc ? oc.startRendering() : null;
}

export class AudioEngine {
  private sources: AudioBufferSourceNode[] = [];
  private wasPlaying = false;
  /** audio clock anchor of the last (re)start: comp time tStart was at ctx time ctxStart */
  private tStart = 0;
  private ctxStart = 0;
  private sig = '';
  private clips: AudioClip[] = [];
  private stale = true;

  constructor(private ed: Editor) {
    onDecoded = () => { ed.emit('audio'); if (ed.store.playing) this.restart(); };
    // music analysis: audio() expressions, beat ticks and snapping follow the comp's music layer
    let envQueued = false;
    const env = () => {
      if (envQueued) return;
      envQueued = true;
      queueMicrotask(() => { envQueued = false; if (refreshAudioEnv(ed.store) && ed.renderer) ed.renderer.dirty = true; });
    };
    onAnalysis(() => { env(); ed.emit('audio'); });
    ed.store.onChange(c => { if (c.structure || c.comp || c.assets || [...c.layers].some(id => ed.store.layer(id)?.type === 'audio')) env(); });
    ed.store.on('comps', env);
    ed.on('loaded', env);
    env();
    // clips are re-collected only after a document change (not every frame)
    // ...and only after one that can change them: a drag of thousands of shape layers while playing
    // must not re-walk the whole layer tree every frame
    ed.store.onChange(c => {
      if (this.stale) return;
      if (c.structure || c.comp || c.assets) { this.stale = true; return; }
      const L = ed.store.project.layers;
      for (const id of c.layers) {
        // audio layers, precomps and anything with children (their in/out/visibility bound the clips below)
        const l = L[id];
        if (!l || l.type === 'audio' || l.type === 'precomp' || l.children.length) { this.stale = true; return; }
      }
    });
    ed.store.on('comps', () => { this.stale = true; pruneAudio(ed.store.project.assets); });
    ed.onFrame((_now, t, playing) => {
      if (playing && !this.wasPlaying) this.restart();
      else if (!playing && this.wasPlaying) this.stopAll();
      else if (playing) {
        // resync when the clips changed (edit, delete, comp switch) or the playhead drifted from
        // the audio clock (scrub, loop wrap, frame step, long frames where the editor clock is capped)
        const sig = this.signature();
        const expected = this.tStart + (this.ctxStart ? audioCtx().currentTime - this.ctxStart : 0);
        // no audible clips (ctxStart 0): nothing to resync. checking drift there restarted (and walked
        // the whole layer tree, precomps included) every few frames of playback.
        if (sig !== this.sig || (this.ctxStart !== 0 && Math.abs(expected - t) > 0.06)) this.restart();
      }
      this.wasPlaying = playing;
    });
  }

  private signature(): string {
    if (!this.stale) return this.sig;
    this.stale = false;
    const st = this.ed.store;
    this.clips = collectAudioClips(st.project, st.comp.root);
    let s = st.comp.id;
    for (const c of this.clips) {
      const a = c.layer.audio, kf = c.layer.props.volume?.kf;
      s += `|${c.layer.id}:${c.asset.id}:${c.offset}:${c.from}:${c.to}:${c.volume}:${a?.fadeIn ?? 0}:${a?.fadeOut ?? 0}:${c.layer.props.volume?.v[0] ?? 100}:${kf ? kf.map(k => k.t + '=' + k.v[0]).join(',') : ''}`;
    }
    return s;
  }

  stopAll() {
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    this.sources = [];
  }

  /** stop now and resync on the next playing frame (the frame loop is about to stop, e.g. export) */
  halt() { this.stopAll(); this.wasPlaying = false; }

  restart() {
    this.stopAll();
    const st = this.ed.store;
    const t = st.time;
    this.stale = true;
    this.sig = this.signature();
    const wa = this.ed.validWorkArea();
    const end = wa ? wa[1] : st.comp.duration;
    if (!this.clips.length) { this.tStart = t; this.ctxStart = 0; return; }
    const ac = audioCtx();
    if (ac.state === 'suspended') ac.resume();
    this.tStart = t; this.ctxStart = ac.currentTime;
    for (const c of this.clips) {
      const buf = getAudioBuffer(c.asset);
      if (!buf) continue;
      const from = Math.max(t, c.from, c.offset);
      const to = Math.min(end, c.to, c.offset + buf.duration);
      if (to <= from) continue;
      const src = ac.createBufferSource();
      src.buffer = buf;
      const gain = ac.createGain();
      scheduleGain(gain.gain, c, ac.currentTime + (from - t), from, to, buf.duration);
      src.connect(gain).connect(ac.destination);
      src.start(ac.currentTime + (from - t), from - c.offset, to - from);
      this.sources.push(src);
    }
  }

  private lastGrain = 0;
  /** scrub audio: a short grain of every clip under the playhead (while dragging it, not playing) */
  scrub(t: number) {
    if (this.ed.store.playing) return;
    const now = performance.now();
    if (now - this.lastGrain < 45) return;
    this.lastGrain = now;
    const st = this.ed.store;
    const ac = audioCtx();
    if (ac.state === 'suspended') ac.resume();
    for (const c of collectAudioClips(st.project, st.comp.root)) {
      const buf = getAudioBuffer(c.asset);
      if (!buf || t < Math.max(c.from, c.offset) || t >= Math.min(c.to, c.offset + buf.duration)) continue;
      const src = ac.createBufferSource();
      src.buffer = buf;
      const g = ac.createGain(), v = clipGain(c, t, buf.duration) * 0.8, at = ac.currentTime, d = 0.08;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(v, at + 0.008);
      g.gain.setValueAtTime(v, at + d - 0.015);
      g.gain.linearRampToValueAtTime(0, at + d);
      src.connect(g).connect(ac.destination);
      src.start(at, t - c.offset, d);
    }
  }
}
