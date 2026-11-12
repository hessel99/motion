// raster worker: draws path / text / gradient-shape rasters off the main thread.
// receives plain layer data (structured clone), returns pixel buffers as transferables.

import { rasterPath, rasterShapePaint, rasterText, type RasterClip, type RasterResult } from './raster';
import type { Layer } from '../core/model';
import { loadBundledFonts } from './fonts';

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
  if (j.layer.type === 'text') await fontsReady;
  let r: RasterResult | null = null;
  try {
    const l = j.layer;
    if (l.type === 'path') r = rasterPath(l, j.bucket, j.strokeWidth, undefined, j.clip);
    else if (l.type === 'text') r = rasterText(l, j.bucket, j.size, j.clip);
    else r = rasterShapePaint(l, j.bucket, j.size, j.radius, j.strokeWidth, j.clip);
  } catch (e) {
    (self as any).postMessage({ id: j.id, error: String(e) });
    return;
  }
  if (!r) { (self as any).postMessage({ id: j.id, result: null }); return; }
  (self as any).postMessage({ id: j.id, result: r }, [r.data.buffer]);
};
