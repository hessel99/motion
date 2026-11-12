// ⌘K command palette (every layout): layouts, panels, playback, tools, export, layers, and a
// fallback that hands the typed text to the agent. also owns the ` key (timeline drawer / sheet).
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { editor, type Tool } from '../../app/editor';
import { exportLottie, loadDemo, confirmDiscard, saveProject } from '../../app/actions';
import { useChannels } from '../hooks';
import { Kbd } from '../ui';
import { LAYOUTS, askAgent, layout, setLayout, summon, toggleSummon } from './layout';
import { jumpKey } from './moments';

interface Cmd { id: string; label: string; group: string; hint?: string; run: () => void }

const TOOLS: [Tool, string, string][] = [['select', 'Move tool', 'V'], ['rect', 'Rectangle tool', 'R'], ['ellipse', 'Ellipse tool', 'O'], ['text', 'Text tool', 'T'], ['pen', 'Pen tool', 'P'], ['star', 'Star tool', ''], ['polygon', 'Polygon tool', '']];

function commands(p: { toggleAgent: () => void; fit: () => void }): Cmd[] {
  const s = editor.store;
  const L = layout();
  const out: Cmd[] = [
    ...LAYOUTS.map(x => ({ id: 'layout-' + x.id, group: 'Layout', label: `Layout: ${x.label}`, hint: x.id === L ? 'current' : x.blurb, run: () => setLayout(x.id) })),
    { id: 'agent', group: 'Panels', label: 'Toggle AI agent', hint: '⌘I', run: p.toggleAgent },
    { id: 'timeline', group: 'Panels', label: L === 'stage' ? 'Toggle full timeline' : 'Toggle timeline sheet', hint: '`', run: () => toggleSummon('timeline') },
    { id: 'props', group: 'Panels', label: L === 'score' ? 'Show layer details' : 'Toggle properties', run: () => toggleSummon('inspector') },
    { id: 'play', group: 'Playback', label: s.playing ? 'Pause' : 'Play', hint: 'Space', run: () => editor.togglePlay() },
    { id: 'start', group: 'Playback', label: 'Go to start', hint: 'Home', run: () => s.setTime(0) },
    { id: 'nextkey', group: 'Playback', label: 'Next keyframe', hint: 'K', run: () => jumpKey(1) },
    { id: 'prevkey', group: 'Playback', label: 'Previous keyframe', hint: 'J', run: () => jumpKey(-1) },
    { id: 'fit', group: 'View', label: 'Zoom to fit', hint: '⌘0', run: p.fit },
    ...TOOLS.map(([t, label, k]) => ({ id: 'tool-' + t, group: 'Tools', label, hint: k, run: () => editor.setTool(t) })),
    { id: 'export-video', group: 'File', label: 'Export video…', run: () => { import('../ExportDialog').then(m => m.openExportDialog()); } },
    { id: 'export-lottie', group: 'File', label: 'Export Lottie JSON', run: exportLottie },
    { id: 'save', group: 'File', label: 'Save', hint: '⌘S', run: () => saveProject(false) },
    { id: 'demo', group: 'File', label: 'Load demo animation', run: () => { if (confirmDiscard()) loadDemo(); } },
    { id: 'help', group: 'Help', label: 'Keyboard shortcuts', hint: '?', run: () => editor.emit('help') },
  ];
  const walk = (ids: string[]) => { for (const id of ids) { const l = s.layer(id); if (!l) continue; out.push({ id: 'layer-' + id, group: 'Layers', label: `Select ${l.name}`, hint: l.type, run: () => s.select([id]) }); walk(l.children); } };
  walk(s.comp.root);
  return out;
}

function score(label: string, q: string) {
  const a = label.toLowerCase();
  if (!q) return 1;
  if (a.includes(q)) return 3 - a.indexOf(q) / 100;
  // subsequence match ("tl" -> "Toggle timeLine")
  let i = 0;
  for (const c of a) if (c === q[i]) i++;
  return i === q.length ? 1 : 0;
}

export function CommandPalette(props: { toggleAgent: () => void; fit: () => void }) {
  useChannels([], ['layout']);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const open = summon.palette;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); toggleSummon('palette'); return; }
      if (e.key === '`' && !typing && !e.metaKey && !e.ctrlKey && !document.querySelector('[aria-modal="true"]') && layout() !== 'classic') { e.preventDefault(); toggleSummon('timeline'); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  useLayoutEffect(() => { if (open) { setQ(''); setSel(0); input.current?.focus(); } }, [open]);
  if (!open) return null;
  const query = q.trim().toLowerCase();
  const list = commands(props).map(c => ({ c, s: score(c.label + ' ' + c.group, query) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 12).map(x => x.c);
  if (query) list.push({ id: 'ask', group: 'Agent', label: `Ask the agent: “${q.trim()}”`, hint: '↵', run: () => askAgent(q.trim()) });
  const close = () => toggleSummon('palette', false);
  const run = (c: Cmd) => { close(); c.run(); };
  const cur = Math.min(sel, list.length - 1);
  return (
    <div class="palette-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input ref={input} class="palette-input" placeholder="Type a command, a layer, or ask the agent…" value={q}
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={list[cur] ? 'pc-' + list[cur].id : undefined}
          onInput={e => { setQ((e.target as HTMLInputElement).value); setSel(0); }}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Escape') { e.preventDefault(); close(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(list.length - 1, cur + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, cur - 1)); }
            else if (e.key === 'Enter' && list[cur]) { e.preventDefault(); run(list[cur]); }
          }} />
        <div class="palette-list" id="palette-list" role="listbox">
          {list.map((c, i) => (
            <div id={'pc-' + c.id} role="option" aria-selected={i === cur} class={'palette-item' + (i === cur ? ' active' : '') + (c.id === 'ask' ? ' ask' : '')}
              onPointerMove={() => i !== cur && setSel(i)} onClick={() => run(c)}>
              <span class="palette-group">{c.group}</span>
              <span class="palette-label">{c.label}</span>
              {c.hint && <span class="palette-hint">{c.hint.length <= 6 && c.group !== 'Layers' && c.group !== 'Layout' ? <Kbd>{c.hint}</Kbd> : c.hint}</span>}
            </div>
          ))}
          {!list.length && <div class="palette-empty muted">Nothing matches</div>}
        </div>
      </div>
    </div>
  );
}
