// canvas pills for motion (the reference patterns, translated):
// - SelectionBar: a small bar floating above the selected layer(s) with motion actions: a key at
//   the playhead, an ease for its keys, ask the agent about it, show it in the timeline.
// - PlaybackPill: bottom right, playback and preview: play / pause, loop, the preview range,
//   full-screen preview (Esc leaves it).
// positions are written straight into the dom per frame (only when they change).

import { useEffect, useRef, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { addKeyframe, isAnimated, keyId, setEase } from '../../core/commands';
import { EASE_PRESETS, SPRING_PRESETS } from '../../core/easing';
import { setSpring } from '../../core/commands';
import type { PropKey } from '../../core/model';
import { useChannels } from '../hooks';
import { menuFrom } from '../menu';
import { Diamond, Maximize2, Pause, Play, Repeat, Sparkles, Spline, Brackets, Rows3 } from './icons';
import { setUi, ui } from './ui-state';
import { view } from './view';

const TRANSFORM: PropKey[] = ['position', 'scale', 'rotation', 'opacity', 'anchor'];

/** every keyframe id of the given layers */
function keysOf(ids: string[]) {
  const s = editor.store, out: string[] = [];
  for (const id of ids) {
    const l = s.layer(id);
    if (!l) continue;
    for (const k in l.props) l.props[k as PropKey]?.kf?.forEach((_, i) => out.push(keyId(id, k as PropKey, i)));
  }
  return out;
}

export function SelectionBar() {
  useChannels(['selection', 'playing'], ['tool']);
  const el = useRef<HTMLDivElement>(null);
  const [down, setDown] = useState(false);
  const s = editor.store;
  const ids = s.selection.filter(id => s.layer(id));
  useEffect(() => {
    // hidden while the pointer is down on the canvas (dragging, resizing)
    const host = document.querySelector('.viewport') as HTMLElement | null;
    const d = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.vp-ui')) setDown(true); };
    const u = () => setDown(false);
    host?.addEventListener('pointerdown', d);
    window.addEventListener('pointerup', u);
    let last = '';
    const off = editor.onFrame(() => {
      const bar = el.current, vp = view.vp;
      if (!bar || !vp) return;
      const b = vp.boundsOf(editor.store.selection);
      if (!b) { if (last !== 'none') { bar.style.visibility = 'hidden'; last = 'none'; } return; }
      const [x0, y0] = vp.toScreen(b[0], b[1]);
      const [x1] = vp.toScreen(b[2], b[3]);
      const w = bar.offsetWidth, hostW = bar.parentElement?.clientWidth ?? 0;
      const x = Math.round(Math.max(8, Math.min(hostW - w - 8, (x0 + x1) / 2 - w / 2)));
      const y = Math.round(Math.max(8, y0 - bar.offsetHeight - 14));
      const key = x + ',' + y;
      if (key !== last) { bar.style.transform = `translate(${x}px, ${y}px)`; bar.style.visibility = 'visible'; last = key; }
    });
    return () => { off(); host?.removeEventListener('pointerdown', d); window.removeEventListener('pointerup', u); };
  }, []);
  if (!ids.length || s.playing || down || editor.tool !== 'select' || ui.view !== 'editor') return null;
  const key = () => {
    // a key at the playhead on what is animated (position when nothing is yet)
    s.batch('bar-key', () => {
      const props = new Set<PropKey>();
      for (const id of ids) { const l = s.layer(id)!; for (const p of TRANSFORM) if (isAnimated(l, p)) props.add(p); }
      if (!props.size) props.add('position');
      for (const p of props) addKeyframe(s, ids, p);
    }, 'Add keyframe');
    for (const id of ids) view.tl?.expand(id, true);
  };
  const ease = (e: MouseEvent) => {
    const keys = keysOf(ids);
    menuFrom(e.currentTarget as Element, [
      ...SPRING_PRESETS.map(p => ({ label: `Spring · ${p.name}`, disabled: !keys.length, action: () => setSpring(s, keys, p.bounce) })),
      { separator: true },
      ...EASE_PRESETS.map(p => ({ label: p.name, disabled: !keys.length, action: () => setEase(s, keys, p.name) })),
    ], { above: true });
  };
  return (
    <div ref={el} class="sel-bar vp-ui" role="toolbar" aria-label="Selection" style={{ visibility: 'hidden' }}>
      <button type="button" class="sel-btn" data-tooltip="Keyframe at the playhead" data-tooltip-side="top" onClick={key}><Diamond size={14} /></button>
      <button type="button" class="sel-btn" aria-haspopup="menu" data-tooltip="Ease its keys" data-tooltip-side="top" onClick={ease as any}><Spline size={14} /></button>
      <button type="button" class="sel-btn" data-tooltip="Show in the timeline" data-tooltip-side="top" onClick={() => { for (const id of ids) view.tl?.expand(id, true); view.tl?.reveal(ids[0]); }}><Rows3 size={14} /></button>
      <span class="sel-sep" aria-hidden="true" />
      <button type="button" class="sel-btn sel-ask" onClick={() => editor.emit('ask-bar')}><Sparkles size={14} />Ask</button>
    </div>
  );
}

export function PlaybackPill() {
  useChannels(['playing', 'workarea'], ['view', 'ui']);
  const s = editor.store;
  const wa = s.workArea;
  return (
    <div class="play-pill vp-ui" role="toolbar" aria-label="Playback">
      <button type="button" class="pp-btn" data-tooltip={s.playing ? 'Pause (Space)' : 'Play (Space)'} data-tooltip-side="top" aria-label={s.playing ? 'Pause' : 'Play'} onClick={() => editor.togglePlay()}>{s.playing ? <Pause size={14} /> : <Play size={14} />}</button>
      <button type="button" class={'pp-btn' + (s.loop ? ' on' : '')} aria-pressed={s.loop} data-tooltip={s.loop ? 'Loop: on' : 'Loop: off'} data-tooltip-side="top" onClick={() => { s.loop = !s.loop; editor.emit('view'); }}><Repeat size={14} /></button>
      <button type="button" class={'pp-btn' + (wa ? ' on' : '')} aria-pressed={!!wa} data-tooltip={wa ? 'Preview range on (click: whole composition)' : 'Preview only from the playhead to the end (B / N)'} data-tooltip-side="top"
        onClick={() => { s.workArea = wa ? null : [s.time, s.comp.duration]; s.emit('workarea'); }}><Brackets size={14} /></button>
      <button type="button" class="pp-btn" data-tooltip="Full-screen preview (Esc to leave)" data-tooltip-side="top" onClick={() => startPreview()}><Maximize2 size={14} /></button>
    </div>
  );
}

/** full-screen preview: only the canvas, fitted, playing; Esc (or a click on the hint) leaves */
export function startPreview() {
  setUi({ previewing: true });
  requestAnimationFrame(() => requestAnimationFrame(() => { view.vp?.resize(); view.vp?.fit(); editor.play(); }));
  const leave = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopImmediatePropagation();
    stopPreview();
  };
  window.addEventListener('keydown', leave, true);
  stopHook = () => window.removeEventListener('keydown', leave, true);
}
let stopHook: (() => void) | null = null;
export function stopPreview() {
  stopHook?.(); stopHook = null;
  editor.pause();
  setUi({ previewing: false });
  requestAnimationFrame(() => requestAnimationFrame(() => { view.vp?.resize(); view.vp?.fit(); view.tl?.resize(); }));
}
