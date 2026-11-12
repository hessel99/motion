// rasterizes layers that can't be drawn analytically in the shader (vector paths, text,
// images, gradient fills) into atlas textures.
//
// "mask" rasters store coverage only: R = fill coverage, G = stroke coverage. the shader
// tints them with the (animatable) fill / stroke colors, so color + opacity animation never
// needs a re-raster. "rgba" rasters (images, gradients) store final premultiplied colors.
//
// paints (figma fidelity): solid, linear / radial / angular / diamond gradients, images (fill / fit /
// tile / stretch-crop, rotation, filters), noise; each with its own opacity and blend mode, stacked
// bottom -> top. strokes: align, dashes, caps, joins, miter limit, per-side weights, stroke paints.
// shapes: rounded boxes with corner smoothing (squircles). text: figma glyph outlines when the text
// is unchanged since the paste, otherwise live layout with runs, case, decoration, lists, truncation.

import { textSig, type Asset, type BlendMode, type ImageFilters, type Layer, type NoiseParams, type Paint, type PathGeometry, type TextData } from '../core/model';

export interface RasterResult {
  kind: 'mask' | 'rgba';
  /** pixel size */
  pw: number; ph: number;
  /** placement in the layer's raster space (geometry space for paths, local box otherwise) */
  x: number; y: number; w: number; h: number;
  /** rgba bytes; masks: r=fill g=stroke coverage, rgba: premultiplied color */
  data: Uint8Array;
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let ctx: Ctx | null = null;

function newCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function getCtx(w: number, h: number) {
  if (!canvas) {
    canvas = newCanvas(w, h);
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

// scratch canvases for layered drawing (stroke paints, paint layers): a small pool by depth
const scratch: { cv: OffscreenCanvas | HTMLCanvasElement; c: Ctx }[] = [];
function scratchCtx(depth: number, w: number, h: number): Ctx {
  let s = scratch[depth];
  if (!s) { const cv = newCanvas(w, h); s = scratch[depth] = { cv, c: cv.getContext('2d') as Ctx }; }
  if (s.cv.width < w || s.cv.height < h) { s.cv.width = Math.max(s.cv.width, w); s.cv.height = Math.max(s.cv.height, h); }
  const c = s.c;
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

/** viewport tile: a pixel window of the layer's raster at scale `s`. x/y are absolute raster pixels
 *  (raster space * scale), so tiles of one level share one pixel grid and line up seamlessly. */
export interface RasterClip { x: number; y: number; pw: number; ph: number }

// ---------------- assets (image paints) ----------------

let assetLookup: ((id: string) => Asset | undefined) | null = null;
/** main thread: how image paints find their asset (workers have none: those layers raster here) */
export function setAssetLookup(fn: (id: string) => Asset | undefined) { assetLookup = fn; }
export function getAssetLookup() { return assetLookup; }

const hasImagePaint = (ps: Paint[] | undefined) => !!ps && ps.some(p => p.type === 'image');
/** layers whose raster needs main-thread data (image bitmaps) */
export function needsMainThread(l: Layer): boolean {
  if (l.type === 'image') return true;
  if (hasImagePaint(l.paints) || hasImagePaint(l.strokePaints)) return true;
  return !!l.geometry?.some(g => hasImagePaint(g.paints));
}

/** a rect / ellipse / group that the sdf shader can't draw (squircle corners, dashes, per-side strokes) */
export function needsShapeRaster(l: Layer): boolean {
  if (l.type !== 'rect' && l.type !== 'ellipse' && l.type !== 'group') return false;
  return (l.smoothing ?? 0) > 0 || !!l.dash?.length || !!l.strokeSides;
}

/** fills / strokes that must be baked into an rgba raster (not a tintable coverage mask) */
export function hasComplexPaint(l: Layer): boolean {
  if (l.paints && l.paints.some(p => (p.type !== 'solid' && p.type !== 'shader') || (p.blend && p.blend !== 'normal'))) return true;
  if (l.strokePaints?.length) return true;
  if (l.geometry?.some(g => g.paints)) return true;
  if (l.type === 'text' && l.text) return textNeedsRgba(l);
  return false;
}

/** the unscaled box a raster of this layer covers (raster space: geometry space for paths, local box
 *  otherwise), without the 2/scale anti-aliasing pad. same math as the raster functions. */
export function rasterBox(l: Layer, size: number[], strokeWidth: number): [number, number, number, number] {
  if (l.type === 'path') {
    const geoms = l.geometry ?? [];
    const strokeGeoms = l.strokeGeometry;
    const [bx, by, bw, bh] = geometryBounds(strokeGeoms ? [...geoms, ...strokeGeoms] : geoms);
    const pad = strokeGeoms ? 0 : strokePad(l, strokeWidth);
    return [bx - pad, by - pad, bw + pad * 2, bh + pad * 2];
  }
  if (l.type === 'text') {
    const b = textBox(l, size);
    return [b.x, b.y, b.w, b.h];
  }
  if (l.type === 'image') return [0, 0, size[0], size[1]];
  const sp = strokePad(l, strokeWidth);
  return [-sp, -sp, size[0] + sp * 2, size[1] + sp * 2];
}

/** how far a stroke can reach outside the shape */
function strokePad(l: Layer, w: number): number {
  const sw = l.strokeSides ? Math.max(w, ...l.strokeSides) : w;
  if (sw <= 0) return 0;
  const align = l.strokeAlign ?? 'center';
  const out = align === 'inside' ? 0 : align === 'outside' ? sw : sw / 2;
  // miter joins / square caps reach further than half the width
  const k = l.type === 'path' && (l.strokeJoin ?? 'miter') === 'miter' ? Math.min(l.miterLimit ?? 4, 4) : l.strokeCap === 'square' ? Math.SQRT2 : 1;
  return Math.max(out, (sw / 2) * k);
}

function fitScale(w: number, h: number, scale: number) {
  const s = Math.min(scale, MAX_PX / Math.max(1, w), MAX_PX / Math.max(1, h));
  return Math.max(s, 0.01);
}

/** read back alpha of the current canvas into a channel of out */
function alphaInto(c: Ctx, w: number, h: number, out: Uint8Array, ch: number) {
  const img = c.getImageData(0, 0, w, h).data;
  for (let i = 3, j = ch; i < img.length; i += 4, j += 4) out[j] = img[i];
}

/** premultiplied rgba bytes of the current canvas region */
function rgbaData(c: Ctx, w: number, h: number): Uint8Array {
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
function strokeTrimmed(c: Ctx, g: PathGeometry, tr: TrimValues) {
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

// ---------------- shapes ----------------

/** rounded box with figma-style corner smoothing (squircle corners). each corner: a circular arc in
 *  the middle and two cubic transitions into the edges; with smoothing 0 it is a plain rounded box.
 *  the transition lengths follow the construction figma described publicly ("desperately seeking
 *  squircles"): p = (1 + smoothing) r along each edge, limited by half the shorter side. */
export function squirclePath(w: number, h: number, radius: number[], smoothing: number): Path2D {
  const p = new Path2D();
  const budget = Math.min(w, h) / 2;
  // corners clockwise from top-left; travel direction along the top edge is +x
  const K: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h]];
  const dirs: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // edge after corner i (top, right, bottom, left)
  const segs: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const r = Math.max(0, Math.min(radius[i] ?? 0, budget));
    if (r <= 1e-6) { segs.push([]); continue; }
    const xi = Math.max(0, Math.min(smoothing, budget / r - 1));
    const pl = Math.min((1 + xi) * r, budget);
    const arcDeg = 90 * (1 - xi);
    const arcLen = Math.sin((arcDeg / 2) * (Math.PI / 180)) * r * Math.SQRT2;
    const alpha = (90 - arcDeg) / 2;
    const p34 = r * Math.tan((alpha / 2) * (Math.PI / 180));
    const beta = 45 * xi * (Math.PI / 180);
    const c = p34 * Math.cos(beta);
    const d = c * Math.tan(beta);
    const b = Math.max(0, (pl - arcLen - c - d) / 3);
    const a = 2 * b;
    segs.push([r, pl, a, b, c, d]);
  }
  // corner i sits between edge (i-1) (incoming, direction e1) and edge i (outgoing, e2)
  const pt = (i: number, s: number, t: number): [number, number] => {
    const e1 = dirs[(i + 3) % 4], e2 = dirs[i];
    return [K[i][0] - s * e1[0] + t * e2[0], K[i][1] - s * e1[1] + t * e2[1]];
  };
  for (let i = 0; i < 4; i++) {
    const sg = segs[i];
    if (!sg.length) { const [x, y] = K[i]; i === 0 ? p.moveTo(x, y) : p.lineTo(x, y); continue; }
    const [r, pl, a, b, c, d] = sg;
    const s0 = pt(i, pl, 0);
    i === 0 ? p.moveTo(s0[0], s0[1]) : p.lineTo(s0[0], s0[1]);
    const c1 = pt(i, pl - a, 0), c2 = pt(i, pl - a - b, 0), p3 = pt(i, pl - a - b - c, d);
    p.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p3[0], p3[1]);
    const ctr = pt(i, r, r), p4 = pt(i, d, pl - a - b - c);
    const a0 = Math.atan2(p3[1] - ctr[1], p3[0] - ctr[0]), a1 = Math.atan2(p4[1] - ctr[1], p4[0] - ctr[0]);
    p.arc(ctr[0], ctr[1], r, a0, a1, false);
    const c3 = pt(i, 0, pl - a - b), c4 = pt(i, 0, pl - a), e = pt(i, 0, pl);
    p.bezierCurveTo(c3[0], c3[1], c4[0], c4[1], e[0], e[1]);
  }
  p.closePath();
  return p;
}

/** the outline of a rect / ellipse / group box in its local space */
export function shapePath(l: Layer, w: number, h: number, radius: number[]): Path2D {
  if (l.type === 'ellipse') { const p = new Path2D(); p.ellipse(w / 2, h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2); return p; }
  const sm = l.smoothing ?? 0;
  if (sm > 0 && radius.some(r => r > 0)) return squirclePath(w, h, radius, sm);
  const p = new Path2D();
  p.roundRect(0, 0, w, h, [Math.max(0, radius[0] || 0), Math.max(0, radius[1] || 0), Math.max(0, radius[2] || 0), Math.max(0, radius[3] || 0)]);
  return p;
}

// ---------------- strokes ----------------

function setStrokeStyle(c: Ctx, l: Layer, width: number, doubled: boolean) {
  c.lineWidth = doubled ? width * 2 : width;
  c.lineJoin = l.strokeJoin ?? (l.type === 'path' ? 'round' : 'miter');
  c.lineCap = l.strokeCap ?? (l.type === 'path' ? 'round' : 'butt');
  c.miterLimit = l.miterLimit ?? 4;
  c.lineDashOffset = 0; // trims set it on this shared context: never let it leak into the next path
  if (l.dash?.length) {
    // figma dashes are measured along the visible stroke (inside/outside strokes use a doubled width,
    // the dash lengths stay the same)
    c.setLineDash(l.dash.length % 2 ? [...l.dash, ...l.dash] : l.dash);
  } else c.setLineDash([]);
}

/** stroke `paths` with the layer's stroke settings in `style` (a color or paint pattern) */
function drawStroke(c: Ctx, l: Layer, paths: Path2D[], rules: CanvasFillRule[], strokeGeoms: PathGeometry[] | undefined, width: number, style: string | CanvasGradient | CanvasPattern, box?: [number, number]) {
  if (strokeGeoms) {
    // figma provides pre-outlined stroke geometry (dashes, caps, joins, variable width): fill it
    c.fillStyle = style;
    for (const g of strokeGeoms) c.fill(toPath2D(g), g.fillRule);
    return;
  }
  c.strokeStyle = style;
  c.fillStyle = style;
  const align = l.strokeAlign ?? 'center';
  if (l.strokeSides && box) {
    // individual side weights: bands along the box edges, cut to the shape
    const [w, h] = box, [t, r, b, lf] = l.strokeSides;
    const k = align === 'inside' ? 0 : align === 'outside' ? 1 : 0.5;
    const bands = new Path2D();
    if (t > 0) bands.rect(-lf * k, -t * k, w + (lf + r) * k, t);
    if (b > 0) bands.rect(-lf * k, h - b * (1 - k), w + (lf + r) * k, b);
    if (lf > 0) bands.rect(-lf * k, -t * k, lf, h + (t + b) * k);
    if (r > 0) bands.rect(w - r * (1 - k), -t * k, r, h + (t + b) * k);
    c.save();
    if (align === 'inside') c.clip(paths[0], rules[0]);
    else if (align === 'outside') { const o = new Path2D(); o.rect(-1e5, -1e5, 2e5, 2e5); o.addPath(paths[0]); c.clip(o, 'evenodd'); }
    c.fill(bands);
    c.restore();
    return;
  }
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (trim) { setStrokeStyle(c, l, width, false); c.setLineDash([]); strokeTrimmed(c, trimGeoms![i], trim); continue; }
    if (align === 'center') { setStrokeStyle(c, l, width, false); c.stroke(p); continue; }
    c.save();
    setStrokeStyle(c, l, width, true);
    if (align === 'inside') c.clip(p, rules[i]);
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

let trim: TrimValues | undefined;
let trimGeoms: PathGeometry[] | undefined;

/** vector path: fill + stroke coverage masks in geometry space */
export function rasterPath(l: Layer, scale: number, strokeWidth: number, trimArg?: TrimValues, clip?: RasterClip): RasterResult | null {
  const geoms = l.geometry ?? [];
  const strokeGeoms = trimArg ? undefined : l.strokeGeometry;
  trim = trimArg; trimGeoms = geoms;
  const [bx, by, bw, bh] = geometryBounds(strokeGeoms ? [...geoms, ...strokeGeoms] : geoms);
  const pad = (strokeGeoms ? 0 : strokePad(l, strokeWidth)) + 2 / scale;
  let x = bx - pad, y = by - pad, w = bw + pad * 2, h = bh + pad * 2;
  let s = fitScale(w, h, scale);
  if (clip) { s = scale; x = clip.x / s; y = clip.y / s; w = clip.pw / s; h = clip.ph / s; }
  const pw = clip ? clip.pw : Math.max(1, Math.ceil(w * s)), ph = clip ? clip.ph : Math.max(1, Math.ceil(h * s));
  const c = getCtx(pw, ph);
  const T = [s, 0, 0, s, -x * s, -y * s];
  c.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  const paths = geoms.map(toPath2D), rules = geoms.map(g => g.fillRule);
  try {
    if (hasComplexPaint(l)) {
      const gs = l.geomSize ?? [bw, bh];
      const anyOwn = geoms.some(g => g.paints);
      if (anyOwn) {
        for (let i = 0; i < geoms.length; i++) paintFill(c, T, geoms[i].paints ?? l.paints ?? solidOf(l), [paths[i]], [rules[i]], gs, pw, ph, 1);
      } else paintFill(c, T, l.paints ?? solidOf(l), paths, rules, gs, pw, ph, 1);
      if (strokeWidth > 0 || strokeGeoms) strokeWithPaints(c, T, l, paths, rules, strokeGeoms, strokeWidth, gs, pw, ph);
      return { kind: 'rgba', pw, ph, x, y, w: pw / s, h: ph / s, data: rgbaData(c, pw, ph) };
    }
    const out = new Uint8Array(pw * ph * 4);
    c.fillStyle = '#fff';
    for (let i = 0; i < paths.length; i++) c.fill(paths[i], rules[i]);
    alphaInto(c, pw, ph, out, 0);
    if (strokeWidth > 0 || strokeGeoms) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, pw, ph);
      c.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
      drawStroke(c, l, paths, rules, strokeGeoms, strokeWidth, '#fff');
      alphaInto(c, pw, ph, out, 1);
    }
    finishMask(out);
    return { kind: 'mask', pw, ph, x, y, w: pw / s, h: ph / s, data: out };
  } finally { trim = undefined; trimGeoms = undefined; }
}

function solidOf(l: Layer): Paint[] {
  const v = l.props.fill?.v ?? [0, 0, 0, 0];
  return [{ type: 'solid', color: [v[0], v[1], v[2], v[3] ?? 1] }];
}

/** stroke drawn with the layer's stroke paints (or its solid stroke color) */
function strokeWithPaints(c: Ctx, T: number[], l: Layer, paths: Path2D[], rules: CanvasFillRule[], strokeGeoms: PathGeometry[] | undefined, width: number, box: [number, number] | number[], pw: number, ph: number) {
  if (!l.strokePaints?.length) {
    const sv = l.props.stroke?.v;
    if (!sv || sv[3] <= 0) return;
    drawStroke(c, l, paths, rules, strokeGeoms, width, cssColor(sv), [box[0], box[1]]);
    return;
  }
  // stroke coverage on a scratch canvas, then the paints inside it, then onto the raster
  const sc = scratchCtx(0, pw, ph);
  sc.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  drawStroke(sc, l, paths, rules, strokeGeoms, width, '#fff', [box[0], box[1]]);
  const full = new Path2D();
  full.rect(-1e5, -1e5, 2e5, 2e5);
  sc.globalCompositeOperation = 'source-in';
  paintFill(sc, T, l.strokePaints, [full], ['nonzero'], box, pw, ph, 1);
  sc.globalCompositeOperation = 'source-over';
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.drawImage(sc.canvas as CanvasImageSource, 0, 0, pw, ph, 0, 0, pw, ph);
  c.restore();
}

/** where a path mask raster goes (same math as rasterPath) */
export interface PathPlacement { x: number; y: number; s: number; pw: number; ph: number }
export function pathPlacement(l: Layer, scale: number, strokeWidth: number, trimArg?: TrimValues): PathPlacement {
  const geoms = l.geometry ?? [];
  const strokeGeoms = trimArg ? undefined : l.strokeGeometry;
  const [bx, by, bw, bh] = geometryBounds(strokeGeoms ? [...geoms, ...strokeGeoms] : geoms);
  const pad = (strokeGeoms ? 0 : strokePad(l, strokeWidth)) + 2 / scale;
  const x = bx - pad, y = by - pad, w = bw + pad * 2, h = bh + pad * 2;
  const s = fitScale(w, h, scale);
  return { x, y, s, pw: Math.max(1, Math.ceil(w * s)), ph: Math.max(1, Math.ceil(h * s)) };
}

/** draw a path coverage mask straight into a canvas at (ox, oy): R = fill, G = stroke coverage
 *  (premultiplied, so a premultiplied upload of the canvas gives exactly the mask that rasterPath
 *  reads back with getImageData, without the read-back). clears the 1px gutter around it. */
export function drawPathMask(c: Ctx, pl: PathPlacement, ox: number, oy: number, l: Layer, strokeWidth: number, trimArg?: TrimValues) {
  const geoms = l.geometry ?? [];
  const strokeGeoms = trimArg ? undefined : l.strokeGeometry;
  trim = trimArg; trimGeoms = geoms;
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
    drawStroke(c, l, geoms.map(toPath2D), geoms.map(g => g.fillRule), strokeGeoms, strokeWidth, '#0f0');
  }
  c.restore();
  trim = undefined; trimGeoms = undefined;
}

export function cssColor(v: number[]) {
  return `rgba(${Math.round(v[0] * 255)},${Math.round(v[1] * 255)},${Math.round(v[2] * 255)},${v[3] ?? 1})`;
}

// ---------------- paints ----------------

const COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', add: 'lighter', darken: 'darken', lighten: 'lighten',
  overlay: 'overlay', softLight: 'soft-light', hardLight: 'hard-light', colorDodge: 'color-dodge', colorBurn: 'color-burn',
  linearBurn: 'multiply', // no canvas equivalent: closest separable mode
  difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

function stopsGradient(g: CanvasGradient, p: Paint) {
  for (const s of p.stops ?? []) g.addColorStop(Math.min(1, Math.max(0, s.pos)), cssColor(s.color));
}

/** paints (bottom -> top) inside paths. T: the canvas transform of raster space, box: the size of
 *  the box paints are laid out in (layer box / geometry size) */
function paintFill(c: Ctx, T: number[], paints: Paint[], paths: Path2D[], rules: CanvasFillRule[], box: [number, number] | number[], pw: number, ph: number, depth: number) {
  const [bw, bh] = box;
  for (const paint of paints) {
    const op = paint.opacity ?? 1;
    if (op <= 0) continue;
    c.save();
    c.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
    c.globalAlpha = op;
    const mode = paint.blend && paint.blend !== 'normal' ? COMPOSITE[paint.blend] : null;
    if (mode && c.globalCompositeOperation === 'source-over') c.globalCompositeOperation = mode;
    // clip to the shape, then cover the clip with the paint
    const clipPath = paths.length === 1 ? paths[0] : (() => { const u = new Path2D(); for (const p of paths) u.addPath(p); return u; })();
    c.clip(clipPath, paths.length === 1 ? rules[0] : 'nonzero');
    const cover = () => { c.setTransform(1, 0, 0, 1, 0, 0); c.fillRect(0, 0, pw, ph); };
    switch (paint.type) {
      case 'solid': c.fillStyle = cssColor(paint.color ?? [0, 0, 0, 1]); cover(); break;
      case 'linear': case 'radial': case 'angular': case 'diamond': {
        if (!paint.stops?.length) break;
        const m = paint.transform ?? [1, 0, 0, 1, 0, 0];
        // gradient space: unit square mapped onto the box with paint.transform
        c.transform(bw, 0, 0, bh, 0, 0);
        c.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        if (paint.type === 'linear') { const g = c.createLinearGradient(0, 0.5, 1, 0.5); stopsGradient(g, paint); c.fillStyle = g; fillUnitCover(c); }
        else if (paint.type === 'radial') { const g = c.createRadialGradient(0.5, 0.5, 0, 0.5, 0.5, 0.5); stopsGradient(g, paint); c.fillStyle = g; fillUnitCover(c); }
        else if (paint.type === 'angular') {
          if (typeof (c as any).createConicGradient === 'function') { const g = (c as any).createConicGradient(0, 0.5, 0.5) as CanvasGradient; stopsGradient(g, paint); c.fillStyle = g; fillUnitCover(c); }
          else { const g = c.createRadialGradient(0.5, 0.5, 0, 0.5, 0.5, 0.5); stopsGradient(g, paint); c.fillStyle = g; fillUnitCover(c); }
        } else {
          // diamond: |dx| + |dy| from the center, i.e. a linear gradient per quadrant
          const q: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
          for (const [sx, sy] of q) {
            c.save();
            const tri = new Path2D();
            tri.moveTo(0.5, 0.5); tri.lineTo(0.5 + sx * 1e4, 0.5); tri.lineTo(0.5 + sx * 1e4, 0.5 + sy * 1e4); tri.lineTo(0.5, 0.5 + sy * 1e4); tri.closePath();
            c.clip(tri);
            const g = c.createLinearGradient(0.5, 0.5, 0.5 + sx * 0.25, 0.5 + sy * 0.25);
            stopsGradient(g, paint);
            c.fillStyle = g;
            c.fill(tri);
            c.restore();
          }
        }
        break;
      }
      case 'image': drawImagePaint(c, paint, bw, bh); break;
      case 'noise': if (paint.noise) drawNoise(c, paint.noise, bw, bh, T); break;
      default: break;
    }
    c.restore();
  }
  void depth;
}

/** cover the whole (huge) area in the current gradient space */
function fillUnitCover(c: Ctx) { c.fillRect(-1e4, -1e4, 2e4, 2e4); }

// image paints: bitmaps load async (getBitmap); filtered versions are cached per asset + filters
const filtered = new Map<string, OffscreenCanvas | HTMLCanvasElement>();
function filteredImage(asset: Asset, bmp: ImageBitmap, f: ImageFilters | undefined): CanvasImageSource {
  if (!f || !Object.keys(f).length) return bmp;
  const key = asset.id + JSON.stringify(f);
  let cv = filtered.get(key);
  if (cv) return cv;
  const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  cv = newCanvas(w, h);
  const c = cv.getContext('2d', { willReadFrequently: true }) as Ctx;
  c.drawImage(bmp, 0, 0, w, h);
  const img = c.getImageData(0, 0, w, h);
  applyImageFilters(img.data, f);
  c.putImageData(img, 0, 0);
  if (filtered.size > 32) filtered.clear();
  filtered.set(key, cv);
  return cv;
}

/** figma-style image adjustments on straight rgba bytes (approximation of figma's curves; each
 *  slider is -1..1). exposure: stops of light; contrast / saturation: around mid grey / luma;
 *  temperature: warm (+) / cool (-); tint: magenta (+) / green (-); highlights / shadows: tone curve
 *  on the bright / dark range */
export function applyImageFilters(d: Uint8ClampedArray | Uint8Array, f: ImageFilters) {
  const ex = Math.pow(2, (f.exposure ?? 0) * 2), ct = 1 + (f.contrast ?? 0), sat = 1 + (f.saturation ?? 0);
  const temp = (f.temperature ?? 0) * 0.18, tint = (f.tint ?? 0) * 0.12, hi = f.highlights ?? 0, sh = f.shadows ?? 0;
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.pow(i / 255, 2.2); // srgb -> ~linear
  for (let i = 0; i < d.length; i += 4) {
    let r = lut[d[i]] * ex, g = lut[d[i + 1]] * ex, b = lut[d[i + 2]] * ex;
    r = Math.pow(Math.min(1, r), 1 / 2.2); g = Math.pow(Math.min(1, g), 1 / 2.2); b = Math.pow(Math.min(1, b), 1 / 2.2);
    r += temp; b -= temp; g -= tint; r += tint * 0.5; b += tint * 0.5;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (hi || sh) {
      const hw = Math.max(0, (y - 0.5) * 2), sw = Math.max(0, (0.5 - y) * 2);
      const dl = hi * 0.25 * hw * hw + sh * 0.25 * sw * sw;
      r += dl; g += dl; b += dl;
    }
    r = (r - 0.5) * ct + 0.5; g = (g - 0.5) * ct + 0.5; b = (b - 0.5) * ct + 0.5;
    const y2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = y2 + (r - y2) * sat; g = y2 + (g - y2) * sat; b = y2 + (b - y2) * sat;
    d[i] = Math.max(0, Math.min(255, r * 255)); d[i + 1] = Math.max(0, Math.min(255, g * 255)); d[i + 2] = Math.max(0, Math.min(255, b * 255));
  }
}

function drawImagePaint(c: Ctx, p: Paint, bw: number, bh: number) {
  const asset = p.imageRef && assetLookup ? assetLookup(p.imageRef) : undefined;
  const bmp = asset ? getBitmap(asset) : null;
  if (!asset || !bmp) { c.fillStyle = 'rgba(204,204,204,1)'; c.fillRect(-1e4, -1e4, 2e4, 2e4); return; }
  const img = filteredImage(asset, bmp, p.filters);
  const iw = bmp.width, ih = bmp.height;
  const rot = ((Math.round((p.rotation ?? 0) / 90) % 4) + 4) % 4;
  c.imageSmoothingQuality = 'high';
  const mode = p.scaleMode ?? 'fill';
  if (mode === 'stretch') {
    const m = p.transform ?? [1, 0, 0, 1, 0, 0];
    c.transform(bw, 0, 0, bh, 0, 0);
    c.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    c.drawImage(img, 0, 0, 1, 1);
    return;
  }
  // rotation about the box center; a quarter turn swaps the image's sides for fitting
  const rw = rot % 2 ? ih : iw, rh = rot % 2 ? iw : ih;
  if (mode === 'tile') {
    const s = p.tileScale ?? 1;
    const pat = c.createPattern(img, 'repeat');
    if (!pat) return;
    const k = iw / ((img as any).width || iw);
    pat.setTransform(new DOMMatrix([s * k, 0, 0, s * k, 0, 0]).rotate(rot * 90));
    c.fillStyle = pat;
    c.fillRect(-1e4, -1e4, 2e4, 2e4);
    return;
  }
  const s = mode === 'fit' ? Math.min(bw / rw, bh / rh) : Math.max(bw / rw, bh / rh);
  c.translate(bw / 2, bh / 2);
  c.rotate(rot * Math.PI / 2);
  c.drawImage(img, -iw * s / 2, -ih * s / 2, iw * s, ih * s);
}

/** deterministic hash of a grain cell -> 0..1 */
export function cellHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** noise grain over the box: cells of `size` px; `density` of them get the grain color */
function drawNoise(c: Ctx, n: NoiseParams, bw: number, bh: number, T: number[]) {
  const size = Math.max(0.25, n.size || 1);
  // cells at most ~1 per device pixel
  const dev = Math.hypot(T[0], T[1]);
  const cell = Math.max(size, 1 / Math.max(dev, 1e-6));
  const cw = Math.min(2048, Math.ceil(bw / cell)), ch = Math.min(2048, Math.ceil(bh / cell));
  if (cw <= 0 || ch <= 0) return;
  const cv = newCanvas(cw, ch);
  const nc = cv.getContext('2d') as Ctx;
  const img = nc.createImageData(cw, ch);
  const d = img.data, seed = n.seed ?? 0, dens = n.density;
  const c1 = n.color ?? [0, 0, 0, 1], c2 = n.secondary ?? [1, 1, 1, 1], op = n.opacity ?? 1;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const o = (y * cw + x) * 4, r = cellHash(x, y, seed);
    if (n.mode === 'multi') {
      if (r >= dens) continue;
      d[o] = cellHash(x, y, seed + 1) * 255; d[o + 1] = cellHash(x, y, seed + 2) * 255; d[o + 2] = cellHash(x, y, seed + 3) * 255; d[o + 3] = op * 255;
    } else if (r < dens) { d[o] = c1[0] * 255; d[o + 1] = c1[1] * 255; d[o + 2] = c1[2] * 255; d[o + 3] = (c1[3] ?? 1) * 255; }
    else if (n.mode === 'duo') { d[o] = c2[0] * 255; d[o + 1] = c2[1] * 255; d[o + 2] = c2[2] * 255; d[o + 3] = (c2[3] ?? 1) * 255; }
  }
  nc.putImageData(img, 0, 0);
  c.imageSmoothingEnabled = false;
  c.drawImage(cv as CanvasImageSource, 0, 0, cw * cell, ch * cell);
  c.imageSmoothingEnabled = true;
}

/** rect / ellipse / group drawn as a raster: complex paints (rgba), or shape features the sdf can't
 *  do (corner smoothing, dashes, per-side strokes) as a coverage mask (R fill, G stroke) */
export function rasterShapePaint(l: Layer, scale: number, size: number[], radius: number[], strokeWidth: number, clip?: RasterClip): RasterResult {
  const [w, h] = size;
  const pad = strokePad(l, strokeWidth) + 2 / scale;
  const s = clip ? scale : fitScale(w + pad * 2, h + pad * 2, scale);
  const pw = clip ? clip.pw : Math.max(1, Math.ceil((w + pad * 2) * s)), ph = clip ? clip.ph : Math.max(1, Math.ceil((h + pad * 2) * s));
  const c = getCtx(pw, ph);
  const T = clip ? [s, 0, 0, s, -clip.x, -clip.y] : [s, 0, 0, s, pad * s, pad * s];
  c.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  const p = shapePath(l, w, h, radius);
  const place = clip ? { x: clip.x / s, y: clip.y / s } : { x: -pad, y: -pad };
  if (!hasComplexPaint(l)) {
    const out = new Uint8Array(pw * ph * 4);
    c.fillStyle = '#fff';
    c.fill(p);
    alphaInto(c, pw, ph, out, 0);
    if (strokeWidth > 0 || l.strokeSides) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, pw, ph);
      c.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
      drawStroke(c, l, [p], ['nonzero'], undefined, strokeWidth, '#fff', [w, h]);
      alphaInto(c, pw, ph, out, 1);
    }
    finishMask(out);
    return { kind: 'mask', pw, ph, ...place, w: pw / s, h: ph / s, data: out };
  }
  paintFill(c, T, l.paints ?? solidOf(l), [p], ['nonzero'], [w, h], pw, ph, 1);
  if (strokeWidth > 0 || l.strokeSides) strokeWithPaints(c, T, l, [p], ['nonzero'], undefined, strokeWidth, [w, h], pw, ph);
  return { kind: 'rgba', pw, ph, ...place, w: pw / s, h: ph / s, data: rgbaData(c, pw, ph) };
}

// ---------------- text ----------------

export interface TextLine {
  text: string;
  width: number;
  /** content index of text[prefix] */
  start: number;
  /** list marker characters at the start of `text` */
  prefix: number;
  /** last line of its paragraph */
  paraEnd: boolean;
  /** first line of its paragraph */
  paraStart: boolean;
}

export function fontString(l: Layer, run?: { fontFamily?: string; fontWeight?: number; fontStyle?: string; fontSize?: number }) {
  const t = l.text!;
  const famRaw = run?.fontFamily ?? t.fontFamily;
  const fam = /[\s,]/.test(famRaw) && !famRaw.includes('"') ? `"${famRaw}"` : famRaw;
  const style = run?.fontStyle ?? t.fontStyle;
  return `${style === 'italic' ? 'italic ' : ''}${run?.fontWeight ?? t.fontWeight} ${run?.fontSize ?? t.fontSize}px ${fam}, Inter, system-ui, sans-serif`;
}

let measureCtx: Ctx | null = null;
export function mctx() {
  if (!measureCtx) {
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : document.createElement('canvas');
    measureCtx = cv.getContext('2d') as any;
  }
  return measureCtx!;
}

/** the text as drawn (text case applied; same length as the content) */
export function displayText(t: TextData): string {
  const s = t.content;
  switch (t.textCase) {
    case 'upper': return s.toUpperCase().length === s.length ? s.toUpperCase() : s;
    case 'lower': return s.toLowerCase().length === s.length ? s.toLowerCase() : s;
    case 'title': return s.replace(/(^|[\s\-/(])(\p{L})/gu, (_m, a: string, b: string) => a + (b.toUpperCase().length === 1 ? b.toUpperCase() : b));
    default: return s;
  }
}

function setFont(c: Ctx, l: Layer) {
  const t = l.text!;
  c.font = fontString(l);
  (c as any).letterSpacing = `${t.letterSpacing || 0}px`;
  if ('fontVariantCaps' in c) (c as any).fontVariantCaps = t.textCase === 'smallCaps' || t.features?.includes('smcp') ? 'small-caps' : 'normal';
  if ('fontKerning' in c) (c as any).fontKerning = t.features?.includes('-kern') ? 'none' : 'normal';
}

export function layoutText(l: Layer, boxWidth: number | null): TextLine[] {
  const t = l.text!;
  const c = mctx();
  setFont(c, l);
  const wrapW = t.autoResize === 'width' ? null : boxWidth;
  const lines: TextLine[] = [];
  const text = displayText(t);
  let pos = 0, n = 0, ol = 0;
  const paras = text.split('\n');
  for (let pi = 0; pi < paras.length; pi++) {
    const para = paras[pi];
    const list = t.lists?.[pi] ?? null;
    ol = list === 'ol' ? ol + 1 : 0;
    const marker = list === 'ul' ? '•  ' : list === 'ol' ? `${ol}.  ` : '';
    const first = lines.length;
    if (wrapW == null) lines.push({ text: marker + para, width: c.measureText(marker + para).width, start: pos, prefix: marker.length, paraEnd: true, paraStart: true });
    else {
      const words = para.split(/(\s+)/);
      let cur = marker, curStart = pos, idx = pos;
      for (const w of words) {
        const next = cur + w;
        if (cur.length > marker.length && c.measureText(next).width > wrapW + 0.5 && w.trim()) {
          const tr = cur.trimEnd();
          lines.push({ text: tr, width: c.measureText(tr).width, start: curStart, prefix: lines.length === first ? marker.length : 0, paraEnd: false, paraStart: lines.length === first });
          cur = w.trimStart();
          curStart = idx + (w.length - w.trimStart().length);
        } else cur = next;
        idx += w.length;
      }
      lines.push({ text: cur, width: c.measureText(cur).width, start: curStart, prefix: lines.length === first ? marker.length : 0, paraEnd: true, paraStart: lines.length === first });
    }
    pos += para.length + 1;
    n++;
  }
  void n;
  // truncation: keep maxLines (or what fits the box height) and end the last one with an ellipsis
  if (t.truncate) {
    const lh = t.fontSize * t.lineHeight;
    const hMax = (l.props.size?.v[1] ?? 0) > 0 && t.autoResize !== 'height' && t.autoResize !== 'width' ? Math.max(1, Math.floor(((l.props.size!.v[1]) + 0.5) / lh)) : Infinity;
    const max = Math.min(t.maxLines && t.maxLines > 0 ? t.maxLines : Infinity, hMax);
    if (lines.length > max) {
      lines.length = max;
      const last = lines[max - 1];
      let s = last.text;
      const limit = (wrapW ?? Infinity);
      while (s.length && c.measureText(s + '…').width > limit) s = s.slice(0, -1);
      last.text = s.trimEnd() + '…';
      last.width = c.measureText(last.text).width;
      last.paraEnd = true;
    }
  }
  return lines;
}

/** live text needs an rgba raster when runs have their own colors or the text has paints */
function textNeedsRgba(l: Layer): boolean {
  const t = l.text!;
  if (l.paints?.some(p => (p.type !== 'solid' && p.type !== 'shader') || (p.blend && p.blend !== 'normal'))) return true;
  if (outlineValid(l)) return t.outline!.groups.some(g => g.fill);
  return !!t.runs?.some(r => r.fill);
}

/** figma's outline is still what the text looks like */
export function outlineValid(l: Layer): boolean {
  const t = l.text;
  return !!t?.outline && t.outline.sig === textSig(t, l.props.size?.v);
}

/** vertical layout of live text in the box */
function textMetrics(l: Layer, size: number[]) {
  const t = l.text!;
  const lines = layoutText(l, size[0] > 0 ? size[0] : null);
  const lh = t.fontSize * t.lineHeight;
  const ps = t.paragraphSpacing ?? 0;
  let textH = lines.length * lh;
  for (let i = 0; i < lines.length - 1; i++) if (lines[i].paraEnd) textH += ps;
  const boxH = size[1] > 0 ? size[1] : textH;
  const y0 = t.valign === 'center' ? (boxH - textH) / 2 : t.valign === 'bottom' ? boxH - textH : 0;
  return { lines, lh, ps, textH, y0 };
}

function textBox(l: Layer, size: number[]): { x: number; y: number; w: number; h: number } {
  const t = l.text!;
  const pad = t.fontSize * 0.5;
  if (outlineValid(l)) {
    const all: PathGeometry[] = [];
    for (const g of t.outline!.groups) all.push(...g.geometry);
    const [bx, by, bw, bh] = geometryBounds(all);
    const x0 = Math.min(0, bx), y0 = Math.min(0, by), x1 = Math.max(size[0], bx + bw), y1 = Math.max(size[1], by + bh);
    return { x: x0 - 2, y: y0 - 2, w: x1 - x0 + 4, h: y1 - y0 + 4 };
  }
  const m = textMetrics(l, size);
  const maxW = Math.max(size[0], ...m.lines.map(x => x.width));
  return { x: -pad, y: Math.min(0, m.y0) - pad, w: maxW + pad * 2, h: Math.max(size[1], m.textH) + pad * 2 + Math.max(0, -m.y0) };
}

export function rasterText(l: Layer, scale: number, size: number[], clip?: RasterClip): RasterResult {
  const t = l.text!;
  const box = textBox(l, size);
  const s = clip ? scale : fitScale(box.w, box.h, scale);
  const pw = clip ? clip.pw : Math.max(1, Math.ceil(box.w * s)), ph = clip ? clip.ph : Math.max(1, Math.ceil(box.h * s));
  const c = getCtx(pw, ph);
  const T = clip ? [s, 0, 0, s, -clip.x, -clip.y] : [s, 0, 0, s, -box.x * s, -box.y * s];
  c.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  const rgba = hasComplexPaint(l);
  const base = l.props.fill?.v ?? [0, 0, 0, 1];
  const place = clip ? { x: clip.x / s, y: clip.y / s } : { x: box.x, y: box.y };
  // gradient / image fills: glyph coverage first, the paints go inside it below
  const painted = !!l.paints?.some(p => (p.type !== 'solid' && p.type !== 'shader') || (p.blend && p.blend !== 'normal'));
  const colored = rgba && !painted;
  if (outlineValid(l)) {
    for (const g of t.outline!.groups) {
      c.fillStyle = colored ? cssColor(g.fill ?? base) : '#fff';
      for (const geo of g.geometry) c.fill(toPath2D(geo), geo.fillRule);
    }
  } else drawLiveText(c, l, size, colored ? base : null);
  if (painted) {
    // text with gradient / image fills: the paints inside the glyphs
    c.globalCompositeOperation = 'source-in';
    const full = new Path2D();
    full.rect(-1e5, -1e5, 2e5, 2e5);
    paintFill(c, T, l.paints!, [full], ['nonzero'], size[0] > 0 ? size : [box.w, box.h], pw, ph, 1);
    c.globalCompositeOperation = 'source-over';
  }
  if (rgba) return { kind: 'rgba', pw, ph, ...place, w: pw / s, h: ph / s, data: rgbaData(c, pw, ph) };
  const out = new Uint8Array(pw * ph * 4);
  alphaInto(c, pw, ph, out, 0);
  finishMask(out);
  return { kind: 'mask', pw, ph, ...place, w: pw / s, h: ph / s, data: out };
}

/** live layout: lines, alignment (incl. justify), runs (font / color / decoration), paragraph spacing */
function drawLiveText(c: Ctx, l: Layer, size: number[], color: number[] | null) {
  const t = l.text!;
  const { lines, lh, ps, y0 } = textMetrics(l, size);
  setFont(c, l);
  c.textBaseline = 'alphabetic';
  const ascent = t.fontSize * 0.8;
  const half = (lh - t.fontSize) / 2;
  const runs = t.runs ?? [];
  const width = size[0] > 0 ? size[0] : Math.max(0, ...lines.map(x => x.width));
  let y = y0;
  for (const line of lines) {
    const by = y + half + ascent;
    let x = t.align === 'center' ? (width - line.width) / 2 : t.align === 'right' ? width - line.width : 0;
    if (line.paraStart && t.paragraphIndent && t.align !== 'center' && t.align !== 'right') x += t.paragraphIndent;
    const justify = t.align === 'justify' && !line.paraEnd ? (width - line.width) / Math.max(1, (line.text.match(/ /g) ?? []).length) : 0;
    // segments: [from, to) in line.text with one style each
    const segs: { a: number; b: number; run: (typeof runs)[number] | null }[] = [];
    let a = 0;
    while (a < line.text.length) {
      const ci = line.start + Math.max(0, a - line.prefix);
      const run = a < line.prefix ? null : runs.find(r => ci >= r.start && ci < r.end) ?? null;
      let b = a + 1;
      while (b < line.text.length) {
        const cj = line.start + Math.max(0, b - line.prefix);
        const rj = b < line.prefix ? null : runs.find(r => cj >= r.start && cj < r.end) ?? null;
        if (rj !== run || (justify && line.text[b] === ' ')) break;
        b++;
      }
      segs.push({ a, b, run });
      a = b;
    }
    for (const sg of segs) {
      const str = line.text.slice(sg.a, sg.b);
      const r = sg.run;
      c.font = r ? fontString(l, r) : fontString(l);
      (c as any).letterSpacing = `${r?.letterSpacing ?? t.letterSpacing ?? 0}px`;
      c.fillStyle = color ? cssColor(r?.fill ?? color) : '#fff';
      c.fillText(str, x, by);
      const w = c.measureText(str).width;
      const dec = r?.decoration ?? t.decoration;
      if (dec) {
        const fs = r?.fontSize ?? t.fontSize, th = Math.max(1, fs / 14);
        c.fillRect(x, dec === 'underline' ? by + fs * 0.1 : by - fs * 0.3, w, th);
      }
      x += w + (justify && str === ' ' ? justify : 0);
    }
    y += lh + (line.paraEnd ? ps : 0);
  }
}

// ---------------- images ----------------

const bitmaps = new Map<string, ImageBitmap | 'loading' | 'error'>();
export let onImageLoaded: (() => void) | null = null;
export function setImageLoadedHandler(fn: () => void) { onImageLoaded = fn; }

/** largest useful raster scale of an image layer (its native resolution), or 0 while it loads */
export function imageMaxScale(asset: Asset, size: number[]): number {
  const b = bitmaps.get(asset.id);
  if (!b || typeof b === 'string') return 0;
  return Math.min(b.width / Math.max(1, size[0]), b.height / Math.max(1, size[1]));
}

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

/** image paints of a layer whose bitmaps are not decoded yet (the raster waits for them) */
export function imagePaintsPending(l: Layer): boolean {
  const all = [...(l.paints ?? []), ...(l.strokePaints ?? []), ...(l.geometry ?? []).flatMap(g => g.paints ?? [])];
  for (const p of all) {
    if (p.type !== 'image' || !p.imageRef || !assetLookup) continue;
    const a = assetLookup(p.imageRef);
    if (a && !getBitmap(a) && bitmaps.get(a.id) !== 'error') return true;
  }
  return false;
}

export function rasterImage(asset: Asset, scale: number, size: number[], clip?: RasterClip): RasterResult | null {
  const bmp = getBitmap(asset);
  if (!bmp) return null;
  const [w, h] = size;
  if (clip) {
    const c = getCtx(clip.pw, clip.ph);
    c.imageSmoothingQuality = 'high';
    c.drawImage(bmp, -clip.x, -clip.y, w * scale, h * scale);
    return { kind: 'rgba', pw: clip.pw, ph: clip.ph, x: clip.x / scale, y: clip.y / scale, w: clip.pw / scale, h: clip.ph / scale, data: rgbaData(c, clip.pw, clip.ph) };
  }
  const s = Math.min(fitScale(w, h, scale), bmp.width / Math.max(1, w), bmp.height / Math.max(1, h)) || 1;
  const pw = Math.max(1, Math.round(w * s)), ph = Math.max(1, Math.round(h * s));
  const c = getCtx(pw, ph);
  c.imageSmoothingQuality = 'high';
  c.drawImage(bmp, 0, 0, pw, ph);
  return { kind: 'rgba', pw, ph, x: 0, y: 0, w, h, data: rgbaData(c, pw, ph) };
}

/** one entry point for every raster kind (worker and main thread) */
export function rasterLayer(l: Layer, scale: number, size: number[], radius: number[], strokeWidth: number, clip?: RasterClip, asset?: Asset): RasterResult | null {
  if (l.type === 'path') return rasterPath(l, scale, strokeWidth, undefined, clip);
  if (l.type === 'text') return rasterText(l, scale, size, clip);
  if (l.type === 'image') return asset ? rasterImage(asset, scale, size, clip) : null;
  if (imagePaintsPending(l)) return null;
  return rasterShapePaint(l, scale, size, radius, strokeWidth, clip);
}

// ---------------- text units (per char / word / line animation) ----------------

export interface TextUnit { text: string; x: number; y: number; w: number; h: number; index: number }

/** split a text layer into animation units with their position in the layer box */
export function textUnits(l: Layer, boxW: number, by: 'char' | 'word' | 'line'): TextUnit[] {
  const t = l.text!;
  const lines = layoutText(l, boxW > 0 ? boxW : null);
  const c = mctx();
  setFont(c, l);
  const lh = t.fontSize * t.lineHeight;
  const out: TextUnit[] = [];
  const width = boxW > 0 ? boxW : Math.max(...lines.map(x => x.width));
  let y = 0;
  lines.forEach(line => {
    const lx = t.align === 'center' ? (width - line.width) / 2 : t.align === 'right' ? width - line.width : 0;
    if (by === 'line') { if (line.text.trim()) out.push({ text: line.text, x: lx, y, w: line.width, h: lh, index: out.length }); }
    else {
      const parts = by === 'char' ? [...line.text] : line.text.split(/(\s+)/);
      let prefix = '';
      for (const part of parts) {
        const x = lx + (prefix ? c.measureText(prefix).width : 0);
        prefix += part;
        if (!part.trim()) continue;
        out.push({ text: part, x, y, w: c.measureText(part).width, h: lh, index: out.length });
      }
    }
    y += lh + (line.paraEnd ? t.paragraphSpacing ?? 0 : 0);
  });
  return out;
}
