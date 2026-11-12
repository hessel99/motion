// window top bar: home (app menu), the open document as a tab, Settings (when open), "+", then
// the motion bar: the composition switcher with its format (size · fps · duration), undo / redo,
// the Agent toggle and Export.
// in the mac desktop app the window has no title bar (electron/main.cjs: hiddenInset): the
// traffic lights sit at the strip's left and the empty strip drags the window.

import { useRef, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { confirmDiscard, exportAeScript, exportFramePng, exportGifFile, exportLottie, isDirty, newProject, toast } from '../../app/actions';
import { addPrecompLayer, newComposition, renameComp, setProjectName } from '../../core/commands';
import { useChannels } from '../hooks';
import { showContextMenu, type MenuItem } from '../menu';
import { Button } from '../ui';
import { ChevronDown, Clapperboard, Download, File, House, Plus, Redo2, Settings, Sparkles, Undo2, X } from './icons';
import { closeSettings, openSettings, showEditor, toggleAgent, ui } from './ui-state';
import { fmtDuration } from './view';

const native = (globalThis as any).motionNative as { platform?: string } | undefined;
const MAC_APP = native?.platform === 'darwin';

export function exportMenu(x: number, y: number) {
  const items: MenuItem[] = [
    { label: 'Video (MP4 / WebM)…', action: () => { import('../ExportDialog').then(m => m.openExportDialog()); } },
    { label: 'GIF', action: () => { exportGifFile().catch(() => {}); } },
    { label: 'Frame as PNG', action: () => { exportFramePng().catch(() => {}); } },
    { separator: true },
    { label: 'Lottie JSON', action: exportLottie },
    { label: 'After Effects (.jsx)', action: exportAeScript },
  ];
  showContextMenu(x, y, items);
}

export function TabStrip(props: { appMenu: (x: number, y: number) => void }) {
  useChannels(['doc', 'history', 'comps'], ['ui']);
  const s = editor.store;
  const [renaming, setRenaming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const editorOn = ui.view === 'editor';
  const commit = (v: string) => { setRenaming(false); const n = v.trim(); if (n && n !== s.project.name) setProjectName(s, n); };
  const tabKey = (e: KeyboardEvent, fn: () => void) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
  const history = (e: MouseEvent) => {
    e.preventDefault();
    const labels = s.historyLabels;
    const items: MenuItem[] = labels.map((label, i) => ({ label: `${label}`, shortcut: i === labels.length - 1 ? 'last' : `${labels.length - i}`, action: () => s.undoTo(i + s.historyLength - labels.length) })).reverse().slice(0, 25);
    if (items.length) showContextMenu(e.clientX, e.clientY + 8, items);
  };
  const agentOn = ui.leftOpen && ui.leftTab === 'agent';
  return (
    <header class={'tabstrip' + (MAC_APP ? ' mac-app' : '')}>
      {MAC_APP && <div class="ts-traffic" aria-hidden="true" />}
      <button type="button" class="ts-home" aria-label="Menu" aria-haspopup="menu" title="Menu"
        onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); props.appMenu(r.left, r.bottom + 4); }}>
        <House />
      </button>
      <div class="ts-tabs" role="tablist" aria-label="Open documents">
        <div role="tab" tabIndex={0} aria-selected={editorOn} class={'ts-tab' + (editorOn ? ' on' : '')}
          title={`${s.project.name} (double-click to rename)`}
          onClick={showEditor} onKeyDown={e => tabKey(e, showEditor)} onDblClick={() => { setRenaming(true); requestAnimationFrame(() => input.current?.select()); }}>
          <File class="ts-icon" />
          {renaming
            ? <input ref={input} class="ts-rename" aria-label="Project name" defaultValue={s.project.name} spellcheck={false}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(false); }}
                onBlur={e => commit((e.target as HTMLInputElement).value)} />
            : <span class="ts-name">{s.project.name}</span>}
          {isDirty() && <span class="ts-dirty" title="Unsaved changes" aria-label="Unsaved changes" />}
        </div>
        {ui.settingsOpen && (
          <div role="tab" tabIndex={0} aria-selected={!editorOn} class={'ts-tab ts-settings' + (!editorOn ? ' on' : '')}
            onClick={() => openSettings()} onKeyDown={e => tabKey(e, () => openSettings())}>
            <Settings class="ts-icon" />
            <span class="ts-name">Settings</span>
            <button type="button" class="ts-close" aria-label="Close Settings" title="Close"
              onClick={e => { e.stopPropagation(); closeSettings(); }}><X size={14} /></button>
          </div>
        )}
        <button type="button" class="ts-add" aria-label="New file" title="New file"
          onClick={() => { if (confirmDiscard()) { newProject(); showEditor(); } }}><Plus /></button>
      </div>
      {editorOn && <div class="ts-motion">
        <CompSwitcher />
        <span class="ts-format" title="Composition size · frame rate · duration">
          {s.comp.width}×{s.comp.height}<i aria-hidden="true">·</i>{s.comp.fps} fps<i aria-hidden="true">·</i>{fmtDuration(s.comp.duration)}
        </span>
      </div>}
      <div class="ts-drag" />
      {editorOn && <div class="ts-actions">
        <Button variant="ghost" icon size="sm" disabled={!s.canUndo} aria-label="Undo" title={`Undo ${s.undoLabel ?? ''} (⌘Z), right-click for history`} onClick={() => s.undo()} onContextMenu={history as any}><Undo2 /></Button>
        <Button variant="ghost" icon size="sm" disabled={!s.canRedo} tip="Redo (⇧⌘Z)" onClick={() => s.redo()}><Redo2 /></Button>
        <span class="ts-sep" aria-hidden="true" />
        <Button variant="ghost" size="sm" class="ts-agent" active={agentOn} title="Agent (⌘I)" onClick={toggleAgent}><Sparkles />Agent</Button>
        <button type="button" class="pill-btn ts-export" aria-haspopup="menu"
          onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); exportMenu(r.right - 200, r.bottom + 4); }}><Download size={14} />Export</button>
      </div>}
    </header>
  );
}

/** the active composition, as a menu: switch, new, rename, use as a layer */
function CompSwitcher() {
  const s = editor.store;
  const open = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const comps = Object.values(s.project.comps);
    const others = comps.filter(c => c.id !== s.comp.id);
    const items: MenuItem[] = [
      ...comps.map(c => ({ label: `${c.name}`, shortcut: `${c.width}×${c.height}`, checked: c.id === s.comp.id, action: () => { if (c.id !== s.comp.id) s.openComp(c.id); } })),
      { separator: true },
      { label: 'New composition', action: () => { const c = newComposition(s); s.openComp(c.id); } },
      { label: 'Rename composition…', action: () => { const v = prompt('Composition name', s.comp.name); if (v) renameComp(s, s.comp.id, v); } },
      { label: 'Add composition as layer', disabled: !others.length, submenu: others.map(c => ({ label: c.name, action: () => { try { addPrecompLayer(s, c.id); } catch (err: any) { toast(err.message, 'error'); } } })) },
    ];
    showContextMenu(r.left, r.bottom + 4, items);
  };
  const n = Object.keys(s.project.comps).length;
  return (
    <button type="button" class="ts-comp" aria-haspopup="menu" title={n > 1 ? `Composition (${n} in this file)` : 'Composition'} onClick={open}>
      <Clapperboard size={15} />
      <span class="ts-comp-name">{s.comp.name}</span>
      <ChevronDown size={14} class="ts-chev" />
    </button>
  );
}
