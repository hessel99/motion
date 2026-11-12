// PNG export: one frame, or every frame of a range as a numbered sequence in a zip. frames are the
// editor's own (FrameGrabber) at the requested scale, with real transparency (straight alpha, sRGB).

import { zipSync } from 'fflate';
import { editor } from '../app/editor';
import { FrameGrabber, frameTime, unpremultiply } from './frames';

/** output size for a comp at a scale (at least 1 px) */
export function pngSize(w: number, h: number, scale = 1) { return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }; }

async function encode(px: Uint8Array, w: number, h: number): Promise<Blob> {
  const data = new ImageData(new Uint8ClampedArray(px), w, h, { colorSpace: 'srgb' });
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d', { colorSpace: 'srgb' })!.putImageData(data, 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d')!.putImageData(data, 0, 0);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('png encode failed'))), 'image/png'));
}

async function withGrabber<T>(scale: number, fn: (g: FrameGrabber) => Promise<T>): Promise<T> {
  const c = editor.store.comp;
  const { width, height } = pngSize(c.width, c.height, scale);
  const wasPlaying = editor.store.playing;
  editor.pause();
  editor.stop();
  const g = new FrameGrabber(editor.renderer, c, { width, height });
  g.begin();
  try { return await fn(g); } finally { g.end(); editor.resume(); if (wasPlaying) editor.play(); }
}

/** the frame at time t as a png (scale relative to the comp size) */
export async function framePng(t: number, scale = 1): Promise<Blob> {
  return withGrabber(scale, async g => encode(unpremultiply(await g.grab(t)), g.width, g.height));
}

export interface PngSequenceOptions { scale?: number; fps?: number; start?: number; end?: number; name?: string }

/** every frame of [start, end) at fps as name_0000.png … in a zip */
export async function pngSequence(opts: PngSequenceOptions = {}, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<{ blob: Blob; files: number }> {
  const c = editor.store.comp;
  const fps = opts.fps || c.fps;
  const t0 = Math.max(0, opts.start ?? 0), t1 = Math.min(c.duration, opts.end ?? c.duration);
  const total = Math.max(1, Math.ceil((t1 - t0) * fps - 1e-6));
  const base = (opts.name || 'frame').replace(/[^\w\- ]+/g, '_');
  const digits = Math.max(4, String(total - 1).length);
  const files: Record<string, Uint8Array> = {};
  await withGrabber(opts.scale ?? 1, async g => {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      const blob = await encode(unpremultiply(await g.grab(frameTime(i, fps, t0, t1))), g.width, g.height);
      files[`${base}_${String(i).padStart(digits, '0')}.png`] = new Uint8Array(await blob.arrayBuffer());
      onProgress?.(i + 1, total);
    }
  });
  // pngs are already deflated: store them
  const zip = zipSync(files, { level: 0 });
  return { blob: new Blob([zip as BlobPart], { type: 'application/zip' }), files: total };
}
