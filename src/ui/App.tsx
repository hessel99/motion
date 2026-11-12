import { useEffect, useRef, useState } from 'preact/hooks';
import { Component, type ComponentChildren } from 'preact';
import { editor } from '../app/editor';
import { ViewportController } from './viewport-controller';
import { Timeline } from './timeline';
import { SyncReview, STYLE_MIME, applyStyle } from './LibraryPanel';
import { useChannels } from './hooks';
import { showContextMenu, type MenuItem } from './menu';
import {
  exportLottie, exportAeScript, exportFramePng, confirmDiscard, loadDemo, loadStress, newProject, openBrowserFile, openFileDialog, saveProject, setupShortcuts, runBenchmark, exportGifFile,
} from '../app/actions';
import { deleteLayers } from '../core/commands';
import { Button, Dialog, Kbd } from './ui';
import { IconProvider, PanelLeft } from './chrome/icons';
import { TabStrip } from './chrome/TabStrip';
import { LeftPanel } from './chrome/LeftPanel';
import { RightPanel } from './chrome/RightPanel';
import { Toolbar } from './chrome/Toolbar';
import { Transport } from './chrome/Transport';
import { SettingsPage } from './settings/Settings';
import { ui, openSettings, setUi, toggleAgent } from './chrome/ui-state';
import { view } from './chrome/view';
import { SHORTCUTS } from './chrome/shortcuts';

let vp: ViewportController | null = null;
let tl: Timeline | null = null;

export function App() {
  useChannels([], ['ui']);
  useEffect(() => {
    setupShortcuts({
      fit: () => vp?.fit(),
      zoom: f => vp?.setZoom(vp.zoom * f),
      toggleAgent,
      editText: id => startTextEdit(id),
    });
    // ⌘, opens Settings (like any mac app)
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // the panels changed width: the canvases follow on the next frame (their ResizeObservers also
  // fire, this only avoids one frame at the old size)
  useEffect(() => { requestAnimationFrame(() => { vp?.resize(); tl?.resize(); }); }, [ui.leftOpen]);
  const settings = ui.view === 'settings';
  return (
    <IconProvider>
      <div class={'app' + (ui.leftOpen ? '' : ' no-left') + (settings ? ' show-settings' : '')}>
        <Guard name="Tab strip"><TabStrip appMenu={appMenu} /></Guard>
        {/* the editor stays mounted under Settings: its canvases and WebGL context live for the session */}
        <aside class="left" aria-label="Agent and layers" hidden={!ui.leftOpen}><Guard name="Left panel"><LeftPanel /></Guard></aside>
        <main class="center" aria-label="Canvas">
          <Viewport />
          {!ui.leftOpen && <Button variant="ghost" icon class="lp-reopen" tip="Show panel" onClick={() => setUi({ leftOpen: true })}><PanelLeft /></Button>}
        </main>
        <section class="bottom" aria-label="Timeline"><Guard name="Transport"><Transport /></Guard><TimelineHost /></section>
        <aside class="right" aria-label="Properties"><Guard name="Properties"><RightPanel /></Guard></aside>
        {settings && <div class="settings-host"><Guard name="Settings"><SettingsPage /></Guard></div>}
        <Guard name="Sync"><SyncReview /></Guard>
        <ShortcutHelp />
        <Welcome />
        <Benchmark />
      </div>
    </IconProvider>
  );
}

/** the app menu (home button in the tab strip) */
export function appMenu(x: number, y: number) {
  const s = editor.store;
  const items: MenuItem[] = [
    { label: 'New', shortcut: '', action: () => { if (confirmDiscard()) newProject(); } },
    { label: 'Open / Import…', shortcut: '⌘O', action: openFileDialog },
    { label: 'Save', shortcut: '⌘S', action: () => saveProject(false) },
    { label: 'Save As…', shortcut: '⇧⌘S', action: () => saveProject(true) },
    { separator: true },
    {
      label: 'Export', submenu: [
        { label: 'Video…', action: () => { import('./ExportDialog').then(m => m.openExportDialog()); } },
        { label: 'GIF', action: () => { exportGifFile().catch(() => {}); } },
        { label: 'Frame as PNG', action: () => { exportFramePng().catch(() => {}); } },
        { label: 'Lottie JSON', action: exportLottie },
        { label: 'After Effects (.jsx)', action: exportAeScript },
      ],
    },
    { separator: true },
    { label: 'Undo', shortcut: '⌘Z', disabled: !s.canUndo, action: () => s.undo() },
    { label: 'Redo', shortcut: '⇧⌘Z', disabled: !s.canRedo, action: () => s.redo() },
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
    { label: editor.showHud ? 'Hide performance HUD' : 'Show performance HUD', action: () => { editor.showHud = !editor.showHud; editor.emit('hud'); } },
    { separator: true },
    { label: 'Keyboard shortcuts', shortcut: '?', action: () => editor.emit('help') },
    { label: 'Settings…', shortcut: '⌘,', action: () => openSettings() },
  ];
  showContextMenu(x, y, items);
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
    view.vp = vp;
    vp.onTextEdit = (id, fresh) => startTextEdit(id, fresh);
    (globalThis as any).viewport = vp;
  }, []);
  return (
    <div class={'viewport' + (drag ? ' dropping' : '')} ref={host}
      onDragOver={e => { e.preventDefault(); if (e.dataTransfer?.types.includes(STYLE_MIME)) { e.dataTransfer.dropEffect = 'link'; vp?.hoverAt(e); return; } setDrag(true); }}
      onDragLeave={() => { setDrag(false); vp?.hoverAt(null); }}
      onDrop={async e => {
        e.preventDefault(); setDrag(false);
        const style = e.dataTransfer?.getData(STYLE_MIME);
        if (style) {
          // a style swatch dropped on a layer links it (alt: as the stroke). on empty canvas: the selection
          vp?.hoverAt(null);
          const hit = vp?.layerAt(e);
          applyStyle(style, hit ? [hit] : editor.store.selection, e.altKey);
          if (hit) editor.store.select([hit]);
          return;
        }
        for (const f of e.dataTransfer?.files ?? []) await openBrowserFile(f);
      }}>
      <Toolbar />
      <Hud />
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
    view.tl = tl;
    (globalThis as any).timeline = tl;
    editor.store.on('selection', () => { const s = editor.store.selection; if (s.length === 1) tl!.reveal(s[0]); });
  }, []);
  return <div class="timeline" ref={host} />;
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
          <li><b>Animate</b>: click a property's keyframe diamond to add keyframes, or use <i>Animate</i> presets and <i>Text animation</i> in the right panel. Press F9 for easy ease.</li>
          <li><b>AI agent</b> (bottom left): describe an animation and Claude Code builds it in your file, with your own subscription. One click undoes everything it did.</li>
          <li><b>Everything else</b>: press <Kbd>?</Kbd> for shortcuts. Export video or Lottie from the Export button (top right) or the home menu.</li>
        </ol>
    </Dialog>
  );
}
