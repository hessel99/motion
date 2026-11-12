// video export: renders the active composition frame by frame on the editor's webgl canvas and
// encodes it with WebCodecs (VideoEncoder) into MP4 (H.264) or WebM (VP9), muxed by mediabunny.
//
// the render loop is synchronous per frame: render(t) and `new VideoFrame(canvas)` happen in the
// same task, because the webgl context uses preserveDrawingBuffer:false. the editor's rAF loop is
// stopped for the duration so it cannot draw over (or resize) the canvas between frames.

import {
  Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat, EncodedVideoPacketSource, EncodedPacket,
  AudioBufferSource, getFirstEncodableAudioCodec,
} from 'mediabunny';
import { mixAudio } from '../audio/engine';
import { editor } from '../app/editor';
import { getBitmap } from '../render/raster';

export type VideoFormat = 'mp4' | 'webm';
export type VideoQuality = 'low' | 'medium' | 'high';

export interface ExportVideoOptions {
  /** container; mp4 = H.264, webm = VP9. mp4 falls back to webm/VP9 when H.264 is unavailable */
  format?: VideoFormat;
  /** resolution relative to the comp size (default 1) */
  scale?: number;
  /** output frame rate (default comp fps) */
  fps?: number;
  quality?: VideoQuality;
  /** explicit bitrate in bits/s (overrides quality) */
  bitrate?: number;
  /** time range in seconds (default the whole comp) */
  start?: number;
  end?: number;
}

export interface ExportProgress {
  frame: number;
  total: number;
  /** 0..1 */
  progress: number;
  elapsedMs: number;
  etaMs: number;
  /** frames encoded per second so far */
  fps: number;
}

export interface ExportVideoResult {
  blob: Blob;
  format: VideoFormat;
  codec: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  bitrate: number;
  elapsedMs: number;
}

// ---------------- pure helpers (unit tested) ----------------

/** output size for a comp and scale; both rounded to even numbers (H.264 4:2:0 needs even dims) */
export function evenDimensions(width: number, height: number, scale = 1): { width: number; height: number } {
  const ev = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
  return { width: ev(width), height: ev(height) };
}

const BPP: Record<VideoQuality, number> = { low: 0.05, medium: 0.1, high: 0.2 };

/** target bitrate in bits/s: width*height*fps*bits-per-pixel, clamped to [0.5, 80] Mbit/s */
export function computeBitrate(width: number, height: number, fps: number, quality: VideoQuality = 'medium'): number {
  const raw = width * height * fps * BPP[quality];
  return Math.round(Math.min(80_000_000, Math.max(500_000, raw)));
}

/** number of frames that cover [start, end) at fps (at least 1) */
export function frameCount(duration: number, fps: number): number {
  return Math.max(1, Math.ceil(duration * fps - 1e-6));
}

/** presentation timestamp of frame i in microseconds (integer, no drift) */
export function frameTimestampUs(i: number, fps: number): number {
  return Math.round((i * 1_000_000) / fps);
}

/** duration of frame i in microseconds, so that consecutive frames tile exactly */
export function frameDurationUs(i: number, fps: number): number {
  return frameTimestampUs(i + 1, fps) - frameTimestampUs(i, fps);
}

// H.264 levels: [level_idc, max macroblocks per frame, max macroblocks per second]
const AVC_LEVELS: [number, number, number][] = [
  [0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2a, 8704, 522240],
  [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600],
  [0x3c, 139264, 4177920], [0x3d, 139264, 8355840], [0x3e, 139264, 16711680],
];

/** smallest H.264 level_idc that fits the frame size and rate */
export function avcLevel(width: number, height: number, fps: number): number {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  for (const [lvl, fs, mbps] of AVC_LEVELS) {
    // a dimension may not exceed sqrt(8 * maxFS) macroblocks
    const maxDim = Math.sqrt(8 * fs);
    if (mbs <= fs && mbs * fps <= mbps && Math.ceil(width / 16) <= maxDim && Math.ceil(height / 16) <= maxDim) return lvl;
  }
  return 0x3e;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** codec strings to try, best first */
export function codecCandidates(format: VideoFormat, width: number, height: number, fps: number): string[] {
  if (format === 'mp4') {
    const lvl = avcLevel(width, height, fps);
    const levels = [...new Set([lvl, Math.max(lvl, 0x33), 0x34, 0x3c])];
    const out: string[] = [];
    // high, main, constrained baseline
    for (const profile of ['6400', '4d00', '4240', '42e0']) for (const l of levels) out.push(`avc1.${profile}${hex2(l)}`);
    return out;
  }
  const big = width * height > 2048 * 1152;
  return big ? ['vp09.00.51.08', 'vp09.00.41.08', 'vp8'] : ['vp09.00.41.08', 'vp09.00.51.08', 'vp8'];
}

// ---------------- encoder selection ----------------

interface Picked { format: VideoFormat; codec: string; config: VideoEncoderConfig }

async function pickEncoder(format: VideoFormat, width: number, height: number, fps: number, bitrate: number): Promise<Picked> {
  if (typeof VideoEncoder === 'undefined') throw new Error('WebCodecs VideoEncoder is not available in this browser');
  const tryFormat = async (f: VideoFormat): Promise<Picked | null> => {
    for (const codec of codecCandidates(f, width, height, fps)) {
      for (const hw of ['prefer-hardware', 'no-preference'] as HardwareAcceleration[]) {
        const config: VideoEncoderConfig = {
          codec, width, height, bitrate, framerate: fps,
          bitrateMode: 'variable', latencyMode: 'quality', hardwareAcceleration: hw,
        };
        if (codec.startsWith('avc1')) config.avc = { format: 'avc' };
        try {
          const r = await VideoEncoder.isConfigSupported(config);
          if (r.supported) return { format: f, codec, config };
        } catch { /* invalid string: try next */ }
      }
    }
    return null;
  };
  const p = (await tryFormat(format)) ?? (format === 'mp4' ? await tryFormat('webm') : null);
  if (!p) throw new Error(`no supported video encoder for ${format} at ${width}×${height}`);
  return p;
}

/** which formats/codecs this runtime can encode at a given size (for the ui) */
export async function probeVideoSupport(width = 1920, height = 1080, fps = 30): Promise<Record<VideoFormat, string | null>> {
  const out: Record<VideoFormat, string | null> = { mp4: null, webm: null };
  for (const f of ['mp4', 'webm'] as VideoFormat[]) {
    try { const p = await pickEncoder(f, width, height, fps, computeBitrate(width, height, fps)); if (p.format === f) out[f] = p.codec; } catch { /* none */ }
  }
  return out;
}

// ---------------- export ----------------

const yieldTask = () => new Promise<void>(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

async function waitForAssets() {
  try { await (document as any).fonts?.ready; } catch { /* */ }
  const assets = Object.values(editor.store.project.assets ?? {});
  const until = performance.now() + 5000;
  for (const a of assets) {
    while (a.kind === 'image' && !getBitmap(a) && performance.now() < until) await new Promise(r => setTimeout(r, 20));
  }
}

let exporting = false;
export const isExportingVideo = () => exporting;

/** render + encode the active composition. returns the encoded file */
export async function exportVideo(opts: ExportVideoOptions = {}, onProgress?: (p: ExportProgress) => void, signal?: AbortSignal): Promise<Blob> {
  return (await exportVideoDetailed(opts, onProgress, signal)).blob;
}

export async function exportVideoDetailed(opts: ExportVideoOptions = {}, onProgress?: (p: ExportProgress) => void, signal?: AbortSignal): Promise<ExportVideoResult> {
  if (exporting) throw new Error('an export is already running');
  const store = editor.store, r = editor.renderer;
  const comp = store.comp;
  const fps = Math.max(1, Math.min(240, opts.fps || comp.fps));
  const { width, height } = evenDimensions(comp.width, comp.height, opts.scale ?? 1);
  const t0 = Math.max(0, opts.start ?? 0), t1 = Math.min(comp.duration, opts.end ?? comp.duration);
  const total = frameCount(Math.max(0, t1 - t0), fps);
  const bitrate = opts.bitrate ?? computeBitrate(width, height, fps, opts.quality ?? 'medium');
  const picked = await pickEncoder(opts.format ?? 'mp4', width, height, fps, bitrate);
  const throwIfAborted = () => { if (signal?.aborted) throw new DOMException('export cancelled', 'AbortError'); };
  throwIfAborted();

  exporting = true;
  const wasPlaying = store.playing;
  editor.pause();
  editor.stop();
  editor.renderer.syncRaster = true; // every frame complete and sharp (no async rasters)
  const prev = { zoom: r.zoom, panX: r.panX, panY: r.panY, w: r.cssW, h: r.cssH, dpr: r.dpr, bg: r.editorBg };
  // cover the output exactly (even-rounding may change the aspect by < 1px): scale to cover, center
  const zoom = Math.max(width / comp.width, height / comp.height);
  const panX = (width - comp.width * zoom) / 2, panY = (height - comp.height * zoom) / 2;
  r.editorBg = [0, 0, 0]; // transparent comp backgrounds become black, as in other tools
  // the canvas is drawn at export size during the export: hide it so the compositor doesn't have
  // to present (and scale) every frame. VideoFrame capture reads the drawing buffer regardless.
  const prevVisibility = r.canvas.style.visibility;
  r.canvas.style.visibility = 'hidden';

  const output = new Output({
    format: picked.format === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const source = new EncodedVideoPacketSource(picked.codec.startsWith('avc1') ? 'avc' : picked.codec.startsWith('vp09') ? 'vp9' : 'vp8');
  output.addVideoTrack(source, { frameRate: fps });
  // audio: all audio layers mixed offline into one stereo track
  let audio: { src: AudioBufferSource; buf: AudioBuffer } | null = null;
  {
    const st = editor.store;
    const mixed = await mixAudio(st.project, st.comp.root, t0, t1).catch(() => null);
    if (mixed) {
      const codec = await getFirstEncodableAudioCodec(picked.format === 'mp4' ? ['aac', 'opus'] : ['opus', 'vorbis'], { numberOfChannels: 2, sampleRate: mixed.sampleRate });
      if (codec) {
        const src = new AudioBufferSource({ codec, bitrate: 192_000 });
        output.addAudioTrack(src);
        audio = { src, buf: mixed };
      } else console.warn('no encodable audio codec; exporting without audio');
    }
  }
  let encErr: unknown = null;
  let mux: Promise<void> = Promise.resolve();
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      mux = mux.then(() => source.add(packet, meta)).catch(e => { encErr ??= e; });
    },
    error: e => { encErr ??= e; },
  });
  const started = performance.now();
  let finished = false;
  try {
    await output.start();
    // audio first (it is small): the muxer can then interleave each video packet immediately
    if (audio) { await audio.src.add(audio.buf); audio.src.close(); }
    encoder.configure(picked.config);
    await waitForAssets();
    const keyEvery = Math.max(1, Math.round(fps * 2));
    let lastYield = performance.now(), lastReport = 0;
    for (let i = 0; i < total; i++) {
      throwIfAborted();
      if (encErr) throw encErr;
      // encoder backpressure: keep a short queue so memory stays flat
      while (encoder.encodeQueueSize > 4) {
        await new Promise<void>(res => {
          const done = () => { clearTimeout(to); encoder.removeEventListener('dequeue', done); res(); };
          const to = setTimeout(done, 50);
          encoder.addEventListener('dequeue', done);
        });
        if (encErr) throw encErr;
      }
      const t = Math.min(t0 + i / fps, comp.duration);
      // (re)apply each frame: a ResizeObserver could have reset the canvas between tasks
      r.resize(width, height, 1);
      r.setView(zoom, panX, panY);
      r.render(t);
      // first-time rasters are spread over frames in the editor: for export, finish them now
      for (let k = 0; k < 50 && r.dirty; k++) r.render(t);
      // capture synchronously: the drawing buffer is only valid until this task ends
      const frame = new VideoFrame(r.canvas, { timestamp: frameTimestampUs(i, fps), duration: frameDurationUs(i, fps) });
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
      frame.close();
      const now = performance.now();
      if (onProgress && (now - lastReport > 100 || i === total - 1)) {
        lastReport = now;
        const elapsed = now - started, done = i + 1;
        onProgress({ frame: done, total, progress: done / total, elapsedMs: elapsed, etaMs: (elapsed / done) * (total - done), fps: (done * 1000) / Math.max(1, elapsed) });
      }
      if (now - lastYield > 30) { await yieldTask(); lastYield = performance.now(); }
    }
    await encoder.flush();
    await mux;
    if (encErr) throw encErr;
    await output.finalize();
    finished = true;
    const buf = (output.target as BufferTarget).buffer!;
    const blob = new Blob([buf], { type: picked.format === 'mp4' ? 'video/mp4' : 'video/webm' });
    return { blob, format: picked.format, codec: picked.codec, width, height, fps, frames: total, bitrate, elapsedMs: performance.now() - started };
  } finally {
    try { if (encoder.state !== 'closed') encoder.close(); } catch { /* */ }
    if (!finished) { try { await output.cancel(); } catch { /* */ } }
    r.editorBg = prev.bg;
    r.canvas.style.visibility = prevVisibility;
    r.resize(prev.w, prev.h, prev.dpr);
    r.setView(prev.zoom, prev.panX, prev.panY);
    r.dirty = true;
    exporting = false;
    editor.renderer.syncRaster = false;
    editor.resume();
    if (wasPlaying) editor.play();
  }
}

/** file name for an export */
export function videoFileName(projectName: string, format: VideoFormat) {
  const base = (projectName || 'animation').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'animation';
  return `${base}.${format}`;
}

// handy for debugging and scripted checks (scripts/export-check.mjs --electron), like window.editor
(globalThis as any).motionVideo = { exportVideo, exportVideoDetailed, probeVideoSupport };
