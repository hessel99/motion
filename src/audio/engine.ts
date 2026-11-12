// audio layers: decoded once per asset, played through WebAudio in sync with the playhead.
// the playback clock stays the editor's (frame accurate); audio is (re)scheduled on play,
// on loop wrap and whenever the playhead jumps while playing.

import type { Asset, Layer } from '../core/model';
import type { Editor } from '../app/editor';

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
      .catch(() => { buffers.set(asset.id, 'error'); return null; }));
  }
  return null;
}

/** waits for the decoded buffer (null if decoding failed) */
export async function loadAudioBuffer(asset: Asset): Promise<AudioBuffer | null> {
  return getAudioBuffer(asset) ?? (await pending.get(asset.id)) ?? null;
}

/**
 * mixes the visible audio layers of the root comp for [t0, t1) into one stereo buffer, honoring
 * start time, in/out points and volume. returns null when there is no audible audio.
 */
export async function mixAudio(project: { layers: Record<string, Layer>; assets: Record<string, Asset> }, root: string[], t0: number, t1: number, sampleRate = 48000): Promise<AudioBuffer | null> {
  const layers = Object.values(project.layers).filter(l => l.type === 'audio' && l.visible && root.includes(l.id) && (l.volume ?? 1) > 0);
  const len = Math.max(1, Math.ceil((t1 - t0) * sampleRate));
  let oc: OfflineAudioContext | null = null;
  for (const l of layers) {
    const asset = l.imageRef ? project.assets[l.imageRef] : undefined;
    if (!asset) continue;
    const buf = await loadAudioBuffer(asset);
    if (!buf) continue;
    const start = l.startTime ?? 0;
    const from = Math.max(t0, l.inPoint, start);
    const to = Math.min(t1, l.outPoint, start + buf.duration);
    if (to <= from) continue;
    oc ??= new OfflineAudioContext(2, len, sampleRate);
    const src = oc.createBufferSource();
    src.buffer = buf;
    const gain = oc.createGain();
    gain.gain.value = l.volume ?? 1;
    src.connect(gain).connect(oc.destination);
    src.start(from - t0, from - start, to - from);
  }
  return oc ? oc.startRendering() : null;
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

export class AudioEngine {
  private sources: AudioBufferSourceNode[] = [];
  private lastTime = 0;
  private wasPlaying = false;

  constructor(private ed: Editor) {
    onDecoded = () => { ed.emit('audio'); if (ed.store.playing) this.restart(); };
    // react to the playhead: start/stop with playback, resync on jumps (scrub, loop wrap)
    ed.onFrame((_now, t, playing) => {
      if (playing && !this.wasPlaying) this.restart();
      else if (!playing && this.wasPlaying) this.stopAll();
      else if (playing && (t < this.lastTime - 0.05 || t > this.lastTime + 0.25)) this.restart();
      this.wasPlaying = playing;
      this.lastTime = t;
    });
  }

  private layers(): Layer[] {
    const st = this.ed.store;
    return Object.values(st.project.layers).filter(l => l.type === 'audio' && l.visible && st.comp.root.includes(l.id));
  }

  stopAll() {
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    this.sources = [];
  }

  restart() {
    this.stopAll();
    const st = this.ed.store;
    const t = st.time;
    const wa = this.ed.validWorkArea();
    const end = wa ? wa[1] : st.comp.duration;
    const ac = audioCtx();
    if (ac.state === 'suspended') ac.resume();
    for (const l of this.layers()) {
      const asset = l.imageRef ? st.project.assets[l.imageRef] : undefined;
      if (!asset) continue;
      const buf = getAudioBuffer(asset);
      if (!buf) continue;
      const start = l.startTime ?? 0;
      const from = Math.max(t, l.inPoint, start);
      const to = Math.min(end, l.outPoint, start + buf.duration);
      if (to <= from) continue;
      const src = ac.createBufferSource();
      src.buffer = buf;
      const gain = ac.createGain();
      gain.gain.value = l.volume ?? 1;
      src.connect(gain).connect(ac.destination);
      src.start(ac.currentTime + (from - t), from - start, to - from);
      this.sources.push(src);
    }
  }
}
