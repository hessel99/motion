// analysis cache for audio assets: decoded once, analysed in a worker, cached per file hash (memory +
// IndexedDB, so reopening a project or re-pasting a song is instant). analyses live here, beside the
// document, never in it: they are derived data (compact typed arrays) and stay out of undo history.
// the layer only stores the small, undoable overrides (bpm, grid offset) in layer.audio.

import { analyzeAudio, ANALYSIS_VERSION, type AudioAnalysis } from './analysis';
import { decodeWav16 } from './wav';
import type { Asset, Layer } from '../core/model';

const byKey = new Map<string, AudioAnalysis>();
const pending = new Map<string, Promise<AudioAnalysis | null>>();
const hashes = new Map<string, string>();
const failed = new Set<string>();
const listeners = new Set<() => void>();

export function onAnalysis(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
function notify() { for (const f of listeners) { try { f(); } catch (e) { console.error(e); } } }

/** cheap, stable content hash of an asset's data (fnv-1a over the string, sampled for big files) */
export function assetHash(asset: Asset): string {
  let h = hashes.get(asset.id);
  if (h) return h;
  const s = asset.data, n = s.length, step = Math.max(1, Math.floor(n / 2_000_000));
  let a = 0x811c9dc5, b = 0x01000193 ^ n;
  for (let i = 0; i < n; i += step) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 2246822519); }
  h = ((a >>> 0).toString(16) + (b >>> 0).toString(16)).padStart(16, '0') + ':' + n;
  hashes.set(asset.id, h);
  return h;
}

const keyOf = (asset: Asset, bpm?: number) => `${assetHash(asset)}|v${ANALYSIS_VERSION}|${bpm ? Math.round(bpm * 100) / 100 : 'auto'}`;

/** analysis for this asset (and bpm override) if it is ready; starts it otherwise (browser) */
export function getAnalysis(asset: Asset, bpm?: number): AudioAnalysis | null {
  const k = keyOf(asset, bpm);
  const a = byKey.get(k);
  if (a) return a;
  if (!pending.has(k) && !failed.has(k)) ensureAnalysis(asset, bpm);
  return null;
}

export function analysisFailed(asset: Asset, bpm?: number) { return failed.has(keyOf(asset, bpm)); }
export function analysisPending(asset: Asset, bpm?: number) { return pending.has(keyOf(asset, bpm)); }

/** the analysis of an audio layer (its asset + bpm override), or null while it runs */
export function layerAnalysis(l: Layer, assets: Record<string, Asset>): AudioAnalysis | null {
  const asset = l.type === 'audio' && l.imageRef ? assets[l.imageRef] : undefined;
  return asset ? getAnalysis(asset, l.audio?.bpm) : null;
}

/** store an analysis directly (tests, or a precomputed one) */
export function putAnalysis(asset: Asset, a: AudioAnalysis, bpm?: number) { byKey.set(keyOf(asset, bpm), a); notify(); }

export function ensureAnalysis(asset: Asset, bpm?: number): Promise<AudioAnalysis | null> {
  const k = keyOf(asset, bpm);
  const done = byKey.get(k);
  if (done) return Promise.resolve(done);
  let p = pending.get(k);
  if (p) return p;
  p = run(asset, k, bpm).then(a => {
    pending.delete(k);
    if (a) byKey.set(k, a); else failed.add(k);
    notify();
    return a;
  }, e => { console.warn('audio analysis failed', e); pending.delete(k); failed.add(k); notify(); return null; });
  pending.set(k, p);
  return p;
}

async function run(asset: Asset, key: string, bpm?: number): Promise<AudioAnalysis | null> {
  const cached = await idbGet(key);
  if (cached && cached.version === ANALYSIS_VERSION) return cached;
  const pcm = await monoSamples(asset);
  if (!pcm) return null;
  const a = await analyzeInWorker(pcm.samples, pcm.sr, bpm);
  if (a) idbPut(key, a);
  return a;
}

/** mono mix of the decoded asset: WebAudio in the page, a plain wav reader elsewhere (node tests) */
async function monoSamples(asset: Asset): Promise<{ samples: Float32Array; sr: number } | null> {
  if (typeof AudioContext !== 'undefined') {
    const { loadAudioBuffer } = await import('./engine');
    const buf = await loadAudioBuffer(asset);
    if (!buf) return null;
    const n = buf.length, ch = buf.numberOfChannels, out = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
    return { samples: out, sr: buf.sampleRate };
  }
  const m = asset.data.match(/^data:[^;,]*;base64,(.*)$/);
  if (!m) return null;
  const bin = atob(m[1]), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return decodeWav16(bytes);
}

let worker: Worker | null = null;
let wid = 0;
const waiting = new Map<number, (a: AudioAnalysis | null) => void>();
function analyzeInWorker(samples: Float32Array, sr: number, bpm?: number): Promise<AudioAnalysis | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(analyzeAudio(samples, sr, { bpm }));
  try {
    worker ??= (() => {
      const w = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; analysis?: AudioAnalysis; error?: string }>) => {
        const cb = waiting.get(e.data.id);
        waiting.delete(e.data.id);
        if (e.data.error) console.warn('audio analysis:', e.data.error);
        cb?.(e.data.analysis ?? null);
      };
      w.onerror = e => { console.warn('audio analysis worker failed', e.message); for (const cb of waiting.values()) cb(null); waiting.clear(); worker = null; };
      return w;
    })();
  } catch { return Promise.resolve(analyzeAudio(samples, sr, { bpm })); }
  const id = ++wid;
  return new Promise(res => { waiting.set(id, res); worker!.postMessage({ id, samples, sr, bpm }, [samples.buffer]); });
}

// ---------------------------------------------------------------- indexeddb cache (best effort)
const DB = 'motion-audio', STORE = 'analysis';
let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbp ??= new Promise(res => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}
async function idbGet(key: string): Promise<AudioAnalysis | null> {
  const d = await db();
  if (!d) return null;
  return new Promise(res => {
    try { const r = d.transaction(STORE).objectStore(STORE).get(key); r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null); } catch { res(null); }
  });
}
async function idbPut(key: string, a: AudioAnalysis) {
  const d = await db();
  if (!d) return;
  try { d.transaction(STORE, 'readwrite').objectStore(STORE).put(a, key); } catch { /* quota / private mode */ }
}
