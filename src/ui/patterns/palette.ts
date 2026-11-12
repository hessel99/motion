// canvas colors for the pattern widgets (ease studio, feel pad, rhythm strip), resolved from the
// design tokens once per theme (getComputedStyle per frame forces a style recalc). `ink(a)` is
// the theme's text color at alpha a: white-ish lines in dark, dark lines in light.

import { onThemeChange, T } from '../theme';
import { cssVar } from './ticker';

export interface PtPalette {
  name: 'dark' | 'light';
  accent: string;
  /** the "B" (compare / hover) color */
  warm: string;
  padBg: string;
  /** text color with alpha */
  ink: (a: number) => string;
  /** accent with alpha */
  accentA: (a: number) => string;
  warmA: (a: number) => string;
}

let cache: PtPalette | null = null;
let hooked = false;

/** '#rrggbb' / '#rgb' / 'rgb(a)(...)' -> [r, g, b] (0..255); null if unparseable */
export function parseColor(c: string): [number, number, number] | null {
  c = c.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return [...m[1]].map(h => parseInt(h + h, 16)) as [number, number, number];
  const r = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c);
  return r ? [+r[1], +r[2], +r[3]] : null;
}

const withAlpha = (c: string, fallback: [number, number, number]) => {
  const [r, g, b] = parseColor(c) ?? fallback;
  return (a: number) => `rgba(${r},${g},${b},${a})`;
};

export function ptPalette(): PtPalette {
  if (!hooked && typeof document !== 'undefined') { hooked = true; onThemeChange(() => { cache = null; }); }
  if (cache) return cache;
  const root = document.documentElement;
  const light = root.dataset.theme === 'light';
  const accent = cssVar(root, '--accent', T.accent);
  const warm = cssVar(root, '--pt-b', light ? '#c26a00' : '#ffb54c');
  const text = cssVar(root, '--text', light ? '#1c1c21' : '#e4e4e8');
  cache = {
    name: light ? 'light' : 'dark',
    accent,
    warm,
    padBg: cssVar(root, '--pt-pad-bg', light ? '#ffffff' : '#141418'),
    ink: withAlpha(text, light ? [28, 28, 33] : [228, 228, 232]),
    accentA: withAlpha(accent, [76, 141, 255]),
    warmA: withAlpha(warm, [255, 181, 76]),
  };
  return cache;
}
