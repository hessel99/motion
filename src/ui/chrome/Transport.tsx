// the bar above the timeline: playback, the playhead's timecode, auto-key, undo / redo, zoom.
// the timecode is written straight into its text node every frame (fixed width, tabular digits:
// no relayout of the bar during playback); everything else re-renders on its channels only.

import { useEffect, useRef } from 'preact/hooks';
import { editor } from '../../app/editor';
import { editMode } from '../../core/commands';
import { useChannels } from '../hooks';
import { showContextMenu, type MenuItem } from '../menu';
import { Button } from '../ui';
import { Pause, Play, Redo2, SkipBack, StepBack, StepForward, Undo2 } from './icons';
import { fmtTimecode, view } from './view';

export function Transport() {
  useChannels(['playing', 'history', 'doc', 'comps'], ['view']);
  const s = editor.store;
  const time = useRef<HTMLSpanElement>(null);
  const zoom = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let lastZ = -1;
    return editor.onFrame((_n, t) => {
      const el = time.current;
      if (el) { const txt = fmtTimecode(t, s.comp.fps); if (el.textContent !== txt) el.textContent = txt; }
      // zoom readout: only touches the dom when the zoom changed
      const z = Math.round((view.vp?.zoom ?? 1) * 100);
      if (z !== lastZ && zoom.current) { lastZ = z; zoom.current.textContent = z + '%'; }
    });
  }, []);
  const history = (e: MouseEvent) => {
    e.preventDefault();
    const labels = s.historyLabels;
    const items: MenuItem[] = labels.map((label, i) => ({ label: `${label}`, shortcut: i === labels.length - 1 ? 'last' : `${labels.length - i}`, action: () => s.undoTo(i + s.historyLength - labels.length) })).reverse().slice(0, 25);
    if (items.length) showContextMenu(e.clientX, e.clientY + 8, items);
  };
  return (
    <div class="transport" role="toolbar" aria-label="Playback">
      <Button variant="ghost" icon size="sm" class="tp-play" tip={s.playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={s.playing ? 'Pause' : 'Play'} onClick={() => editor.togglePlay()}>
        {s.playing ? <Pause /> : <Play />}
      </Button>
      <Button variant="ghost" icon size="sm" tip="Go to start (Home)" onClick={() => s.setTime(0)}><SkipBack /></Button>
      <Button variant="ghost" icon size="sm" tip="Previous frame (,)" onClick={() => editor.stepFrames(-1)}><StepBack /></Button>
      <Button variant="ghost" icon size="sm" tip="Next frame (.)" onClick={() => editor.stepFrames(1)}><StepForward /></Button>
      <span class="timecode" ref={time} aria-label="Current time">00:00:00</span>
      <span class="tp-dur" title="Duration">/ {fmtTimecode(s.comp.duration, s.comp.fps)}</span>
      <span class="tp-meta">{s.comp.width}×{s.comp.height} · {s.comp.fps} fps</span>
      <span class="grow" />
      <button type="button" class={'tp-chip autokey' + (editMode.autoKey ? ' rec' : '')} aria-pressed={editMode.autoKey}
        title="Auto-keyframe: every change creates a keyframe at the playhead"
        onClick={() => { editMode.autoKey = !editMode.autoKey; editor.emit('view'); }}>
        <span class="rec-dot" aria-hidden="true" />Auto-key
      </button>
      <span class="tp-sep" aria-hidden="true" />
      <Button variant="ghost" icon size="sm" disabled={!s.canUndo} aria-label="Undo" title={`Undo ${s.undoLabel ?? ''} (⌘Z), right-click for history`} onClick={() => s.undo()} onContextMenu={history as any}><Undo2 /></Button>
      <Button variant="ghost" icon size="sm" disabled={!s.canRedo} tip="Redo (⇧⌘Z)" onClick={() => s.redo()}><Redo2 /></Button>
      <button type="button" ref={zoom} class="tp-chip zoom" title="Zoom to fit (⌘0)" onClick={() => view.vp?.fit()}>100%</button>
    </div>
  );
}
