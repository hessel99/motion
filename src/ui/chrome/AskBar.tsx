// the ask bar (⌘K or "/"): a compact bar floating over the canvas. typing filters the commands;
// a sentence goes to the agent about what is selected (layers, keyframes, the preview range: the
// chips show it). Enter runs the highlighted row; the "Ask the agent" row is always last, and
// first when no command matches.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { jumpToKey, loadDemo, newProject, openExport, openFileDialog, saveProject, toast } from '../../app/actions';
import { cloneLayers, deleteLayers, newComposition, precompose, setEase } from '../../core/commands';
import { askAgent, selectionContext } from '../agent-bridge';
import { setTheme, getTheme } from '../theme';
import { Kbd } from '../ui';
import { Sparkles } from './icons';
import { openSettings, setUi, showHome, toggleAgent, ui } from './ui-state';
import { view } from './view';

interface Cmd { label: string; keys?: string; run: () => void; when?: () => boolean }

function commands(): Cmd[] {
  const s = editor.store;
  const sel = () => s.selection.length > 0;
  return [
    { label: 'Play / pause', keys: 'Space', run: () => editor.togglePlay() },
    { label: 'Export…', keys: '⌘E', run: openExport },
    { label: 'New file', keys: '⌘N', run: () => newProject() },
    { label: 'Open file…', keys: '⌘O', run: () => openFileDialog() },
    { label: 'Save', keys: '⌘S', run: () => saveProject(false) },
    { label: 'New composition', run: () => { const c = newComposition(s, { width: s.comp.width, height: s.comp.height, fps: s.comp.fps }); s.openComp(c.id); } },
    { label: 'Easy ease selected keys', keys: 'F9', when: () => s.keySelection.size > 0, run: () => setEase(s, [...s.keySelection], 'Easy Ease') },
    { label: 'Next keyframe', keys: 'K', run: () => jumpToKey(1) },
    { label: 'Previous keyframe', keys: 'J', run: () => jumpToKey(-1) },
    { label: 'Duplicate', keys: '⌘D', when: sel, run: () => { const ids = cloneLayers(s, s.selection); if (ids?.length) s.select(ids); } },
    { label: 'Delete', keys: '⌫', when: sel, run: () => deleteLayers(s, s.selection) },
    { label: 'Pre-compose', keys: '⇧⌘C', when: sel, run: () => { try { precompose(s, s.selection); } catch (e: any) { toast(e.message, 'error'); } } },
    { label: 'Select all', keys: '⌘A', run: () => s.select(s.comp.root.slice()) },
    { label: 'Zoom to fit', keys: '⌘0', run: () => view.vp?.fit() },
    { label: 'Fit the timeline', run: () => view.tl?.fitTime() },
    { label: 'Graph editor', run: () => view.tl?.setMode('graph') },
    { label: 'Keyframe view', run: () => view.tl?.setMode('keys') },
    { label: 'Show / hide the agent', keys: '⌘I', run: toggleAgent },
    { label: 'Assets', run: () => setUi({ leftOpen: true, leftTab: 'assets' }) },
    { label: 'Home', run: showHome },
    { label: 'Open the demo animation', run: () => loadDemo() },
    { label: getTheme() === 'dark' ? 'Light theme' : 'Dark theme', run: () => setTheme(getTheme() === 'dark' ? 'light' : 'dark') },
    { label: 'Keyboard shortcuts', keys: '?', run: () => editor.emit('help') },
    { label: 'Settings', keys: '⌘,', run: () => openSettings() },
  ];
}

function score(label: string, q: string) {
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 3;
  if (l.split(/[\s/]+/).some(w => w.startsWith(q))) return 2;
  return l.includes(q) ? 1 : 0;
}

export function AskBar() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const show = () => { if (ui.view === 'home') return; setQ(''); setActive(0); setOpen(true); requestAnimationFrame(() => input.current?.focus()); };
    const offBar = editor.on('ask-bar', show);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (document.querySelector('[aria-modal="true"]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); show(); }
      else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); e.stopImmediatePropagation(); show(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { offBar(); window.removeEventListener('keydown', onKey, true); };
  }, []);
  const s = editor.store;
  const query = q.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!open) return [];
    const cmds = commands().filter(c => !c.when || c.when());
    const hits = query ? cmds.map(c => ({ c, sc: score(c.label, query) })).filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc).map(x => x.c) : cmds.slice(0, 7);
    // a sentence (several words, or nothing matched) goes to the agent first
    const sentence = query.split(/\s+/).length >= 3 || (query.length > 0 && !hits.length);
    const ask: Cmd | null = query ? { label: `Ask the agent: “${q.trim()}”`, run: () => askAgent(q.trim(), { context: selectionContext() }) } : null;
    const list = hits.slice(0, 7);
    return ask ? (sentence ? [ask, ...list] : [...list, ask]) : list;
  }, [open, query]);
  if (!open) return null;
  const close = () => setOpen(false);
  const run = (c: Cmd) => { close(); c.run(); };
  const sel = s.selection.map(id => s.layer(id)?.name).filter(Boolean) as string[];
  const ctx = selectionContext();
  return (
    <div class="askbar-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div class="askbar" role="dialog" aria-modal="true" aria-label="Ask or run a command">
        <div class="askbar-row">
          <Sparkles class="askbar-icon" />
          <input ref={input} class="askbar-input" value={q} placeholder={sel.length ? 'Ask about the selection, or type a command…' : 'Ask the agent, or type a command…'} spellcheck={false}
            onInput={e => { setQ((e.target as HTMLInputElement).value); setActive(0); }}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Escape') { e.preventDefault(); close(); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(rows.length - 1, a + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
              else if (e.key === 'Enter' && rows[active]) { e.preventDefault(); run(rows[active]); }
            }} />
          <Kbd>esc</Kbd>
        </div>
        <div class="askbar-ctx">
          <span class="ctx-chip"><span class="ctx-chip-name">{sel.length ? (sel.length === 1 ? sel[0] : `${sel.length} layers`) : s.comp.name}</span></span>
          {ctx && <span class="ctx-chip"><span class="ctx-chip-name">{ctx}</span></span>}
        </div>
        {rows.length > 0 && (
          <div class="askbar-list" role="listbox">
            {rows.map((c, i) => (
              <div role="option" aria-selected={i === active} class={'askbar-item' + (i === active ? ' on' : '') + (c.keys ? '' : c.label.startsWith('Ask the agent') ? ' ask' : '')}
                onPointerMove={() => setActive(i)} onClick={() => run(c)}>
                <span class="grow">{c.label}</span>{c.keys && <span class="askbar-keys">{c.keys}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
