// bundled fonts (Inter, OFL-1.1) so text renders the same as in Figma on every machine.
// loaded explicitly with FontFace on the main thread AND inside raster workers
// (workers don't see the document's fonts).

import w100 from '@fontsource/inter/files/inter-latin-100-normal.woff2?url';
import w200 from '@fontsource/inter/files/inter-latin-200-normal.woff2?url';
import w300 from '@fontsource/inter/files/inter-latin-300-normal.woff2?url';
import w400 from '@fontsource/inter/files/inter-latin-400-normal.woff2?url';
import w500 from '@fontsource/inter/files/inter-latin-500-normal.woff2?url';
import w600 from '@fontsource/inter/files/inter-latin-600-normal.woff2?url';
import w700 from '@fontsource/inter/files/inter-latin-700-normal.woff2?url';
import w800 from '@fontsource/inter/files/inter-latin-800-normal.woff2?url';
import w900 from '@fontsource/inter/files/inter-latin-900-normal.woff2?url';

export const FONT_FILES: { family: string; weight: number; url: string }[] = [
  [100, w100], [200, w200], [300, w300], [400, w400], [500, w500], [600, w600], [700, w700], [800, w800], [900, w900],
].map(([weight, url]) => ({ family: 'Inter', weight: weight as number, url: url as string }));

let loading: Promise<void> | null = null;

/** load the bundled fonts into a FontFaceSet (document.fonts or self.fonts in a worker) */
export function loadBundledFonts(base?: string): Promise<void> {
  if (loading) return loading;
  const set: any = (globalThis as any).document?.fonts ?? (globalThis as any).fonts;
  if (!set || typeof FontFace === 'undefined') return (loading = Promise.resolve());
  loading = Promise.all(FONT_FILES.map(async f => {
    try {
      const url = base ? new URL(f.url, base).href : f.url;
      const face = new FontFace(f.family, `url(${url})`, { weight: String(f.weight), style: 'normal' });
      await face.load();
      set.add(face);
    } catch { /* missing font file: fall back to system fonts */ }
  })).then(() => undefined);
  return loading;
}

// ---------------- more bundled families (OFL-1.1, variable, latin), loaded on first use ----------------
// common Figma fonts, so text that isn't drawn from Figma's glyph outlines (edited text, plugin / REST
// imports) still uses the right face. ~300 KB in all, fetched only when a text layer uses the family.
import robotoFlex from '@fontsource-variable/roboto-flex/files/roboto-flex-latin-wght-normal.woff2?url';
import sourceSerif from '@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2?url';
import sourceSerifI from '@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-italic.woff2?url';
import playfair from '@fontsource-variable/playfair-display/files/playfair-display-latin-wght-normal.woff2?url';
import playfairI from '@fontsource-variable/playfair-display/files/playfair-display-latin-wght-italic.woff2?url';
import jbMono from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';
import jbMonoI from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-italic.woff2?url';

export const LAZY_FONTS: Record<string, { url: string; weight: string; style: 'normal' | 'italic' }[]> = {
  'Roboto Flex': [{ url: robotoFlex, weight: '100 1000', style: 'normal' }],
  'Source Serif 4': [{ url: sourceSerif, weight: '200 900', style: 'normal' }, { url: sourceSerifI, weight: '200 900', style: 'italic' }],
  'Playfair Display': [{ url: playfair, weight: '400 900', style: 'normal' }, { url: playfairI, weight: '400 900', style: 'italic' }],
  'JetBrains Mono': [{ url: jbMono, weight: '100 800', style: 'normal' }, { url: jbMonoI, weight: '100 800', style: 'italic' }],
};
const lazyLoading = new Map<string, Promise<boolean>>();
/** families being fetched right now (a frame drawn meanwhile uses a fallback) */
export let fontsPending = 0;

/** load a bundled family on first use. resolves true when it was loaded by this call (re-raster) */
export function ensureFont(family: string, base?: string): Promise<boolean> {
  const files = LAZY_FONTS[family];
  if (!files) return Promise.resolve(false);
  const p0 = lazyLoading.get(family);
  if (p0) return p0.then(() => false);
  const set: any = (globalThis as any).document?.fonts ?? (globalThis as any).fonts;
  if (!set || typeof FontFace === 'undefined') return Promise.resolve(false);
  fontsPending++;
  const p = Promise.all(files.map(async f => {
    try {
      const face = new FontFace(family, `url(${base ? new URL(f.url, base).href : f.url})`, { weight: f.weight, style: f.style });
      await face.load();
      set.add(face);
    } catch { /* offline / missing: system fallback */ }
  })).then(() => { fontsPending--; return true; });
  lazyLoading.set(family, p);
  return p;
}
