// right card, the inspector: a header with what is selected (its name, a grey "Rectangle · in
// Group 14" line and a "…" menu), the alignment buttons for layers, then the inspector sections.
// with nothing selected it is the composition's settings.

import { editor } from '../../app/editor';
import { cloneLayers, deleteLayers, layerKeyTimes, renameComp, renameLayer } from '../../core/commands';
import { AlignBar, Inspector } from '../Inspector';
import { useChannels } from '../hooks';
import { menuFrom, type MenuItem } from '../menu';
import { Button } from '../ui';
import { Ellipsis } from './icons';
import { TopActions } from './TopBar';

const TYPE_NAME: Record<string, string> = { rect: 'Rectangle', ellipse: 'Ellipse', group: 'Group', text: 'Text', image: 'Image', path: 'Path', precomp: 'Composition', audio: 'Audio' };

export function RightPanel() {
  useChannels(['selection', 'playing', 'comps'], []);
  const s = editor.store;
  const sel = s.selection.filter(id => s.layer(id));
  return (
    <div class="right-panel">
      <TopActions />
      <TitleBlock />
      {sel.length > 0 && !s.playing && !sel.every(id => s.layer(id)!.type === 'audio') && <div class="rp-align"><AlignBar ids={sel} /></div>}
      <Inspector />
    </div>
  );
}

function TitleBlock() {
  useChannels(['selection', 'doc', 'comps']);
  const s = editor.store;
  const sel = s.selection.map(id => s.layer(id)).filter(Boolean);
  let title: string, sub: string, menu: MenuItem[];
  if (sel.length === 1) {
    const l = sel[0]!;
    const keys = layerKeyTimes(l).length;
    const parent = l.parent ? s.layer(l.parent) : null;
    title = l.name;
    sub = [
      l.shape ? (l.shape.kind === 'star' ? 'Star' : 'Polygon') : (TYPE_NAME[l.type] ?? l.type),
      parent ? `in ${parent.name}` : null,
      keys ? `${keys} key${keys === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' · ');
    menu = [
      { label: 'Rename…', action: () => { const n = prompt('Layer name', l.name); if (n) renameLayer(s, l.id, n); } },
      { label: 'Duplicate', shortcut: '⌘D', action: () => { const ids = cloneLayers(s, [l.id]); if (ids?.length) s.select(ids); } },
      { label: 'Delete', shortcut: '⌫', action: () => deleteLayers(s, [l.id]) },
    ];
  } else if (sel.length > 1) {
    title = `${sel.length} layers`;
    sub = [...new Set(sel.map(l => TYPE_NAME[l!.type] ?? l!.type))].slice(0, 3).join(', ');
    menu = [
      { label: 'Duplicate', shortcut: '⌘D', action: () => { const ids = cloneLayers(s, s.selection); if (ids?.length) s.select(ids); } },
      { label: 'Delete', shortcut: '⌫', action: () => deleteLayers(s, s.selection) },
    ];
  } else {
    const c = s.comp;
    title = c.name;
    sub = `Composition · ${c.root.length} layer${c.root.length === 1 ? '' : 's'}`;
    menu = [
      { label: 'Rename composition…', action: () => { const v = prompt('Composition name', c.name); if (v) renameComp(s, c.id, v); } },
    ];
  }
  return (
    <div class="rp-title">
      <div class="grow">
        <div class="rp-name" title={title}>{title}</div>
        <div class="rp-sub">{sub}</div>
      </div>
      <Button variant="ghost" icon size="sm" tip="More" aria-haspopup="menu" onClick={(e: MouseEvent) => menuFrom(e.currentTarget as Element, menu, { align: 'right' })}><Ellipsis /></Button>
    </div>
  );
}
