// floating tool pill at the bottom of the canvas. tools with variants (move / hand, the shape
// family) show a small corner mark: click the active tool again, right-click it, or click the
// corner to pick a variant. "+" inserts, the sliders icon holds the canvas view options.

import { useState } from 'preact/hooks';
import { editor, type Tool } from '../../app/editor';
import { addPrecompLayer, newComposition } from '../../core/commands';
import { confirmDiscard, loadDemo, openFileDialog, toast } from '../../app/actions';
import { prefs, setPref } from '../../app/prefs';
import { useChannels } from '../hooks';
import { showContextMenu, type MenuItem } from '../menu';
import { Circle, Hand, MousePointer2, PenTool, Pentagon, Plus, SlidersHorizontal, Square, Star, Type, type LucideIcon } from './icons';
import { view } from './view';

interface ToolDef { id: Tool; label: string; key: string; Icon: LucideIcon }
const T: Record<string, ToolDef> = {
  select: { id: 'select', label: 'Move', key: 'V', Icon: MousePointer2 },
  hand: { id: 'hand', label: 'Hand', key: 'H', Icon: Hand },
  rect: { id: 'rect', label: 'Rectangle', key: 'R', Icon: Square },
  ellipse: { id: 'ellipse', label: 'Ellipse', key: 'O', Icon: Circle },
  polygon: { id: 'polygon', label: 'Polygon', key: '', Icon: Pentagon },
  star: { id: 'star', label: 'Star', key: '', Icon: Star },
  pen: { id: 'pen', label: 'Pen', key: 'P', Icon: PenTool },
  text: { id: 'text', label: 'Text', key: 'T', Icon: Type },
};
/** button slots: a group shows its last used member */
const GROUPS: Tool[][] = [['select', 'hand'], ['rect', 'ellipse', 'polygon', 'star'], ['pen'], ['text']];

const lastUsed = new Map<number, Tool>();

export function Toolbar() {
  useChannels([], ['tool', 'prefs']);
  const [, force] = useState(0);
  const cur = editor.tool;
  const variants = (gi: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const items: MenuItem[] = GROUPS[gi].map(id => ({ label: T[id].label, shortcut: T[id].key, checked: cur === id, action: () => { lastUsed.set(gi, id); editor.setTool(id); force(x => x + 1); } }));
    openAbove(r, items);
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
          <button type="button" class={'tool' + (on ? ' on' : '')} aria-pressed={on} aria-label={def.label} data-tooltip={tip} data-tooltip-side="top"
            aria-haspopup={multi ? 'menu' : undefined}
            onClick={e => {
              const el = e.currentTarget as HTMLElement;
              const b = el.getBoundingClientRect();
              // the corner mark (or a second click on the active tool) opens the variants
              const corner = e.clientX > b.right - 11 && e.clientY > b.bottom - 11;
              if (multi && (corner || on)) { variants(gi, el); return; }
              lastUsed.set(gi, active);
              editor.setTool(active);
            }}
            onContextMenu={e => { if (multi) { e.preventDefault(); variants(gi, e.currentTarget as HTMLElement); } }}>
            <def.Icon size={18} />
            {multi && <span class="tool-corner" aria-hidden="true" />}
          </button>
        );
      })}
      <span class="toolbar-sep" aria-hidden="true" />
      <button type="button" class="tool" aria-label="Insert" aria-haspopup="menu" data-tooltip="Insert" data-tooltip-side="top" onClick={e => insertMenu(e.currentTarget as HTMLElement)}>
        <Plus size={18} /><span class="tool-corner" aria-hidden="true" />
      </button>
      <button type="button" class="tool" aria-label="View options" aria-haspopup="menu" data-tooltip="View options" data-tooltip-side="top" onClick={e => viewMenu(e.currentTarget as HTMLElement)}>
        <SlidersHorizontal size={18} />
      </button>
    </div>
  );
}

function openAbove(r: DOMRect, items: MenuItem[]) {
  showContextMenu(r.left, r.top, items);
  const m = document.querySelector('.ctx-menu') as HTMLElement | null;
  if (m) m.style.top = Math.max(4, r.top - m.offsetHeight - 8) + 'px';
}

function insertMenu(el: HTMLElement) {
  const s = editor.store;
  const comps = Object.values(s.project.comps).filter(c => c.id !== s.comp.id);
  openAbove(el.getBoundingClientRect(), [
    { label: 'Image, SVG, Lottie or After Effects file…', shortcut: '⌘O', action: openFileDialog },
    { label: 'New composition', action: () => { const c = newComposition(s); s.openComp(c.id); } },
    { label: 'Composition as layer', disabled: !comps.length, submenu: comps.map(c => ({ label: c.name, action: () => { try { addPrecompLayer(s, c.id); } catch (err: any) { toast(err.message, 'error'); } } })) },
    { separator: true },
    { label: 'Demo animation', action: () => { if (confirmDiscard()) loadDemo(); } },
    { separator: true },
    { label: 'Save last Figma paste for debugging…', action: () => { import('../../app/figma-capture').then(m => m.saveLastFigmaPaste()).catch(err => toast(String(err), 'error')); } },
  ]);
}

function viewMenu(el: HTMLElement) {
  const vp = view.vp;
  const z = Math.round((vp?.zoom ?? 1) * 100);
  openAbove(el.getBoundingClientRect(), [
    { label: `Zoom to fit (${z}%)`, shortcut: '⌘0', action: () => vp?.fit() },
    { label: 'Zoom to 100%', action: () => vp?.setZoom(1) },
    { label: 'Zoom in', shortcut: '⌘+', action: () => vp?.setZoom(vp.zoom * 1.25) },
    { label: 'Zoom out', shortcut: '⌘−', action: () => vp?.setZoom(vp.zoom / 1.25) },
    { separator: true },
    { label: 'Pixel grid (400% and above)', checked: prefs.pixelGrid, action: () => setPref('pixelGrid', !prefs.pixelGrid) },
    { label: 'Snap to pixel grid', checked: prefs.snapToPixels, action: () => setPref('snapToPixels', !prefs.snapToPixels) },
    { label: 'Play at composition fps', checked: editor.snapPlaybackToFrames, action: () => { editor.snapPlaybackToFrames = !editor.snapPlaybackToFrames; toast(editor.snapPlaybackToFrames ? 'Playback snaps to composition frames' : 'Playback is smooth (every display frame)'); } },
    { label: 'Performance HUD', checked: editor.showHud, action: () => { editor.showHud = !editor.showHud; editor.emit('hud'); } },
  ]);
}
