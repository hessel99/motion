// svg import ("copy as svg" pastes, dropped .svg files).
//
// uses a tiny built-in xml parser instead of DOMParser so the whole thing runs (and is tested)
// in node as well as the browser. supported: svg/g/rect/circle/ellipse/line/polyline/polygon/path/
// text(+tspan)/image/use, transform attr, presentation attributes, style attr, simple class rules
// from <style>, linear/radial gradients (objectBoundingBox + userSpaceOnUse, gradientTransform, href).
// paths always have their full transform baked into geometry; rect/ellipse/text/image keep a
// decomposed (translate/rotate/scale) transform unless the matrix has skew, in which case
// rect/ellipse are converted to baked paths.

import { createLayer, uid, type TextRun, type Asset, type Layer, type Paint, type PathCmd, type PathGeometry } from '../core/model';

type Mat = [number, number, number, number, number, number]; // a b c d e f (x' = a x + c y + e)
type Color = [number, number, number, number];
const I: Mat = [1, 0, 0, 1, 0, 0];

// ================= path data (pure) =================

/** tokenizer for path data / number lists: handles "1.5.5", "-1-2", "1e-3", compact arc flags */
class NumScanner {
  i = 0;
  constructor(public s: string) {}
  skipSep() {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44) this.i++;
      else break;
    }
  }
  hasNumber(): boolean {
    this.skipSep();
    const c = this.s[this.i];
    return c !== undefined && /[0-9.+\-]/.test(c);
  }
  num(): number {
    this.skipSep();
    const s = this.s;
    const start = this.i;
    let i = this.i;
    if (s[i] === '+' || s[i] === '-') i++;
    let digits = false, dot = false;
    while (i < s.length) {
      const c = s[i];
      if (c >= '0' && c <= '9') { digits = true; i++; }
      else if (c === '.' && !dot) { dot = true; i++; }
      else break;
    }
    if (digits && (s[i] === 'e' || s[i] === 'E')) {
      let j = i + 1;
      if (s[j] === '+' || s[j] === '-') j++;
      if (s[j] >= '0' && s[j] <= '9') {
        while (s[j] >= '0' && s[j] <= '9') j++;
        i = j;
      }
    }
    if (!digits) throw new Error('number expected');
    this.i = i;
    return parseFloat(s.slice(start, i));
  }
  flag(): number {
    this.skipSep();
    const c = this.s[this.i];
    if (c === '0' || c === '1') { this.i++; return c === '1' ? 1 : 0; }
    throw new Error('flag expected');
  }
}

/** parse svg path data into absolute M/L/C/Q/Z commands (H/V -> L, S/T expanded, A -> cubics) */
export function parsePathD(d: string): PathCmd[] {
  const out: PathCmd[] = [];
  const sc = new NumScanner(d);
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let lastC: [number, number] | null = null; // reflected control for S
  let lastQ: [number, number] | null = null; // for T
  let cmd = '';
  try {
    while (true) {
      sc.skipSep();
      if (sc.i >= d.length) break;
      const ch = d[sc.i];
      if (/[a-zA-Z]/.test(ch)) { cmd = ch; sc.i++; }
      else if (!cmd || !sc.hasNumber()) break;
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      if (C === 'Z') {
        out.push(['Z']);
        cx = sx; cy = sy; lastC = lastQ = null;
        continue;
      }
      // a command letter followed by one or more argument groups
      let first = true;
      do {
        const ox = rel ? cx : 0, oy = rel ? cy : 0;
        switch (C) {
          case 'M': {
            const x = sc.num() + ox, y = sc.num() + oy;
            if (first) { out.push(['M', x, y]); sx = x; sy = y; }
            else out.push(['L', x, y]); // implicit lineto
            cx = x; cy = y; lastC = lastQ = null;
            break;
          }
          case 'L': { const x = sc.num() + ox, y = sc.num() + oy; out.push(['L', x, y]); cx = x; cy = y; lastC = lastQ = null; break; }
          case 'H': { const x = sc.num() + ox; out.push(['L', x, cy]); cx = x; lastC = lastQ = null; break; }
          case 'V': { const y = sc.num() + oy; out.push(['L', cx, y]); cy = y; lastC = lastQ = null; break; }
          case 'C': {
            const x1 = sc.num() + ox, y1 = sc.num() + oy, x2 = sc.num() + ox, y2 = sc.num() + oy, x = sc.num() + ox, y = sc.num() + oy;
            out.push(['C', x1, y1, x2, y2, x, y]); lastC = [x2, y2]; lastQ = null; cx = x; cy = y; break;
          }
          case 'S': {
            const x1: number = lastC ? 2 * cx - lastC[0] : cx, y1: number = lastC ? 2 * cy - lastC[1] : cy;
            const x2 = sc.num() + ox, y2 = sc.num() + oy, x = sc.num() + ox, y = sc.num() + oy;
            out.push(['C', x1, y1, x2, y2, x, y]); lastC = [x2, y2]; lastQ = null; cx = x; cy = y; break;
          }
          case 'Q': {
            const x1 = sc.num() + ox, y1 = sc.num() + oy, x = sc.num() + ox, y = sc.num() + oy;
            out.push(['Q', x1, y1, x, y]); lastQ = [x1, y1]; lastC = null; cx = x; cy = y; break;
          }
          case 'T': {
            const x1: number = lastQ ? 2 * cx - lastQ[0] : cx, y1: number = lastQ ? 2 * cy - lastQ[1] : cy;
            const x = sc.num() + ox, y = sc.num() + oy;
            out.push(['Q', x1, y1, x, y]); lastQ = [x1, y1]; lastC = null; cx = x; cy = y; break;
          }
          case 'A': {
            const rx = sc.num(), ry = sc.num(), rot = sc.num(), large = sc.flag(), sweep = sc.flag();
            const x = sc.num() + ox, y = sc.num() + oy;
            arcToCubics(cx, cy, rx, ry, rot, large, sweep, x, y, out);
            cx = x; cy = y; lastC = lastQ = null; break;
          }
          default:
            return out; // unknown command: stop (svg spec: render up to the error)
        }
        first = false;
      } while (sc.hasNumber());
    }
  } catch {
    // malformed data: keep what parsed so far (matches browser behaviour)
  }
  return out;
}

/** svg arc (endpoint parameterization) -> cubic beziers, appended to out (spec F.6) */
export function arcToCubics(x1: number, y1: number, rx: number, ry: number, angleDeg: number, large: number, sweep: number, x2: number, y2: number, out: PathCmd[]) {
  if (x1 === x2 && y1 === y2) return;
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx === 0 || ry === 0) { out.push(['L', x2, y2]); return; }
  const phi = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const rx2 = rx * rx, ry2 = ry * ry;
  let k = (rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p) / (rx2 * y1p * y1p + ry2 * x1p * x1p);
  k = Math.sqrt(Math.max(0, k)) * (large === sweep ? -1 : 1);
  const cxp = (k * rx * y1p) / ry, cyp = (-k * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= Math.PI * 2;
  else if (sweep && dt < 0) dt += Math.PI * 2;
  const segs = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const delta = dt / segs;
  const kappa = (4 / 3) * Math.tan(delta / 4);
  let t = t1;
  const pt = (a: number) => {
    const ex = rx * Math.cos(a), ey = ry * Math.sin(a);
    return [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy];
  };
  const der = (a: number) => {
    const ex = -rx * Math.sin(a), ey = ry * Math.cos(a);
    return [cos * ex - sin * ey, sin * ex + cos * ey];
  };
  for (let i = 0; i < segs; i++) {
    const ta = t, tb = t + delta;
    const p0 = pt(ta), d0 = der(ta), d1 = der(tb);
    const p3 = i === segs - 1 ? [x2, y2] : pt(tb);
    out.push(['C', p0[0] + kappa * d0[0], p0[1] + kappa * d0[1], p3[0] - kappa * d1[0], p3[1] - kappa * d1[1], p3[0], p3[1]]);
    t = tb;
  }
}

export function transformCmds(cmds: PathCmd[], m: Mat): PathCmd[] {
  const [a, b, c, d, e, f] = m;
  const X = (x: number, y: number) => a * x + c * y + e;
  const Y = (x: number, y: number) => b * x + d * y + f;
  return cmds.map((p): PathCmd => {
    switch (p[0]) {
      case 'M': return ['M', X(p[1], p[2]), Y(p[1], p[2])];
      case 'L': return ['L', X(p[1], p[2]), Y(p[1], p[2])];
      case 'Q': return ['Q', X(p[1], p[2]), Y(p[1], p[2]), X(p[3], p[4]), Y(p[3], p[4])];
      case 'C': return ['C', X(p[1], p[2]), Y(p[1], p[2]), X(p[3], p[4]), Y(p[3], p[4]), X(p[5], p[6]), Y(p[5], p[6])];
      default: return ['Z'];
    }
  });
}

/** tight bounds (curve extrema, not control hull): [x, y, w, h] */
export function cmdsBounds(cmds: PathCmd[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  let px = 0, py = 0, sx = 0, sy = 0;
  for (const p of cmds) {
    switch (p[0]) {
      case 'M': px = sx = p[1]; py = sy = p[2]; add(px, py); break;
      case 'L': px = p[1]; py = p[2]; add(px, py); break;
      case 'Q': {
        add(p[3], p[4]);
        for (const [a, b, c, setx] of [[px, p[1], p[3], true], [py, p[2], p[4], false]] as [number, number, number, boolean][]) {
          const den = a - 2 * b + c;
          if (Math.abs(den) > 1e-12) {
            const t = (a - b) / den;
            if (t > 0 && t < 1) {
              const v = (1 - t) * (1 - t) * a + 2 * (1 - t) * t * b + t * t * c;
              if (setx) add(v, py); else add(px, v);
            }
          }
        }
        px = p[3]; py = p[4]; break;
      }
      case 'C': {
        add(p[5], p[6]);
        const xs = [px, p[1], p[3], p[5]], ys = [py, p[2], p[4], p[6]];
        for (const t of cubicExtrema(xs)) add(cubicAt(xs, t), py);
        for (const t of cubicExtrema(ys)) add(px, cubicAt(ys, t));
        px = p[5]; py = p[6]; break;
      }
      case 'Z': px = sx; py = sy; break;
    }
  }
  if (x0 === Infinity) return [0, 0, 0, 0];
  return [x0, y0, x1 - x0, y1 - y0];
}
function cubicAt(v: number[], t: number) {
  const u = 1 - t;
  return u * u * u * v[0] + 3 * u * u * t * v[1] + 3 * u * t * t * v[2] + t * t * t * v[3];
}
function cubicExtrema(v: number[]): number[] {
  // derivative: 3(a t^2 + b t + c)
  const a = -v[0] + 3 * v[1] - 3 * v[2] + v[3];
  const b = 2 * (v[0] - 2 * v[1] + v[2]);
  const c = v[1] - v[0];
  const res: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) res.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      res.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return res.filter(t => t > 0 && t < 1);
}

// ================= transforms / colors (pure) =================

export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
function invert(m: Mat): Mat {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, 0, 0];
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** parse an svg transform attribute */
export function parseTransform(s: string | undefined | null): Mat {
  let m: Mat = I;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(s))) {
    const a = numList(r[2]);
    let t: Mat = I;
    switch (r[1]) {
      case 'matrix': if (a.length >= 6) t = [a[0], a[1], a[2], a[3], a[4], a[5]]; break;
      case 'translate': t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]; break;
      case 'scale': t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const rad = ((a[0] ?? 0) * Math.PI) / 180, c = Math.cos(rad), sn = Math.sin(rad);
        t = [c, sn, -sn, c, 0, 0];
        if (a.length >= 3) t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case 'skewX': t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, t);
  }
  return m;
}

export function numList(s: string | undefined | null): number[] {
  const out: number[] = [];
  if (!s) return out;
  const sc = new NumScanner(s);
  try { while (sc.hasNumber()) out.push(sc.num()); } catch { /* stop */ }
  return out;
}

/** the 148 css named colors */
const NAMED: Record<string, string> = {aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4', azure: '#f0ffff', beige: '#f5f5dc', bisque: '#ffe4c4', black: '#000000', blanchedalmond: '#ffebcd', blue: '#0000ff', blueviolet: '#8a2be2', brown: '#a52a2a', burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00', chocolate: '#d2691e', coral: '#ff7f50', cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c', cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b', darkgoldenrod: '#b8860b', darkgray: '#a9a9a9', darkgreen: '#006400', darkgrey: '#a9a9a9', darkkhaki: '#bdb76b', darkmagenta: '#8b008b', darkolivegreen: '#556b2f', darkorange: '#ff8c00', darkorchid: '#9932cc', darkred: '#8b0000', darksalmon: '#e9967a', darkseagreen: '#8fbc8f', darkslateblue: '#483d8b', darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f', darkturquoise: '#00ced1', darkviolet: '#9400d3', deeppink: '#ff1493', deepskyblue: '#00bfff', dimgray: '#696969', dimgrey: '#696969', dodgerblue: '#1e90ff', firebrick: '#b22222', floralwhite: '#fffaf0', forestgreen: '#228b22', fuchsia: '#ff00ff', gainsboro: '#dcdcdc', ghostwhite: '#f8f8ff', gold: '#ffd700', goldenrod: '#daa520', gray: '#808080', green: '#008000', greenyellow: '#adff2f', grey: '#808080', honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c', indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa', lavenderblush: '#fff0f5', lawngreen: '#7cfc00', lemonchiffon: '#fffacd', lightblue: '#add8e6', lightcoral: '#f08080', lightcyan: '#e0ffff', lightgoldenrodyellow: '#fafad2', lightgray: '#d3d3d3', lightgreen: '#90ee90', lightgrey: '#d3d3d3', lightpink: '#ffb6c1', lightsalmon: '#ffa07a', lightseagreen: '#20b2aa', lightskyblue: '#87cefa', lightslategray: '#778899', lightslategrey: '#778899', lightsteelblue: '#b0c4de', lightyellow: '#ffffe0', lime: '#00ff00', limegreen: '#32cd32', linen: '#faf0e6', magenta: '#ff00ff', maroon: '#800000', mediumaquamarine: '#66cdaa', mediumblue: '#0000cd', mediumorchid: '#ba55d3', mediumpurple: '#9370db', mediumseagreen: '#3cb371', mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a', mediumturquoise: '#48d1cc', mediumvioletred: '#c71585', midnightblue: '#191970', mintcream: '#f5fffa', mistyrose: '#ffe4e1', moccasin: '#ffe4b5', navajowhite: '#ffdead', navy: '#000080', oldlace: '#fdf5e6', olive: '#808000', olivedrab: '#6b8e23', orange: '#ffa500', orangered: '#ff4500', orchid: '#da70d6', palegoldenrod: '#eee8aa', palegreen: '#98fb98', paleturquoise: '#afeeee', palevioletred: '#db7093', papayawhip: '#ffefd5', peachpuff: '#ffdab9', peru: '#cd853f', pink: '#ffc0cb', plum: '#dda0dd', powderblue: '#b0e0e6', purple: '#800080', rebeccapurple: '#663399', red: '#ff0000', rosybrown: '#bc8f8f', royalblue: '#4169e1', saddlebrown: '#8b4513', salmon: '#fa8072', sandybrown: '#f4a460', seagreen: '#2e8b57', seashell: '#fff5ee', sienna: '#a0522d', silver: '#c0c0c0', skyblue: '#87ceeb', slateblue: '#6a5acd', slategray: '#708090', slategrey: '#708090', snow: '#fffafa', springgreen: '#00ff7f', steelblue: '#4682b4', tan: '#d2b48c', teal: '#008080', thistle: '#d8bfd8', tomato: '#ff6347', turquoise: '#40e0d0', violet: '#ee82ee', wheat: '#f5deb3', white: '#ffffff', whitesmoke: '#f5f5f5', yellow: '#ffff00', yellowgreen: '#9acd32'};

/** parse a css color. returns null for none/transparent/unknown/url(...) */
export function parseColor(s: string | undefined | null): Color | null {
  if (!s) return null;
  s = s.trim().toLowerCase();
  if (s === 'none' || s === 'transparent') return null;
  if (NAMED[s]) s = NAMED[s];
  if (s === 'currentcolor') return [0, 0, 0, 1];
  if (s[0] === '#') {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) return null;
    const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [v(0), v(2), v(4), h.length === 8 ? v(6) : 1];
  }
  const m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[2].split(/[\s,/]+/).filter(Boolean);
    const comp = (p: string | undefined, scale: number) => (p == null ? 1 : p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / scale);
    const alpha = parts[3] != null ? comp(parts[3], 1) : 1;
    if (m[1].startsWith('rgb')) return [comp(parts[0], 255), comp(parts[1], 255), comp(parts[2], 255), alpha].map(clamp01) as Color;
    const hh = (((parseFloat(parts[0]) % 360) + 360) % 360) / 360, ss = comp(parts[1], 100), ll = comp(parts[2], 100);
    return [...hsl(hh, ss, ll), clamp01(alpha)] as Color;
  }
  return null;
}
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
function hsl(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

// ================= minimal xml parser (pure) =================

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string; // concatenated direct text content
  parts: (XmlNode | string)[];
}

const XML_ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
function xmlUnescape(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, b: string) => {
    if (b[0] === '#') {
      const code = b[1] === 'x' || b[1] === 'X' ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENT[b.toLowerCase()] ?? m;
  });
}

export function parseXml(src: string): XmlNode | null {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '', parts: [] };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;
  const pushText = (t: string) => {
    if (!t) return;
    const top = stack[stack.length - 1];
    top.text += t;
    top.parts.push(t);
  };
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { pushText(xmlUnescape(src.slice(i))); break; }
    if (lt > i) pushText(xmlUnescape(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); pushText(src.slice(lt + 9, e < 0 ? n : e)); i = e < 0 ? n : e + 3; continue; }
    if (src[lt + 1] === '?') { const e = src.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src[lt + 1] === '!') {
      // doctype (may contain an internal subset in [...])
      let j = lt + 2, depth = 0;
      while (j < n) { const c = src[j]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; j++; }
      i = j + 1; continue;
    }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      const tag = src.slice(lt + 2, e < 0 ? n : e).trim();
      // pop to matching tag (tolerant of mismatches)
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === tag) { stack.length = k; break; }
      i = e < 0 ? n : e + 1; continue;
    }
    // start tag
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const tag = src.slice(lt + 1, j);
    const node: XmlNode = { tag, attrs: {}, children: [], text: '', parts: [] };
    // attributes
    let selfClose = false;
    while (j < n) {
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '>') { j++; break; }
      if (src[j] === '/' && src[j + 1] === '>') { selfClose = true; j += 2; break; }
      let k = j;
      while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const name = src.slice(j, k);
      j = k;
      while (j < n && /\s/.test(src[j])) j++;
      let val = '';
      if (src[j] === '=') {
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") {
          const e = src.indexOf(q, j + 1);
          val = src.slice(j + 1, e < 0 ? n : e);
          j = e < 0 ? n : e + 1;
        } else {
          let e = j;
          while (e < n && !/[\s>]/.test(src[e])) e++;
          val = src.slice(j, e);
          j = e;
        }
      }
      if (name) node.attrs[name] = xmlUnescape(val);
      else j++;
    }
    const top = stack[stack.length - 1];
    top.children.push(node);
    top.parts.push(node);
    if (!selfClose) stack.push(node);
    i = j;
  }
  const find = (x: XmlNode): XmlNode | null => {
    if (localName(x.tag) === 'svg') return x;
    for (const c of x.children) { const r = find(c); if (r) return r; }
    return null;
  };
  return find(root);
}
const localName = (t: string) => { const k = t.indexOf(':'); return k < 0 ? t : t.slice(k + 1); };

// ================= svg -> layers =================

interface Style {
  fill: string; fillOpacity: number; fillRule: 'nonzero' | 'evenodd';
  stroke: string; strokeOpacity: number; strokeWidth: number;
  fontFamily: string; fontSize: number; fontWeight: string; fontStyle: string; textAnchor: string; letterSpacing: number;
  visibility: string; color: string;
  dash: number[] | null; dashOffset: number; cap: string; join: string; miter: number;
}
const DEFAULT_STYLE: Style = {
  fill: 'black', fillOpacity: 1, fillRule: 'nonzero', stroke: 'none', strokeOpacity: 1, strokeWidth: 1,
  fontFamily: 'Inter', fontSize: 16, fontWeight: '400', fontStyle: 'normal', textAnchor: 'start', letterSpacing: 0,
  visibility: 'visible', color: 'black',
  dash: null, dashOffset: 0, cap: 'butt', join: 'miter', miter: 4,
};
const SKIP_TAGS = new Set(['defs', 'clipPath', 'mask', 'symbol', 'pattern', 'marker', 'title', 'desc', 'metadata', 'style', 'script', 'linearGradient', 'radialGradient', 'filter', 'foreignObject']);

function parseStyleAttr(s: string | undefined, into: Record<string, string>) {
  if (!s) return;
  for (const decl of s.split(';')) {
    const k = decl.indexOf(':');
    if (k < 0) continue;
    const name = decl.slice(0, k).trim().toLowerCase();
    const val = decl.slice(k + 1).replace(/!important/i, '').trim();
    if (name) into[name] = val;
  }
}

/** length in user units; percentages resolved against ref */
function len(v: string | undefined, ref = 0, d = 0): number {
  if (v == null || v === '') return d;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(%|px|pt|pc|mm|cm|in|em|rem)?\s*$/i.exec(v);
  if (!m) return d;
  const x = parseFloat(m[1]);
  switch ((m[2] || '').toLowerCase()) {
    case '%': return (x / 100) * ref;
    case 'pt': return x * (4 / 3);
    case 'pc': return x * 16;
    case 'mm': return x * (96 / 25.4);
    case 'cm': return x * (96 / 2.54);
    case 'in': return x * 96;
    case 'em': case 'rem': return x * 16;
    default: return x;
  }
}

function decompose(m: Mat): { tx: number; ty: number; rot: number; sx: number; sy: number; skew: boolean } {
  const [a, b, c, d, e, f] = m;
  const sx = Math.hypot(a, b) || 0;
  const rot = Math.atan2(b, a);
  const det = a * d - b * c;
  const sy = sx ? det / sx : 0;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const skew = Math.abs(c - -sy * sin) + Math.abs(d - sy * cos) > 1e-6 * (1 + Math.abs(sy));
  return { tx: e, ty: f, rot: (rot * 180) / Math.PI, sx, sy, skew };
}

class SvgConverter {
  layers: Layer[] = [];
  assets: Asset[] = [];
  private ids = new Map<string, XmlNode>();
  private classRules = new Map<string, Record<string, string>>();
  private vw = 0;
  private vh = 0;
  private nonScaling = false;
  private parents = new Map<XmlNode, XmlNode>();
  private rules: { sel: string; decl: Record<string, string>; imp: Record<string, string>; spec: number; order: number }[] = [];

  constructor(private root: XmlNode) {
    const walk = (n: XmlNode) => {
      if (n.attrs.id) this.ids.set(n.attrs.id, n);
      if (localName(n.tag) === 'style') this.parseCss(n.text);
      for (const c of n.children) { this.parents.set(c, n); walk(c); }
    };
    walk(root);
  }

  private parseCss(css: string) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
      const decl: Record<string, string> = {}, imp: Record<string, string> = {};
      for (const d of m[2].split(';')) {
        const k = d.indexOf(':');
        if (k < 0) continue;
        const name = d.slice(0, k).trim().toLowerCase(), raw = d.slice(k + 1);
        if (!name) continue;
        if (/!important/i.test(raw)) imp[name] = raw.replace(/!important/i, '').trim(); else decl[name] = raw.trim();
      }
      for (const sel of m[1].split(',')) {
        const s = sel.trim().replace(/\s*>\s*/g, ' > ');
        if (!s || /[:\[*+~]/.test(s)) continue; // pseudo classes, attributes, siblings: not supported
        let spec = 0;
        for (const part of s.split(/\s+/)) { if (part === '>') continue; spec += (part.match(/#/g)?.length ?? 0) * 100 + (part.match(/\./g)?.length ?? 0) * 10 + (/^[a-zA-Z]/.test(part) ? 1 : 0); }
        this.rules.push({ sel: s, decl, imp, spec, order: this.rules.length });
      }
    }
  }

  /** one compound selector (tag, .class, #id, combined) */
  private matchOne(n: XmlNode, part: string): boolean {
    const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(part);
    if (!m) return false;
    if (m[1] && localName(n.tag) !== m[1]) return false;
    const cls = (n.attrs.class ?? '').split(/\s+/);
    for (const t of m[2].match(/[.#][\w-]+/g) ?? []) {
      if (t[0] === '#' ? n.attrs.id !== t.slice(1) : !cls.includes(t.slice(1))) return false;
    }
    return true;
  }
  /** descendant (space) and child (>) combinators, right to left */
  private matches(n: XmlNode, sel: string): boolean {
    const parts = sel.split(/\s+/);
    if (!this.matchOne(n, parts[parts.length - 1])) return false;
    let cur: XmlNode | undefined = n;
    for (let k = parts.length - 2; k >= 0; k--) {
      if (parts[k] === '>') { cur = cur && this.parents.get(cur); if (!cur || !this.matchOne(cur, parts[--k])) return false; continue; }
      let found = false;
      for (cur = cur && this.parents.get(cur); cur; cur = this.parents.get(cur)) if (this.matchOne(cur, parts[k])) { found = true; break; }
      if (!found) return false;
    }
    return true;
  }

  /** presentation attrs < css rules (by specificity) < style attr < !important rules */
  private props(n: XmlNode): Record<string, string> {
    const p: Record<string, string> = {};
    for (const k in n.attrs) p[k] = n.attrs[k];
    if (this.rules.length) {
      const hits = this.rules.filter(r => this.matches(n, r.sel)).sort((a, b) => a.spec - b.spec || a.order - b.order);
      for (const r of hits) Object.assign(p, r.decl);
      parseStyleAttr(n.attrs.style, p);
      for (const r of hits) Object.assign(p, r.imp);
    } else parseStyleAttr(n.attrs.style, p);
    return p;
  }

  private inherit(parent: Style, p: Record<string, string>): Style {
    const s = { ...parent };
    if (p.color) s.color = p.color;
    if (p.fill) s.fill = p.fill === 'currentColor' ? s.color : p.fill;
    if (p['fill-opacity']) s.fillOpacity = parseFloat(p['fill-opacity']);
    if (p['fill-rule']) s.fillRule = p['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero';
    if (p.stroke) s.stroke = p.stroke === 'currentColor' ? s.color : p.stroke;
    if (p['stroke-opacity']) s.strokeOpacity = parseFloat(p['stroke-opacity']);
    if (p['stroke-width']) s.strokeWidth = len(p['stroke-width'], Math.hypot(this.vw, this.vh) / Math.SQRT2, 1);
    if (p['font-family']) s.fontFamily = p['font-family'].split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (p['font-size']) s.fontSize = len(p['font-size'], s.fontSize, s.fontSize);
    if (p['font-weight']) s.fontWeight = p['font-weight'];
    if (p['font-style']) s.fontStyle = p['font-style'];
    if (p['text-anchor']) s.textAnchor = p['text-anchor'];
    if (p['letter-spacing']) s.letterSpacing = len(p['letter-spacing'], 0, 0);
    if (p.visibility) s.visibility = p.visibility;
    if (p['stroke-dasharray']) { const d = numList(p['stroke-dasharray']); s.dash = d.length && d.some(x => x > 0) && p['stroke-dasharray'] !== 'none' ? d : null; }
    if (p['stroke-dashoffset']) s.dashOffset = len(p['stroke-dashoffset'], 0, 0);
    if (p['stroke-linecap']) s.cap = p['stroke-linecap'];
    if (p['stroke-linejoin']) s.join = p['stroke-linejoin'];
    if (p['stroke-miterlimit']) s.miter = parseFloat(p['stroke-miterlimit']) || 4;
    return s;
  }

  run(): string[] {
    const r = this.root;
    const vb = numList(r.attrs.viewBox);
    const hasVb = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
    let w = len(r.attrs.width, 0, 0), h = len(r.attrs.height, 0, 0);
    if (!w && !h) { w = hasVb ? vb[2] : 300; h = hasVb ? vb[3] : 150; }
    else if (!w) w = hasVb ? (h * vb[2]) / vb[3] : 300;
    else if (!h) h = hasVb ? (w * vb[3]) / vb[2] : 150;
    let m: Mat = I;
    if (hasVb) {
      const par = (r.attrs.preserveAspectRatio ?? 'xMidYMid meet').trim();
      let sx = w / vb[2], sy = h / vb[3];
      let tx = 0, ty = 0;
      if (!par.startsWith('none')) {
        const s = par.includes('slice') ? Math.max(sx, sy) : Math.min(sx, sy);
        sx = sy = s;
        const ax = par.includes('xMin') ? 0 : par.includes('xMax') ? 1 : 0.5;
        const ay = par.includes('YMin') ? 0 : par.includes('YMax') ? 1 : 0.5;
        tx = (w - vb[2] * s) * ax;
        ty = (h - vb[3] * s) * ay;
      }
      m = [sx, 0, 0, sy, tx - vb[0] * sx, ty - vb[1] * sy];
      this.vw = vb[2]; this.vh = vb[3];
    } else { this.vw = w; this.vh = h; }

    const group = createLayer('group', { w, h });
    group.name = r.attrs.id || 'SVG';
    group.props.fill!.v = [1, 1, 1, 0];
    group.props.strokeWidth!.v = [0];
    group.clip = false;
    this.layers.push(group);
    const style = this.inherit(DEFAULT_STYLE, this.props(r));
    for (const c of r.children) this.node(c, group, m, style, 0);
    return [group.id];
  }

  private node(n: XmlNode, parent: Layer, pending: Mat, ps: Style, depth: number) {
    const tag = localName(n.tag);
    if (SKIP_TAGS.has(tag) || depth > 64) return;
    const p = this.props(n);
    if (p.display === 'none') return;
    const style = this.inherit(ps, p);
    const own = parseTransform(p.transform);
    this.nonScaling = p['vector-effect'] === 'non-scaling-stroke';
    const opacity = p.opacity != null ? clamp01(parseFloat(p.opacity)) : 1;
    let layer: Layer | null = null;
    switch (tag) {
      case 'svg': {
        // nested viewport: x / y / width / height, its viewBox + preserveAspectRatio, clipped (overflow hidden by default)
        const x = len(p.x, this.vw), y = len(p.y, this.vh), w = len(p.width, this.vw, this.vw), h = len(p.height, this.vh, this.vh);
        const vb = numList(p.viewBox);
        const g = createLayer('group', { w, h });
        g.name = p.id || 'svg';
        g.props.fill!.v = [1, 1, 1, 0]; g.props.strokeWidth!.v = [0];
        g.clip = (p.overflow ?? 'hidden') === 'hidden' || p.overflow === 'clip';
        this.setTransform(g, mul(pending, own), x, y, w, h);
        g.props.opacity!.v = [opacity * 100];
        this.add(g, this.clipHost(p, parent, mul(pending, own)));
        const inner = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? viewBoxMatrix(vb, w, h, p.preserveAspectRatio) : I;
        const pvw = this.vw, pvh = this.vh;
        if (vb.length === 4) { this.vw = vb[2]; this.vh = vb[3]; }
        for (const c of n.children) this.node(c, g, inner, style, depth + 1);
        this.vw = pvw; this.vh = pvh;
        return;
      }
      case 'g': case 'a': case 'switch': {
        let m = mul(pending, own);
        const dc = decompose(m);
        const g = createLayer('group', { w: 0, h: 0 });
        g.name = p.id || tag;
        g.props.fill!.v = [1, 1, 1, 0];
        g.props.strokeWidth!.v = [0];
        g.clip = false;
        let childM: Mat = I;
        if (dc.skew) childM = m; // can't express skew on a group: push it down to the leaves
        else this.setTransform(g, m, 0, 0, 0, 0);
        g.props.opacity!.v = [opacity * 100];
        this.filter(g, p);
        this.add(g, this.clipHost(p, parent, m));
        for (const c of n.children) this.node(c, g, childM, style, depth + 1);
        return;
      }
      case 'use': {
        const href = p.href ?? p['xlink:href'] ?? '';
        const ref = href.startsWith('#') ? this.ids.get(href.slice(1)) : undefined;
        if (!ref || ref === n) return;
        const m = mul(mul(pending, own), [1, 0, 0, 1, len(p.x, this.vw), len(p.y, this.vh)]);
        const wrapper: XmlNode = { tag: 'g', attrs: { opacity: p.opacity ?? '1' }, children: [], text: '', parts: [] };
        // render the referenced element (symbols render their children, in their viewBox scaled to the use's size)
        let target: XmlNode = ref;
        if (localName(ref.tag) === 'symbol') {
          const vb = numList(ref.attrs.viewBox);
          const sw = len(p.width ?? ref.attrs.width, this.vw, vb[2] ?? 0), sh = len(p.height ?? ref.attrs.height, this.vh, vb[3] ?? 0);
          const vm = vb.length === 4 && vb[2] > 0 && vb[3] > 0 && sw > 0 && sh > 0 ? viewBoxMatrix(vb, sw, sh, ref.attrs.preserveAspectRatio) : I;
          const [a, b, c2, d, e, f] = vm;
          target = { ...ref, tag: 'g', attrs: { ...ref.attrs, id: '', transform: `matrix(${a} ${b} ${c2} ${d} ${e} ${f})` } };
        }
        wrapper.children.push(target);
        this.node(wrapper, parent, m, style, depth + 1);
        return;
      }
      case 'rect': {
        const x = len(p.x, this.vw), y = len(p.y, this.vh), w = len(p.width, this.vw), h = len(p.height, this.vh);
        if (w <= 0 || h <= 0) return;
        let rx = p.rx != null ? len(p.rx, this.vw) : NaN, ry = p.ry != null ? len(p.ry, this.vh) : NaN;
        if (isNaN(rx)) rx = isNaN(ry) ? 0 : ry;
        if (isNaN(ry)) ry = rx;
        rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
        layer = this.shape('rect', x, y, w, h, mul(pending, own), style, rectCmds(x, y, w, h, rx, ry));
        const r = Math.min(rx, ry);
        if (layer?.type === 'rect') layer.props.radius!.v = [r, r, r, r];
        break;
      }
      case 'circle': case 'ellipse': {
        const cx = len(p.cx, this.vw), cy = len(p.cy, this.vh);
        const rx = tag === 'circle' ? len(p.r, Math.hypot(this.vw, this.vh) / Math.SQRT2) : len(p.rx, this.vw);
        const ry = tag === 'circle' ? rx : len(p.ry, this.vh);
        if (rx <= 0 || ry <= 0) return;
        layer = this.shape('ellipse', cx - rx, cy - ry, rx * 2, ry * 2, mul(pending, own), style, ellipseCmds(cx, cy, rx, ry));
        break;
      }
      case 'line': {
        const cmds: PathCmd[] = [['M', len(p.x1, this.vw), len(p.y1, this.vh)], ['L', len(p.x2, this.vw), len(p.y2, this.vh)]];
        layer = this.path(cmds, mul(pending, own), { ...style, fill: 'none' });
        break;
      }
      case 'polyline': case 'polygon': {
        const a = numList(p.points);
        if (a.length < 4) return;
        const cmds: PathCmd[] = [['M', a[0], a[1]]];
        for (let i = 2; i + 1 < a.length; i += 2) cmds.push(['L', a[i], a[i + 1]]);
        if (tag === 'polygon') cmds.push(['Z']);
        layer = this.path(cmds, mul(pending, own), style);
        break;
      }
      case 'path': {
        const cmds = parsePathD(p.d ?? '');
        if (!cmds.length) return;
        layer = this.path(cmds, mul(pending, own), style);
        break;
      }
      case 'text': layer = this.text(n, p, mul(pending, own), style); break;
      case 'image': layer = this.image(p, mul(pending, own)); break;
      default:
        return;
    }
    if (!layer) return;
    if (p.id) layer.name = p.id;
    layer.props.opacity!.v = [opacity * 100];
    if (style.visibility === 'hidden') layer.visible = false;
    this.filter(layer, p);
    // paint-order: stroke drawn below the fill -> a stroke-only copy under the fill-only layer
    if (/^\s*stroke/.test(p['paint-order'] ?? '') && layer.props.strokeWidth?.v[0] && (layer.props.fill?.v[3] ?? 0) > 0) {
      const under: Layer = JSON.parse(JSON.stringify(layer));
      under.id = uid(); under.props.fill!.v = [0, 0, 0, 0]; delete under.paints;
      layer.props.strokeWidth!.v = [0];
      const host = this.clipHost(p, parent, mul(pending, own));
      this.add(under, host); this.add(layer, host);
      return;
    }
    this.add(layer, this.clipHost(p, parent, mul(pending, own)));
  }

  /** clip-path / mask on an element: a group holding the mask (a figma-style mask layer) + the element */
  private clipHost(p: Record<string, string>, parent: Layer, m: Mat, bbox?: number[]): Layer {
    const ref = (v: string | undefined) => { const u = /url\(\s*['"]?#([^'")\s]+)/.exec(v ?? ''); return u ? this.ids.get(u[1]) : undefined; };
    const cp = ref(p['clip-path']), mk = ref(p.mask);
    if (!cp && !mk) return parent;
    let host = parent;
    for (const [def, kind] of [[cp, 'vector'], [mk, 'luminance']] as [XmlNode | undefined, 'vector' | 'luminance'][]) {
      if (!def) continue;
      // a clipPath clipped itself: both masks apply (nested hosts intersect)
      if (def.attrs['clip-path'] && def.attrs['clip-path'] !== p['clip-path']) host = this.clipHost({ 'clip-path': def.attrs['clip-path'] }, host, m);
      const g = createLayer('group', { w: 0, h: 0 });
      g.name = kind === 'vector' ? 'clip-path' : 'mask';
      g.props.fill!.v = [1, 1, 1, 0]; g.props.strokeWidth!.v = [0]; g.clip = false;
      this.add(g, host);
      const mg = createLayer('group', { w: 0, h: 0 });
      mg.name = (def.attrs.id ?? kind) + ' (mask)';
      mg.props.fill!.v = [1, 1, 1, 0]; mg.props.strokeWidth!.v = [0]; mg.clip = false;
      mg.mask = true; mg.maskType = kind;
      this.add(mg, g);
      const units = kind === 'vector' ? def.attrs.clipPathUnits : def.attrs.maskContentUnits;
      let mm = m;
      if (units === 'objectBoundingBox') {
        const b = bbox ?? this.bboxOf(p);
        if (b) mm = mul(m, [b[2], 0, 0, b[3], b[0], b[1]]);
      }
      const st = this.inherit(DEFAULT_STYLE, kind === 'vector' ? { fill: 'black' } : {});
      for (const c of def.children) this.node(c, mg, mm, st, 1);
      host = g;
    }
    return host;
  }

  /** user-space bbox of a basic shape from its attributes (objectBoundingBox units) */
  private bboxOf(p: Record<string, string>): number[] | null {
    if (p.width != null && p.height != null) return [len(p.x, this.vw), len(p.y, this.vh), len(p.width, this.vw), len(p.height, this.vh)];
    if (p.r != null) { const r = len(p.r, this.vw); return [len(p.cx, this.vw) - r, len(p.cy, this.vh) - r, 2 * r, 2 * r]; }
    if (p.rx != null && p.ry != null) { const rx = len(p.rx, this.vw), ry = len(p.ry, this.vh); return [len(p.cx, this.vw) - rx, len(p.cy, this.vh) - ry, 2 * rx, 2 * ry]; }
    if (p.d) { const b = cmdsBounds(parsePathD(p.d)); return b; }
    if (p.points) { const a = numList(p.points); const xs = a.filter((_, k) => k % 2 === 0), ys = a.filter((_, k) => k % 2 === 1); return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; }
    return null;
  }

  /** filter="url(#f)": gaussian blur -> layer blur, drop shadow -> shadow props (figma radius = 2 sigma) */
  private filter(l: Layer, p: Record<string, string>) {
    const u = /url\(\s*['"]?#([^'")\s]+)/.exec(p.filter ?? '');
    const f = u ? this.ids.get(u[1]) : undefined;
    if (!f) return;
    for (const c of f.children) {
      const t = localName(c.tag), a = this.props(c);
      const sd = numList(a.stdDeviation)[0] ?? 0;
      if (t === 'feGaussianBlur' && sd > 0) l.props.blur = { v: [sd * 2] };
      if (t === 'feDropShadow') {
        const col = parseColor(a['flood-color'] ?? 'black') ?? [0, 0, 0, 1];
        const op = a['flood-opacity'] != null ? parseFloat(a['flood-opacity']) : 1;
        l.props.shadowColor = { v: [col[0], col[1], col[2], col[3] * op] };
        l.props.shadowOffset = { v: [parseFloat(a.dx ?? '2') || 0, parseFloat(a.dy ?? '2') || 0] };
        l.props.shadowBlur = { v: [sd * 2] };
        l.props.shadowSpread = { v: [0] };
        l.effects = [{ type: 'dropShadow', showBehind: true }];
      }
    }
  }

  private add(l: Layer, parent: Layer) {
    l.parent = parent.id;
    parent.children.push(l.id);
    this.layers.push(l);
  }

  /** decomposed transform for a local box (bx,by,w,h) under matrix m */
  private setTransform(l: Layer, m: Mat, bx: number, by: number, w: number, h: number) {
    const dc = decompose(m);
    l.props.anchor!.v = [w / 2, h / 2];
    l.props.position!.v = apply(m, bx + w / 2, by + h / 2);
    l.props.rotation!.v = [Math.abs(dc.rot) < 1e-9 ? 0 : dc.rot];
    l.props.scale!.v = [dc.sx * 100, dc.sy * 100];
  }

  private shape(type: 'rect' | 'ellipse', x: number, y: number, w: number, h: number, m: Mat, st: Style, fallback: PathCmd[]): Layer | null {
    if (decompose(m).skew || this.nonScaling) return this.path(fallback, m, st);
    const l = createLayer(type, { w, h });
    this.setTransform(l, m, x, y, w, h);
    // local box space (top-left origin) -> element user space
    this.applyPaint(l, st, [1, 0, 0, 1, x, y], w, h, [x, y, w, h]);
    this.applyStroke(l, st, 1);
    return l;
  }

  private path(cmds: PathCmd[], m: Mat, st: Style): Layer | null {
    const local = cmdsBounds(cmds);
    const baked = transformCmds(cmds, m);
    const [bx, by, bw, bh] = cmdsBounds(baked);
    const w = Math.max(bw, 1e-3), h = Math.max(bh, 1e-3);
    const geom: PathGeometry = { cmds: transformCmds(baked, [1, 0, 0, 1, -bx, -by]), fillRule: st.fillRule };
    const l = createLayer('path', { x: bx, y: by, w, h });
    l.geometry = [geom];
    l.geomSize = [w, h];
    // geometry space -> element user space = inv(m) · translate(bx,by)
    this.applyPaint(l, st, mul(invert(m), [1, 0, 0, 1, bx, by]), w, h, local);
    const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
    this.applyStroke(l, st, this.nonScaling ? 1 : Math.sqrt(det));
    return l;
  }

  /**
   * fill: solid -> props.fill, url(#gradient) -> layer.paints.
   * boxToUser maps the layer's local box space (0..w, 0..h) to the element's user space;
   * bbox is the element's own user-space bbox (for objectBoundingBox gradients).
   */
  private applyPaint(l: Layer, st: Style, boxToUser: Mat, w: number, h: number, bbox: number[]) {
    const fill = st.fill;
    const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(fill ?? '');
    if (url) {
      const pat = this.pattern(url[1], boxToUser, bbox, st.fillOpacity);
      if (pat) { l.paints = [pat]; l.props.fill!.v = [0.5, 0.5, 0.5, 1]; return; }
      const paint = this.gradient(url[1], boxToUser, w, h, bbox, st.fillOpacity);
      if (paint) {
        l.paints = [paint];
        l.props.fill!.v = paint.stops?.length ? [...paint.stops[paint.stops.length - 1].color] : [0, 0, 0, 0];
        return;
      }
      const fb = /\)\s*(.+)$/.exec(fill)?.[1];
      const c = parseColor(fb);
      l.props.fill!.v = c ? [c[0], c[1], c[2], c[3] * st.fillOpacity] : [0, 0, 0, 0];
      return;
    }
    const c = parseColor(fill);
    l.props.fill!.v = c ? [c[0], c[1], c[2], c[3] * st.fillOpacity] : [0, 0, 0, 0];
  }

  /** <pattern>: its tile as an svg image, repeated (image paint in tile mode with the pattern transform) */
  private pattern(id: string, boxToUser: Mat, bbox: number[], opacity: number): Paint | null {
    const n = this.ids.get(id);
    if (!n || localName(n.tag) !== 'pattern') return null;
    const a = this.gradAttrs(n);
    const obb = (a.patternUnits ?? 'objectBoundingBox') !== 'userSpaceOnUse';
    const L = (v: string | undefined, ref: number) => (v == null ? 0 : v.trim().endsWith('%') ? (parseFloat(v) / 100) * ref : parseFloat(v) * (obb ? ref : 1));
    const tw = L(a.width, obb ? bbox[2] : this.vw), th = L(a.height, obb ? bbox[3] : this.vh);
    if (!(tw > 0 && th > 0)) return null;
    const tx = L(a.x, obb ? bbox[2] : this.vw) + (obb ? bbox[0] : 0), ty = L(a.y, obb ? bbox[3] : this.vh) + (obb ? bbox[1] : 0);
    let kids = n.children;
    for (let src: XmlNode | undefined = n, k = 0; !kids.length && src && k < 8; k++) { const h: string | undefined = src.attrs.href ?? src.attrs['xlink:href']; src = h?.startsWith('#') ? this.ids.get(h.slice(1)) : undefined; if (src) kids = src.children; }
    const vb = numList(a.viewBox);
    const ccu = a.patternContentUnits === 'objectBoundingBox' ? ` transform="matrix(${bbox[2]} 0 0 ${bbox[3]} 0 0)"` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}" viewBox="${vb.length === 4 ? vb.join(' ') : `0 0 ${tw} ${th}`}"${a.preserveAspectRatio ? ` preserveAspectRatio="${a.preserveAspectRatio}"` : ''}><g${ccu}>${kids.map(serializeXml).join('')}</g></svg>`;
    const data = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    const asset: Asset = { id: uid('a'), kind: 'image', mime: 'image/svg+xml', data, width: tw, height: th };
    this.assets.push(asset);
    // tile space -> user (patternTransform, origin) -> layer box
    const m = mul(invert(boxToUser), mul(parseTransform(a.patternTransform), [1, 0, 0, 1, tx, ty]));
    return { type: 'image', imageRef: asset.id, scaleMode: 'tile', tileScale: 1, transform: m, opacity };
  }

  private gradientStops(n: XmlNode, seen = 0): XmlNode[] {
    const stops = n.children.filter(c => localName(c.tag) === 'stop');
    if (stops.length || seen > 8) return stops;
    const href = n.attrs.href ?? n.attrs['xlink:href'];
    const ref = href?.startsWith('#') ? this.ids.get(href.slice(1)) : undefined;
    return ref ? this.gradientStops(ref, seen + 1) : [];
  }

  /** gradient attrs with href inheritance */
  private gradAttrs(n: XmlNode, seen = 0): Record<string, string> {
    const href = n.attrs.href ?? n.attrs['xlink:href'];
    const ref = href?.startsWith('#') ? this.ids.get(href.slice(1)) : undefined;
    const base = ref && seen < 8 ? this.gradAttrs(ref, seen + 1) : {};
    return { ...base, ...n.attrs };
  }

  private gradient(id: string, boxToUser: Mat, w: number, h: number, bbox: number[], opacity: number): Paint | null {
    const n = this.ids.get(id);
    if (!n) return null;
    const tag = localName(n.tag);
    if (tag !== 'linearGradient' && tag !== 'radialGradient') return null;
    const a = this.gradAttrs(n);
    const stops = this.gradientStops(n).map(s => {
      const sp = this.props(s);
      const off = sp.offset ?? '0';
      const pos = off.trim().endsWith('%') ? parseFloat(off) / 100 : parseFloat(off);
      const c = parseColor(sp['stop-color'] ?? 'black') ?? [0, 0, 0, 0];
      const so = sp['stop-opacity'] != null ? parseFloat(sp['stop-opacity']) : 1;
      return { pos: clamp01(pos), color: [c[0], c[1], c[2], c[3] * so] as Color };
    });
    if (!stops.length) return null;
    // monotonic offsets (svg spec)
    for (let i = 1; i < stops.length; i++) if (stops[i].pos < stops[i - 1].pos) stops[i].pos = stops[i - 1].pos;
    const obb = (a.gradientUnits ?? 'objectBoundingBox') !== 'userSpaceOnUse';
    const rw = obb ? 1 : this.vw, rh = obb ? 1 : this.vh;
    const L = (v: string | undefined, ref: number, d: string) => {
      const s = v ?? d;
      return s.trim().endsWith('%') ? (parseFloat(s) / 100) * ref : len(s, ref, 0);
    };
    let base: Mat;
    if (tag === 'linearGradient') {
      const x1 = L(a.x1, rw, '0%'), y1 = L(a.y1, rh, '0%'), x2 = L(a.x2, rw, '100%'), y2 = L(a.y2, rh, '0%');
      const dx = x2 - x1, dy = y2 - y1;
      // unit x-axis -> (p1->p2); unit y-axis -> perpendicular of same length; (0,.5) -> p1
      base = [dx, dy, -dy, dx, x1 + 0.5 * dy, y1 - 0.5 * dx];
      if (dx === 0 && dy === 0) base = [1e-6, 0, 0, 1e-6, x1, y1];
    } else {
      const rref = Math.hypot(rw, rh) / Math.SQRT2;
      const cx = L(a.cx, rw, '50%'), cy = L(a.cy, rh, '50%'), r = L(a.r, rref, '50%');
      base = [2 * r, 0, 0, 2 * r, cx - r, cy - r];
    }
    let g = mul(parseTransform(a.gradientTransform), base);
    if (obb) g = mul([bbox[2] || 1, 0, 0, bbox[3] || 1, bbox[0], bbox[1]], g);
    // unit gradient space -> user -> layer box -> normalized box
    let t = mul([1 / (w || 1), 0, 0, 1 / (h || 1), 0, 0], mul(invert(boxToUser), g));
    const spread = a.spreadMethod;
    let st = stops;
    if (spread === 'reflect' || spread === 'repeat') {
      // the gradient parameter range the box covers -> whole periods k0..k1, stops repeated (or mirrored)
      const inv = invert(t), lin = tag === 'linearGradient';
      let lo = Infinity, hi = -Infinity;
      for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const [gx, gy] = apply(inv, x, y);
        const v = lin ? gx : Math.hypot(gx - 0.5, gy - 0.5) * 2;
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      const k0 = lin ? Math.max(-32, Math.floor(lo)) : 0, k1 = Math.min(k0 + 64, Math.ceil(hi));
      const n = Math.max(1, k1 - k0);
      if (n > 1 || k0 !== 0) {
        st = [];
        for (let k = k0; k < k1; k++) {
          const flip = spread === 'reflect' && ((k % 2) + 2) % 2 === 1;
          const seq = flip ? stops.map(s => ({ pos: 1 - s.pos, color: s.color })).reverse() : stops;
          for (const s of seq) st.push({ pos: (k - k0 + s.pos) / n, color: s.color });
        }
        // gradient space scaled so [0,1] spans the n periods
        const sc: Mat = lin ? [n, 0, 0, 1, k0, 0] : [n, 0, 0, n, 0.5 - 0.5 * n, 0.5 - 0.5 * n];
        t = mul(t, sc);
      }
    }
    return { type: tag === 'linearGradient' ? 'linear' : 'radial', stops: st, transform: t, opacity };
  }

  private applyStroke(l: Layer, st: Style, scale: number) {
    const c = parseColor(st.stroke) ?? this.gradientFallback(st.stroke);
    if (!c || st.strokeWidth <= 0) {
      l.props.stroke!.v = [0, 0, 0, 0];
      l.props.strokeWidth!.v = [0];
      return;
    }
    l.props.stroke!.v = [c[0], c[1], c[2], c[3] * st.strokeOpacity];
    l.props.strokeWidth!.v = [st.strokeWidth * scale];
    l.strokeAlign = 'center';
    l.strokeCap = st.cap === 'round' ? 'round' : st.cap === 'square' ? 'square' : 'butt';
    l.strokeJoin = st.join === 'round' ? 'round' : st.join === 'bevel' ? 'bevel' : 'miter';
    l.miterLimit = st.miter;
    if (st.dash) {
      let d = st.dash.map(x => x * scale);
      if (d.length % 2) d = [...d, ...d];
      // dash offset: rotate the pattern (the renderer has no offset)
      const total = d.reduce((a, b) => a + b, 0);
      let off = total > 0 ? (((st.dashOffset * scale) % total) + total) % total : 0;
      if (off > 0) {
        const out: number[] = [];
        let k = 0;
        while (off >= d[k % d.length] && off > 0) { off -= d[k % d.length]; k++; }
        // start inside segment k: a partial segment, the rest, then an even fix-up keeps on/off parity
        const rest = d.slice(k % d.length).concat(d.slice(0, k % d.length));
        rest[0] -= off;
        if (k % 2) out.push(0);
        out.push(...rest);
        if (out.length % 2) out.push(0);
        d = out;
      }
      l.dash = d;
    }
  }

  private gradientFallback(v: string): Color | null {
    const url = /^url\(\s*['"]?#([^'")\s]+)/.exec(v ?? '');
    if (!url) return null;
    const n = this.ids.get(url[1]);
    const s = n ? this.gradientStops(n)[0] : undefined;
    return s ? parseColor(this.props(s)['stop-color'] ?? 'black') : null;
  }

  private text(n: XmlNode, p: Record<string, string>, m: Mat, st: Style): Layer | null {
    // flatten tspans; each explicit line break (tspan with x/dy) becomes a newline
    let content = '';
    const runs: TextRun[] = [];
    const walk = (x: XmlNode, xs: Style) => {
      for (const part of x.parts) {
        if (typeof part === 'string') content += part;
        else if (localName(part.tag) === 'tspan') {
          // a tspan that repositions vertically starts a new line
          if (content.trim() && (part.attrs.dy != null || part.attrs.y != null)) content += '\n';
          const ps = this.inherit(xs, this.props(part));
          const start = content.length;
          walk(part, ps);
          const r: TextRun = { start, end: content.length };
          const c = parseColor(ps.fill);
          if (ps.fill !== st.fill && c) r.fill = [c[0], c[1], c[2], c[3] * ps.fillOpacity];
          if (ps.fontWeight !== st.fontWeight) r.fontWeight = ps.fontWeight === 'bold' ? 700 : parseInt(ps.fontWeight, 10) || 400;
          if (ps.fontStyle !== st.fontStyle) r.fontStyle = /italic|oblique/.test(ps.fontStyle) ? 'italic' : 'normal';
          if (ps.fontSize !== st.fontSize) r.fontSize = ps.fontSize;
          if (Object.keys(r).length > 2 && r.end > r.start) runs.push(r);
        }
      }
    };
    walk(n, st);
    // per-glyph x / y lists: one text layer per character at its position
    const xl = numList(p.x), yl = numList(p.y);
    if ((xl.length > 1 || yl.length > 1) && !n.children.length) {
      const g = createLayer('group', { w: 0, h: 0 });
      g.name = content.trim().slice(0, 32);
      g.props.fill!.v = [1, 1, 1, 0]; g.props.strokeWidth!.v = [0]; g.clip = false;
      this.setTransform(g, m, 0, 0, 0, 0);
      const chars = [...content.trim()];
      let cx = xl[0] ?? 0, cy = yl[0] ?? 0;
      chars.forEach((ch, k) => {
        if (xl[k] != null) cx = xl[k];
        if (yl[k] != null) cy = yl[k];
        const one = this.text({ tag: 'text', attrs: {}, children: [], text: ch, parts: [ch] }, { x: String(cx), y: String(cy) }, I, st);
        if (one) { one.name = ch; one.parent = g.id; g.children.push(one.id); this.layers.push(one); }
        cx += st.fontSize * 0.6;
      });
      return g;
    }
    // whitespace collapse (run offsets are approximate when inner whitespace collapses)
    content = content.replace(/[ \t\r]*\n[ \t\r]*/g, (s) => (s.includes('\n') ? '\n' : ' ')).replace(/[ \t]+/g, ' ');
    const lead = content.length - content.trimStart().length;
    content = content.trim();
    if (!content) return null;
    const first = n.children.find(c => localName(c.tag) === 'tspan');
    const x = len(p.x ?? first?.attrs.x, this.vw) + len(p.dx, this.vw);
    const y = len(p.y ?? first?.attrs.y, this.vh) + len(p.dy, this.vh);
    const fs = st.fontSize;
    const lines = content.split('\n');
    const w = Math.max(...lines.map(s => s.length)) * fs * 0.6 + Math.max(0, st.letterSpacing) * content.length;
    const lh = 1.2;
    const h = lines.length * fs * lh;
    const align = st.textAnchor === 'middle' ? 'center' : st.textAnchor === 'end' ? 'right' : 'left';
    const bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    // the renderer puts the first baseline at half leading + ascender (inter: .969 / .242 em)
    const by = y - fs * ((lh - 1.211) / 2 + 0.969);
    const l = createLayer('text', { w, h });
    this.setTransform(l, m, bx, by, w, h);
    const wt = st.fontWeight === 'bold' ? 700 : st.fontWeight === 'normal' ? 400 : parseInt(st.fontWeight, 10) || 400;
    l.text = { content, fontFamily: st.fontFamily, fontSize: fs, fontWeight: wt, fontStyle: /italic|oblique/.test(st.fontStyle) ? 'italic' : 'normal', lineHeight: lh, letterSpacing: st.letterSpacing, align, autoResize: 'width' };
    // run offsets refer to the untrimmed content: shift them by what trimming removed at the start
    if (runs.length) l.text.runs = runs.map(r => ({ ...r, start: Math.max(0, r.start - lead), end: Math.max(0, r.end - lead) })).filter(r => r.end > r.start);
    const c = parseColor(st.fill) ?? this.gradientFallback(st.fill) ?? [0, 0, 0, 1];
    l.props.fill!.v = [c[0], c[1], c[2], c[3] * st.fillOpacity];
    l.name = content.slice(0, 32);
    return l;
  }

  private image(p: Record<string, string>, m: Mat): Layer | null {
    const href = p.href ?? p['xlink:href'] ?? '';
    const w = len(p.width, this.vw), h = len(p.height, this.vh);
    if (!href.startsWith('data:') || w <= 0 || h <= 0) return null;
    const mime = /^data:([^;,]+)/.exec(href)?.[1] ?? 'image/png';
    const nat = dataImageSize(href) ?? [w, h];
    const asset: Asset = { id: uid('a'), kind: 'image', mime, data: href, width: nat[0], height: nat[1] };
    this.assets.push(asset);
    // preserveAspectRatio: the image's own aspect inside the x / y / width / height box
    const [ix, iy, iw, ih] = (() => {
      const vm = viewBoxMatrix([0, 0, nat[0], nat[1]], w, h, p.preserveAspectRatio);
      return [vm[4], vm[5], nat[0] * vm[0], nat[1] * vm[3]];
    })();
    const l = createLayer('image', { w: iw, h: ih });
    this.setTransform(l, m, len(p.x, this.vw) + ix, len(p.y, this.vh) + iy, iw, ih);
    l.imageRef = asset.id;
    return l;
  }
}

/** viewBox (x, y, w, h) -> viewport (0..w, 0..h) with preserveAspectRatio */
function viewBoxMatrix(vb: number[], w: number, h: number, parAttr?: string): Mat {
  const par = (parAttr ?? 'xMidYMid meet').trim();
  let sx = w / vb[2], sy = h / vb[3], tx = 0, ty = 0;
  if (!par.startsWith('none')) {
    const s = par.includes('slice') ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = sy = s;
    const ax = par.includes('xMin') ? 0 : par.includes('xMax') ? 1 : 0.5;
    const ay = par.includes('YMin') ? 0 : par.includes('YMax') ? 1 : 0.5;
    tx = (w - vb[2] * s) * ax; ty = (h - vb[3] * s) * ay;
  }
  return [sx, 0, 0, sy, tx - vb[0] * sx, ty - vb[1] * sy];
}

const K = 0.5522847498307936;
function ellipseCmds(cx: number, cy: number, rx: number, ry: number): PathCmd[] {
  const kx = rx * K, ky = ry * K;
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ['Z'],
  ];
}
function rectCmds(x: number, y: number, w: number, h: number, rx: number, ry: number): PathCmd[] {
  if (rx <= 0 || ry <= 0) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
  const kx = rx * K, ky = ry * K;
  return [
    ['M', x + rx, y], ['L', x + w - rx, y],
    ['C', x + w - rx + kx, y, x + w, y + ry - ky, x + w, y + ry], ['L', x + w, y + h - ry],
    ['C', x + w, y + h - ry + ky, x + w - rx + kx, y + h, x + w - rx, y + h], ['L', x + rx, y + h],
    ['C', x + rx - kx, y + h, x, y + h - ry + ky, x, y + h - ry], ['L', x, y + ry],
    ['C', x, y + ry - ky, x + rx - kx, y, x + rx, y], ['Z'],
  ];
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** back to markup (pattern tiles become standalone svg images) */
function serializeXml(n: XmlNode): string {
  const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${xmlEsc(v)}"`).join('');
  const inner = n.parts.map(p => (typeof p === 'string' ? xmlEsc(p) : serializeXml(p))).join('');
  return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
}

/** natural size of a data: uri image (png, jpeg, gif header; svg width / height / viewBox) */
function dataImageSize(href: string): [number, number] | null {
  const comma = href.indexOf(',');
  if (comma < 0) return null;
  const meta = href.slice(5, comma), body = href.slice(comma + 1);
  let bytes: Uint8Array;
  try {
    if (/;base64/i.test(meta)) { const bin = atob(body.replace(/\s+/g, '')); bytes = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k); }
    else bytes = new TextEncoder().encode(decodeURIComponent(body));
  } catch { return null; }
  if (/svg/i.test(meta)) {
    const root = parseXml(new TextDecoder().decode(bytes));
    if (!root) return null;
    const vb = numList(root.attrs.viewBox);
    if (vb.length !== 4) return null; // no viewBox: no intrinsic aspect ratio, the image stretches
    let w = len(root.attrs.width, 0, 0), h = len(root.attrs.height, 0, 0);
    if (!w && vb.length === 4) w = vb[2];
    if (!h && vb.length === 4) h = vb[3];
    return w > 0 && h > 0 ? [w, h] : null;
  }
  const b = bytes;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return [(b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0];
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return [b[6] | (b[7] << 8), b[8] | (b[9] << 8)];
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const mk = b[o + 1], ln = (b[o + 2] << 8) | b[o + 3];
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return [(b[o + 7] << 8) | b[o + 8], (b[o + 5] << 8) | b[o + 6]];
      o += 2 + ln;
    }
  }
  return null;
}

/** convert svg markup to layers. a single root group holds the svg content. */
export function svgToLayers(svgText: string): { layers: Layer[]; roots: string[]; assets: Asset[] } {
  const root = parseXml(svgText);
  if (!root) return { layers: [], roots: [], assets: [] };
  const c = new SvgConverter(root);
  const roots = c.run();
  return { layers: c.layers, roots, assets: c.assets };
}
