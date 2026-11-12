// lottie bakes: layers lottie can't draw are rendered by the editor's own renderer into images, in
// the layer's own space (its transform is left to lottie, so it still moves, scales and fades
// exactly like the original). runs a second, private renderer on a scratch copy of the project, so
// the open document, its undo history and the viewport are never touched.

import { Store } from '../core/store';
import { Renderer } from '../render/renderer';
import { setAssetLookup, setImageLoadedHandler, getAssetLookup, onImageLoaded, getBitmap } from '../render/raster';
import { createComp, type Layer, type Project } from '../core/model';
import { FrameGrabber, unpremultiply } from './frames';
import type { BakeRequest, BakeResult } from './lottie';
import { editor } from '../app/editor';

async function pngDataUrl(px: Uint8Array, w: number, h: number): Promise<string> {
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
  const b = await c.convertToBlob({ type: 'image/png' });
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.onerror = () => rej(fr.error); fr.readAsDataURL(b); });
}

function hash(px: Uint8Array) {
  let h = 2166136261 >>> 0;
  const u = new Uint32Array(px.buffer, px.byteOffset, px.byteLength >> 2);
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619) >>> 0;
  return `${h}:${px.length}`;
}

/** a baker for one export: call bake() per request, then dispose() */
export function createBaker(project: Project) {
  let store: Store | null = null, renderer: Renderer | null = null;
  // the scratch renderer takes over the raster module's hooks: they go back to the editor's after each bake
  const prevLookup = getAssetLookup(), prevLoaded = onImageLoaded;
  const restore = () => {
    if (prevLookup) setAssetLookup(prevLookup);
    if (prevLoaded) setImageLoadedHandler(prevLoaded);
  };
  const ensure = () => {
    if (renderer) return renderer;
    store = new Store();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    renderer = new Renderer(store, canvas);
    renderer.cullOffscreen = false;
    return renderer;
  };
  const bake = async (req: BakeRequest): Promise<BakeResult> => {
    const r = ensure();
    setAssetLookup(id => store!.project.assets[id]);
    const layers = req.layers ?? project.layers;
    const src = layers[req.layerId];
    const comp = project.comps[req.compId];
    const [bx, by, bw, bh] = req.box;
    // the layer alone, at its own origin: anchor 0, position = -box origin, no rotation / scale / opacity
    const clone: Layer = { ...src, parent: null, mask: false, blend: undefined, props: { ...src.props } };
    clone.props.anchor = { v: [0, 0] };
    clone.props.position = { v: [-bx, -by] };
    clone.props.scale = { v: [100, 100] };
    clone.props.rotation = { v: [0] };
    clone.props.opacity = { v: [100] };
    const tmp = createComp({ name: 'bake', width: bw, height: bh, fps: comp.fps, duration: comp.duration, background: [0, 0, 0, 0], root: [clone.id] });
    const p: Project = { ...project, comps: { ...project.comps, [tmp.id]: tmp }, activeComp: tmp.id, layers: { ...layers, [clone.id]: clone } };
    store!.load(p);
    const until = performance.now() + 5000;
    for (const a of Object.values(p.assets)) while (a.kind === 'image' && !getBitmap(a) && performance.now() < until) await new Promise(z => setTimeout(z, 20));
    const w = Math.max(1, Math.round(bw * req.scale)), h = Math.max(1, Math.round(bh * req.scale));
    const g = new FrameGrabber(r, tmp, { width: w, height: h });
    g.begin();
    const images: string[] = [], frames: number[] = [], seen = new Map<string, number>();
    try {
      for (const t of req.times) {
        const px = await g.grab(t);
        const key = hash(px);
        let idx = seen.get(key);
        if (idx === undefined) {
          idx = images.length;
          seen.set(key, idx);
          images.push(await pngDataUrl(unpremultiply(px.slice()), w, h));
        }
        frames.push(idx);
      }
    } finally { g.end(); restore(); }
    return { frames, images };
  };
  return {
    bake,
    dispose() { renderer?.dispose(); renderer = null; store = null; restore(); },
  };
}

/** the exact evaluation the editor renders with (expressions, springs): for baking keys */
export function editorSampler() {
  const r = editor.renderer;
  return (id: string, t: number) => r.sampleLayer(id, t);
}

/** the lottie export the app ships: preflight issues baked unless ignored, expressions baked from
 *  the renderer, Inter text as glyph outlines */
export async function exportLottieFull(project: Project, ignore: Iterable<string> = []) {
  const { exportLottieDoc } = await import('./lottie');
  const baker = createBaker(project);
  try {
    const res = await exportLottieDoc(project, { ignore, bake: baker.bake, sample: editorSampler() });
    try { const g = await import('./lottie-glyphs'); await g.addGlyphs(res.lottie); } catch (e) { console.warn('glyphs skipped', e); }
    return res;
  } finally { baker.dispose(); }
}
