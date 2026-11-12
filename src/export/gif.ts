// animated GIF export (gifenc). frames are read straight from the webgl canvas; one global
// palette (built from sampled frames) avoids color flicker between frames.

import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { editor } from '../app/editor';

export interface GifOptions { maxSize?: number; fps?: number; start?: number; end?: number }

export async function exportGif(opts: GifOptions = {}, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Blob> {
  const r = editor.renderer, store = editor.store, comp = store.comp;
  const maxSize = opts.maxSize ?? 640;
  const scale = Math.min(1, maxSize / Math.max(comp.width, comp.height));
  const w = Math.max(2, Math.round(comp.width * scale)), h = Math.max(2, Math.round(comp.height * scale));
  const fps = Math.min(opts.fps ?? Math.min(comp.fps, 30), 50);
  const t0 = opts.start ?? 0, t1 = opts.end ?? comp.duration;
  const total = Math.max(1, Math.round((t1 - t0) * fps));
  const gl = r.gl;
  const prev = { zoom: r.zoom, panX: r.panX, panY: r.panY, w: r.cssW, h: r.cssH, dpr: r.dpr };
  editor.pause();
  editor.stop();
  editor.renderer.syncRaster = true; // every frame complete and sharp (no async rasters)
  r.resize(w, h, 1);
  r.setView(scale, 0, 0);
  const px = new Uint8Array(w * h * 4);
  const read = async (t: number) => {
    // let async rasters settle so early frames are complete
    for (let k = 0; k < 30; k++) { r.render(t); if (!r.dirty) break; await new Promise(z => setTimeout(z, 16)); }
    await r.settleShaders(t); // figma shaders: wait for this exact frame
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // flip vertically (webgl origin is bottom-left)
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return out;
  };
  try {
    // global palette from ~8 sampled frames
    const samples: Uint8Array[] = [];
    for (let i = 0; i < 8; i++) samples.push(await read(t0 + ((t1 - t0) * (i + 0.5)) / 8));
    const big = new Uint8Array(samples.length * w * h * 4);
    samples.forEach((s, i) => big.set(s, i * w * h * 4));
    const palette = quantize(big, 256, { format: 'rgb565' });
    const gif = GIFEncoder();
    const delay = Math.round(1000 / fps);
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      const rgba = await read(t0 + i / fps);
      gif.writeFrame(applyPalette(rgba, palette, 'rgb565'), w, h, { palette: i === 0 ? palette : undefined, delay });
      onProgress?.(i + 1, total);
      if (i % 10 === 9) await new Promise(z => setTimeout(z, 0)); // keep the ui responsive
    }
    gif.finish();
    return new Blob([gif.bytes() as unknown as BlobPart], { type: 'image/gif' });
  } finally {
    r.resize(prev.w, prev.h, prev.dpr);
    r.setView(prev.zoom, prev.panX, prev.panY);
    r.dirty = true;
    editor.renderer.syncRaster = false;
    editor.resume();
  }
}
