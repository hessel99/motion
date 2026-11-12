// left panel: a compact icon tab row (agent, file, components, library, comments) + collapse,
// the tab's content, and the agent composer at the bottom of every tab.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { cloneLayers, deleteLayers, newComposition, renameComp, renameLayer, setLayerField, addPrecompLayer } from '../../core/commands';
import { toast } from '../../app/actions';
import type { Layer } from '../../core/model';
import { AgentPanel } from '../AgentPanel';
import { ComponentsSection, StylesSection } from '../LibraryPanel';
import { useChannels } from '../hooks';
import { showContextMenu } from '../menu';
import { Button } from '../ui';
import {
  ChevronRight, Component, Eye, EyeOff, Hexagon, LAYER_ICON, Layers, Lock, MessageSquare, PanelLeft, Plus, Search, Sparkles, X, type LucideIcon,
} from './icons';
import { setUi, ui, type LeftTab } from './ui-state';

const TABS: { id: LeftTab; label: string; Icon: LucideIcon; tip: string }[] = [
  { id: 'agent', label: 'Agent', Icon: Sparkles, tip: 'Agent (⌘I)' },
  { id: 'file', label: 'File', Icon: Layers, tip: 'Compositions and layers' },
  { id: 'components', label: 'Components', Icon: Component, tip: 'Components' },
  { id: 'library', label: 'Library', Icon: Hexagon, tip: 'Colors and numbers (styles and variables)' },
  { id: 'comments', label: 'Comments', Icon: MessageSquare, tip: 'Comments' },
];

export function LeftPanel() {
  useChannels([], ['ui']);
  const tab = ui.leftTab;
  return (
    <div class="left-panel">
      <div class="lp-tabs" role="tablist" aria-label="Left panel">
        {TABS.map(t => {
          const on = t.id === tab;
          return (
            <button type="button" role="tab" aria-selected={on} aria-label={t.label} class={'lp-tab' + (on ? ' on' : '')}
              data-tooltip={on ? undefined : t.tip} onClick={() => setUi({ leftTab: t.id })}>
              <t.Icon />{on && <span>{t.label}</span>}
            </button>
          );
        })}
        <span class="grow" />
        <Button variant="ghost" icon size="sm" class="lp-collapse" tip="Hide panel (⌘I shows the agent)" onClick={() => setUi({ leftOpen: false })}><PanelLeft /></Button>
      </div>
      <AgentPanel chat={tab === 'agent'} onSent={() => setUi({ leftTab: 'agent' })}>
        {tab === 'file' && <FileTab />}
        {tab === 'components' && <div class="lp-scroll"><ComponentsTab /></div>}
        {tab === 'library' && <div class="lp-scroll"><LibraryTab /></div>}
        {tab === 'comments' && <CommentsTab />}
      </AgentPanel>
    </div>
  );
}

function ComponentsTab() {
  useChannels(['doc', 'components', 'selection', 'comps']);
  return <div class="library"><ComponentsSection /></div>;
}

function LibraryTab() {
  useChannels(['doc', 'tokens', 'selection', 'comps']);
  return <div class="library"><StylesSection /></div>;
}

function CommentsTab() {
  return (
    <div class="lp-empty">
      <MessageSquare size={20} />
      <div><b>No comments yet</b></div>
      <div class="muted">Comments on frames and layers are coming. For now, markers (M) can carry notes on the timeline.</div>
    </div>
  );
}

// ---------------- file: pages (compositions) + layers ----------------
function FileTab() {
  return (
    <div class="file-tab">
      <Pages />
      <LayerTree />
    </div>
  );
}

function Pages() {
  useChannels(['comps', 'doc']);
  const s = editor.store;
  const [renaming, setRenaming] = useState<string | null>(null);
  const comps = Object.values(s.project.comps);
  return (
    <section class="lp-section pages" aria-label="Compositions">
      <header class="lp-head">
        <span>Compositions</span>
        <Button variant="ghost" icon size="sm" tip="New composition" onClick={() => { const c = newComposition(s); s.openComp(c.id); }}><Plus /></Button>
      </header>
      <div class="pages-list" role="listbox" aria-label="Compositions">
        {comps.map(c => {
          const on = c.id === s.comp.id;
          return (
            <div role="option" aria-selected={on} tabIndex={0} class={'page-row' + (on ? ' on' : '')} title="Double-click to rename"
              onClick={() => { if (!on) s.openComp(c.id); }}
              onKeyDown={e => { if (e.key === 'Enter') s.openComp(c.id); }}
              onDblClick={() => setRenaming(c.id)}
              onContextMenu={e => {
                e.preventDefault();
                showContextMenu(e.clientX, e.clientY, [
                  { label: 'Open', action: () => s.openComp(c.id) },
                  { label: 'Rename', action: () => setRenaming(c.id) },
                  { label: 'Add as layer', disabled: on, action: () => { try { addPrecompLayer(s, c.id); } catch (err: any) { toast(err.message, 'error'); } } },
                ]);
              }}>
              {renaming === c.id
                ? <InlineName value={c.name} onDone={v => { setRenaming(null); if (v && v !== c.name) renameComp(s, c.id, v); }} />
                : <span class="page-name">{c.name}</span>}
              <span class="page-meta">{c.width}×{c.height}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function InlineName(props: { value: string; onDone: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input ref={ref} class="inline-name" aria-label="Name" defaultValue={props.value} spellcheck={false}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') props.onDone((e.target as HTMLInputElement).value.trim()); if (e.key === 'Escape') props.onDone(null); }}
      onBlur={e => props.onDone((e.target as HTMLInputElement).value.trim())} />
  );
}

/**
 * the layer tree. virtualized (only the rows in view are in the dom), rebuilt only when the tree
 * changes: plain edits (dragging a layer, keyframes) re-render it only when a visible row's
 * name / visibility / lock changed.
 */
const ROW_H = 28;
interface TRow { l: Layer; depth: number }

function LayerTree() {
  const s = editor.store;
  const [, force] = useState(0);
  const [version, setVersion] = useState(0);
  const expanded = useRef(new Set<string>());
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [filter, setFilter] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const shown = useRef(new Map<string, string>()); // id -> name|visible|locked of rendered rows

  useEffect(() => {
    let raf = 0;
    const later = (fn: () => void) => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; fn(); }); };
    const offChange = s.onChange(c => {
      if (c.comp || (c.structure && !c.sameTree)) { later(() => setVersion(v => v + 1)); return; }
      for (const id of c.layers) {
        const prev = shown.current.get(id);
        if (prev === undefined) continue;
        const l = s.layer(id);
        if (!l || prev !== sig(l)) { later(() => force(x => x + 1)); return; }
      }
    });
    const offSel = s.on('selection', () => {
      // reveal the (single) selected layer: open its ancestors, scroll it into view
      const sel = s.selection;
      if (sel.length === 1) {
        let p = s.layer(sel[0])?.parent, opened = false;
        while (p) { if (!expanded.current.has(p)) { expanded.current.add(p); opened = true; } p = s.layer(p)?.parent; }
        if (opened) setVersion(v => v + 1);
        requestAnimationFrame(() => revealRef.current?.(sel[0]));
      }
      later(() => force(x => x + 1));
    });
    const offComps = s.on('comps', () => { expanded.current.clear(); setVersion(v => v + 1); });
    const offLoaded = editor.on('loaded', () => { expanded.current.clear(); setVersion(v => v + 1); });
    return () => { offChange(); offSel(); offComps(); offLoaded(); cancelAnimationFrame(raf); };
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const q = filter?.trim().toLowerCase() ?? '';
  const rows = useMemo(() => {
    const out: TRow[] = [];
    const L = s.project.layers;
    if (q) {
      // search: a flat list of matches (cheap, no ancestry)
      const roots = new Set(s.comp.root);
      for (const id of Object.keys(L)) { const l = L[id]; if (l && l.name.toLowerCase().includes(q) && inComp(s, l, roots)) out.push({ l, depth: 0 }); if (out.length > 2000) break; }
      return out;
    }
    const walk = (ids: string[], depth: number) => {
      for (let i = ids.length - 1; i >= 0; i--) {
        const l = L[ids[i]];
        if (!l) continue;
        out.push({ l, depth });
        if (l.children.length && expanded.current.has(l.id)) walk(l.children, depth + 1);
      }
    };
    walk(s.comp.root, 0);
    return out;
  }, [version, q, s.comp]);

  const revealRef = useRef<(id: string) => void>();
  revealRef.current = (id: string) => {
    const i = rows.findIndex(r => r.l.id === id);
    const el = scroller.current;
    if (i < 0 || !el) return;
    const y = i * ROW_H;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_H - el.clientHeight;
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 4);
  const sel = new Set(s.selection);
  shown.current.clear();
  const toggle = (id: string) => { if (expanded.current.has(id)) expanded.current.delete(id); else expanded.current.add(id); setVersion(v => v + 1); };
  const click = (e: MouseEvent, id: string) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) s.select([id], e.metaKey || e.ctrlKey ? 'toggle' : 'add');
    else s.select([id]);
  };
  const menu = (e: MouseEvent, l: Layer) => {
    e.preventDefault();
    if (!sel.has(l.id)) s.select([l.id]);
    const ids = s.selection;
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Rename', action: () => setRenaming(l.id) },
      { label: 'Duplicate', shortcut: '⌘D', action: () => { const n = cloneLayers(s, ids); if (n?.length) s.select(n); } },
      { label: l.visible ? 'Hide' : 'Show', action: () => setLayerField(s, ids, 'visible', !l.visible, l.visible ? 'Hide' : 'Show') },
      { label: l.locked ? 'Unlock' : 'Lock', action: () => setLayerField(s, ids, 'locked', !l.locked, l.locked ? 'Unlock' : 'Lock') },
      { separator: true },
      { label: 'Delete', shortcut: '⌫', action: () => deleteLayers(s, ids) },
    ]);
  };

  return (
    <section class="lp-section layers" aria-label="Layers">
      <header class="lp-head">
        {filter === null ? <span>Layers</span> : (
          <input class="lp-search" placeholder="Find layers" aria-label="Find layers" value={filter} autoFocus
            onInput={e => setFilter((e.target as HTMLInputElement).value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setFilter(null); }} />
        )}
        <Button variant="ghost" icon size="sm" tip={filter === null ? 'Find layers' : 'Close search'} onClick={() => setFilter(filter === null ? '' : null)}>
          {filter === null ? <Search /> : <X />}
        </Button>
      </header>
      <div class="tree" ref={scroller} role="tree" aria-label="Layers" aria-multiselectable="true" onScroll={e => setScrollTop((e.currentTarget as HTMLElement).scrollTop)}>
        <div class="tree-inner" style={{ height: rows.length * ROW_H + 'px' }}>
          {rows.slice(first, last).map((r, k) => {
            const l = r.l;
            shown.current.set(l.id, sig(l));
            const Icon = LAYER_ICON[l.type];
            const on = sel.has(l.id);
            const open = expanded.current.has(l.id);
            return (
              <div role="treeitem" aria-selected={on} aria-expanded={l.children.length && !q ? open : undefined} aria-level={r.depth + 1}
                class={'tree-row' + (on ? ' on' : '') + (l.visible ? '' : ' hidden-layer')}
                style={{ top: (first + k) * ROW_H + 'px', paddingLeft: 8 + r.depth * 14 + 'px' }}
                onClick={e => click(e, l.id)} onDblClick={() => setRenaming(l.id)} onContextMenu={e => menu(e, l)}>
                {l.children.length && !q
                  ? <button type="button" class={'twirl' + (open ? ' open' : '')} aria-label={open ? 'Collapse' : 'Expand'} tabIndex={-1} onClick={e => { e.stopPropagation(); toggle(l.id); }}><ChevronRight size={14} /></button>
                  : <span class="twirl" />}
                <Icon size={14} class="tree-icon" />
                {renaming === l.id
                  ? <InlineName value={l.name} onDone={v => { setRenaming(null); if (v && v !== l.name) renameLayer(s, l.id, v); }} />
                  : <span class="tree-name">{l.name}</span>}
                {l.locked && <Lock size={12} class="tree-lock" />}
                <button type="button" class={'tree-eye' + (l.visible ? '' : ' off')} aria-label={l.visible ? 'Hide layer' : 'Show layer'} tabIndex={-1}
                  onClick={e => { e.stopPropagation(); setLayerField(s, [l.id], 'visible', !l.visible, l.visible ? 'Hide' : 'Show'); }}>
                  {l.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
              </div>
            );
          })}
        </div>
        {!rows.length && <div class="lp-hint muted">{q ? 'No layers match.' : 'No layers yet. Draw with the toolbar, paste from Figma or drop a file.'}</div>}
      </div>
    </section>
  );
}

const sig = (l: Layer) => `${l.name}|${l.visible}|${l.locked}|${l.children.length}`;

function inComp(s: typeof editor.store, l: Layer, roots: Set<string>) {
  let top: Layer | undefined = l;
  while (top?.parent) top = s.layer(top.parent);
  return !!top && roots.has(top.id);
}
