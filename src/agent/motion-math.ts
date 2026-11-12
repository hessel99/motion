// pure geometry / sampling helpers for the agent's analysis and layout tools. no renderer needed
// (works in tests and headless): transforms come from keyframes + expressions, text boxes are
// measured with the canvas when there is one and estimated otherwise.

import type { Store } from '../core/store';
import { valueAt } from '../core/commands';
import { compileExpr, evalExpr, EXPR_PROPS } from '../core/expr';
import { PROP_DEFS, type Layer, type PropKey } from '../core/model';
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
