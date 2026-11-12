// right panel, the motion inspector: a title block for what is selected (the composition when
// nothing is), then the inspector: the ease studio leads when keys are selected, then the
// animated properties as rows with keyframe navigation, then the layer's look.

import { editor } from '../../app/editor';
import { cloneLayers, deleteLayers, layerKeyTimes, renameComp, renameLayer } from '../../core/commands';
import { Inspector } from '../Inspector';
import { useChannels } from '../hooks';
import { showContextMenu, type MenuItem } from '../menu';
import { Button } from '../ui';
import { Ellipsis } from './icons';

const TYPE_NAME: Record<string, string> = { rect: 'Rectangle', ellipse: 'Ellipse', group: 'Group', text: 'Text', image: 'Image', path: 'Path', precomp: 'Composition layer', audio: 'Audio' };

export function RightPanel() {
  useChannels(['selection', 'playing', 'comps'], []);
  return (
    <div class="right-panel">
      <TitleBlock />
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
    title = l.name;
    sub = `${TYPE_NAME[l.type] ?? l.type}${keys ? ` · ${keys} key${keys === 1 ? '' : 's'}` : ''}${l.children.length ? ` · ${l.children.length} layers` : ''}`;
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
    const n = Object.keys(s.project.layers).length;
    title = c.name;
    sub = `Composition · ${c.root.length} layer${c.root.length === 1 ? '' : 's'}${n > c.root.length && Object.keys(s.project.comps).length === 1 ? ` (${n} in all)` : ''}`;
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
      <Button variant="ghost" icon size="sm" tip="More" aria-haspopup="menu" onClick={(e: MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); showContextMenu(r.left - 150, r.bottom + 4, menu); }}><Ellipsis /></Button>
    </div>
  );
}
