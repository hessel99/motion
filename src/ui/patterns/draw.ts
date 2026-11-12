// tiny canvas drawing helpers shared by the pattern widgets (no per-frame allocations: callers
// pass numbers, paths are built straight into the context)

import { springAt } from '../../core/easing';
import { bezierY } from './feel';
import type { EaseSpec } from './ops';

/** progress y for normalized time x under an ease spec */
export function easeAt(spec: EaseSpec, x: number): number {
  if (spec.kind === 'linear') return x <= 0 ? 0 : x >= 1 ? 1 : x;
  if (spec.kind === 'spring') return x <= 0 ? 0 : x >= 1 ? 1 : springAt(spec.bounce, x);
  return bezierY(spec.v, x);
}

export function sameSpec(a: EaseSpec | null | undefined, b: EaseSpec | null | undefined) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'spring') return Math.abs(a.bounce - (b as any).bounce) < 1e-3;
  if (a.kind === 'bezier') return a.v.every((x, i) => Math.abs(x - (b as any).v[i]) < 2e-3);
  return true;
}

/** stroke the curve of an ease into the box (x, y, w, h); y range [lo, hi] maps to the box */
export function strokeEase(ctx: CanvasRenderingContext2D, spec: EaseSpec, x: number, y: number, w: number, h: number, lo = 0, hi = 1, steps = 40) {
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const v = easeAt(spec, u);
    const px = x + u * w, py = y + h - ((v - lo) / (hi - lo)) * h;
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.stroke();
}

/** loop phase for preview animations: hold, move (0..1), hold. returns progress time in 0..1 */
export function loopPhase(now: number, moveMs = 900, holdA = 220, holdB = 520) {
  const period = holdA + moveMs + holdB;
  const t = now % period;
  return t < holdA ? 0 : t > holdA + moveMs ? 1 : (t - holdA) / moveMs;
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * an animator's spacing chart: the ball's position at equal time steps along a line. bunched
 * dots = slow, spread dots = fast. plus the live ball (stretched by its speed, like motion blur).
 */
export function drawLane(ctx: CanvasRenderingContext2D, spec: EaseSpec, x0: number, x1: number, y: number, phase: number, color: string, dim: string, ghosts = 13) {
  const span = x1 - x0;
  ctx.fillStyle = dim;
  for (let i = 0; i < ghosts; i++) {
    const v = easeAt(spec, i / (ghosts - 1));
    ctx.beginPath();
    ctx.arc(x0 + v * span, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  const v = easeAt(spec, phase);
  const dv = Math.abs(easeAt(spec, Math.min(1, phase + 0.02)) - v) / 0.02; // relative speed
  const stretch = Math.min(3.2, 1 + (phase > 0 && phase < 1 ? dv * 0.35 : 0));
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x0 + v * span, y, 5 * stretch, 5 / Math.sqrt(stretch), 0, 0, Math.PI * 2);
  ctx.fill();
}
