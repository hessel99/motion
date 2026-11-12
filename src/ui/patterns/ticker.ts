// one requestAnimationFrame loop shared by every animated pattern widget. it only runs while
// something is subscribed, and stops while the tab is hidden (rAF does that for us).

type Fn = (now: number) => void;
const subs = new Set<Fn>();
let raf = 0;

function loop(now: number) {
  raf = subs.size ? requestAnimationFrame(loop) : 0;
  for (const fn of subs) { try { fn(now); } catch (e) { console.error('[patterns ticker]', e); } }
}

export function onTick(fn: Fn): () => void {
  subs.add(fn);
  if (!raf) raf = requestAnimationFrame(loop);
  return () => { subs.delete(fn); };
}

/** size a canvas for the device pixel ratio once; returns the 2d context scaled to css px */
export function setupCanvas(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = w + 'px'; c.style.height = h + 'px';
  }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** read a css custom property from an element (theme-aware canvas colors) with a fallback */
export function cssVar(el: Element, name: string, fallback: string) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}
