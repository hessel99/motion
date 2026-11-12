// animated GIF export (gifenc). frames are the editor's own (FrameGrabber), at the same frame
// times as the video export. timing: GIF delays are whole centiseconds, so each frame's delay is
// the difference of the rounded start times (3, 3, 4 cs at 30 fps): frames never drift and the
// loop lasts exactly the comp. colours: one global palette from frames sampled across the comp;
// a frame the global palette can't represent well gets its own local palette (no colour drift on
// late, differently coloured frames). transparent comps keep 1-bit transparency (a GIF limit:
// semi-transparent pixels become opaque from 50% alpha up, clear below).

import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { editor } from '../app/editor';
import { FrameGrabber, frameTime, unpremultiply } from './frames';
import { gifDelayCs, gifFrameCount, gifSize } from './gif-timing';

export interface GifOptions { maxSize?: number; fps?: number; start?: number; end?: number }

export { gifFrameCount, gifDelayCs, gifSize };

/** mean squared rgb error of a frame against a palette (sampled) */
function paletteError(rgba: Uint8Array, palette: number[][], idx: Uint8Array) {
  let e = 0, n = 0;
  for (let p = 0; p < idx.length; p += 7) {
    const c = palette[idx[p]], o = p * 4;
    if (rgba[o + 3] < 128) continue;
    e += (c[0] - rgba[o]) ** 2 + (c[1] - rgba[o + 1]) ** 2 + (c[2] - rgba[o + 2]) ** 2;
    n++;
  }
  return n ? e / n : 0;
}

/** transparent comps: the clear colour at index 0 (the background index decoders clear to on
 *  disposal), added when the palette has none */
function clearFirst(pal: number[][], alpha: boolean): number[][] {
  if (!alpha) return pal;
  const i = pal.findIndex(c => c[3] === 0);
  const rest = pal.filter((_, k) => k !== i);
  return [[0, 0, 0, 0], ...rest].slice(0, 256);
}

export async function exportGif(opts: GifOptions = {}, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Blob> {
  const store = editor.store, comp = store.comp;
  const { width: w, height: h } = gifSize(comp.width, comp.height, opts.maxSize ?? 640);
  // browsers stretch delays below 2 cs to 10 cs: 50 fps is the fastest a GIF can really play
  const fps = Math.min(opts.fps ?? Math.min(comp.fps, 30), 50);
  const t0 = Math.max(0, opts.start ?? 0), t1 = Math.min(comp.duration, opts.end ?? comp.duration);
  const total = gifFrameCount(t1 - t0, fps);
  const alpha = comp.background[3] < 1;
  const format = alpha ? 'rgba4444' : 'rgb565';
  editor.pause();
  editor.stop();
  const g = new FrameGrabber(editor.renderer, comp, { width: w, height: h });
  g.begin();
  const read = async (t: number) => {
    const px = unpremultiply((await g.grab(t)).slice());
    // 1-bit alpha; clear pixels lose their colour (palette matching weighs rgb and alpha alike)
    if (alpha) for (let i = 3; i < px.length; i += 4) { if (px[i] < 128) px[i] = px[i - 1] = px[i - 2] = px[i - 3] = 0; else px[i] = 255; }
    return px;
  };
  try {
    // global palette from up to 16 frames across the range
    const ns = Math.min(16, total), sample = new Uint8Array(ns * w * h * 4);
    for (let i = 0; i < ns; i++) sample.set(await read(frameTime(Math.floor(((i + 0.5) * total) / ns), fps, t0, t1)), i * w * h * 4);
    const qopt = alpha ? { format, oneBitAlpha: true, clearAlpha: true } : { format };
    const palette = clearFirst(quantize(sample, 256, qopt as any), alpha);
    const tIndex = alpha ? 0 : -1;
    const gif = GIFEncoder();
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      const rgba = await read(frameTime(i, fps, t0, t1));
      let pal = palette, idx = applyPalette(rgba, palette, format as any), ti = tIndex;
      // > ~6 levels rms off: this frame's colours are not in the global palette
      if (i > 0 && paletteError(rgba, palette, idx) > 40) {
        pal = clearFirst(quantize(rgba, 256, qopt as any), alpha);
        idx = applyPalette(rgba, pal, format as any);
      }
      gif.writeFrame(idx, w, h, {
        palette: i === 0 || pal !== palette ? pal : undefined,
        delay: gifDelayCs(i, fps) * 10,
        transparent: ti >= 0, transparentIndex: Math.max(0, ti),
        // transparent frames replace the previous one instead of drawing over it
        dispose: alpha ? 2 : -1,
      });
      onProgress?.(i + 1, total);
      if (i % 10 === 9) await new Promise(z => setTimeout(z, 0)); // keep the ui responsive
    }
    gif.finish();
    return new Blob([gif.bytes() as unknown as BlobPart], { type: 'image/gif' });
  } finally {
    g.end();
    editor.resume();
  }
}
