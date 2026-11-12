// the transport: the control bar between the canvas and the timeline. three parts:
//   left    the playhead's timecode (large) / the duration (a menu sets it) · fps
//   center  go to start, previous key (J), previous frame, PLAY, next frame, next key (K), end
//   right   loop, preview range (B / N), add marker (M), auto-key, timeline zoom (− fit +)
// its top edge is the splitter that sizes the timeline (drag it; double-click resets).
// the timecode is written straight into its text node every frame (fixed width, tabular digits:
// no relayout of the bar during playback); everything else re-renders on its channels only.

import { useEffect, useRef } from 'preact/hooks';
import { editor } from '../../app/editor';
import { jumpToKey } from '../../app/actions';
import { addMarker, editMode, setCompSettings } from '../../core/commands';
import { useChannels } from '../hooks';
import { showContextMenu, type MenuItem } from '../menu';
import { Button } from '../ui';
import {
  Bookmark, Brackets, ChevronDown, Maximize2, Pause, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward, ZoomIn, ZoomOut, ChevronsLeft, ChevronsRight,
} from './icons';
import { fmtDuration, fmtTimecode, view } from './view';
import { setUi, STAGE_MIN, TL_MIN, ui } from './ui-state';

export function Transport() {
  useChannels(['playing', 'doc', 'comps', 'workarea'], ['view']);
  const s = editor.store;
  const time = useRef<HTMLSpanElement>(null);
  useEffect(() => editor.onFrame((_n, t) => {
    const el = time.current;
    if (el) { const txt = fmtTimecode(t, s.comp.fps); if (el.textContent !== txt) el.textContent = txt; }
  }), []);
  const wa = s.workArea;
  const durationMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const d = s.comp.duration;
    const items: MenuItem[] = [1, 2, 3, 4, 5, 6, 8, 10, 15, 30].map(v => ({ label: fmtDuration(v), checked: Math.abs(v - d) < 1e-6, action: () => setCompSettings(s, { duration: v }) }));
    items.push({ separator: true }, { label: 'Custom…', action: () => { const v = parseFloat(prompt('Duration in seconds', String(d)) ?? ''); if (v > 0) setCompSettings(s, { duration: v }); } });
    showContextMenu(r.left, r.top, items);
    const m = document.querySelector('.ctx-menu') as HTMLElement | null;
    if (m) m.style.top = Math.max(4, r.top - m.offsetHeight - 6) + 'px';
  };
  return (
    <div class="transport" role="toolbar" aria-label="Playback">
      <Grip />
      <div class="tp-side tp-left">
        <span class="timecode" ref={time} aria-label="Current time">00:00:00</span>
        <button type="button" class="tp-dur" aria-haspopup="menu" title="Duration (click to change)" onClick={durationMenu}>
          / {fmtTimecode(s.comp.duration, s.comp.fps)}<ChevronDown size={12} />
        </button>
        <span class="tp-fps">{s.comp.fps} fps</span>
      </div>
      <div class="tp-center">
        <Button variant="ghost" icon size="sm" tip="Go to start (Home)" tipSide="top" onClick={() => s.setTime(s.workArea?.[0] ?? 0)}><SkipBack /></Button>
        <Button variant="ghost" icon size="sm" tip="Previous keyframe (J)" tipSide="top" onClick={() => jumpToKey(-1)}><ChevronsLeft /></Button>
        <Button variant="ghost" icon size="sm" tip="Previous frame (,)" tipSide="top" onClick={() => editor.stepFrames(-1)}><StepBack /></Button>
        <button type="button" class={'tp-play' + (s.playing ? ' on' : '')} data-tooltip={s.playing ? 'Pause (Space)' : 'Play (Space)'} data-tooltip-side="top"
          aria-label={s.playing ? 'Pause' : 'Play'} onClick={() => editor.togglePlay()}>
          {s.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <Button variant="ghost" icon size="sm" tip="Next frame (.)" tipSide="top" onClick={() => editor.stepFrames(1)}><StepForward /></Button>
        <Button variant="ghost" icon size="sm" tip="Next keyframe (K)" tipSide="top" onClick={() => jumpToKey(1)}><ChevronsRight /></Button>
        <Button variant="ghost" icon size="sm" tip="Go to end (End)" tipSide="top" onClick={() => s.setTime(s.comp.duration)}><SkipForward /></Button>
      </div>
      <div class="tp-side tp-right">
        <Button variant="ghost" icon size="sm" class="tp-loop" active={s.loop} tip={s.loop ? 'Loop playback: on' : 'Loop playback: off'} tipSide="top"
          onClick={() => { s.loop = !s.loop; editor.emit('view'); }}><Repeat /></Button>
        <button type="button" class={'tp-chip tp-range' + (wa ? ' set' : '')} data-tooltip={wa ? 'Preview range (click to clear). B / N set its ends' : 'Preview range: B / N set its start / end at the playhead'} data-tooltip-side="top"
          onClick={() => {
            if (wa) s.workArea = null;
            else s.workArea = [s.time, s.comp.duration];
            s.emit('workarea');
          }}>
          <Brackets size={14} />{wa ? `${wa[0].toFixed(2)}–${wa[1].toFixed(2)}s` : 'Range'}
        </button>
        <Button variant="ghost" icon size="sm" tip="Add marker at playhead (M)" tipSide="top" onClick={() => addMarker(s, s.time)}><Bookmark /></Button>
        <button type="button" class={'tp-chip autokey' + (editMode.autoKey ? ' rec' : '')} aria-pressed={editMode.autoKey}
          data-tooltip="Auto-key: every change creates a keyframe at the playhead" data-tooltip-side="top"
          onClick={() => { editMode.autoKey = !editMode.autoKey; editor.emit('view'); }}>
          <span class="rec-dot" aria-hidden="true" />Auto-key
        </button>
        <span class="tp-sep" aria-hidden="true" />
        <Button variant="ghost" icon size="sm" tip="Zoom timeline out (⌘ wheel)" tipSide="top" onClick={() => view.tl?.zoomTime(1 / 1.5)}><ZoomOut /></Button>
        <Button variant="ghost" icon size="sm" tip="Fit the composition in the timeline" tipSide="top" onClick={() => view.tl?.fitTime()}><Maximize2 /></Button>
        <Button variant="ghost" icon size="sm" tip="Zoom timeline in (⌘ wheel)" tipSide="top" onClick={() => view.tl?.zoomTime(1.5)}><ZoomIn /></Button>
      </div>
    </div>
  );
}

/** the splitter on the transport's top edge: sizes the timeline. it writes the grid row on the
 *  app element directly (once per animation frame) and saves the height on release */
function Grip() {
  const down = (e: PointerEvent) => {
    const app = document.querySelector('.app') as HTMLElement | null;
    const tl = document.querySelector('.bottom') as HTMLElement | null;
    if (!app || !tl) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY, h0 = tl.getBoundingClientRect().height;
    const max = () => Math.max(TL_MIN, window.innerHeight - STAGE_MIN - 120);
    let h = h0, raf = 0;
    const move = (ev: PointerEvent) => {
      h = Math.round(Math.min(max(), Math.max(TL_MIN, h0 + (y0 - ev.clientY))));
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; app.style.setProperty('--tl-h', h + 'px'); });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      cancelAnimationFrame(raf);
      app.style.setProperty('--tl-h', h + 'px');
      setUi({ tlH: h });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return <div class="tp-grip" role="separator" aria-orientation="horizontal" aria-label="Resize timeline" title="Drag to resize the timeline (double-click: default)"
    onPointerDown={down as any} onDblClick={() => { (document.querySelector('.app') as HTMLElement | null)?.style.removeProperty('--tl-h'); setUi({ tlH: 0 }); }} />;
}

/** the timeline height as a css value for the app grid (0: the default from tokens) */
export function tlHeightStyle(): Record<string, string> | undefined {
  return ui.tlH ? { '--tl-h': ui.tlH + 'px' } : undefined;
}
