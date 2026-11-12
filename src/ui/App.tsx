import { useEffect, useRef, useState } from 'preact/hooks';
import { editor, type Tool } from '../app/editor';
import { ViewportController } from './viewport-controller';
import { Timeline, fmtTime } from './timeline';
import { Inspector } from './Inspector';
import { AgentPanel } from './AgentPanel';
import { useChannels } from './hooks';
import { showContextMenu, type MenuItem } from './menu';
import {
  exportLottie, loadDemo, loadStress, newProject, openBrowserFile, openFileDialog, saveProject, setupShortcuts, toast, runBenchmark,
} from '../app/actions';
import { setProjectName, editMode, newComposition, addPrecompLayer, renameComp } from '../core/commands';

let vp: ViewportController | null = null;
let tl: Timeline | null = null;

export function App() {
  const [agentOpen, setAgentOpen] = useState(() => { try { return localStorage.getItem('motion.agentOpen') !== '0'; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem('motion.agentOpen', agentOpen ? '1' : '0'); } catch { /* */ } requestAnimationFrame(() => { vp?.resize(); tl?.resize(); }); }, [agentOpen]);
  useEffect(() => {
    setupShortcuts({
      fit: () => vp?.fit(),
      zoom: f => vp?.setZoom(vp.zoom * f),
      toggleAgent: () => setAgentOpen(o => !o),
      editText: id => startTextEdit(id),
    });
  }, []);
  return (
    <div class={'app' + (agentOpen ? '' : ' no-agent')}>
      <TopBar agentOpen={agentOpen} toggleAgent={() => setAgentOpen(o => !o)} />
      {agentOpen && <aside class="left"><AgentPanel /></aside>}
      <main class="center"><Viewport /></main>
      <aside class="right"><Inspector /></aside>
      <section class="bottom"><TimelineHost /></section>
      <ShortcutHelp />
      <Benchmark />
    </div>
  );
}

// ---------------- top bar ----------------
function TopBar(props: { agentOpen: boolean; toggleAgent: () => void }) {
  useChannels(['doc', 'playing', 'history', 'comps'], ['view']);
  const s = editor.store;
  const time = useRef<HTMLSpanElement>(null);
  useEffect(() => editor.onFrame((_n, t) => {
    if (time.current) {
      const txt = `${fmtTimecode(t, s.comp.fps)}`;
      if (time.current.textContent !== txt) time.current.textContent = txt;
    }
  }), []);
  const fileMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [
      { label: 'New', shortcut: '', action: newProject },
      { label: 'Open / Import…', shortcut: '⌘O', action: openFileDialog },
      { label: 'Save', shortcut: '⌘S', action: () => saveProject(false) },
      { label: 'Save As…', shortcut: '⇧⌘S', action: () => saveProject(true) },
      { separator: true },
      { label: 'Export Lottie JSON', action: exportLottie },
      { label: 'Export video…', action: () => { import('./ExportDialog').then(m => m.openExportDialog()); } },
      { separator: true },
      { label: 'Load demo animation', action: loadDemo },
      {
        label: 'Performance test', submenu: [
          { label: '1,000 animated shapes', action: () => loadStress(1000) },
          { label: '5,000 animated shapes', action: () => loadStress(5000) },
          { label: '10,000 animated shapes', action: () => loadStress(10000) },
          { label: '25,000 animated shapes', action: () => loadStress(25000) },
          { label: '2,000 mixed (text, stars, shapes, groups)', action: () => loadStress(2000, ['rect', 'ellipse', 'text', 'path'], true) },
        ],
      },
      { label: 'Run performance benchmark', action: () => editor.emit('benchmark') },
      { separator: true },
      { label: editor.showHud ? 'Hide performance HUD' : 'Show performance HUD', action: () => { editor.showHud = !editor.showHud; editor.emit('hud'); } },
      { label: editor.snapPlaybackToFrames ? 'Play smooth (display refresh)' : 'Play at composition fps', action: () => { editor.snapPlaybackToFrames = !editor.snapPlaybackToFrames; toast(editor.snapPlaybackToFrames ? 'Playback snaps to composition frames' : 'Playback is smooth (every display frame)'); } },
    ];
    showContextMenu(r.left, r.bottom + 4, items);
  };
  return (
    <header class="topbar">
      <div class="tb-left">
        <button class="ghost logo" onClick={fileMenu as any} title="Menu">◆ Motion ▾</button>
        <input class="filename" value={s.project.name} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          onChange={e => setProjectName(s, (e.target as HTMLInputElement).value || 'Untitled')} spellcheck={false} />
        <button class="ghost comp-switch" title="Compositions" onClick={(e: MouseEvent) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const comps = Object.values(s.project.comps);
          showContextMenu(r.left, r.bottom + 4, [
            ...comps.map(c => ({ label: (c.id === s.comp.id ? '● ' : '   ') + c.name, action: () => s.openComp(c.id) })),
            { separator: true },
            { label: 'New composition', action: () => { const c = newComposition(s); s.openComp(c.id); } },
            ...(comps.length > 1 ? [{ label: 'Add composition as layer', submenu: comps.filter(c => c.id !== s.comp.id).map(c => ({ label: c.name, action: () => { try { addPrecompLayer(s, c.id); } catch (err: any) { toast(err.message, 'error'); } } })) }] : []),
            { label: 'Rename composition…', action: () => { const n = prompt('Composition name', s.comp.name); if (n) renameComp(s, s.comp.id, n); } },
          ]);
        }}>▣ {s.comp.name} ▾</button>
        <span class="muted small">{s.comp.width}×{s.comp.height} · {s.comp.fps}fps · {s.comp.duration}s</span>
      </div>
      <div class="tb-center">
        <button class="ghost" title="Go to start (Home)" onClick={() => s.setTime(0)}>⏮</button>
        <button class="ghost" title="Previous frame (,)" onClick={() => editor.stepFrames(-1)}>◂</button>
        <button class="play" title="Play / pause (Space)" onClick={() => editor.togglePlay()}>{s.playing ? '❚❚' : '▶'}</button>
        <button class="ghost" title="Next frame (.)" onClick={() => editor.stepFrames(1)}>▸</button>
        <span class="timecode" ref={time}>00:00</span>
        <button class={'ghost autokey' + (editMode.autoKey ? ' rec' : '')} title="Auto-keyframe: every change creates a keyframe at the playhead" onClick={() => { editMode.autoKey = !editMode.autoKey; editor.emit('view'); }}>● Auto-key</button>
      </div>
      <div class="tb-right">
        <button class="ghost" disabled={!s.canUndo} title={`Undo ${s.undoLabel ?? ''} (⌘Z)`} onClick={() => s.undo()}>↶</button>
        <button class="ghost" disabled={!s.canRedo} title="Redo (⇧⌘Z)" onClick={() => s.redo()}>↷</button>
        <button class="ghost zoom" title="Zoom to fit (⌘0)" onClick={() => vp?.fit()}>{Math.round((vp?.zoom ?? 1) * 100)}%</button>
        <button class={'ghost' + (props.agentOpen ? ' on' : '')} title="AI agent (⌘I)" onClick={props.toggleAgent}>✦ Agent</button>
      </div>
    </header>
  );
}

function fmtTimecode(t: number, fps: number) {
  const s = Math.floor(t + 1e-6);
  const f = Math.floor((t - s) * fps + 1e-6);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

// ---------------- viewport ----------------
function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.className = 'vp-canvas';
    host.current!.appendChild(canvas);
    editor.attachCanvas(canvas);
    vp = new ViewportController(editor, host.current!, canvas);
    vp.onTextEdit = id => startTextEdit(id);
    (globalThis as any).viewport = vp;
  }, []);
  return (
    <div class={'viewport' + (drag ? ' dropping' : '')} ref={host}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={async e => { e.preventDefault(); setDrag(false); for (const f of e.dataTransfer?.files ?? []) await openBrowserFile(f); }}>
      <Toolbar />
      <Hud />
    </div>
  );
}

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'select', label: 'Move', key: 'V', icon: '➤' },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: '▢' },
  { id: 'ellipse', label: 'Ellipse', key: 'O', icon: '◯' },
  { id: 'text', label: 'Text', key: 'T', icon: 'T' },
  { id: 'pen', label: 'Pen', key: 'P', icon: '✒' },
  { id: 'hand', label: 'Hand', key: 'H', icon: '✋' },
];

function Toolbar() {
  useChannels([], ['tool']);
  return (
    <div class="toolbar vp-ui">
      {TOOLS.map(t => (
        <button class={editor.tool === t.id ? 'on' : ''} title={`${t.label} (${t.key})`} onClick={() => editor.setTool(t.id)}>{t.icon}</button>
      ))}
    </div>
  );
}

function Hud() {
  useChannels([], ['hud']);
  const el = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let last = 0;
    return editor.onFrame(now => {
      if (!editor.showHud || !el.current || now - last < 250) return;
      last = now;
      const r = editor.renderer.stats;
      el.current.textContent =
        `${editor.measuredFps().toFixed(0)} fps\n` +
        `layers ${r.layers}  drawn ${r.instances}  culled ${r.culled}  draw calls ${r.drawCalls}\n` +
        `frame ${r.frameMs.toFixed(2)}ms  eval ${r.evalMs.toFixed(2)}  write ${r.writeMs.toFixed(2)}\n` +
        `raster ${r.rasterMs.toFixed(2)}  gpu submit ${r.gpuSubmitMs.toFixed(2)}\n` +
        `atlas ${r.atlasEntries} entries / ${r.atlasPages} pages`;
    });
  }, []);
  if (!editor.showHud) return null;
  return <pre class="hud vp-ui" ref={el} />;
}

// ---------------- timeline ----------------
function TimelineHost() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tl = new Timeline(editor, host.current!);
    (globalThis as any).timeline = tl;
    editor.store.on('selection', () => { const s = editor.store.selection; if (s.length === 1) tl!.reveal(s[0]); });
  }, []);
  return <div class="timeline" ref={host} />;
}

// ---------------- text editing overlay ----------------
function startTextEdit(id: string) {
  const s = editor.store;
  const l = s.layer(id);
  if (!l?.text || !vp) return;
  const c = editor.renderer.corners(id);
  const host = document.querySelector('.viewport') as HTMLElement;
  if (!c || !host) return;
  const [x, y] = vp.toScreen(c[0], c[1]);
  const ta = document.createElement('textarea');
  ta.className = 'text-overlay';
  ta.value = l.text.content;
  Object.assign(ta.style, { left: x + 'px', top: y + 'px', fontSize: Math.max(11, Math.min(48, l.text.fontSize * vp.zoom)) + 'px' });
  host.appendChild(ta);
  ta.focus();
  ta.select();
  const done = () => {
    const v = ta.value;
    ta.remove();
    const cur = s.layer(id);
    if (cur?.text && v !== cur.text.content) s.transact('Edit text', tx => { tx.set(cur, 'text', { ...cur.text!, content: v }); tx.touch(id); });
  };
  ta.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) ta.blur(); });
  ta.addEventListener('blur', done);
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'], [', / .', 'Previous / next frame (shift: 10)'], ['J / K', 'Previous / next keyframe'], ['Home / End', 'Start / end'],
  ['V R O T P H', 'Move, rectangle, ellipse, text, pen, hand'], ['⌘Z / ⇧⌘Z', 'Undo / redo'], ['⌘C ⌘V ⌘X', 'Copy, paste (also from Figma), cut — layers or keyframes'],
  ['⌘D', 'Duplicate'], ['Alt-drag', 'Duplicate while moving'], ['⌘G / ⇧⌘G', 'Group / ungroup'], ['⇧⌘C', 'Pre-compose'],
  ['⌘[ / ⌘]', 'Send backward / bring forward (alt: to back / front)'], ['Arrows', 'Nudge (shift: 10px)'], ['⇧P ⇧S ⇧A', 'Animate position / scale / anchor'],
  ['F9', 'Easy ease on selected keys'], ['B / N', 'Preview range start / end at playhead (double-click its bar to clear)'], ['Delete', 'Delete layers or keyframes'], ['⌘0 / ⌘+ / ⌘−', 'Fit / zoom in / zoom out'],
  ['⌘ while dragging', 'No snapping'], ['Shift while dragging', 'Constrain axis / keep aspect / 15° steps'], ['Alt while resizing', 'From center'],
  ['Double-click', 'Edit text / enter group / edit path / open precomp'], ['⌘I', 'Toggle AI agent'], ['?', 'This help'],
];

function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => editor.on('help', () => setOpen(o => !o)), []);
  if (!open) return null;
  return (
    <div class="help-backdrop" onClick={() => setOpen(false)}>
      <div class="help" onClick={e => e.stopPropagation()}>
        <div class="help-title">Keyboard shortcuts <button class="ghost" onClick={() => setOpen(false)}>✕</button></div>
        <div class="help-grid">{SHORTCUTS.map(([k, d]) => <><kbd>{k}</kbd><span>{d}</span></>)}</div>
      </div>
    </div>
  );
}

function Benchmark() {
  const [rows, setRows] = useState<Record<string, string | number>[] | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => editor.on('benchmark', async () => {
    setRows([]); setRunning(true);
    try { await runBenchmark(r => setRows(x => [...(x ?? []), r])); } finally { setRunning(false); }
  }), []);
  if (!rows) return null;
  return (
    <div class="help-backdrop" onClick={() => !running && setRows(null)}>
      <div class="help" onClick={e => e.stopPropagation()}>
        <div class="help-title">Performance benchmark {running ? <span class="muted small">running… (every layer animates position, rotation, scale, opacity, color). your project is restored afterwards; undo history is reset.</span> : <button class="ghost" onClick={() => setRows(null)}>✕</button>}</div>
        <table class="bench">
          <thead><tr><th>layers</th><th>fps</th><th>p95 frame</th><th>cpu / frame</th></tr></thead>
          <tbody>{rows.map(r => <tr><td>{(r.layers as number).toLocaleString()}</td><td>{r.fps}</td><td>{r['p95 frame ms']} ms</td><td>{r['cpu ms/frame']} ms</td></tr>)}</tbody>
        </table>
        {rows[0] && <div class="muted small" style={{ marginTop: '10px' }}>GPU: {rows[0].gpu}. fps is capped by your display refresh rate; cpu/frame is the editor's own work per frame.</div>}
      </div>
    </div>
  );
}
