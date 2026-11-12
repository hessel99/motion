// raster worker: draws path / text / gradient-shape rasters off the main thread.
// receives plain layer data (structured clone), returns pixel buffers as transferables.

import { rasterLayer, type RasterClip, type RasterResult } from './raster';
import type { Layer } from '../core/model';
import { ensureFont, loadBundledFonts } from './fonts';

const fontsReady = loadBundledFonts(self.location.href);

export interface RasterJob {
  id: number;
  layer: Layer;
  bucket: number;
  size: number[];
  radius: number[];
  strokeWidth: number;
  /** viewport tile: only this pixel window of the raster */
  clip?: RasterClip;
}

self.onmessage = async (ev: MessageEvent<RasterJob>) => {
  const j = ev.data;
  if (j.layer.type === 'text') { await fontsReady; await ensureFont(j.layer.text!.fontFamily, self.location.href); for (const r of j.layer.text!.runs ?? []) if (r.fontFamily) await ensureFont(r.fontFamily, self.location.href); }
  let r: RasterResult | null = null;
  try {
    r = rasterLayer(j.layer, j.bucket, j.size, j.radius, j.strokeWidth, j.clip);
  } catch (e) {
    (self as any).postMessage({ id: j.id, error: String(e) });
    return;
  }
  if (!r) { (self as any).postMessage({ id: j.id, result: null }); return; }
  (self as any).postMessage({ id: j.id, result: r }, [r.data.buffer]);
};
