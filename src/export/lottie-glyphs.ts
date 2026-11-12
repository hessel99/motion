// lottie text as glyph outlines ("chars"): with them every lottie player (lottie-web canvas,
// ios, android) draws our text exactly, without needing the font installed. only the bundled
// Inter has outlines here; projects with other fonts keep font-name based text.

import type { PathCmd } from '../core/model';
import { cmdsToLottieShapes } from './lottie';

const STYLE: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
export const interStyle = (w: number) => STYLE[Math.min(900, Math.max(100, Math.round(w / 100) * 100))];

// latin + latin-ext outlines per weight (woff: opentype.js reads woff, not woff2)
const files = import.meta.glob('/node_modules/@fontsource/inter/files/inter-latin{,-ext}-*00-normal.woff', { query: '?url', import: 'default' });

const fonts = new Map<string, Promise<any | null>>();
function loadFont(weight: number, subset: 'latin' | 'latin-ext') {
  const key = `${subset}-${weight}`;
  let p = fonts.get(key);
  if (!p) {
    const path = `/node_modules/@fontsource/inter/files/inter-${subset}-${weight}-normal.woff`;
    const imp = files[path];
    p = imp ? Promise.all([imp() as Promise<string>, import('opentype.js')]).then(async ([url, ot]) => ot.parse(await (await fetch(url)).arrayBuffer())).catch(() => null) : Promise.resolve(null);
    fonts.set(key, p);
  }
  return p;
}

function glyphCmds(path: { commands: any[] }): PathCmd[] {
  const out: PathCmd[] = [];
  for (const c of path.commands) {
    if (c.type === 'M') out.push(['M', c.x, c.y]);
    else if (c.type === 'L') out.push(['L', c.x, c.y]);
    else if (c.type === 'Q') out.push(['Q', c.x1, c.y1, c.x, c.y]);
    else if (c.type === 'C') out.push(['C', c.x1, c.y1, c.x2, c.y2, c.x, c.y]);
    else if (c.type === 'Z') out.push(['Z']);
  }
  return out;
}

/** walks all text layers (main + precomp assets) */
function textDocs(lot: any): any[] {
  const docs: any[] = [];
  const walk = (layers: any[]) => { for (const l of layers ?? []) if (l.ty === 5) for (const k of l.t?.d?.k ?? []) docs.push(k.s); };
  walk(lot.layers);
  for (const a of lot.assets ?? []) walk(a.layers);
  return docs;
}

/** adds `chars` (glyph outlines) to a lottie export when all its text uses Inter. returns whether it did */
export async function addGlyphs(lot: any): Promise<boolean> {
  const list: any[] = lot.fonts?.list ?? [];
  if (!list.length || list.some(f => f.fFamily !== 'Inter')) return false;
  const docs = textDocs(lot);
  const chars: any[] = [];
  for (const f of list) {
    const weight = +(Object.entries(STYLE).find(([, s]) => f.fStyle.replace(' Italic', '') === s)?.[0] ?? 400);
    const [latin, ext] = await Promise.all([loadFont(weight, 'latin'), loadFont(weight, 'latin-ext')]);
    if (!latin) return false;
    const used = new Set<string>();
    for (const d of docs) if (d.f === f.fName) for (const ch of String(d.t)) if (ch !== '\r' && ch !== '\n') used.add(ch);
    for (const ch of used) {
      let font = latin, g = latin.charToGlyph(ch);
      if ((!g || g.index === 0) && ext) { const g2 = ext.charToGlyph(ch); if (g2 && g2.index !== 0) { font = ext; g = g2; } }
      const scale = 100 / font.unitsPerEm;
      const shapes = cmdsToLottieShapes(glyphCmds(g.getPath(0, 0, 100)));
      chars.push({
        ch, size: 100, style: f.fStyle, fFamily: f.fFamily, w: Math.round(g.advanceWidth * scale * 100) / 100,
        data: shapes.length ? { shapes: [{ ty: 'gr', nm: ch, np: shapes.length, it: [...shapes.map(s => ({ ty: 'sh', ks: { a: 0, k: s } })), { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }] }] } : {},
      });
    }
  }
  lot.chars = chars;
  // with glyphs, lottie-web places the first baseline at ascent% of the size: 90 matches our
  // layout of Inter (measured against lottie-web, scripts/export-compare.mjs)
  for (const f of list) f.ascent = 90;
  return true;
}
