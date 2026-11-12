// rhythm: timing as three knobs instead of dragging dozens of keyframes.
//  - Tempo ("breath"): the whole selection's animation length; turning it stretches or squeezes
//    every key around the first one, so the motion breathes faster or slower without changing
//    its shape.
//  - Stagger: seconds between the layers' starts (layers cascade in start order).
//  - Groove: bends the cascade (rushing at first and settling, or building up).
// with the magnet on, starts / the end snap to timeline markers (e.g. beats detected from audio).
// the knobs read the document (stagger and groove are detected from the current timing).

import { useEffect, useRef, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { Knob } from './Knob';
import { applyStagger, applyTempo, maxTempo, snapshotTiming, type TimingSnap } from './ops';
import { detectStagger, layerSpan } from './timing';
import { setupCanvas } from './ticker';
import { ptPalette } from './palette';
import { roundRect } from './draw';
import { armPerform } from './perform';
import './patterns.css';

let magnetOn = (() => { try { return localStorage.getItem('motion.rhythm.magnet') !== 'off'; } catch { return true; } })();

const fmtS = (v: number) => (v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(2) + 's');

export function RhythmPanel({ ids }: { ids: string[] }) {
  const store = editor.store;
  const [magnet, setMagnet] = useState(magnetOn);
  const snap = useRef<TimingSnap | null>(null);
  const g0 = useRef({ stagger: 0, groove: 0 });
  const live = snapshotTiming(store, ids);
  if (!live && ids.length !== 1) return null;
  const n = live?.layers.length ?? 0;
  const det = detectStagger(live ? live.layers.map(l => l.span[0]) : []);
  const span = live ? live.span[1] - live.span[0] : 0;
  const markers = (store.comp.markers ?? []).map(m => m.t);
  const opts = (mk: string) => ({ mergeKey: mk, targets: magnet ? markers : undefined, radius: 0.08 });
  const begin = () => { snap.current = snapshotTiming(store, ids); };
  const end = () => { snap.current = null; };
  const onStart = () => { begin(); g0.current = det; };
  // tempo range: from the span at the start of the gesture (stable while turning), a quarter to
  // four times as long, never past the composition end; 360px of travel for the whole range
  const base = snap.current ?? live;
  const baseSpan = base ? base.span[1] - base.span[0] : 0;
  const tMax = base ? Math.min(maxTempo(store, base), Math.max(baseSpan * 4, 0.1)) : 1;
  const tMin = Math.min(tMax, Math.max(1 / store.comp.fps, baseSpan / 4));

  return (
    <div class="insp-section pt-rhythm">
      <div class="insp-title">
        <span>Rhythm</span>
        <button class={'pt-switch' + (magnet ? ' on' : '')} aria-pressed={magnet}
          title={markers.length ? 'Magnet: snap starts and ends to timeline markers' : 'Magnet: snaps to timeline markers (add some with M, or from audio beats)'}
          onClick={() => { magnetOn = !magnet; setMagnet(magnetOn); try { localStorage.setItem('motion.rhythm.magnet', magnetOn ? 'on' : 'off'); } catch { /* */ } }}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1v4a3 3 0 0 0 6 0V1M2 3h2M6 3h2" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
          Magnet
        </button>
      </div>
      {live && <RhythmStrip snap={live} markers={markers} />}
      {live && <div class="pt-knobs">
        <Knob label="Tempo" value={span} min={tMin} max={tMax} log travel={360} size={50}
          format={fmtS} disabled={span < 1e-6}
          title="Stretch or squeeze the whole animation of the selection (shape stays the same)"
          onStart={begin} onEnd={end}
          onChange={(v, mk) => { if (!snap.current) begin(); applyTempo(store, snap.current!, v, opts(mk)); }} />
        <Knob label="Stagger" value={det.stagger} min={0} max={1} size={50} disabled={n < 2}
          format={fmtS} detents={[{ v: 0, label: 'together' }]} defaultValue={0}
          title="Delay between layers (in start order)"
          onStart={onStart} onEnd={end}
          onChange={(v, mk) => { if (!snap.current) onStart(); applyStagger(store, snap.current!, v, g0.current.groove, opts(mk)); }} />
        <Knob label="Groove" value={det.groove} min={-1} max={1} size={50} disabled={n < 3 || det.stagger < 1e-4}
          format={v => (Math.abs(v) < 0.02 ? 'even' : v > 0 ? 'rush ' + Math.round(v * 100) : 'build ' + Math.round(-v * 100))}
          detents={[{ v: 0, label: 'even' }]} defaultValue={0}
          title="Shape of the cascade: rush (fast first, then settle) or build (slow first, then accelerate)"
          onStart={onStart} onEnd={end}
          onChange={(v, mk) => { if (!snap.current) onStart(); applyStagger(store, snap.current!, g0.current.stagger, v, opts(mk)); }} />
      </div>}
      {ids.length === 1 && (
        <div class="pt-actions">
          <button class="btn pt-rec-btn" title="Act out the motion with the mouse on the canvas; get clean position keyframes (Esc cancels)"
            onClick={() => armPerform(ids[0])}><i />Perform</button>
          <span class="muted">move it with your hand, get clean keys</span>
        </div>
      )}
    </div>
  );
}

/** sequencer-style overview: one bar per layer (start..end), marker ticks, shared time axis */
function RhythmStrip({ snap, markers }: { snap: TimingSnap; markers: number[] }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const rows = Math.min(8, snap.layers.length);
  const W = 236, rowH = 7, H = 14 + rows * (rowH + 3);
  useEffect(() => {
    const c = cv.current!;
    const ctx = setupCanvas(c, W, H);
    ctx.clearRect(0, 0, W, H);
    const P = ptPalette();
    const accent = P.accent;
    roundRect(ctx, 0, 0, W, H, 8);
    ctx.fillStyle = P.padBg;
    ctx.fill();
    const t0 = Math.max(0, snap.span[0] - 0.1), t1 = snap.span[1] + 0.1;
    const X = (t: number) => 8 + ((t - t0) / (t1 - t0 || 1)) * (W - 16);
    // markers / beats
    ctx.fillStyle = P.warmA(0.6);
    for (const m of markers) if (m >= t0 && m <= t1) ctx.fillRect(Math.round(X(m)), 4, 1, H - 8);
    // bars (layer i fades along the cascade so the rhythm reads left to right)
    for (let i = 0; i < rows; i++) {
      const l = editor.store.layer(snap.layers[i].id);
      const s = l ? layerSpan(l) : null;
      if (!s) continue;
      const y = 7 + i * (rowH + 3);
      ctx.globalAlpha = 0.55 + 0.45 * (1 - i / Math.max(1, rows - 1));
      ctx.fillStyle = accent;
      roundRect(ctx, X(s[0]), y, Math.max(3, X(s[1]) - X(s[0])), rowH, 3.5);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(X(s[0]) + 3.5, y + rowH / 2, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (snap.layers.length > rows) {
      ctx.font = '9px Inter, system-ui, sans-serif'; ctx.fillStyle = P.ink(0.5); ctx.textAlign = 'right';
      ctx.fillText(`+${snap.layers.length - rows}`, W - 6, H - 3);
    }
  });
  return <canvas ref={cv} class="pt-strip" aria-label={`${snap.layers.length} animated layers from ${snap.span[0].toFixed(2)}s to ${snap.span[1].toFixed(2)}s`} role="img" />;
}
