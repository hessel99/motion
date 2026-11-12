// rasterizes layers that can't be drawn analytically in the shader (vector paths, text,
// images, gradient fills) into atlas textures.
//
// "mask" rasters store coverage only: R = fill coverage, G = stroke coverage. the shader
// tints them with the (animatable) fill / stroke colors, so color + opacity animation never
// needs a re-raster. "rgba" rasters (images, gradients) store final premultiplied colors.

import type { Asset, Layer, Paint, PathGeometry } from '../core/model';

export interface RasterResult {
  kind: 'mask' | 'rgba';
  /** pixel size */
  pw: number; ph: number;
  /** placement in the layer's raster space (geometry space for paths, local box otherwise) */
  x: number; y: number; w: number; h: number;
  /** rgba bytes; masks: r=fill g=stroke coverage, rgba: premultiplied color */
  data: Uint8Array;
}

let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

function getCtx(w: number, h: number) {
  if (!canvas) {
    canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true }) as any;
  }
  if (canvas.width < w || canvas.height < h) {
    canvas.width = Math.max(canvas.width, w);
    canvas.height = Math.max(canvas.height, h);
  }
  const c = ctx!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.clearRect(0, 0, w, h);
  return c;
}

const pathCache = new WeakMap<PathGeometry, Path2D>();
export function toPath2D(g: PathGeometry): Path2D {
  let p = pathCache.get(g);
  if (p) return p;
  p = new Path2D();
  for (const c of g.cmds) {
    switch (c[0]) {
      case 'M': p.moveTo(c[1], c[2]); break;
      case 'L': p.lineTo(c[1], c[2]); break;
      case 'C': p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]); break;
      case 'Q': p.quadraticCurveTo(c[1], c[2], c[3], c[4]); break;
      case 'Z': p.closePath(); break;
    }
  }
  pathCache.set(g, p);
  return p;
}

export function geometryBounds(geoms: PathGeometry[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of geoms) for (const c of g.cmds) {
    for (let i = 1; i + 1 < c.length; i += 2) {
      const x = c[i] as number, y = c[i + 1] as number;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (!isFinite(x0)) return [0, 0, 0, 0];
  return [x0, y0, x1 - x0, y1 - y0];
}

const MAX_PX = 2040;

function fitScale(w: number, h: number, scale: number) {
  const s = Math.min(scale, MAX_PX / Math.max(1, w), MAX_PX / Math.max(1, h));
  return Math.max(s, 0.01);
}

/** read back alpha of the current canvas into a channel of out */
function alphaInto(c: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, w: number, h: number, out: Uint8Array, ch: number) {
  const img = c.getImageData(0, 0, w, h).data;
  for (let i = 3, j = ch; i < img.length; i += 4, j += 4) out[j] = img[i];
}

/** premultiplied rgba bytes of the current canvas region */
function rgbaData(c: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, w: number, h: number): Uint8Array {
  const img = c.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(img.length);
  for (let i = 0; i < img.length; i += 4) {
    const a = img[i + 3];
    out[i] = (img[i] * a + 127) / 255;
    out[i + 1] = (img[i + 1] * a + 127) / 255;
    out[i + 2] = (img[i + 2] * a + 127) / 255;
    out[i + 3] = a;
  }
  return out;
}

function finishMask(out: Uint8Array) {
  for (let i = 0; i < out.length; i += 4) out[i + 3] = Math.max(out[i], out[i + 1]);
}

function hasComplexPaint(l: Layer) {
  return !!l.paints && l.paints.some(p => p.type !== 'solid');
}

/** trim (0..1 start/end, offset in turns) for strokes, applied with a dash pattern */
export interface TrimValues { start: number; end: number; offset: number }

/** split a geometry into subpaths (each starts with M) with their measured lengths */
const subpathCache = new WeakMap<PathGeometry, { path: Path2D; len: number }[]>();
function subpaths(g: PathGeometry): { path: Path2D; len: number }[] {
  let c = subpathCache.get(g);
  if (!c) subpathCache.set(g, (c = measureSubpaths(g)));
  return c;
}
function measureSubpaths(g: PathGeometry): { path: Path2D; len: number }[] {
  const out: { path: Path2D; len: number }[] = [];
  let cur: Path2D | null = null, len = 0, x = 0, y = 0, sx = 0, sy = 0;
  const flush = () => { if (cur) out.push({ path: cur, len }); };
  for (const c of g.cmds) {
    if (c[0] === 'M') { flush(); cur = new Path2D(); len = 0; x = sx = c[1]; y = sy = c[2]; cur.moveTo(x, y); continue; }
    if (!cur) { cur = new Path2D(); cur.moveTo(x, y); }
    if (c[0] === 'L') { len += Math.hypot(c[1] - x, c[2] - y); x = c[1]; y = c[2]; cur.lineTo(x, y); }
    else if (c[0] === 'Z') { len += Math.hypot(sx - x, sy - y); x = sx; y = sy; cur.closePath(); }
    else {
      const pts = c[0] === 'C' ? [x, y, c[1], c[2], c[3], c[4], c[5], c[6]] : [x, y, x + (2 / 3) * (c[1] - x), y + (2 / 3) * (c[2] - y), c[3] + (2 / 3) * (c[1] - c[3]), c[4] + (2 / 3) * (c[2] - c[4]), c[3], c[4]];
      let px = x, py = y;
      for (let k = 1; k <= 48; k++) {
        const t = k / 48, u = 1 - t;
        const qx = u * u * u * pts[0] + 3 * u * u * t * pts[2] + 3 * u * t * t * pts[4] + t * t * t * pts[6];
        const qy = u * u * u * pts[1] + 3 * u * u * t * pts[3] + 3 * u * t * t * pts[5] + t * t * t * pts[7];
        len += Math.hypot(qx - px, qy - py); px = qx; py = qy;
      }
      cur.bezierCurveTo(pts[2], pts[3], pts[4], pts[5], pts[6], pts[7]);
      x = pts[6]; y = pts[7];
    }
  }
  flush();
  return out;
}

/** stroke only the trimmed part: visible range over the total length of all subpaths (wraps with offset) */
function strokeTrimmed(c: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, g: PathGeometry, tr: TrimValues) {
  const subs = subpaths(g);
  const L = subs.reduce((a, b) => a + b.len, 0);
  if (L <= 0) return;
  const a = Math.min(tr.start, tr.end), b = Math.max(tr.start, tr.end);
  const vis = Math.min(1, b - a) * L;
  if (vis <= 0.01) return;
  const s0 = ((((a + tr.offset) % 1) + 1) % 1) * L;
  const ranges = s0 + vis <= L + 1e-6 ? [[s0, s0 + vis]] : [[s0, L], [0, s0 + vis - L]];
  let p0 = 0;
  for (const sp of subs) {
    const p1 = p0 + sp.len;
    for (const [r0, r1] of ranges) {
      const o0 = Math.max(p0, r0), o1 = Math.min(p1, r1);
      if (o1 - o0 <= 1e-4) continue;
      // one dash of exactly the visible length, gap longer than the path (never repeats)
      c.setLineDash([o1 - o0, sp.len + L + 1]);
      c.lineDashOffset = -(o0 - p0);
      c.stroke(sp.path);
    }
    p0 = p1;
  }
  c.setLineDash([]);
  c.lineDashOffset = 0;
}

/** vector path: fill + stroke coverage masks in geometry space */
export function rasterPath(l: Layer, scale: number, strokeWidth: number, trimArg?: TrimValues): RasterResult | null {
  const geoms = l.geometry ?? [];
  const strokeGeoms = trimArg ? undefined : l.strokeGeometry;
  trim = trimArg;
  const [bx, by, bw, bh] = geometryBounds(strokeGeoms ? [...geoms, ...strokeGeoms] : geoms);
  const pad = (strokeGeoms ? 0 : strokeWidth) + 2 / scale;
  const x = bx - pad, y = by - pad, w = bw + pad * 2, h = bh + pad * 2;
  const s = fitScale(w, h, scale);
  const pw = Math.max(1, Math.ceil(w * s)), ph = Math.max(1, Math.ceil(h * s));
  const c = getCtx(pw, ph);
  c.setTransform(s, 0, 0, s, -x * s, -y * s);
  if (hasComplexPaint(l)) {
    paintFill(c, l.paints!, geoms.map(toPath2D), geoms, [bx, by, bw, bh], l);
    if (strokeWidth > 0 && l.props.stroke && l.props.stroke.v[3] > 0) strokeGeom(c, l, geoms, strokeGeoms, strokeWidth, cssColor(l.props.stroke.v));
    return { kind: 'rgba', pw, ph, x, y, w: pw / s, h: ph / s, data: rgbaData(c, pw, ph) };
  }
  const out = new Uint8Array(pw * ph * 4);
  c.fillStyle = '#fff';
  for (const g of geoms) c.fill(toPath2D(g), g.fillRule);
  alphaInto(c, pw, ph, out, 0);
  if (strokeWidth > 0 || strokeGeoms) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, pw, ph);
    c.setTransform(s, 0, 0, s, -x * s, -y * s);
    strokeGeom(c, l, geoms, strokeGeoms, strokeWidth, '#fff');
    alphaInto(c, pw, ph, out, 1);
  }
  finishMask(out);
  return { kind: 'mask', pw, ph, x, y, w: pw / s, h: ph / s, data: out };
}

/** where a path mask raster goes (same math as rasterPath) */
export interface PathPlacement { x: number; y: number; s: number; pw: number; ph: number }
export function pathPlacement(l: Layer, scale: number, strokeWidth: number, trimArg?: TrimValues): PathPlacement {
  const geoms = l.geometry ?? [];
  const strokeGeoms = trimArg ? undefined : l.strokeGeometry;
  const [bx, by, bw, bh] = geometryBounds(strokeGeoms ? [...geoms, ...strokeGeoms] : geoms);
  const pad = (strokeGeoms ? 0 : strokeWidth) + 2 / scale;
  const x = bx - pad, y = by - pad, w = bw + pad * 2, h = bh + pad * 2;
  const s = fitScale(w, h, scale);
  return { x, y, s, pw: Math.max(1, Math.ceil(w * s)), ph: Math.max(1, Math.ceil(h * s)) };
}

/** draw a path coverage mask straight into a canvas at (ox, oy): R = fill, G = stroke coverage
 *  (premultiplied, so a premultiplied upload of the canvas gives exactly the mask that rasterPath
 *  reads back with getImageData, without the read-back). clears the 1px gutter around it. */
export function drawPathMask(c: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, pl: PathPlacement, ox: number, oy: number, l: Layer, strokeWidth: number, trimArg?: TrimValues) {
  const geoms = l.geometry ?? [];
  const strokeGeoms = trimArg ? undefined : l.strokeGeometry;
  trim = trimArg;
  const { x, y, s, pw, ph } = pl;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(ox - 1, oy - 1, pw + 2, ph + 2);
  c.beginPath();
  c.rect(ox, oy, pw, ph);
  c.clip();
  c.setTransform(s, 0, 0, s, ox - x * s, oy - y * s);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.fillStyle = '#f00';
  for (const g of geoms) c.fill(toPath2D(g), g.fillRule);
  if (strokeWidth > 0 || strokeGeoms) {
    c.globalCompositeOperation = 'lighter';
    strokeGeom(c, l, geoms, strokeGeoms, strokeWidth, '#0f0');
  }
  c.restore();
  trim = undefined;
}

let trim: TrimValues | undefined;
function strokeGeom(c: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, l: Layer, geoms: PathGeometry[], strokeGeoms: PathGeometry[] | undefined, width: number, style: string) {
  if (strokeGeoms) {
    // figma provides pre-outlined stroke geometry: fill it
    c.fillStyle = style;
    for (const g of strokeGeoms) c.fill(toPath2D(g), g.fillRule);
    return;
  }
  c.strokeStyle = style;
  c.lineJoin = 'round';
  c.lineCap = 'round';
  const align = l.strokeAlign ?? 'center';
  for (const g of geoms) {
    const p = toPath2D(g);
    if (trim) { c.lineWidth = width; strokeTrimmed(c, g, trim); continue; }
    if (align === 'center') { c.lineWidth = width; c.stroke(p); continue; }
    c.save();
    c.lineWidth = width * 2;
    if (align === 'inside') c.clip(p, g.fillRule);
    else {
      // outside: clip to everything except the shape
      const outside = new Path2D();
      outside.rect(-1e5, -1e5, 2e5, 2e5);
      outside.addPath(p);
      c.clip(outside, 'evenodd');
    }
    c.stroke(p);
    c.restore();
  }
  c.setLineDash([]);
  c.lineDashOffset = 0;
}

function cssColor(v: number[]) {
  return `rgba(${(v[0] * 255) | 0},${(v[1] * 255) | 0},${(v[2] * 255) | 0},${v[3] ?? 1})`;
}

function paintFill(c: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, paints: Paint[], paths: Path2D[], geoms: PathGeometry[], box: number[], l: Layer) {
  for (const paint of paints) {
    c.save();
    c.globalAlpha = paint.opacity ?? 1;
    if (paint.type === 'solid') {
      c.fillStyle = cssColor(paint.color ?? [0, 0, 0, 1]);
    } else if ((paint.type === 'linear' || paint.type === 'radial') && paint.stops) {
      // gradient space: unit square mapped onto the layer's geometry box with paint.transform
      const sz = l.geomSize ?? (l.props.size?.v as [number, number]) ?? [box[2], box[3]];
      const m = paint.transform ?? [1, 0, 0, 1, 0, 0];
      c.transform(sz[0], 0, 0, sz[1], 0, 0);
      c.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      const grad = paint.type === 'linear' ? c.createLinearGradient(0, 0.5, 1, 0.5) : c.createRadialGradient(0.5, 0.5, 0, 0.5, 0.5, 0.5);
      for (const s of paint.stops) grad.addColorStop(Math.min(1, Math.max(0, s.pos)), cssColor(s.color));
      c.fillStyle = grad;
      // paths are in geometry space: undo the gradient transform for path drawing
      const inv = invert([sz[0] * m[0], sz[1] * m[1], sz[0] * m[2], sz[1] * m[3], sz[0] * m[4], sz[1] * m[5]]);
      for (let i = 0; i < paths.length; i++) {
        const p = new Path2D();
        p.addPath(paths[i], new DOMMatrix(inv));
        c.fill(p, geoms[i].fillRule);
      }
      c.restore();
      continue;
    } else {
      c.restore();
      continue;
    }
    for (let i = 0; i < paths.length; i++) c.fill(paths[i], geoms[i].fillRule);
    c.restore();
  }
}

function invert(m: number[]) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1e-9;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** rect/ellipse with a gradient paint: rendered as an rgba raster in the local box */
export function rasterShapePaint(l: Layer, scale: number, size: number[], radius: number[], strokeWidth: number): RasterResult {
  const [w, h] = size;
  const pad = strokeWidth + 2 / scale;
  const s = fitScale(w + pad * 2, h + pad * 2, scale);
  const pw = Math.max(1, Math.ceil((w + pad * 2) * s)), ph = Math.max(1, Math.ceil((h + pad * 2) * s));
  const c = getCtx(pw, ph);
  c.setTransform(s, 0, 0, s, pad * s, pad * s);
  const p = new Path2D();
  if (l.type === 'ellipse') p.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else p.roundRect(0, 0, w, h, [radius[0] || 0, radius[1] || 0, radius[2] || 0, radius[3] || 0]);
  const g: PathGeometry = { cmds: [], fillRule: 'nonzero' };
  pathCache.set(g, p);
  const saved = l.geomSize;
  (l as any).geomSize = [w, h];
  paintFill(c, l.paints ?? [], [p], [g], [0, 0, w, h], l);
  (l as any).geomSize = saved;
  if (strokeWidth > 0 && l.props.stroke && l.props.stroke.v[3] > 0) {
    c.strokeStyle = cssColor(l.props.stroke.v);
    c.lineWidth = strokeWidth;
    c.stroke(p);
  }
  return { kind: 'rgba', pw, ph, x: -pad, y: -pad, w: pw / s, h: ph / s, data: rgbaData(c, pw, ph) };
}

// ---------------- text ----------------

export interface TextLine { text: string; width: number }

export function fontString(l: Layer) {
  const t = l.text!;
  const fam = /[\s,]/.test(t.fontFamily) && !t.fontFamily.includes('"') ? `"${t.fontFamily}"` : t.fontFamily;
  return `${t.fontStyle === 'italic' ? 'italic ' : ''}${t.fontWeight} ${t.fontSize}px ${fam}, Inter, system-ui, sans-serif`;
}

let measureCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
export function mctx() {
  if (!measureCtx) {
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : document.createElement('canvas');
    measureCtx = cv.getContext('2d') as any;
  }
  return measureCtx!;
}

export function layoutText(l: Layer, boxWidth: number | null): TextLine[] {
  const t = l.text!;
  const c = mctx();
  c.font = fontString(l);
  (c as any).letterSpacing = `${t.letterSpacing || 0}px`;
  const lines: TextLine[] = [];
  for (const para of t.content.split('\n')) {
    if (boxWidth == null) { lines.push({ text: para, width: c.measureText(para).width }); continue; }
    const words = para.split(/(\s+)/);
    let cur = '';
    for (const w of words) {
      const next = cur + w;
      if (cur && c.measureText(next).width > boxWidth + 0.5 && w.trim()) {
        lines.push({ text: cur.trimEnd(), width: c.measureText(cur.trimEnd()).width });
        cur = w.trimStart();
      } else cur = next;
    }
    lines.push({ text: cur, width: c.measureText(cur).width });
  }
  return lines;
}

export function rasterText(l: Layer, scale: number, size: number[]): RasterResult {
  const t = l.text!;
  const lines = layoutText(l, size[0] > 0 ? size[0] : null);
  const lh = t.fontSize * t.lineHeight;
  const textH = lines.length * lh;
  const maxW = Math.max(size[0], ...lines.map(x => x.width));
  const pad = t.fontSize * 0.5 + 2 / scale;
  const w = maxW + pad * 2, h = Math.max(size[1], textH) + pad * 2;
  const s = fitScale(w, h, scale);
  const pw = Math.max(1, Math.ceil(w * s)), ph = Math.max(1, Math.ceil(h * s));
  const c = getCtx(pw, ph);
  c.setTransform(s, 0, 0, s, pad * s, pad * s);
  c.font = fontString(l);
  (c as any).letterSpacing = `${t.letterSpacing || 0}px`;
  c.textBaseline = 'alphabetic';
  c.fillStyle = '#fff';
  const ascent = t.fontSize * 0.8;
  const half = (lh - t.fontSize) / 2;
  lines.forEach((line, i) => {
    const x = t.align === 'center' ? (size[0] - line.width) / 2 : t.align === 'right' ? size[0] - line.width : 0;
    c.fillText(line.text, x, i * lh + half + ascent);
  });
  const out = new Uint8Array(pw * ph * 4);
  alphaInto(c, pw, ph, out, 0);
  finishMask(out);
  return { kind: 'mask', pw, ph, x: -pad, y: -pad, w: pw / s, h: ph / s, data: out };
}

// ---------------- images ----------------

const bitmaps = new Map<string, ImageBitmap | 'loading' | 'error'>();
export let onImageLoaded: (() => void) | null = null;
export function setImageLoadedHandler(fn: () => void) { onImageLoaded = fn; }

export function getBitmap(asset: Asset): ImageBitmap | null {
  const b = bitmaps.get(asset.id);
  if (b === 'loading' || b === 'error') return null;
  if (b) return b;
  bitmaps.set(asset.id, 'loading');
  fetch(asset.data)
    .then(r => r.blob())
    .then(blob => createImageBitmap(blob))
    .then(bmp => { bitmaps.set(asset.id, bmp); onImageLoaded?.(); })
    .catch(() => bitmaps.set(asset.id, 'error'));
  return null;
}

export function rasterImage(asset: Asset, scale: number, size: number[]): RasterResult | null {
  const bmp = getBitmap(asset);
  if (!bmp) return null;
  const [w, h] = size;
  const s = Math.min(fitScale(w, h, scale), bmp.width / Math.max(1, w), bmp.height / Math.max(1, h)) || 1;
  const pw = Math.max(1, Math.round(w * s)), ph = Math.max(1, Math.round(h * s));
  const c = getCtx(pw, ph);
  c.imageSmoothingQuality = 'high';
  c.drawImage(bmp, 0, 0, pw, ph);
  return { kind: 'rgba', pw, ph, x: 0, y: 0, w, h, data: rgbaData(c, pw, ph) };
}

// ---------------- text units (per char / word / line animation) ----------------

export interface TextUnit { text: string; x: number; y: number; w: number; h: number; index: number }

/** split a text layer into animation units with their position in the layer box */
export function textUnits(l: Layer, boxW: number, by: 'char' | 'word' | 'line'): TextUnit[] {
  const t = l.text!;
  const lines = layoutText(l, boxW > 0 ? boxW : null);
  const c = mctx();
  c.font = fontString(l);
  (c as any).letterSpacing = `${t.letterSpacing || 0}px`;
  const lh = t.fontSize * t.lineHeight;
  const out: TextUnit[] = [];
  const width = boxW > 0 ? boxW : Math.max(...lines.map(x => x.width));
  lines.forEach((line, li) => {
    const lx = t.align === 'center' ? (width - line.width) / 2 : t.align === 'right' ? width - line.width : 0;
    const y = li * lh;
    if (by === 'line') { if (line.text.trim()) out.push({ text: line.text, x: lx, y, w: line.width, h: lh, index: out.length }); return; }
    const parts = by === 'char' ? [...line.text] : line.text.split(/(\s+)/);
    let prefix = '';
    for (const part of parts) {
      const x = lx + (prefix ? c.measureText(prefix).width : 0);
      prefix += part;
      if (!part.trim()) continue;
      out.push({ text: part, x, y, w: c.measureText(part).width, h: lh, index: out.length });
    }
  });
  return out;
}
