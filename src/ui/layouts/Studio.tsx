// D · Studio layout chrome (docs/layouts.md): icon rail, transport over the timeline (current /
// duration timecode), the fps badge on the stage, and the "Transitions & effects" browser with
// live previews. Inspired by owner-supplied references of a timeline-centric motion tool
// (patterns only: label-colored layer bars, slim contextual inspector, preset browser).
import { useEffect, useRef, useState } from 'preact/hooks';
import { editor, type Tool } from '../../app/editor';
import { confirmDiscard, exportLottie, loadDemo, openFileDialog, saveProject, toast, exportGifFile } from '../../app/actions';
import { setCompSettings, setEase, setSpring } from '../../core/commands';
import { EASE_PRESETS, SPRING_PRESETS, springAt } from '../../core/easing';
import { ANIM_PRESETS, applyPreset, setTextAnim, TEXT_ANIM_PRESETS } from '../../core/presets';
import { useChannels } from '../hooks';
import { showContextMenu, type MenuItem } from '../menu';
import { Button } from '../ui';
import { summon, toggleSummon } from './layout';

const menuAt = (e: MouseEvent, items: MenuItem[]) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showContextMenu(r.right + 6, r.top, items);
};
const tool = (t: Tool) => () => editor.setTool(t);

export function StudioRail(props: { agentOpen: boolean; toggleAgent: () => void }) {
  useChannels(['comps'], ['layout']);
  const s = editor.store;
  return (
    <nav class="studio-rail" aria-label="Studio">
      <Button variant="ghost" icon tip="Add" aria-haspopup="menu" onClick={(e: MouseEvent) => menuAt(e, [
        { label: 'Rectangle', shortcut: 'R', action: tool('rect') }, { label: 'Ellipse', shortcut: 'O', action: tool('ellipse') },
        { label: 'Text', shortcut: 'T', action: tool('text') }, { label: 'Star', action: tool('star') }, { label: 'Polygon', action: tool('polygon') },
        { label: 'Pen', shortcut: 'P', action: tool('pen') }, { separator: true }, { label: 'Import file…', shortcut: '⌘O', action: openFileDialog },
      ])}>＋</Button>
      <Button variant="ghost" icon tip="Files" aria-haspopup="menu" onClick={(e: MouseEvent) => menuAt(e, [
        { label: 'Open / Import…', shortcut: '⌘O', action: openFileDialog }, { label: 'Save', shortcut: '⌘S', action: () => saveProject(false) },
        { label: 'Save As…', action: () => saveProject(true) }, { separator: true }, { label: 'Load demo animation', action: () => { if (confirmDiscard()) loadDemo(); } },
      ])}>▤</Button>
      <Button variant="ghost" icon tip="Compositions" aria-haspopup="menu" onClick={(e: MouseEvent) => menuAt(e,
        Object.values(s.project.comps).map(c => ({ label: (c.id === s.comp.id ? '● ' : '   ') + c.name, action: () => s.openComp(c.id) })))}>❖</Button>
      <Button variant="ghost" icon active={props.agentOpen} tip="AI agent (⌘I)" onClick={props.toggleAgent}>✦</Button>
      <span class="grow" />
      <Button variant="ghost" icon tip="Command palette (⌘K)" onClick={() => toggleSummon('palette', true)}>⌘</Button>
      <Button variant="ghost" icon tip="Keyboard shortcuts (?)" onClick={() => editor.emit('help')}>?</Button>
    </nav>
  );
}

function tc(t: number, fps: number) {
  const sec = Math.floor(t + 1e-6), f = Math.floor((t - sec) * fps + 1e-6);
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

/** transport over the timeline: play + start on the left, "current / duration ▾" centered */
export function StudioTransport() {
  useChannels(['playing', 'doc', 'comps']);
  const s = editor.store;
  const cur = useRef<HTMLSpanElement>(null);
  useEffect(() => editor.onFrame((_n, t) => {
    const txt = tc(t, editor.store.comp.fps);
    if (cur.current && cur.current.textContent !== txt) cur.current.textContent = txt;
  }), []);
  const durMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const set = (d: number) => setCompSettings(s, { duration: d });
    showContextMenu(r.left, r.bottom + 4, [
      ...[2, 3, 4, 5, 6, 8, 10, 15].map(d => ({ label: (Math.abs(d - s.comp.duration) < 1e-6 ? '● ' : '   ') + `${d} s`, action: () => set(d) })),
      { separator: true },
      { label: '   Custom…', action: () => { const v = prompt('Duration (seconds)', String(s.comp.duration)); if (v && +v > 0) set(+v); } },
    ]);
  };
  return (
    <div class="studio-transport" role="toolbar" aria-label="Transport">
      <div class="st-group">
        <Button variant="ghost" icon tip={s.playing ? 'Pause (Space)' : 'Play (Space)'} tipSide="top" aria-label={s.playing ? 'Pause' : 'Play'} onClick={() => editor.togglePlay()}>{s.playing ? '❚❚' : '▶'}</Button>
        <Button variant="ghost" icon tip="Go to start (Home)" tipSide="top" onClick={() => s.setTime(0)}>⏮</Button>
      </div>
      <div class="studio-tc">
        <span class="mono" ref={cur} aria-label="Current time">00:00:00</span>
        <span class="muted"> / </span>
        <button type="button" class="ghost studio-dur mono" title="Composition duration" aria-haspopup="menu" onClick={durMenu as any}>{tc(s.comp.duration, s.comp.fps)} ▾</button>
      </div>
      <div class="st-group">
        <Button variant="ghost" size="sm" tip="Fit the composition in the timeline" tipSide="top" onClick={() => (globalThis as any).timeline?.fitTime()}>↔</Button>
      </div>
    </div>
  );
}

export function StudioFps() {
  useChannels(['comps', 'doc'], ['hud']);
  const s = editor.store;
  return (
    <button type="button" class="studio-fps" title="Composition frame rate (click: performance HUD)" onClick={() => { editor.showHud = !editor.showHud; editor.emit('hud'); }}>
      {s.comp.fps} FPS
    </button>
  );
}

// ---------------- transitions & effects browser ----------------
type Item = { id: string; cat: string; name: string; preview: string; style?: string; apply: () => void; needs: 'layers' | 'text' | 'keys' };

/** css linear() of a spring, so the browser previews springs with the real curve */
function springLinear(b: number) {
  const pts: string[] = [];
  for (let i = 0; i <= 24; i++) pts.push(springAt(b, i / 24).toFixed(3));
  return `linear(${pts.join(', ')})`;
}

function items(): Item[] {
  const s = editor.store;
  const sel = () => s.selection.slice();
  const out: Item[] = [];
  for (const p of ANIM_PRESETS) {
    out.push({
      id: 'anim-' + p.name, cat: p.kind === 'loop' ? 'Loops' : 'Layer motion', name: p.name, needs: 'layers',
      preview: 'pv-' + p.name.toLowerCase().replace(/[^a-z]+/g, '-'),
      apply: () => { try { applyPreset(s, sel(), p.name); (globalThis as any).timeline?.expand(sel()[0], true); } catch (e: any) { toast(e.message, 'error'); } },
    });
  }
  for (const p of TEXT_ANIM_PRESETS) {
    out.push({
      id: 'text-' + p.name, cat: 'Text motion', name: p.name, needs: 'text', preview: 'pv-text pv-' + p.name.toLowerCase().replace(/[^a-z]+/g, '-'),
      apply: () => { const ids = sel().filter(id => s.layer(id)?.type === 'text'); const l = s.layer(ids[0]); if (l) setTextAnim(s, ids, { ...p.anim, start: s.time - l.inPoint }); },
    });
  }
  for (const p of EASE_PRESETS) {
    out.push({ id: 'ease-' + p.name, cat: 'Easing', name: p.name, needs: 'keys', preview: 'pv-ease', style: `--pv-ease: cubic-bezier(${p.v.join(',')})`, apply: () => setEase(s, [...s.keySelection], p.name) });
  }
  for (const p of SPRING_PRESETS) {
    out.push({ id: 'spring-' + p.name, cat: 'Springs', name: p.name, needs: 'keys', preview: 'pv-ease', style: `--pv-ease: ${springLinear(p.bounce)}`, apply: () => setSpring(s, [...s.keySelection], p.bounce) });
  }
  return out;
}

const CATS = ['All', 'Layer motion', 'Text motion', 'Loops', 'Easing', 'Springs'];

export function StudioEffects() {
  useChannels(['selection', 'keys'], ['layout']);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const open = summon.inspector;
  const s = editor.store;
  if (!open) {
    return <button type="button" class="studio-fx-pill" onClick={() => toggleSummon('inspector', true)}>Transitions &amp; effects</button>;
  }
  const hasText = s.selection.some(id => s.layer(id)?.type === 'text');
  const ok = (it: Item) => it.needs === 'keys' ? s.keySelection.size > 0 : it.needs === 'text' ? hasText : s.selection.length > 0;
  const qq = q.trim().toLowerCase();
  const list = items().filter(it => (cat === 'All' || it.cat === cat) && (!qq || (it.name + ' ' + it.cat).toLowerCase().includes(qq)));
  const groups = CATS.slice(1).map(c => [c, list.filter(it => it.cat === c)] as const).filter(([, l]) => l.length);
  return (
    <section class="studio-fx" aria-label="Transitions and effects">
      <div class="studio-fx-head">
        <span class="section-title">Transitions &amp; effects</span>
        <Button variant="ghost" icon size="sm" aria-label="Close" onClick={() => toggleSummon('inspector', false)}>✕</Button>
      </div>
      <input class="studio-fx-search" placeholder="Search presets, eases, springs…" value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') toggleSummon('inspector', false); }} />
      <div class="studio-fx-cats" role="tablist">
        {CATS.map(c => <button type="button" role="tab" aria-selected={c === cat} class={'ghost btn-sm' + (c === cat ? ' on' : '')} onClick={() => setCat(c)}>{c}</button>)}
      </div>
      <div class="studio-fx-list">
        {groups.map(([c, l]) => (
          <>
            <div class="label-xs studio-fx-cat">{c}{!ok(l[0]) && <span class="muted"> · {l[0].needs === 'keys' ? 'select keys' : l[0].needs === 'text' ? 'select a text layer' : 'select layers'}</span>}</div>
            <div class="studio-fx-grid">
              {l.map(it => (
                <button type="button" class="studio-fx-item" disabled={!ok(it)} title={it.name} onClick={it.apply}>
                  <span class={'studio-pv ' + it.preview} style={it.style}><i /></span>
                  <span class="studio-fx-name">{it.name}</span>
                </button>
              ))}
            </div>
          </>
        ))}
        {!groups.length && <div class="muted small">Nothing matches “{q}”</div>}
      </div>
    </section>
  );
}

/** export button for the studio top bar */
export function studioExportMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showContextMenu(r.right - 200, r.bottom + 4, [
    { label: 'Video (MP4 / WebM)…', action: () => { import('../ExportDialog').then(m => m.openExportDialog()); } },
    { label: 'GIF', action: () => { exportGifFile().catch(() => {}); } },
    { label: 'Lottie JSON', action: exportLottie },
  ]);
}
