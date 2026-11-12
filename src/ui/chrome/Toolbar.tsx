// the floating tool pill at the bottom centre of the canvas: select, hand, the shape family (one
// button: its corner caret, a right-click or a second click on it picks rectangle / ellipse /
// polygon / star), pen and text, then the zoom (its menu holds the canvas view options).

import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { editor, type Tool } from '../../app/editor';
import { useChannels } from '../hooks';
import { menuFrom, type MenuItem } from '../menu';
import { Circle, Hand, MousePointer2, PenTool, Pentagon, Square, Star, Type, type LucideIcon } from './icons';

interface ToolDef { id: Tool; label: string; key: string; Icon: LucideIcon }
const T: Record<string, ToolDef> = {
  select: { id: 'select', label: 'Select', key: 'V', Icon: MousePointer2 },
  hand: { id: 'hand', label: 'Hand', key: 'H', Icon: Hand },
  rect: { id: 'rect', label: 'Rectangle', key: 'R', Icon: Square },
  ellipse: { id: 'ellipse', label: 'Ellipse', key: 'O', Icon: Circle },
  polygon: { id: 'polygon', label: 'Polygon', key: '', Icon: Pentagon },
  star: { id: 'star', label: 'Star', key: '', Icon: Star },
  pen: { id: 'pen', label: 'Pen', key: 'P', Icon: PenTool },
  text: { id: 'text', label: 'Text', key: 'T', Icon: Type },
};
/** button slots: a group shows its last used member */
const GROUPS: Tool[][] = [['select'], ['hand'], ['rect', 'ellipse', 'polygon', 'star'], ['pen'], ['text']];

const lastUsed = new Map<number, Tool>();

export function Toolbar(props: { children?: ComponentChildren }) {
  useChannels([], ['tool']);
  const [, force] = useState(0);
  const cur = editor.tool;
  const variants = (gi: number, el: HTMLElement) => {
    const items: MenuItem[] = GROUPS[gi].map(id => ({ label: T[id].label, shortcut: T[id].key, checked: cur === id, action: () => { lastUsed.set(gi, id); editor.setTool(id); force(x => x + 1); } }));
    menuFrom(el, items, { above: true });
  };
  return (
    <div class="toolbar vp-ui" role="toolbar" aria-label="Tools">
      {GROUPS.map((g, gi) => {
        const active = g.includes(cur) ? cur : (lastUsed.get(gi) ?? g[0]);
        const def = T[active];
        const on = g.includes(cur);
        const multi = g.length > 1;
        const tip = def.key ? `${def.label} (${def.key})` : def.label;
        return (
          <button type="button" class={'tool' + (on ? ' on' : '')} aria-pressed={on} aria-label={def.label} data-tooltip={multi ? tip + ' · more shapes ▾' : tip} data-tooltip-side="top"
            aria-haspopup={multi ? 'menu' : undefined}
            onClick={e => {
              const el = e.currentTarget as HTMLElement;
              const b = el.getBoundingClientRect();
              // the corner caret (or a second click on the active tool) opens the variants
              const corner = e.clientX > b.right - 11 && e.clientY > b.bottom - 11;
              if (multi && (corner || on)) { variants(gi, el); return; }
              lastUsed.set(gi, active);
              editor.setTool(active);
            }}
            onContextMenu={e => { if (multi) { e.preventDefault(); variants(gi, e.currentTarget as HTMLElement); } }}>
            <def.Icon />
            {multi && <span class="tool-corner" aria-hidden="true" />}
          </button>
        );
      })}
      {props.children && <span class="toolbar-sep" aria-hidden="true" />}
      {props.children}
    </div>
  );
}
