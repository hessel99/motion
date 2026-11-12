import { useEffect, useRef, useState } from 'preact/hooks';
import { Component, type ComponentChildren } from 'preact';
import { editor } from '../app/editor';
import { ViewportController } from './viewport-controller';
import { Timeline } from './timeline';
import { STYLE_MIME, applyStyle } from './LibraryPanel';
import { useChannels } from './hooks';
import { menuFrom, showContextMenu } from './menu';
import { agentMenuItems } from './agent-menu';
import { AskBar } from './chrome/AskBar';
import { EmptyCanvas, ImportSuggestion } from './chrome/CanvasAgent';
import { SelectionBar, stopPreview } from './chrome/CanvasBars';
import { openBrowserFile, setupShortcuts, runBenchmark, toast } from '../app/actions';
import { prefs, setPref } from '../app/prefs';
import { cloneLayers, deleteLayers } from '../core/commands';
import { Button, Dialog, Kbd } from './ui';
import { IconProvider, X } from './chrome/icons';
import { TopBar } from './chrome/TopBar';
import { Rail } from './chrome/Rail';
import { Home } from './chrome/Home';
import { LeftPanel } from './chrome/LeftPanel';
import { RightPanel } from './chrome/RightPanel';
import { Toolbar } from './chrome/Toolbar';
import { TimelineHeader, tlHeightStyle } from './chrome/TimelineHeader';
import { SettingsPage } from './settings/Settings';
import { ui, closeSettings, openSettings, toggleAgent } from './chrome/ui-state';
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
    document.documentElement.dataset.view = ui.view;
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // the panels changed size: the canvases follow on the next frame (their ResizeObservers also
  // fire, this only avoids one frame at the old size)
  useEffect(() => { requestAnimationFrame(() => { vp?.resize(); tl?.resize(); }); }, [ui.leftOpen, ui.view]);
  // the window: the icon rail, two fixed full-height sidebars (agent / assets on the left, the
  // inspector on the right) and between them the stage: the file tabs, then the canvas and the
  // timeline as two inset cards. Home replaces the stage; Settings is a modal.
  const home = ui.view === 'home';
  return (
    <IconProvider>
      <div class={'app' + (ui.leftOpen ? '' : ' no-left') + (home ? ' show-home' : '') + (ui.previewing ? ' previewing' : '')} style={tlHeightStyle()}>
        <Guard name="Rail"><Rail /></Guard>
        <Guard name="Top bar"><TopBar /></Guard>
        {/* the editor stays mounted under Home: its canvases and WebGL context live for the session */}
        <aside class="left sidebar" aria-label="Agent and assets" hidden={!ui.leftOpen}><Guard name="Side panel"><LeftPanel /></Guard></aside>
        <main class="center card" aria-label="Canvas">
          <Viewport />
          {ui.previewing && <button type="button" class="preview-exit" onClick={stopPreview}>Esc · leave preview</button>}
        </main>
        <section class="bottom card" aria-label="Timeline">
          <Guard name="Timeline header"><TimelineHeader /></Guard>
          <TimelineHost />
        </section>
        <aside class="right sidebar" aria-label="Properties"><Guard name="Properties"><RightPanel /></Guard></aside>
        {home && <div class="home-host"><Guard name="Home"><Home /></Guard></div>}
        {ui.settingsOpen && <SettingsModal />}
        <AskBar />
        <ShortcutHelp />
        <Welcome />
        <Benchmark />
      </div>
    </IconProvider>
  );
}

/** Settings as a large modal: aria-modal keeps the editor's shortcuts off while it is open */
function SettingsModal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.ctx-menu')) { e.preventDefault(); closeSettings(); } };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); if (prev && document.contains(prev)) prev.focus({ preventScroll: true }); };
  }, []);
  return (
    <div class="dialog-backdrop settings-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) closeSettings(); }}>
      <div ref={ref} class="settings-modal" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1}>
        <Guard name="Settings"><SettingsPage /></Guard>
        <Button variant="ghost" icon size="sm" class="settings-close" tip="Close (Esc)" onClick={closeSettings}><X size={14} /></Button>
      </div>
    </div>
  );
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
      onContextMenu={e => {
        // right-click on the canvas: the layer under the pointer (or the selection), then the agent's asks
        if ((e.target as HTMLElement).closest('.vp-ui, .vp-empty-card')) return;
        e.preventDefault();
        const s = editor.store;
        const hit = vp?.layerAt(e);
        if (hit && !s.selection.includes(hit)) s.select([hit]);
        const has = s.selection.length > 0;
        showContextMenu(e.clientX, e.clientY, [
          ...agentMenuItems(has ? 'layers' : 'comp'),
          ...(has ? [{ separator: true } as const, { label: 'Duplicate', shortcut: '⌘D', action: () => { const ids = cloneLayers(s, s.selection); if (ids?.length) s.select(ids); } }, { label: 'Delete', shortcut: '⌫', action: () => deleteLayers(s, s.selection) }] : []),
        ]);
      }}
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
      <EmptyCanvas />
      <ImportSuggestion />
      <SelectionBar />
      <Toolbar><ZoomBadge /></Toolbar>
      <Hud />
    </div>
  );
}

/** canvas zoom at the stage's bottom right: a menu with the zoom steps and the canvas view
 *  options. touches the dom only when the zoom changed */
function ZoomBadge() {
  const el = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let lastZ = -1;
    return editor.onFrame(() => {
      const z = Math.round((vp?.zoom ?? 1) * 100);
      if (z !== lastZ && el.current) { lastZ = z; el.current.textContent = z + '%'; }
    });
  }, []);
  const menu = () => {
    if (!el.current) return;
    menuFrom(el.current, [
      { label: 'Zoom to fit', shortcut: '⌘0', action: () => vp?.fit() },
      { label: 'Zoom to 100%', action: () => vp?.setZoom(1) },
      { label: 'Zoom in', shortcut: '⌘+', action: () => vp?.setZoom(vp.zoom * 1.25) },
      { label: 'Zoom out', shortcut: '⌘−', action: () => vp?.setZoom(vp.zoom / 1.25) },
      { separator: true },
      { label: 'Pixel grid (400% and above)', checked: prefs.pixelGrid, action: () => setPref('pixelGrid', !prefs.pixelGrid) },
      { label: 'Snap to pixel grid', checked: prefs.snapToPixels, action: () => setPref('snapToPixels', !prefs.snapToPixels) },
      { label: 'Play at composition fps', checked: editor.snapPlaybackToFrames, action: () => { editor.snapPlaybackToFrames = !editor.snapPlaybackToFrames; toast(editor.snapPlaybackToFrames ? 'Playback snaps to composition frames' : 'Playback is smooth (every display frame)'); } },
      { label: 'Performance HUD', checked: editor.showHud, action: () => { editor.showHud = !editor.showHud; editor.emit('hud'); } },
    ], { align: 'right', above: true });
  };
  return <button type="button" ref={el} class="zoom-badge" aria-haspopup="menu" data-tooltip="Zoom and view options" data-tooltip-side="top" onClick={menu}>100%</button>;
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
          <li><b>AI agent</b> (left panel, ⌘I): describe an animation and Claude Code builds it in your file, with your own subscription. One click undoes everything it did.</li>
          <li><b>Everything else</b>: press <Kbd>?</Kbd> for shortcuts. Export video, GIF, Lottie or After Effects from the Export button (top right, ⌘E).</li>
        </ol>
    </Dialog>
  );
}
