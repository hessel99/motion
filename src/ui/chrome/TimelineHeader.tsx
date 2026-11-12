// the timeline card's header row: the open compositions as small pill tabs ("+" makes a new one;
// double-click a precomp layer to open its tab), the transport (start, frame step, play, loop, an
// editable timecode, duration and fps), the preview range, auto-key, the track view
// (keys / graph) and the time zoom. its top edge (in the gap above the card) is the
// splitter that sizes the timeline.
// the timecode is written straight into its input every frame while it is not being edited
// (fixed width, tabular digits: no relayout during playback); the rest renders on its channels.

import { useEffect, useRef, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { toast } from '../../app/actions';
import { addPrecompLayer, editMode, newComposition, renameComp, setCompSettings } from '../../core/commands';
import { useChannels } from '../hooks';
import { menuFrom, showContextMenu, type MenuItem } from '../menu';
import { Button, Segmented } from '../ui';
import { Brackets, Maximize2, Pause, Play, Plus, Repeat, SkipBack, StepBack, StepForward, X } from './icons';
import { startPreview } from './CanvasBars';
import { fmtDuration, fmtTimecode, view } from './view';
import { setUi, STAGE_MIN, TL_MIN, ui } from './ui-state';
import { agentProgress } from '../agent-bridge';

export function TimelineHeader() {
  return (
    <div class="tl-head" role="toolbar" aria-label="Timeline">
      <Grip />
      <CompTabs />
      <AgentPill />
      <Transport />
      <TrackTools />
    </div>
  );
}

// ---------------- composition tabs ----------------
function CompTabs() {
  useChannels(['comps', 'doc'], []);
  const s = editor.store;
  const tabs = s.compTabs();
  const [renaming, setRenaming] = useState<string | null>(null);
  const commit = (id: string, v: string) => { setRenaming(null); const n = v.trim(); if (n && n !== s.project.comps[id]?.name) renameComp(s, id, n); };
  const menu = (e: MouseEvent, id: string) => {
    e.preventDefault();
    const active = id === s.comp.id;
    const items: MenuItem[] = [
      { label: 'Rename', action: () => setRenaming(id) },
      { label: 'Composition settings', action: () => { s.openComp(id); s.select([]); } },
      { label: `Add to ${s.comp.name} as a layer`, disabled: active, action: () => { try { addPrecompLayer(s, id); } catch (err: any) { toast(err.message, 'error'); } } },
      { separator: true },
      { label: 'Close tab', disabled: tabs.length < 2, action: () => s.closeCompTab(id) },
    ];
    showContextMenu(e.clientX, e.clientY, items);
  };
  return (
    <div class="ct-tabs" role="tablist" aria-label="Compositions">
      {tabs.map(id => {
        const c = s.project.comps[id];
        const on = id === s.comp.id;
        return (
          <div role="tab" tabIndex={0} aria-selected={on} class={'ct-tab' + (on ? ' on' : '')} title={`${c.name} · ${c.width}×${c.height}`}
            onClick={() => s.openComp(id)} onDblClick={() => setRenaming(id)} onContextMenu={e => menu(e as any, id)}
            onAuxClick={e => { if (e.button === 1) s.closeCompTab(id); }}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); s.openComp(id); } }}>
            {renaming === id
              ? <input class="ct-rename" aria-label="Composition name" defaultValue={c.name} spellcheck={false} ref={el => { if (el) requestAnimationFrame(() => { if (document.activeElement !== el) { el.focus(); el.select(); } }); }}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commit(id, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(null); }}
                  onBlur={e => commit(id, (e.target as HTMLInputElement).value)} />
              : <span class="ct-name">{c.name}</span>}
            {tabs.length > 1 && <button type="button" class="ct-close" aria-label={`Close ${c.name}`} title="Close tab" onClick={e => { e.stopPropagation(); s.closeCompTab(id); }}><X size={12} /></button>}
          </div>
        );
      })}
      <Button variant="ghost" icon size="sm" class="ct-add" tip="New composition" tipSide="top" onClick={() => { const c = newComposition(s, { width: s.comp.width, height: s.comp.height, fps: s.comp.fps }); s.openComp(c.id); }}><Plus size={14} /></Button>
    </div>
  );
}

// ---------------- the agent at work (while its panel is hidden) ----------------
function AgentPill() {
  useChannels([], ['agent-turn', 'ui']);
  const p = agentProgress();
  if (!p || (ui.leftOpen && ui.leftTab === 'agent')) return null;
  return (
    <button type="button" class="agent-pill" title="The agent is working: show it (⌘I)" onClick={() => setUi({ leftOpen: true, leftTab: 'agent' })}>
      <span class="agent-pill-dot" aria-hidden="true" />
      <span class="agent-pill-text">{p.activity || 'Working…'}</span>
      {p.live > 0 && <span class="agent-pill-n">{p.live} changed</span>}
    </button>
  );
}

// ---------------- transport ----------------
/** "1:02:15" style input: minutes:seconds:frames, plain seconds ("1.5") or frames ("90f") */
function parseTime(v: string, fps: number): number | null {
  v = v.trim();
  if (!v) return null;
  if (/^\d+f$/i.test(v)) return parseInt(v) / fps;
  if (v.includes(':')) {
    const p = v.split(':').map(Number);
    if (p.some(x => !isFinite(x))) return null;
    const [m, sec, f] = p.length === 3 ? p : [0, p[0], p[1]];
    return m * 60 + sec + (f || 0) / fps;
  }
  const n = parseFloat(v.replace(',', '.'));
  return isFinite(n) ? n : null;
}

function Transport() {
  useChannels(['playing', 'doc', 'comps'], ['view']);
  const s = editor.store;
  const time = useRef<HTMLInputElement>(null);
  const editing = useRef(false);
  useEffect(() => editor.onFrame((_n, t) => {
    const el = time.current;
    if (el && !editing.current) { const txt = fmtTimecode(t, s.comp.fps); if (el.value !== txt) el.value = txt; }
  }), []);
  const durationMenu = (e: MouseEvent) => {
    const d = s.comp.duration;
    const items: MenuItem[] = [1, 2, 3, 4, 5, 6, 8, 10, 15, 30].map(v => ({ label: fmtDuration(v), checked: Math.abs(v - d) < 1e-6, action: () => setCompSettings(s, { duration: v }) }));
    items.push({ separator: true }, { label: 'Custom…', action: () => { const v = parseFloat(prompt('Duration in seconds', String(d)) ?? ''); if (v > 0) setCompSettings(s, { duration: v }); } });
    menuFrom(e.currentTarget as Element, items, { above: false });
  };
  const fpsMenu = (e: MouseEvent) => {
    const f = s.comp.fps;
    menuFrom(e.currentTarget as Element, [...new Set([12, 24, 25, 30, 50, 60, f])].sort((a, b) => a - b).map(v => ({ label: `${v} fps`, checked: v === f, action: () => setCompSettings(s, { fps: v }) })));
  };
  const commit = (el: HTMLInputElement) => {
    editing.current = false;
    const t = parseTime(el.value, s.comp.fps);
    if (t !== null) s.setTime(s.snapTime(t));
    el.value = fmtTimecode(s.time, s.comp.fps);
  };
  return (
    <div class="tp">
      <Button variant="ghost" icon size="sm" tip="Go to start (Home)" tipSide="top" onClick={() => s.setTime(s.workArea?.[0] ?? 0)}><SkipBack /></Button>
      <Button variant="ghost" icon size="sm" tip="Previous frame (,) · previous key (J)" tipSide="top" onClick={() => editor.stepFrames(-1)}><StepBack /></Button>
      <button type="button" class={'tp-play' + (s.playing ? ' on' : '')} data-tooltip={s.playing ? 'Pause (Space)' : 'Play (Space)'} data-tooltip-side="top"
        aria-label={s.playing ? 'Pause' : 'Play'} onClick={() => editor.togglePlay()}>
        {s.playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <Button variant="ghost" icon size="sm" tip="Next frame (.) · next key (K)" tipSide="top" onClick={() => editor.stepFrames(1)}><StepForward /></Button>
      <Button variant="ghost" icon size="sm" class="tp-loop" active={s.loop} tip={s.loop ? 'Loop: on' : 'Loop: off'} tipSide="top"
        onClick={() => { s.loop = !s.loop; editor.emit('view'); }}><Repeat /></Button>
      <Button variant="ghost" icon size="sm" tip="Full-screen preview (Esc to leave)" tipSide="top" onClick={() => startPreview()}><Maximize2 /></Button>
      <input ref={time} class="tp-time" aria-label="Current time (minutes:seconds:frames)" title="Current time: type 1:12, 2.5 (seconds) or 90f" spellcheck={false} defaultValue="00:00:00"
        onFocus={e => { editing.current = true; (e.target as HTMLInputElement).select(); }}
        onBlur={e => commit(e.target as HTMLInputElement)}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { editing.current = false; (e.target as HTMLInputElement).blur(); } }} />
      <button type="button" class="tp-meta tp-dur" aria-haspopup="menu" title="Duration (click to change)" onClick={durationMenu}>/ {fmtDuration(s.comp.duration)}</button>
      <button type="button" class="tp-meta" aria-haspopup="menu" title="Frame rate" onClick={fpsMenu}>{s.comp.fps} fps</button>
    </div>
  );
}

// ---------------- track tools ----------------
function TrackTools() {
  useChannels(['workarea'], ['view', 'tlmode']);
  const s = editor.store;
  const wa = s.workArea;
  const tl = view.tl;
  const zoom = useRef<HTMLInputElement>(null);
  // the slider follows wheel / pinch zoom in the timeline (checked per frame, written on change)
  useEffect(() => {
    let last = -1;
    return editor.onFrame(() => {
      const t = view.tl, el = zoom.current;
      if (!t || !el || document.activeElement === el) return;
      const z = Math.round(Math.log(Math.max(1, t.pxPerSec / t.fitPx())) * 100) / 100;
      if (z !== last) { last = z; el.value = String(z); }
    });
  }, []);
  return (
    <div class="tt">
      <button type="button" class={'tt-chip' + (wa ? ' set' : '')} aria-label="Preview range" data-tooltip={wa ? 'Preview range (click to clear). B / N set its ends' : 'Preview range: B / N set its start / end at the playhead'} data-tooltip-side="top"
        onClick={() => { s.workArea = wa ? null : [s.time, s.comp.duration]; s.emit('workarea'); }}>
        <Brackets size={14} />{wa ? `${wa[0].toFixed(2)}–${wa[1].toFixed(2)}s` : <span class="tt-label">Range</span>}
      </button>
      <button type="button" class={'tt-chip autokey' + (editMode.autoKey ? ' rec' : '')} aria-pressed={editMode.autoKey} aria-label="Auto-key"
        data-tooltip="Auto-key: every change creates a keyframe at the playhead" data-tooltip-side="top"
        onClick={() => { editMode.autoKey = !editMode.autoKey; editor.emit('view'); }}>
        <span class="rec-dot" aria-hidden="true" /><span class="tt-label">Auto-key</span>
      </button>
      <Segmented class="tt-mode" size="sm" label="Track view" value={tl?.mode ?? 'keys'} options={[{ value: 'keys', label: 'Keys' }, { value: 'graph', label: 'Graph', title: 'Value curves' }]}
        onChange={m => view.tl?.setMode(m as any)} />
      <input ref={zoom} type="range" class="tt-zoom slider" aria-label="Timeline zoom" title="Timeline zoom (⌘ wheel). Double-click: fit" min={0} max={4} step={0.01} defaultValue="0"
        onInput={e => view.tl?.setZoomLevel(Math.exp(+(e.target as HTMLInputElement).value))}
        onDblClick={() => { view.tl?.fitTime(); if (zoom.current) zoom.current.value = '0'; }} />
    </div>
  );
}

/** the splitter on the timeline card's top edge: sizes the timeline. it writes the grid row on
 *  the app element directly (once per animation frame) and saves the height on release */
function Grip() {
  const down = (e: PointerEvent) => {
    const app = document.querySelector('.app') as HTMLElement | null;
    const tl = document.querySelector('.bottom') as HTMLElement | null;
    if (!app || !tl) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY, h0 = tl.getBoundingClientRect().height;
    const max = () => Math.max(TL_MIN, window.innerHeight - STAGE_MIN - 60);
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
  const reset = () => { (document.querySelector('.app') as HTMLElement | null)?.style.removeProperty('--tl-h'); setUi({ tlH: 0 }); };
  // keyboard: ↑ / ↓ grow / shrink by 16px (shift: 64px), Home / End: smallest / largest, Enter: default
  const key = (e: KeyboardEvent) => {
    const app = document.querySelector('.app') as HTMLElement | null;
    const tl = document.querySelector('.bottom') as HTMLElement | null;
    if (!app || !tl) return;
    const max = Math.max(TL_MIN, window.innerHeight - STAGE_MIN - 60);
    const h0 = tl.getBoundingClientRect().height, d = e.shiftKey ? 64 : 16;
    let h: number | null = null;
    if (e.key === 'ArrowUp') h = h0 + d; else if (e.key === 'ArrowDown') h = h0 - d;
    else if (e.key === 'Home') h = TL_MIN; else if (e.key === 'End') h = max;
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); reset(); return; }
    if (h === null) return;
    e.preventDefault(); e.stopPropagation();
    h = Math.round(Math.min(max, Math.max(TL_MIN, h)));
    app.style.setProperty('--tl-h', h + 'px');
    setUi({ tlH: h });
  };
  return <div class="tl-grip" role="separator" tabIndex={0} aria-orientation="horizontal" aria-label="Resize timeline" aria-valuemin={TL_MIN} aria-valuenow={ui.tlH || undefined}
    title="Drag or use ↑ ↓ to resize the timeline (double-click: default)"
    onPointerDown={down as any} onKeyDown={key as any} onDblClick={reset} />;
}

/** the timeline height as a css value for the app grid (0: the default from tokens) */
export function tlHeightStyle(): Record<string, string> | undefined {
  return ui.tlH ? { '--tl-h': ui.tlH + 'px' } : undefined;
}
