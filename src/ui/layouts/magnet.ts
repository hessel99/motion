// stage layout: the inspector is a card that sticks next to the selection on the canvas.
// it is an absolutely positioned, contained card moved with left/top (nothing else re-lays out), recomputed when the
// selection, document, view or (paused) time changes, never per frame during playback, and
// frozen while a pointer gesture runs in the viewport so it does not chase a layer being dragged.
import { editor } from '../../app/editor';
import type { ViewportController } from '../viewport-controller';

const GAP = 28;
const EDGE = 12;

export function attachMagnet(card: HTMLElement, getVp: () => ViewportController | null) {
  const st = editor.store;
  let raf = 0, down = false, lastX = NaN, lastY = NaN, lastDock = '';
  const schedule = () => { if (!raf) raf = requestAnimationFrame(place); };

  function place() {
    raf = 0;
    if (down || st.playing) return;
    const vp = getVp();
    const host = document.querySelector<HTMLElement>('.viewport');
    const app = card.offsetParent as HTMLElement | null;
    if (!vp || !host || !app) return;
    const hr = host.getBoundingClientRect(), ar = app.getBoundingClientRect();
    const ox = hr.left - ar.left, oy = hr.top - ar.top;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    // selection bounds in viewport pixels
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of st.selection) {
      const c = editor.renderer.corners(id);
      if (!c) continue;
      for (let i = 0; i < 8; i += 2) {
        const [x, y] = vp.toScreen(c[i], c[i + 1]);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    let x: number, y: number, dock: string;
    const maxX = hr.width - cw - EDGE, maxY = Math.max(EDGE, hr.height - ch - EDGE);
    if (!isFinite(x0)) { x = maxX; y = EDGE; dock = 'docked'; }
    else {
      // right of the selection, else left of it, else docked to the right edge
      if (x1 + GAP + cw <= hr.width - EDGE) { x = x1 + GAP; dock = 'right'; }
      else if (x0 - GAP - cw >= EDGE) { x = x0 - GAP - cw; dock = 'left'; }
      else { x = maxX; dock = 'docked'; }
      y = Math.min(maxY, Math.max(EDGE, y0 - 8));
    }
    x = Math.round(ox + Math.max(EDGE, x)); y = Math.round(oy + y);
    if (x !== lastX || y !== lastY) {
      card.style.left = x + "px"; card.style.top = y + "px"; lastX = x; lastY = y;
    }
    if (dock !== lastDock) { card.dataset.dock = dock; lastDock = dock; }
  }

  const onDown = (e: PointerEvent) => { if ((e.target as HTMLElement).closest?.('.viewport')) down = true; };
  const onUp = () => { if (down) { down = false; schedule(); } };
  const offs = [
    st.on('selection', schedule), st.on('doc', schedule), st.on('playing', schedule),
    st.on('time', () => { if (!st.playing) schedule(); }),
    editor.on('view', schedule), editor.on('layout', schedule),
  ];
  // the card's own size changes (another inspector section) can push it off the stage
  const ro = new ResizeObserver(schedule);
  ro.observe(card);
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('resize', schedule);
  schedule();
  return () => {
    offs.forEach(o => o()); ro.disconnect();
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('resize', schedule);
    cancelAnimationFrame(raf);
    card.style.left = ""; card.style.top = ""; delete card.dataset.dock;
  };
}
