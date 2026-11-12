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
