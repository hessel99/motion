// audio layers: decoded once per asset, played through WebAudio in sync with the playhead.
// the playback clock stays the editor's (frame accurate); audio is (re)scheduled on play,
// on loop wrap and whenever the playhead jumps while playing.

import type { Asset, Composition, Layer } from '../core/model';
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

/** one audible clip in root comp time: buffer time 0 is at `offset`, audible within [from, to) */
export interface AudioClip { layer: Layer; asset: Asset; offset: number; from: number; to: number; volume: number }

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
        if (asset && v > 0) out.push({ layer: l, asset, offset: tOff + (l.startTime ?? 0), from: a, to: b, volume: v });
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
    gain.gain.value = c.volume;
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
    // clips are re-collected only after a document change (not every frame)
    ed.store.on('doc', () => { this.stale = true; });
    ed.store.on('comps', () => { this.stale = true; pruneAudio(ed.store.project.assets); });
    ed.onFrame((_now, t, playing) => {
      if (playing && !this.wasPlaying) this.restart();
      else if (!playing && this.wasPlaying) this.stopAll();
      else if (playing) {
        // resync when the clips changed (edit, delete, comp switch) or the playhead drifted from
        // the audio clock (scrub, loop wrap, frame step, long frames where the editor clock is capped)
        const sig = this.signature();
        const expected = this.tStart + (this.ctxStart ? audioCtx().currentTime - this.ctxStart : 0);
        // without clips there is no audio clock to drift from (restarting would walk the whole
        // layer tree every frame)
        if (sig !== this.sig || (this.ctxStart && Math.abs(expected - t) > 0.06)) this.restart();
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
    for (const c of this.clips) s += `|${c.layer.id}:${c.asset.id}:${c.offset}:${c.from}:${c.to}:${c.volume}`;
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
      gain.gain.value = c.volume;
      src.connect(gain).connect(ac.destination);
      src.start(ac.currentTime + (from - t), from - c.offset, to - from);
      this.sources.push(src);
    }
  }
}
