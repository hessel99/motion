// the window's title bar: one slim row across the whole window, above the rail, the sidebars and
// the stage. its left end is reserved for the mac traffic lights (desktop app, not full screen:
// platform.ts, chrome.css --traffic-w), then the open documents as tabs (drag to reorder,
// middle-click or ✕ to close, double-click to rename, a dot for unsaved changes) and "+", the empty
// middle drags the window, and at the right undo / redo, the app menu and Share.

import { useRef, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { loadDemo, loadStress, newProject, openFileDialog, saveProject } from '../../app/actions';
import { openShare } from './Share';
import { activeDoc, closeDoc, docName, documents, isDocDirty, moveDoc, switchTo, type Doc } from '../../app/documents';
import { setProjectName } from '../../core/commands';
import { useChannels } from '../hooks';
import { menuFrom, showContextMenu, type MenuItem } from '../menu';
import { Button } from '../ui';
import { Ellipsis, File, Plus, Redo2, Undo2, X } from './icons';
import { openSettings, setUi, ui } from './ui-state';
import { EMULATED } from './platform';

export function TopBar() {
  useChannels(['history', 'doc'], ['ui', 'docs']);
  const home = ui.view === 'home';
  const docs = documents();
  return (
    <header class="titlebar">
      {/* the mac traffic lights float here; the browser emulation (?platform=mac) draws stand-ins */}
      <div class="tb-traffic" aria-hidden="true">{EMULATED && <><i /><i /><i /></>}</div>
      <div class="tb-tabs" role="tablist" aria-label="Open files">
        {docs.map(d => <DocTab key={d.id} doc={d} active={!home && d === activeDoc()} />)}
        <Button variant="ghost" icon size="sm" class="tb-add" tip="New file (⌘N)" onClick={() => newProject()}><Plus /></Button>
      </div>
      <div class="tb-drag" />
      <TopActions />
    </header>
  );
}

/** the title bar's right end: undo / redo, the app menu, Share */
function TopActions() {
  const s = editor.store;
  const home = ui.view === 'home';
  const history = (e: MouseEvent) => {
    e.preventDefault();
    const labels = s.historyLabels;
    const items: MenuItem[] = labels.map((label, i) => ({ label: `${label}`, shortcut: i === labels.length - 1 ? 'last' : `${labels.length - i}`, action: () => s.undoTo(i + s.historyLength - labels.length) })).reverse().slice(0, 25);
    if (items.length) showContextMenu(e.clientX, e.clientY + 8, items);
  };
  const editing = !home && !!activeDoc();
  return (
    <div class="tb-actions">
      {editing && <>
        <Button variant="ghost" icon size="sm" disabled={!s.canUndo} aria-label="Undo" data-tooltip={`Undo${s.undoLabel ? ' ' + s.undoLabel : ''} (⌘Z)`} onClick={() => s.undo()} onContextMenu={history as any}><Undo2 /></Button>
        <Button variant="ghost" icon size="sm" disabled={!s.canRedo} tip="Redo (⇧⌘Z)" onClick={() => s.redo()}><Redo2 /></Button>
      </>}
      <Button variant="ghost" icon size="sm" tip="Menu" aria-haspopup="menu" class="tb-menu" onClick={e => menuFrom(e.currentTarget as Element, appMenuItems(), { align: 'right' })}><Ellipsis /></Button>
      <button type="button" class="pill-btn tb-share" disabled={!editing} aria-haspopup="menu" title="Share a preview or export a file (⌘E exports)" onClick={e => openShare(e.currentTarget as HTMLElement)}>Share</button>
    </div>
  );
}

/** one open document */
function DocTab({ doc, active }: { doc: Doc; active: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const dirty = isDocDirty(doc);
  const name = docName(doc);
  const commit = (v: string) => {
    setRenaming(false);
    const n = v.trim();
    if (n && n !== name && doc === activeDoc()) setProjectName(editor.store, n);
  };
  const close = (e: Event) => { e.stopPropagation(); closeDoc(doc.id); };
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    const others = documents().filter(d => d !== doc);
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Rename', action: () => { switchTo(doc.id); setRenaming(true); requestAnimationFrame(() => input.current?.select()); } },
      { label: 'Save', shortcut: '⌘S', action: () => { switchTo(doc.id); saveProject(false); } },
      { separator: true },
      { label: 'Close', shortcut: '⌘W', action: () => closeDoc(doc.id) },
      { label: 'Close others', disabled: !others.length, action: () => { for (const d of others) if (!closeDoc(d.id)) break; } },
    ]);
  };
  // drag to reorder (pointer events: no html5 drag image, the tab itself follows the pointer)
  const down = (e: PointerEvent) => {
    if (e.button === 1) { e.preventDefault(); return; }
    if (e.button !== 0 || renaming || (e.target as HTMLElement).closest('.tb-close')) return;
    const el = e.currentTarget as HTMLElement;
    const x0 = e.clientX;
    let moved = false;
    const tabs = [...el.parentElement!.querySelectorAll<HTMLElement>('.tb-tab')];
    const mids = tabs.map(t => { const r = t.getBoundingClientRect(); return r.left + r.width / 2; });
    const from = tabs.indexOf(el);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 4) return;
      if (!moved) { moved = true; el.setPointerCapture(ev.pointerId); el.classList.add('dragging'); }
      el.style.transform = `translateX(${dx}px)`;
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.style.transform = '';
      el.classList.remove('dragging');
      if (!moved) return;
      const cx = mids[from] + (ev.clientX - x0);
      const to = mids.filter((m, i) => i !== from && m < cx).length;
      moveDoc(doc.id, to);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return (
    <div role="tab" tabIndex={0} aria-selected={active} class={'tb-tab' + (active ? ' on' : '') + (dirty ? ' dirty' : '')}
      title={doc.path ?? name}
      onPointerDown={down as any}
      onClick={() => { switchTo(doc.id); setUi({ view: 'editor' }); }}
      onAuxClick={e => { if (e.button === 1) close(e); }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTo(doc.id); setUi({ view: 'editor' }); } }}
      onDblClick={() => { if (doc === activeDoc()) { setRenaming(true); requestAnimationFrame(() => input.current?.select()); } }}
      onContextMenu={menu as any}>
      <File class="tb-icon" size={14} />
      {renaming
        ? <input ref={input} class="tb-rename" aria-label="File name" defaultValue={name} spellcheck={false}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(false); }}
            onBlur={e => commit((e.target as HTMLInputElement).value)} />
        : <span class="tb-name">{name}</span>}
      {dirty && <span class="tb-dirty" aria-label="Unsaved changes" />}
      <button type="button" class="tb-close" aria-label={`Close ${name}`} title="Close (⌘W)" onClick={close}><X size={13} /></button>
    </div>
  );
}

/** the app menu ("…" in the top bar): files, examples, performance tools, help, Settings */
export function appMenuItems(): MenuItem[] {
  const editing = !!activeDoc();
  return [
    { label: 'New file', shortcut: '⌘N', action: () => newProject() },
    { label: 'Open…', shortcut: '⌘O', action: openFileDialog },
    { label: 'Save', shortcut: '⌘S', disabled: !editing, action: () => saveProject(false) },
    { label: 'Save as…', shortcut: '⇧⌘S', disabled: !editing, action: () => saveProject(true) },
    { separator: true },
    { label: 'Open the demo animation', action: () => loadDemo() },
    {
      label: 'Performance', submenu: [
        { label: '1,000 animated shapes', action: () => stress(1000) },
        { label: '5,000 animated shapes', action: () => stress(5000) },
        { label: '10,000 animated shapes', action: () => stress(10000) },
        { label: '25,000 animated shapes', action: () => stress(25000) },
        { label: '2,000 mixed (text, stars, shapes, groups)', action: () => stress(2000, ['rect', 'ellipse', 'text', 'path'], true) },
        { separator: true },
        { label: 'Run the benchmark', action: () => editor.emit('benchmark') },
        { label: 'Performance HUD', checked: editor.showHud, action: () => { editor.showHud = !editor.showHud; editor.emit('hud'); } },
      ],
    },
    { separator: true },
    { label: 'Keyboard shortcuts', shortcut: '?', action: () => editor.emit('help') },
    { label: 'Settings…', shortcut: '⌘,', action: () => openSettings() },
  ];
}

/** a stress scene opens in its own tab */
function stress(n: number, kinds?: any[], nested = false) {
  newProject();
  loadStress(n, kinds, nested);
}
