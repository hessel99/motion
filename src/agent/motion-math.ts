// pure geometry / sampling helpers for the agent's analysis and layout tools. no renderer needed
// (works in tests and headless): transforms come from keyframes + expressions, text boxes are
// measured with the canvas when there is one and estimated otherwise.

import type { Store } from '../core/store';
import { valueAt } from '../core/commands';
import { compileExpr, evalExpr, EXPR_PROPS } from '../core/expr';
import { PROP_DEFS, type Layer, type PathCmd, type PropKey } from '../core/model';
import { layoutText, textUnits, type TextUnit } from '../render/raster';

export type Mat = number[];
export const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export function inv(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
export const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

/** property value at t including its expression (random/wiggle seeds approximate the renderer's) */
export function propAt(store: Store, l: Layer, key: PropKey, t: number): number[] {
  const p = l.props[key];
  const v = valueAt(l, key, t);
  if (!p?.expr?.trim() || !EXPR_PROPS.includes(key)) return v;
  const c = compileExpr(p.expr);
  if (!c.node) return v;
  const dim = PROP_DEFS[key].dim;
  try {
    const r = evalExpr(c.node, {
      time: t, value: dim === 1 ? v[0] : v, index: 0, fps: store.comp.fps, duration: store.comp.duration, inPoint: l.inPoint,
      valueAt: tt => { const x = valueAt(l, key, tt); return dim === 1 ? x[0] : x; }, keyTimes: (p.kf ?? []).map(k => k.t), seed: hash(l.id),
    });
    const out = typeof r === 'number' ? (dim === 1 ? [r] : new Array(dim).fill(r)) : r.slice(0, dim);
    return out.every(Number.isFinite) ? out : v;
  } catch { return v; }
}

/** estimated text box when no canvas is available (headless): ~0.56 em per glyph */
function estimateLines(l: Layer, boxW: number | null) {
  const t = l.text!;
  const cw = t.fontSize * 0.56 + (t.letterSpacing || 0);
  const out: { text: string; width: number }[] = [];
  for (const para of t.content.split('\n')) {
    if (!boxW) { out.push({ text: para, width: para.length * cw }); continue; }
    let cur = '';
    for (const w of para.split(/(\s+)/)) {
      if (cur && (cur + w).length * cw > boxW && w.trim()) { out.push({ text: cur.trimEnd(), width: cur.trimEnd().length * cw }); cur = w.trimStart(); } else cur += w;
    }
    out.push({ text: cur, width: cur.length * cw });
  }
  return out;
}

export function textLines(l: Layer, boxW: number | null): { text: string; width: number }[] {
  try { return layoutText(l, boxW); } catch { return estimateLines(l, boxW); }
}

/** per char/word/line units of a text layer in its box (measured, or estimated headless) */
export function textUnitsSafe(l: Layer, boxW: number, by: 'char' | 'word' | 'line'): TextUnit[] {
  try { return textUnits(l, boxW, by); } catch { /* headless */ }
  const t = l.text!;
  const cw = t.fontSize * 0.56 + (t.letterSpacing || 0);
  const lh = t.fontSize * t.lineHeight;
  const lines = estimateLines(l, boxW > 0 ? boxW : null);
  const width = boxW > 0 ? boxW : Math.max(...lines.map(x => x.width));
  const out: TextUnit[] = [];
  lines.forEach((line, li) => {
    const lx = t.align === 'center' ? (width - line.width) / 2 : t.align === 'right' ? width - line.width : 0;
    if (by === 'line') { if (line.text.trim()) out.push({ text: line.text, x: lx, y: li * lh, w: line.width, h: lh, index: out.length }); return; }
    const parts = by === 'char' ? [...line.text] : line.text.split(/(\s+)/);
    let n = 0;
    for (const part of parts) {
      const x = lx + n * cw;
      n += part.length;
      if (part.trim()) out.push({ text: part, x, y: li * lh, w: part.length * cw, h: lh, index: out.length });
    }
  });
  return out;
}

/** the layer's box size at t (auto-sized text measured) */
export function layerSize(store: Store, l: Layer, t: number): [number, number] {
  const s = propAt(store, l, 'size', t);
  if (l.type === 'text' && l.text && (s[0] <= 0 || s[1] <= 0)) {
    const lines = textLines(l, s[0] > 0 ? s[0] : null);
    return [s[0] > 0 ? s[0] : Math.ceil(Math.max(1, ...lines.map(x => x.width))), s[1] > 0 ? s[1] : Math.ceil(lines.length * l.text.fontSize * l.text.lineHeight)];
  }
  return [s[0], s[1]];
}

export function localMatrix(store: Store, l: Layer, t: number): Mat {
  const a = propAt(store, l, 'anchor', t), p = propAt(store, l, 'position', t), s = propAt(store, l, 'scale', t), r = propAt(store, l, 'rotation', t)[0] * Math.PI / 180;
  const cs = Math.cos(r), sn = Math.sin(r);
  const A = cs * s[0] / 100, B = sn * s[0] / 100, C = -sn * s[1] / 100, D = cs * s[1] / 100;
  return [A, B, C, D, p[0] - (A * a[0] + C * a[1]), p[1] - (B * a[0] + D * a[1])];
}

export function worldMatrix(store: Store, id: string | null, t: number): Mat {
  let m: Mat = [1, 0, 0, 1, 0, 0];
  for (let cur = id ? store.layer(id) : undefined; cur; cur = cur.parent ? store.layer(cur.parent) : undefined) m = mul(localMatrix(store, cur, t), m);
  return m;
}

/** comp-space axis aligned box [x0, y0, x1, y1] of a layer at t */
export function worldBox(store: Store, l: Layer, t: number): [number, number, number, number] {
  const m = worldMatrix(store, l.id, t);
  const [w, h] = layerSize(store, l, t);
  const pts = [apply(m, 0, 0), apply(m, w, 0), apply(m, w, h), apply(m, 0, h)];
  return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
}

/** shown at t: visible flags, in/out points and opacity of the layer and its ancestors */
export function shownAt(store: Store, l: Layer, t: number): { shown: boolean; opacity: number } {
  let op = 1;
  for (let cur: Layer | undefined = l; cur; cur = cur.parent ? store.layer(cur.parent) : undefined) {
    if (!cur.visible || t < cur.inPoint || t >= cur.outPoint) return { shown: false, opacity: 0 };
    op *= Math.max(0, Math.min(100, propAt(store, cur, 'opacity', t)[0])) / 100;
  }
  return { shown: op > 0.001, opacity: op };
}

/** seeded pseudo random generator (mulberry32) */
export function rng(seed: number) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** wcag relative luminance and contrast */
export function luminance(c: number[]) {
  const f = (x: number) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
export function contrast(a: number[], b: number[]) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** a over b (straight alpha) */
export function over(a: number[], b: number[]): number[] {
  const al = a[3] ?? 1;
  return [a[0] * al + b[0] * (1 - al), a[1] * al + b[1] * (1 - al), a[2] * al + b[2] * (1 - al), 1];
}

export const r2 = (x: number) => Math.round(x * 100) / 100;
export const r0 = (x: number) => Math.round(x);

/** evenly spaced points (by arc length) along path commands, with the tangent angle in degrees */
export function samplePath(cmds: PathCmd[], n: number, tol = 0.5): { x: number; y: number; angle: number }[] {
  // flatten, keeping open subpaths open
  const pts: number[][] = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  for (const c of cmds) {
    if (c[0] === 'M') { x = sx = c[1]; y = sy = c[2]; pts.push([x, y]); }
    else if (c[0] === 'L') { x = c[1]; y = c[2]; pts.push([x, y]); }
    else if (c[0] === 'Z') { x = sx; y = sy; pts.push([x, y]); }
    else {
      const [x1, y1, x2, y2, x3, y3] = c[0] === 'C' ? [c[1], c[2], c[3], c[4], c[5], c[6]] : [x + 2 / 3 * (c[1] - x), y + 2 / 3 * (c[2] - y), c[3] + 2 / 3 * (c[1] - c[3]), c[4] + 2 / 3 * (c[2] - c[4]), c[3], c[4]];
      const len = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
      const k = Math.max(2, Math.min(200, Math.ceil(len / (tol * 8))));
      for (let i = 1; i <= k; i++) { const t = i / k, u = 1 - t; pts.push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]); }
      x = x3; y = y3;
    }
  }
  if (pts.length < 2) throw new Error('the path needs at least two points');
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = acc[acc.length - 1];
  const closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6;
  const out: { x: number; y: number; angle: number }[] = [];
  let j = 1;
  for (let i = 0; i < n; i++) {
    const d = n === 1 ? total / 2 : total * i / (closed ? n : n - 1);
    while (j < acc.length - 1 && acc[j] < d) j++;
    const a = pts[j - 1], b = pts[j], seg = acc[j] - acc[j - 1] || 1, f = Math.min(1, Math.max(0, (d - acc[j - 1]) / seg));
    out.push({ x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI });
  }
  return out;
}

/** comp-space center of a layer's box at t */
export function centerOf(store: Store, l: Layer, t: number): [number, number] {
  const b = worldBox(store, l, t);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}
