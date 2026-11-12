// the feel pad: easing as a place, not a formula. drag the puck through a 2D field where
// x = attack (lazy .. punchy) and y = smoothness (mechanical .. silky). the background "grain"
// is a field of tiny curves, so you can see where you are heading before you get there.

import { useEffect, useRef } from 'preact/hooks';
import { feelToBezier, type Bez, type Feel } from './feel';
import { cssVar, setupCanvas } from './ticker';
import { roundRect } from './draw';
import './patterns.css';

export interface FeelPadProps {
  feel: Feel;
  onFeel: (f: Feel, phase: 'start' | 'move' | 'end') => void;
  /** dim the pad (the segment is a spring / hold): dragging switches back to a curve */
  inactive?: boolean;
  width?: number;
  height?: number;
}

const GX = 9, GY = 5;
const PAD = 18;

export function FeelPad(p: FeelPadProps) {
  const W = p.width ?? 236, H = p.height ?? 148;
  const cv = useRef<HTMLCanvasElement>(null);
  const bg = useRef<{ canvas: HTMLCanvasElement; key: string } | null>(null);
  const live = useRef<Feel | null>(null); // puck position while dragging (follows the pointer exactly)
  const trail = useRef<Float32Array>(new Float32Array(24)); // last 12 puck positions
  const trailN = useRef(0);
  const bez = useRef<Bez>([0, 0, 0, 0]);

  const toPx = (f: Feel) => [PAD + f.attack * (W - 2 * PAD), PAD + (1 - f.smooth) * (H - 2 * PAD)];

  const draw = () => {
    const c = cv.current;
    if (!c) return;
    const ctx = setupCanvas(c, W, H);
    const f = live.current ?? p.feel;
    const accent = cssVar(c, '--accent', '#4c8dff');
    // cached background: gradient + grain of mini curves (rebuilt only when overshoot changes)
    const o = Math.round(f.overshoot * 20) / 20;
    const key = `${W}x${H}:${o}:${accent}:${devicePixelRatio}`;
    if (!bg.current || bg.current.key !== key) bg.current = { canvas: buildBackground(c, W, H, o, accent), key };
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(bg.current.canvas, 0, 0, W, H);

    const [px, py] = toPx(f);
    // crosshair
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px + 0.5, PAD); ctx.lineTo(px + 0.5, H - PAD); ctx.moveTo(PAD, py + 0.5); ctx.lineTo(W - PAD, py + 0.5); ctx.stroke();
    // the current curve, big and soft behind the puck
    feelToBezier(f, bez.current);
    const v = bez.current;
    const bx = 14, by = 20, bw = W - 28, bh = H - 40;
    ctx.save();
    ctx.globalAlpha = p.inactive ? 0.18 : 0.5;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx, by + bh);
    ctx.bezierCurveTo(bx + v[0] * bw, by + bh - v[1] * bh, bx + v[2] * bw, by + bh - v[3] * bh, bx + bw, by);
    ctx.stroke();
    ctx.restore();
    // drag trail
    const tr = trail.current;
    for (let i = 0; i < trailN.current; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.04 + 0.12 * (i / 12)})`;
      ctx.beginPath(); ctx.arc(tr[i * 2], tr[i * 2 + 1], 2 + i * 0.25, 0, Math.PI * 2); ctx.fill();
    }
    // puck: halo + body
    const g = ctx.createRadialGradient(px, py, 2, px, py, 22);
    g.addColorStop(0, hexA(accent, p.inactive ? 0.15 : 0.55));
    g.addColorStop(1, hexA(accent, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(px, py, 22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = p.inactive ? '#8a8a93' : '#fff';
    ctx.beginPath(); ctx.arc(px, py, 6.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = accent; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(px, py, 6.5, 0, Math.PI * 2); ctx.stroke();
  };

  useEffect(draw);

  const fromEvent = (e: PointerEvent): Feel => {
    const r = cv.current!.getBoundingClientRect();
    const x = (e.clientX - r.left - PAD) / (W - 2 * PAD), y = (e.clientY - r.top - PAD) / (H - 2 * PAD);
    const q = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 200) / 200;
    return { attack: q(x), smooth: q(1 - y), overshoot: p.feel.overshoot };
  };
  const pushTrail = (f: Feel) => {
    const tr = trail.current;
    const [x, y] = toPx(f);
    if (trailN.current === 12) tr.copyWithin(0, 2); else trailN.current++;
    tr[(trailN.current - 1) * 2] = x; tr[(trailN.current - 1) * 2 + 1] = y;
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.focus({ focusVisible: false } as FocusOptions);
    el.setPointerCapture(e.pointerId);
    trailN.current = 0;
    live.current = fromEvent(e);
    pushTrail(live.current);
    p.onFeel(live.current, 'start');
    draw();
    const move = (ev: PointerEvent) => {
      live.current = fromEvent(ev);
      pushTrail(live.current);
      p.onFeel(live.current, 'move');
      draw();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      const f = live.current!;
      live.current = null;
      trailN.current = 0;
      p.onFeel(f, 'end');
      draw();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onKey = (e: KeyboardEvent) => {
    const s = e.shiftKey ? 0.2 : 0.05;
    let { attack, smooth } = p.feel;
    if (e.key === 'ArrowLeft') attack -= s;
    else if (e.key === 'ArrowRight') attack += s;
    else if (e.key === 'ArrowUp') smooth += s;
    else if (e.key === 'ArrowDown') smooth -= s;
    else return;
    e.preventDefault();
    e.stopPropagation();
    const c = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;
    p.onFeel({ attack: c(attack), smooth: c(smooth), overshoot: p.feel.overshoot }, 'move');
  };

  return (
    <canvas
      ref={cv} class={'pt-pad' + (p.inactive ? ' inactive' : '')} tabIndex={0}
      role="slider" aria-label="Feel pad: left/right = attack (lazy to punchy), up/down = smoothness"
      aria-valuetext={`attack ${Math.round(p.feel.attack * 100)}%, smoothness ${Math.round(p.feel.smooth * 100)}%`}
      onPointerDown={onDown as any} onKeyDown={onKey as any}
    />
  );
}

function hexA(c: string, a: number) {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return `rgba(76,141,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/** gradient field + grain of tiny curves + region names, drawn once into an offscreen canvas */
function buildBackground(ref: HTMLCanvasElement, W: number, H: number, overshoot: number, accent: string) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const base = cssVar(ref, '--pt-pad-bg', '#141418');
  roundRect(ctx, 0, 0, W, H, 10);
  ctx.fillStyle = base;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // cool (lazy) -> warm (punchy), brighter towards silky
  const gx = ctx.createLinearGradient(0, 0, W, 0);
  gx.addColorStop(0, 'rgba(90,120,255,0.20)');
  gx.addColorStop(0.5, 'rgba(160,110,255,0.10)');
  gx.addColorStop(1, 'rgba(255,120,90,0.20)');
  ctx.fillStyle = gx; ctx.fillRect(0, 0, W, H);
  const gy = ctx.createLinearGradient(0, 0, 0, H);
  gy.addColorStop(0, 'rgba(255,255,255,0.05)');
  gy.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = gy; ctx.fillRect(0, 0, W, H);
  // grain
  const cw = (W - 2 * PAD) / GX, ch = (H - 2 * PAD) / GY;
  const v: Bez = [0, 0, 0, 0];
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  for (let i = 0; i < GX; i++) for (let j = 0; j < GY; j++) {
    const f = { attack: (i + 0.5) / GX, smooth: 1 - (j + 0.5) / GY, overshoot };
    feelToBezier(f, v);
    const s = Math.min(cw, ch) * 0.52;
    const x = PAD + (i + 0.5) * cw - s / 2, y = PAD + (j + 0.5) * ch - s / 2;
    ctx.beginPath();
    ctx.moveTo(x, y + s);
    ctx.bezierCurveTo(x + v[0] * s, y + s - v[1] * s, x + v[2] * s, y + s - v[3] * s, x + s, y);
    ctx.stroke();
  }
  ctx.restore();
  // region names
  ctx.font = '600 9px Inter, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left'; ctx.fillText('LAZY', 8, 4);
  ctx.textAlign = 'center'; ctx.fillText('SILKY', W / 2, 4);
  ctx.textAlign = 'right'; ctx.fillText('SNAPPY', W - 8, 4);
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'center'; ctx.fillText('LINEAR', W / 2, H - 3);
  ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(255,255,255,0.26)'; ctx.fillText('← slow start', 8, H - 3);
  ctx.textAlign = 'right'; ctx.fillText('fast start →', W - 8, H - 3);
  void accent;
  return c;
}
