import { useEffect, useRef, useState } from 'preact/hooks';
import { Component, type ComponentChildren } from 'preact';
import { editor, type Tool } from '../app/editor';
import { ViewportController } from './viewport-controller';
import { Timeline, fmtTime } from './timeline';
import { Inspector } from './Inspector';
import { AgentPanel } from './AgentPanel';
import { useChannels } from './hooks';
import { showContextMenu, type MenuItem } from './menu';
import {
  exportLottie, exportAeScript, exportFramePng, confirmDiscard, loadDemo, loadStress, newProject, openBrowserFile, openFileDialog, saveProject, setupShortcuts, toast, runBenchmark, exportGifFile,
} from '../app/actions';
import { setProjectName, editMode, newComposition, addPrecompLayer, renameComp, deleteLayers } from '../core/commands';
import { Button, Dialog, Kbd } from './ui';
import { getTheme, setTheme } from './theme';
import { LAYOUTS, layout, setLayout, summon, toggleSummon, type LayoutId } from './layouts/layout';
import { attachMagnet } from './layouts/magnet';
import { StageChrome } from './layouts/StageChrome';
import { ScoreFields } from './layouts/ScoreFields';
import { ScoreTabs, Transport } from './layouts/Transport';
import { Storyboard, SummonBar } from './layouts/Storyboard';
import { CommandPalette } from './layouts/CommandPalette';
import './layouts/layouts.css';

let vp: ViewportController | null = null;
let tl: Timeline | null = null;

export function App() {
  const [agentOpen, setAgentOpen] = useState(() => { try { return localStorage.getItem('motion.agentOpen') !== '0'; } catch { return true; } });
  useChannels([], ['layout']);
  const L = layout();
  const right = useRef<HTMLElement>(null);
  useEffect(() => { try { localStorage.setItem('motion.agentOpen', agentOpen ? '1' : '0'); } catch { /* */ } requestAnimationFrame(() => { vp?.resize(); tl?.resize(); }); }, [agentOpen]);
  useEffect(() => {
    setupShortcuts({
      fit: () => vp?.fit(),
      zoom: f => vp?.setZoom(vp.zoom * f),
      toggleAgent: () => setAgentOpen(o => !o),
      editText: id => startTextEdit(id),
    });
    return editor.on('agent-open', () => setAgentOpen(true));
  }, []);
  // a layout change moves the same panels: the canvases follow through their ResizeObservers;
  // the composition is re-fitted to the new stage and the timeline re-fits its time scale
  const firstLayout = useRef(true);
  useEffect(() => {
    applyTimelineMode(L);
    if (firstLayout.current) { firstLayout.current = false; return; }
    requestAnimationFrame(() => { vp?.resize(); vp?.fit(); tl?.relayout(); });
  }, [L]);
  // stage: the drawer grows / shrinks, so the stage re-fits (director's sheet floats: no re-fit)
  useEffect(() => { if (L === 'stage' && tl) { applyTimelineMode(L); requestAnimationFrame(() => { vp?.resize(); vp?.fit(); tl?.relayout(); }); } }, [summon.timeline]);
  // stage: the inspector is a card that sits next to the selection
  useEffect(() => (L === 'stage' && right.current ? attachMagnet(right.current, () => vp) : undefined), [L]);
  const cls = ['app', 'layout-' + L, agentOpen ? '' : 'no-agent', summon.timeline ? 'sum-timeline' : '', summon.inspector ? 'sum-inspector' : ''].filter(Boolean).join(' ');
  return (
    <div class={cls}>
      <Guard name="Top bar"><TopBar agentOpen={agentOpen} toggleAgent={() => setAgentOpen(o => !o)} /></Guard>
      {agentOpen && <aside class="left" aria-label="AI agent"><Guard name="Agent"><AgentPanel /></Guard></aside>}
      <main class="center"><Viewport /></main>
      <aside class="right" ref={right} aria-label="Inspector"><Guard name="Inspector"><Inspector /></Guard></aside>
      <section class="bottom" aria-label="Timeline"><TimelineHost /></section>
      {L === 'stage' && <StageChrome key="stage" agentOpen={agentOpen} openAgent={() => setAgentOpen(true)} />}
      {L === 'score' && <Transport key="score" />}
      {L === 'score' && <ScoreTabs key="score-tabs" />}
      {L === 'director' && <Storyboard key="story" />}
      {L === 'director' && <SummonBar key="summon" />}
      <CommandPalette toggleAgent={() => setAgentOpen(o => !o)} fit={() => vp?.fit()} />
      <ShortcutHelp />
      <Welcome />
      <Benchmark />
    </div>
  );
}

// ---------------- top bar ----------------
function TopBar(props: { agentOpen: boolean; toggleAgent: () => void }) {
  useChannels(['doc', 'playing', 'history', 'comps'], ['view', 'layout']);
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
      { label: 'New', shortcut: '', action: () => { if (confirmDiscard()) newProject(); } },
      { label: 'Open / Import…', shortcut: '⌘O', action: openFileDialog },
      { label: 'Save', shortcut: '⌘S', action: () => saveProject(false) },
      { label: 'Save As…', shortcut: '⇧⌘S', action: () => saveProject(true) },
      { separator: true },
      { label: 'Export Lottie JSON', action: exportLottie },
      { label: 'Export for After Effects (.jsx)', action: exportAeScript },
      { label: 'Export frame as PNG', action: () => { exportFramePng().catch(() => {}); } },
      { label: 'Export GIF', action: () => { exportGifFile().catch(() => {}); } },
      { label: 'Export video…', action: () => { import('./ExportDialog').then(m => m.openExportDialog()); } },
      { separator: true },
      { label: 'Load demo animation', action: () => { if (confirmDiscard()) loadDemo(); } },
      {
        label: 'Performance test', submenu: [
          { label: '1,000 animated shapes', action: () => confirmDiscard() && loadStress(1000) },
          { label: '5,000 animated shapes', action: () => confirmDiscard() && loadStress(5000) },
          { label: '10,000 animated shapes', action: () => confirmDiscard() && loadStress(10000) },
          { label: '25,000 animated shapes', action: () => confirmDiscard() && loadStress(25000) },
          { label: '2,000 mixed (text, stars, shapes, groups)', action: () => confirmDiscard() && loadStress(2000, ['rect', 'ellipse', 'text', 'path'], true) },
        ],
      },
      { label: 'Run performance benchmark', action: () => editor.emit('benchmark') },
      { separator: true },
      { label: editor.showHud ? 'Hide performance HUD' : 'Show performance HUD', action: () => { editor.showHud = !editor.showHud; editor.emit('hud'); } },
      { label: 'Layout', submenu: LAYOUTS.map(x => ({ label: (x.id === layout() ? '● ' : '   ') + x.label, action: () => setLayout(x.id) })) },
      { label: 'Command palette', shortcut: '⌘K', action: () => toggleSummon('palette', true) },
      { label: getTheme() === 'light' ? 'Dark theme' : 'Light theme', action: () => setTheme(getTheme() === 'light' ? 'dark' : 'light') },
      { label: editor.snapPlaybackToFrames ? 'Play smooth (display refresh)' : 'Play at composition fps', action: () => { editor.snapPlaybackToFrames = !editor.snapPlaybackToFrames; toast(editor.snapPlaybackToFrames ? 'Playback snaps to composition frames' : 'Playback is smooth (every display frame)'); } },
    ];
    showContextMenu(r.left, r.bottom + 4, items);
  };
  return (
    <header class="topbar">
      <div class="tb-left">
        <Button variant="ghost" class="logo" onClick={fileMenu as any} aria-haspopup="menu" tip="Menu">◆ Motion ▾</Button>
        <input class="filename" aria-label="Project name" value={s.project.name} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          onChange={e => setProjectName(s, (e.target as HTMLInputElement).value || 'Untitled')} spellcheck={false} />
        <Button variant="ghost" class="comp-switch" tip="Compositions" aria-haspopup="menu" onClick={(e: MouseEvent) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const comps = Object.values(s.project.comps);
          showContextMenu(r.left, r.bottom + 4, [
            ...comps.map(c => ({ label: (c.id === s.comp.id ? '● ' : '   ') + c.name, action: () => s.openComp(c.id) })),
            { separator: true },
            { label: 'New composition', action: () => { const c = newComposition(s); s.openComp(c.id); } },
            ...(comps.length > 1 ? [{ label: 'Add composition as layer', submenu: comps.filter(c => c.id !== s.comp.id).map(c => ({ label: c.name, action: () => { try { addPrecompLayer(s, c.id); } catch (err: any) { toast(err.message, 'error'); } } })) }] : []),
            { label: 'Rename composition…', action: () => { const n = prompt('Composition name', s.comp.name); if (n) renameComp(s, s.comp.id, n); } },
          ]);
        }}>▣ {s.comp.name} ▾</Button>
        <span class="muted small tb-meta">{s.comp.width}×{s.comp.height} · {s.comp.fps}fps · {s.comp.duration}s</span>
      </div>
      <div class="tb-center">
        <Button variant="ghost" icon tip="Go to start (Home)" onClick={() => s.setTime(0)}>⏮</Button>
        <Button variant="ghost" icon tip="Previous frame (,)" onClick={() => editor.stepFrames(-1)}>◂</Button>
        <Button class="play" tip={s.playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={s.playing ? 'Pause' : 'Play'} onClick={() => editor.togglePlay()}>{s.playing ? '❚❚' : '▶'}</Button>
        <Button variant="ghost" icon tip="Next frame (.)" onClick={() => editor.stepFrames(1)}>▸</Button>
        <span class="timecode" ref={time} aria-label="Current time">00:00</span>
        <button type="button" class={'ghost autokey' + (editMode.autoKey ? ' rec' : '')} aria-pressed={editMode.autoKey} title="Auto-keyframe: every change creates a keyframe at the playhead" onClick={() => { editMode.autoKey = !editMode.autoKey; editor.emit('view'); }}>● Auto-key</button>
      </div>
      <div class="tb-right">
        <Button variant="ghost" icon disabled={!s.canUndo} aria-label="Undo" title={`Undo ${s.undoLabel ?? ''} (⌘Z) — right-click for history`} onClick={() => s.undo()} onContextMenu={e => {
          // history: jump back several steps at once (newest first)
          e.preventDefault();
          const labels = s.historyLabels;
          const items: MenuItem[] = labels.map((label, i) => ({ label: `${label}`, shortcut: i === labels.length - 1 ? 'last' : `${labels.length - i}`, action: () => s.undoTo(i + s.historyLength - labels.length) })).reverse().slice(0, 25);
          if (items.length) showContextMenu(e.clientX, e.clientY + 8, items);
        }}>↶</Button>
        <Button variant="ghost" icon disabled={!s.canRedo} tip="Redo (⇧⌘Z)" onClick={() => s.redo()}>↷</Button>
        <Button variant="ghost" class="zoom" tip="Zoom to fit (⌘0)" onClick={() => vp?.fit()}>{Math.round((vp?.zoom ?? 1) * 100)}%</Button>
        <Button variant="ghost" class="layout-switch" tip="Window layout (⌘K for everything)" aria-haspopup="menu" onClick={(e: MouseEvent) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          showContextMenu(r.left, r.bottom + 4, LAYOUTS.map(x => ({ label: (x.id === layout() ? '● ' : '   ') + x.label, action: () => setLayout(x.id) })));
        }}>▦ {LAYOUTS.find(x => x.id === layout())!.short} ▾</Button>
        <Button variant="ghost" active={props.agentOpen} tip="AI agent (⌘I)" onClick={props.toggleAgent}>✦ Agent</Button>
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
    vp.onTextEdit = (id, fresh) => startTextEdit(id, fresh);
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
  { id: 'polygon', label: 'Polygon', key: '', icon: '⬠' },
  { id: 'star', label: 'Star', key: '', icon: '☆' },
  { id: 'text', label: 'Text', key: 'T', icon: 'T' },
  { id: 'pen', label: 'Pen', key: 'P', icon: '✒' },
  { id: 'hand', label: 'Hand', key: 'H', icon: '✋' },
];

function Toolbar() {
  useChannels([], ['tool']);
  return (
    <div class="toolbar vp-ui" role="toolbar" aria-label="Tools">
      {TOOLS.map(t => (
        <Button variant="ghost" active={editor.tool === t.id} tip={t.key ? `${t.label} (${t.key})` : t.label} tipSide="top" aria-label={t.label} onClick={() => editor.setTool(t.id)}>{t.icon}</Button>
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
  useChannels([], ['layout']);
  return (
    <div class="tl-wrap">
      <div class="timeline" ref={host} />
      {layout() === 'score' && <ScoreFields getTl={() => tl} />}
    </div>
  );
}

/** per layout timeline behaviour (see layouts/layout.ts) */
let autoExpanded = new Set<string>();
let unsubSel: (() => void) | null = null;
function applyTimelineMode(L: LayoutId) {
  if (!tl) return;
  const t = tl;
  t.focusSelection = L === 'stage' && !summon.timeline;
  t.allProps = L === 'score';
  t.leftW = L === 'score' ? 440 : 300;
  if (L !== 'score') t.hideValues = false;
  unsubSel?.(); unsubSel = null;
  for (const id of autoExpanded) t.expand(id, false);
  autoExpanded = new Set();
  // stage + score: the selected layers open up (and close again when deselected)
  if (L === 'stage' || L === 'score') {
    const sync = () => {
      const sel = new Set(editor.store.selection);
      for (const id of autoExpanded) if (!sel.has(id)) t.expand(id, false);
      for (const id of sel) if (!t.expanded.has(id)) { t.expand(id, true); autoExpanded.add(id); }
      for (const id of [...autoExpanded]) if (!sel.has(id)) autoExpanded.delete(id);
    };
    sync();
    unsubSel = editor.store.on('selection', sync);
  }
  t.relayout();
}

// ---------------- text editing overlay ----------------
function startTextEdit(id: string, fresh = false) {
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
    if (!cur?.text) return;
    // a new text layer that was never typed into (or emptied) is removed again
    if (fresh && (v.trim() === '' || v === cur.text.content)) { deleteLayers(s, [id]); return; }
    if (v.trim() === '' && !fresh) return;
    if (v !== cur.text.content) {
      const oldName = cur.name, oldContent = cur.text.content;
      s.transact('Edit text', tx => {
        tx.set(cur, 'text', { ...cur.text!, content: v });
        // a layer still named after its (old) content follows the text, like figma
        if (oldName === 'Text' || oldName === oldContent.slice(0, 40).replace(/\s+/g, ' ').trim()) tx.set(cur, 'name', v.slice(0, 40).replace(/\s+/g, ' ').trim());
        tx.touch(id);
      }, fresh ? 'text-create' : undefined);
    }
  };
  ta.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) ta.blur(); });
  ta.addEventListener('blur', done);
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'], [', / .', 'Previous / next frame (shift: 10)'], ['J / K', 'Previous / next keyframe or marker'], ['M', 'Add marker at playhead (drag to move, double-click to name)'], ['Home / End', 'Start / end'],
  ['V R O T P H', 'Move, rectangle, ellipse, text, pen, hand (polygon and star in the toolbar)'], ['⌘Z / ⇧⌘Z', 'Undo / redo'], ['⌘C ⌘V ⌘X', 'Copy, paste (also from Figma), cut — layers or keyframes'],
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
    <Dialog title="Keyboard shortcuts" class="help" onClose={() => setOpen(false)}>
      <div class="help-grid">{SHORTCUTS.map(([k, d]) => <><Kbd>{k}</Kbd><span>{d}</span></>)}</div>
    </Dialog>
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
    <Dialog title="Performance benchmark" class="help" onClose={running ? undefined : () => setRows(null)}>
        {running && <div class="muted small" style={{ marginBottom: 'var(--space-4)' }}>running… (every layer animates position, rotation, scale, opacity, color). your project is restored afterwards; undo history is reset.</div>}
        <table class="bench">
          <thead><tr><th>layers</th><th>fps</th><th>p95 frame</th><th>cpu / frame</th></tr></thead>
          <tbody>{rows.map(r => <tr><td>{(r.layers as number).toLocaleString()}</td><td>{r.fps}</td><td>{r['p95 frame ms']} ms</td><td>{r['cpu ms/frame']} ms</td></tr>)}</tbody>
        </table>
        {rows[0] && <div class="muted small" style={{ marginTop: 'var(--space-5)' }}>GPU: {rows[0].gpu}. fps is capped by your display refresh rate; cpu/frame is the editor's own work per frame.</div>}
    </Dialog>
  );
}

/** error boundary: a crashing panel shows a retry button instead of blanking the whole app */
class Guard extends Component<{ name: string; children: ComponentChildren }, { error: string | null }> {
  state = { error: null as string | null };
  componentDidCatch(err: any) {
    console.error(`[${this.props.name}]`, err);
    this.setState({ error: String(err?.message ?? err) });
  }
  render() {
    if (this.state.error) {
      return (
        <div class="panel-error">
          <b>{this.props.name} crashed</b>
          <div class="muted small">{this.state.error}</div>
          <Button onClick={() => this.setState({ error: null })}>Retry</Button>
        </div>
      );
    }
    return this.props.children as any;
  }
}

function Welcome() {
  const [open, setOpen] = useState(() => {
    try { return !localStorage.getItem('motion.welcomed') && !navigator.webdriver; } catch { return false; }
  });
  if (!open) return null;
  const close = () => { try { localStorage.setItem('motion.welcomed', '1'); } catch { /* */ } setOpen(false); };
  return (
    <Dialog title="Welcome to Motion" class="help welcome" onClose={close} actions={<Button variant="primary" autofocus onClick={close}>Start</Button>}>
        <ol>
          <li><b>Paste from Figma</b>: select layers in Figma, ⌘C, then ⌘V here. A single frame becomes the composition.</li>
          <li><b>Animate</b>: click a property's ◇ to add keyframes, or use <i>Animate</i> presets and <i>Text animation</i> in the right panel. Press F9 for easy ease.</li>
          <li><b>AI agent</b> (left): describe an animation and Claude Code builds it in your file, with your own subscription. One click undoes everything it did.</li>
          <li><b>Everything else</b>: press <Kbd>?</Kbd> for shortcuts. Export video or Lottie from the ◆ menu.</li>
        </ol>
    </Dialog>
  );
}
