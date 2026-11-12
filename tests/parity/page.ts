// in-page side of scripts/export-parity.mjs (loaded from the dev server into the editor page):
// loads a parity scene, renders reference frames with the editor's renderer, and runs every
// export path, handing the bytes back to node for decoding and comparison.

import { SCENES } from './scenes';
import { FrameGrabber } from '../../src/export/frames';
import { editor } from '../../src/app/editor';
import { getBitmap } from '../../src/render/raster';
import { loadAudioBuffer } from '../../src/audio/engine';

const b64 = async (b: Blob | Uint8Array): Promise<string> => {
  const blob = b instanceof Blob ? b : new Blob([b as BlobPart]);
  const url = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
  return url.slice(url.indexOf(',') + 1);
};
const u8b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

async function settle() {
  const s = editor.store;
  try { await (document as any).fonts?.ready; } catch { /* */ }
  const until = performance.now() + 8000;
  for (const a of Object.values(s.project.assets)) {
    if (a.kind === 'image') while (!getBitmap(a) && performance.now() < until) await new Promise(r => setTimeout(r, 20));
    if (a.kind === 'audio') await loadAudioBuffer(a);
  }
  for (let k = 0; k < 20; k++) { editor.renderer.render(0); await new Promise(r => setTimeout(r, 30)); if (!editor.renderer.dirty && !editor.renderer.asyncRasters) break; }
  await editor.renderer.settleShaders(0);
}

const api = {
  scenes: () => SCENES.map(s => ({ id: s.id, title: s.title, quick: !!s.quick, tags: s.tags, exportFps: s.exportFps ?? null })),

  async load(id: string) {
    const sc = SCENES.find(s => s.id === id);
    if (!sc) throw new Error('no scene ' + id);
    editor.pause();
    editor.load(sc.build());
    editor.store.setTime(0);
    await settle();
    const c = editor.store.comp;
    return { width: c.width, height: c.height, fps: c.fps, duration: c.duration, exportFps: sc.exportFps ?? c.fps, background: c.background };
  },

  /** editor frames at comp times: premultiplied RGBA, base64 */
  async reference(times: number[], width?: number, height?: number) {
    editor.pause(); editor.stop();
    const g = new FrameGrabber(editor.renderer, editor.store.comp, { width, height });
    g.begin();
    const out: string[] = [];
    try { for (const t of times) out.push(u8b64(await g.grab(t))); } finally { g.end(); editor.resume(); }
    return { width: g.width, height: g.height, frames: out };
  },

  /** comp-space bounding boxes [x0, y0, x1, y1] of layers at times (regions a path reports as
   *  different before export: excluded from its comparison) */
  boxes(ids: string[], times: number[]) {
    const r = editor.renderer;
    return times.map(t => {
      r.evaluate(t, true);
      return ids.map(id => {
        const c = r.corners(id);
        if (!c) return null;
        const xs = [c[0], c[2], c[4], c[6]], ys = [c[1], c[3], c[5], c[7]];
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      }).filter(Boolean);
    });
  },

  async video(opts: any) {
    const { exportVideoDetailed } = await import('../../src/export/video');
    const res = await exportVideoDetailed(opts);
    return { format: res.format, codec: res.codec, width: res.width, height: res.height, fps: res.fps, frames: res.frames, bitrate: res.bitrate, data: await b64(res.blob) };
  },

  async gif(opts: any) {
    const { exportGif } = await import('../../src/export/gif');
    const blob = await exportGif(opts);
    return { data: await b64(blob) };
  },

  async png(t: number, scale = 1) {
    const m: any = await import('../../src/export/png');
    const blob: Blob = await m.framePng(t, scale);
    return { data: await b64(blob) };
  },

  async pngSequence(opts: any) {
    const m: any = await import('../../src/export/png');
    const res = await m.pngSequence(opts);
    return { data: await b64(res.blob), files: res.files };
  },

  async lottie(opts: any = {}) {
    const m = await import('../../src/export/lottie-bake');
    editor.pause(); editor.stop();
    try {
      let ignore: string[] = opts.ignore ?? [];
      if (opts.ignoreAll) { const { lottiePreflight } = await import('../../src/export/lottie'); ignore = lottiePreflight(editor.store.project).map(i => i.id); }
      const r = await m.exportLottieFull(editor.store.project, ignore);
      return { json: JSON.stringify(r.lottie), preflight: r.preflight };
    } finally { editor.resume(); }
  },

  async preview() {
    const { buildPreviewPage } = await import('../../src/app/share/player');
    const p = await buildPreviewPage();
    return { html: p.html };
  },
};

(globalThis as any).__parity = api;
export default api;
