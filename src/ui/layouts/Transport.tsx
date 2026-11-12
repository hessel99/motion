// score layout: the transport between the stage and the score (play, timecode, key navigation,
// markers), plus the tabs of the side column (agent / layer details).
import { useEffect, useRef } from 'preact/hooks';
import { editor } from '../../app/editor';
import { addMarker, editMode } from '../../core/commands';
import { useChannels } from '../hooks';
import { Button } from '../ui';
import { jumpKey } from './moments';
import { summon, toggleSummon } from './layout';

export function Transport() {
  useChannels(['playing', 'selection', 'doc'], ['layout', 'view']);
  const s = editor.store;
  const tc = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => editor.onFrame((_n, t) => {
    const c = editor.store.comp;
    if (tc.current) {
      const sec = Math.floor(t + 1e-6), f = Math.floor((t - sec) * c.fps + 1e-6);
      const txt = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
      if (tc.current.textContent !== txt) tc.current.textContent = txt;
    }
    // progress hairline: a transform, no layout
    if (bar.current) bar.current.style.transform = `scaleX(${Math.min(1, t / c.duration).toFixed(4)})`;
  }), []);
  const sel = s.selection.map(id => s.layer(id)?.name).filter(Boolean);
  return (
    <div class="score-transport" role="toolbar" aria-label="Transport">
      <div class="st-progress" aria-hidden="true"><div ref={bar} /></div>
      <div class="st-group">
        <Button variant="ghost" icon tip="Go to start (Home)" tipSide="top" onClick={() => s.setTime(0)}>⏮</Button>
        <Button variant="ghost" icon tip="Previous key (J)" tipSide="top" onClick={() => jumpKey(-1)}>⇤</Button>
        <Button class="play" tip={s.playing ? 'Pause (Space)' : 'Play (Space)'} tipSide="top" aria-label={s.playing ? 'Pause' : 'Play'} onClick={() => editor.togglePlay()}>{s.playing ? '❚❚' : '▶'}</Button>
        <Button variant="ghost" icon tip="Next key (K)" tipSide="top" onClick={() => jumpKey(1)}>⇥</Button>
        <span class="st-timecode" ref={tc} aria-label="Current time">00:00:00</span>
        <span class="muted small st-meta">/ {s.comp.duration}s · {s.comp.fps} fps</span>
      </div>
      <span class="muted small st-sel">{sel.length ? `${sel.length === 1 ? sel[0] : sel.length + ' layers'}: every property is a row with its value, ease and keys` : 'Select a layer to open its properties in the score'}</span>
      <div class="st-group">
        <button type="button" class={'ghost btn-sm autokey' + (editMode.autoKey ? ' rec' : '')} aria-pressed={editMode.autoKey} title="Auto-keyframe: every change creates a keyframe at the playhead" onClick={() => { editMode.autoKey = !editMode.autoKey; editor.emit('view'); }}>● Auto-key</button>
        <Button variant="ghost" size="sm" tip="Add marker at playhead (M)" tipSide="top" onClick={() => addMarker(s, s.time)}>⚑ Marker</Button>
        <Button variant="ghost" size="sm" tip="Fit the whole composition in the score" tipSide="top" onClick={() => (globalThis as any).timeline?.fitTime()}>↔ Fit</Button>
      </div>
    </div>
  );
}

/** tabs on top of the side column: the agent, or the layer's non-temporal details (fill, text, blending…) */
export function ScoreTabs() {
  useChannels(['selection'], ['layout']);
  const side = summon.inspector ? 'layer' : 'agent';
  return (
    <div class="score-tabs" role="tablist" aria-label="Side panel">
      <div class="seg seg-sm">
        <button role="tab" aria-selected={side === 'agent'} class={side === 'agent' ? 'on' : ''} onClick={() => { toggleSummon('inspector', false); editor.emit('agent-open'); }}>✦ Agent</button>
        <button role="tab" aria-selected={side === 'layer'} class={side === 'layer' ? 'on' : ''} onClick={() => toggleSummon('inspector', true)}>Layer details</button>
      </div>
    </div>
  );
}
