// "Perform": act out a motion with the mouse on the canvas, get clean keyframes.
// arming puts a thin overlay over the viewport. press anywhere and move: the layer follows your
// hand (relative to where you grabbed), the playhead runs in real time from where it was, so you
// perform against the rest of the animation. release to keep it, Esc to cancel. the recording is
// reduced to a few keys with fitted eases and smooth spatial tangents (perform-math.ts) and lands
// as ONE undo step, replacing only the position keys inside the performed time range.

import { editor } from '../../app/editor';
import { toast } from '../../app/actions';
import { valueAt } from '../../core/commands';
import type { Keyframe, Prop } from '../../core/model';
import { invert } from '../viewport-controller';
import { buildKeys, type Sample } from './perform-math';
import { onTick } from './ticker';

let active: (() => void) | null = null;

export function isPerforming() { return !!active; }

export function armPerform(layerId: string) {
  if (active) { active(); return; }
  const store = editor.store;
  const layer = store.layer(layerId);
  const vp = (globalThis as any).viewport;
  const host = document.querySelector('.vp-canvas')?.parentElement as HTMLElement | null;
  if (!layer || !vp || !host) return;
  const r = host.getBoundingClientRect();
  const ov = document.createElement('div');
  ov.className = 'pt-perform';
  Object.assign(ov.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  const cv = document.createElement('canvas');
  const dpr = Math.min(3, devicePixelRatio || 1);
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  const ctx = cv.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const pill = document.createElement('div');
  pill.className = 'pt-perform-pill';
  pill.innerHTML = '<i></i><b>Perform</b> press and move: the layer follows your hand in real time. Release to keep · Esc cancels';
  ov.append(cv, pill);
  document.body.appendChild(ov);

  const t0 = store.time;
  const fps = store.comp.fps;
  const pinv = layer.parent ? invert(editor.renderer.worldMatrix(layer.parent) ?? [1, 0, 0, 1, 0, 0]) : [1, 0, 0, 1, 0, 0];
  const start = valueAt(layer, 'position', t0);
  const samples: Sample[] = [];
  const trail: number[] = [];
  let rec = false, began = 0, sx = 0, sy = 0, cx = 0, cy = 0;
  let prop: Prop | undefined, saved: { kf?: Keyframe[]; v: number[] } | null = null, offTick: (() => void) | null = null;

  const posAt = (x: number, y: number) => {
    const [ax, ay] = vp.toComp(sx, sy), [bx, by] = vp.toComp(x, y);
    const dx = bx - ax, dy = by - ay;
    return [start[0] + pinv[0] * dx + pinv[2] * dy, start[1] + pinv[1] * dx + pinv[3] * dy];
  };
  const restoreLayer = () => {
    if (prop && saved) { prop.kf = saved.kf; prop.v = saved.v; store.notifyPreview([layerId]); }
    saved = null;
  };
  const cleanup = () => {
    offTick?.();
    restoreLayer();
    ov.remove();
    window.removeEventListener('keydown', onKey, true);
    active = null;
    store.setTime(t0);
  };
  const finish = () => {
    if (!rec) { cleanup(); return; }
    rec = false;
    restoreLayer();
    const keys = buildKeys(samples, { fps, tol: 8 / (vp.zoom || 1) }); // tolerance in screen px
    cleanup();
    if (keys.length < 2) { toast('Too short: hold the button and move'); return; }
    const t1 = t0 + keys[keys.length - 1].t;
    for (const k of keys) k.t += t0;
    const l = store.layer(layerId);
    if (!l) return;
    store.transact('Perform motion', tx => {
      let p = l.props.position;
      if (!p) { p = { v: start.slice() }; tx.set(l.props, 'position', p); }
      const rest = (p.kf ?? []).filter(k => k.t < t0 - 1e-6 || k.t > t1 + 1e-6);
      tx.set(p, 'kf', [...rest, ...keys].sort((a, b) => a.t - b.t));
      tx.touch(layerId);
    });
    (globalThis as any).timeline?.expand(layerId, true);
    toast(`Performed ${(t1 - t0).toFixed(2)}s → ${keys.length} keyframes`);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); rec = false; cleanup(); toast('Performance cancelled'); }
  };

  const tick = (now: number) => {
    if (!rec) return;
    const t = (now - began) / 1000;
    if (t0 + t >= store.comp.duration) { finish(); return; }
    const p = posAt(cx, cy);
    samples.push({ t, x: p[0], y: p[1] });
    if (prop) { prop.v = p; store.notifyPreview([layerId]); }
    store.time = t0 + t;
    store.emit('tick');
    // trail
    trail.push(cx, cy);
    ctx.clearRect(0, 0, r.width, r.height);
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,90,79,0.85)';
    ctx.beginPath();
    for (let i = 0; i < trail.length; i += 2) i ? ctx.lineTo(trail[i], trail[i + 1]) : ctx.moveTo(trail[i], trail[i + 1]);
    ctx.stroke();
    // spacing ticks every 4 frames: the rhythm of your hand
    ctx.fillStyle = '#fff';
    for (let i = 0; i < trail.length; i += 2 * 4) { ctx.beginPath(); ctx.arc(trail[i], trail[i + 1], 1.8, 0, Math.PI * 2); ctx.fill(); }
  };

  ov.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    ov.setPointerCapture(e.pointerId);
    sx = cx = e.clientX - r.left; sy = cy = e.clientY - r.top;
    const l = store.layer(layerId)!;
    prop = l.props.position;
    if (prop) { saved = { kf: prop.kf, v: prop.v }; prop.kf = undefined; prop.v = start.slice(); store.notifyPreview([layerId]); }
    rec = true;
    began = performance.now();
    ov.classList.add('recording');
    offTick = onTick(tick);
  });
  ov.addEventListener('pointermove', e => {
    // coalesced events give the full hand motion even when frames are slow
    const evs = (e as any).getCoalescedEvents?.() as PointerEvent[] | undefined;
    const last = evs?.length ? evs[evs.length - 1] : e;
    cx = last.clientX - r.left; cy = last.clientY - r.top;
  });
  ov.addEventListener('pointerup', finish);
  ov.addEventListener('contextmenu', e => { e.preventDefault(); rec = false; cleanup(); });
  window.addEventListener('keydown', onKey, true);
  active = () => { rec = false; cleanup(); };
}
