// cheap previews for the agent: many small labeled frames in one image (strip / grid / onion skin)
// and a short low-res GIF saved to a file the agent can reference.

import { editor } from '../app/editor';
import { renderer, st, text, type ToolContent, type ToolDef } from './tool-kit';
import { fmtTime } from './describe';

async function frameImage(t: number, size: number): Promise<HTMLImageElement> {
  const url = renderer().snapshot(t, size);
  const im = new Image();
  await new Promise<void>((res, rej) => { im.onload = () => res(); im.onerror = () => rej(new Error('snapshot decode failed')); im.src = url; });
  return im;
}

/** frames at `times` laid out in `cols` columns (or stacked as an onion skin), labeled, as jpeg base64 */
export async function renderStrip(times: number[], cell: number, layout: 'row' | 'grid' | 'onion'): Promise<string> {
  const c = st().comp;
  const sc = Math.min(1, cell / Math.max(c.width, c.height));
  const w = Math.round(c.width * sc), h = Math.round(c.height * sc);
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d')!;
  if (layout === 'onion') {
    canvas.width = w; canvas.height = h + 14;
    g.fillStyle = '#111'; g.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < times.length; i++) {
      // older frames fainter: the latest frame reads solid, the trail shows spacing
      g.globalAlpha = times.length === 1 ? 1 : 0.15 + 0.85 * Math.pow(i / (times.length - 1), 1.5);
      g.drawImage(await frameImage(times[i], Math.max(w, h)), 0, 14, w, h);
    }
    g.globalAlpha = 1;
    g.fillStyle = '#ddd'; g.font = '10px ui-monospace, Menlo, monospace'; g.textBaseline = 'middle';
    g.fillText(`onion ${fmtTime(times[0])}→${fmtTime(times[times.length - 1])} (${times.length} frames, faint = earlier)`, 3, 7);
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  }
  const cols = layout === 'row' ? times.length : Math.min(times.length, Math.max(1, Math.ceil(Math.sqrt(times.length * (h / w) * 1.6))));
  const rows = Math.ceil(times.length / cols);
  const pad = 2, label = 12;
  canvas.width = cols * (w + pad) + pad;
  canvas.height = rows * (h + pad + label) + pad;
  g.fillStyle = '#111'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.font = '10px ui-monospace, Menlo, monospace'; g.textBaseline = 'middle';
  for (let i = 0; i < times.length; i++) {
    const x = pad + (i % cols) * (w + pad), y = pad + Math.floor(i / cols) * (h + pad + label);
    g.fillStyle = '#ddd';
    g.fillText(`${i + 1}·${(Math.round(times[i] * 100) / 100).toFixed(2)}s`, x + 2, y + label / 2);
    g.drawImage(await frameImage(times[i], Math.max(w, h)), x, y + label, w, h);
  }
  return canvas.toDataURL('image/jpeg', 0.78).split(',')[1];
}

export function stripTimes(a: { frames?: number; start?: number; end?: number; times?: number[] }, max: number): number[] {
  const s = st();
  const wa = s.workArea;
  const t0 = a.start ?? wa?.[0] ?? 0, t1 = a.end ?? wa?.[1] ?? s.comp.duration;
  if (!(t1 >= t0)) throw new Error('end must be after start');
  const n = Math.max(2, Math.min(max, Math.round(a.frames ?? 8)));
  const list = a.times?.length ? a.times.slice(0, max).map(Number) : Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1));
  return list.map(t => Math.min(s.comp.duration, Math.max(0, Math.round(t * s.comp.fps) / s.comp.fps)));
}

export const PREVIEW_TOOLS: ToolDef[] = [
  {
    name: 'preview_strip',
    readOnly: true,
    description: 'One small image with many frames over a time range, each labeled with its time: layout "row" (a filmstrip, best for 4–8 frames of one move), "grid" (up to 24 frames of a longer piece) or "onion" (all frames stacked with older ones fainter: shows spacing, arcs and easing in a single picture). Cheaper than several screenshots; use contact_sheet/screenshot for bigger frames.',
    inputSchema: { type: 'object', properties: {
      frames: { type: 'number', default: 8, description: '2..24' }, start: { type: 'number' }, end: { type: 'number' },
      times: { type: 'array', items: { type: 'number' } }, layout: { enum: ['row', 'grid', 'onion'] }, cell: { type: 'number', default: 160, description: 'max frame size px (64..320)' },
    } },
    run: async a => {
      const layout = a.layout ?? 'grid';
      const ts = stripTimes(a, 24);
      const img = await renderStrip(ts, Math.max(64, Math.min(320, a.cell ?? (layout === 'onion' ? 480 : 160))), layout);
      return [{ type: 'text', text: `${ts.length} frames (${layout}) at ${ts.map(fmtTime).join(', ')}` }, { type: 'image', data: img, mimeType: 'image/jpeg' }];
    },
  },
  {
    name: 'preview_video',
    readOnly: true,
    description: 'Render a short low-res animated GIF of a time range (default: the whole comp, 12 fps, 320 px) and save it to a file; returns the file path (desktop: the exports folder; with the bridge: a temp file). Use it to hand the user / another tool a real-time preview; for your own checks preview_strip is cheaper.',
    inputSchema: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' }, fps: { type: 'number', default: 12 }, maxSize: { type: 'number', default: 320, description: 'px, 120..640' } } },
    run: async a => {
      renderer(); // renders the file on screen: not from a background tab
      const s = st();
      const start = Math.max(0, a.start ?? 0), end = Math.min(s.comp.duration, a.end ?? s.comp.duration);
      if (!(end > start)) throw new Error('end must be after start (seconds within the comp)');
      const fps = Math.max(4, Math.min(30, a.fps ?? 12));
      if ((end - start) * fps > 600) throw new Error(`that is ${Math.round((end - start) * fps)} frames; keep previews under 600 (shorter range or lower fps)`);
      const { exportGif } = await import('../export/gif');
      const blob = await exportGif({ start, end, fps, maxSize: Math.max(120, Math.min(640, a.maxSize ?? 320)) });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const name = `${(s.project.name || 'motion').replace(/[^\w\- ]+/g, '_')}-preview-${start.toFixed(1)}-${end.toFixed(1)}s.gif`;
      const native = (globalThis as any).motionNative;
      const info = `${Math.round((end - start) * fps)} frames @${fps}fps, ${Math.round(buf.length / 1024)} KB`;
      if (native?.saveExport) {
        const path = await native.saveExport({ name, data: btoa(bin), encoding: 'base64' });
        return text(`saved GIF: ${path} (${info})`);
      }
      const out: ToolContent[] = [{ type: 'text', text: `GIF preview ${fmtTime(start)}–${fmtTime(end)}, ${info}` }, { type: 'file', name, data: btoa(bin), mimeType: 'image/gif' }];
      return out;
    },
  },
];
