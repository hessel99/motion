// the viewport + timeline controllers, for chrome that drives them (toolbar, transport, menus).
// set once by App when the canvases mount.
import type { ViewportController } from '../viewport-controller';
import type { Timeline } from '../timeline';

export const view: { vp: ViewportController | null; tl: Timeline | null } = { vp: null, tl: null };

/** 00:01:12 (minutes, seconds, frames) */
export function fmtTimecode(t: number, fps: number) {
  const s = Math.floor(t + 1e-6);
  const f = Math.floor((t - s) * fps + 1e-6);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}
