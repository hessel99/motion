// window chrome state: Home or the editor, the left panel's tab (agent / assets) and whether it is
// collapsed, the timeline's height, Settings (a modal) and its open section. persisted per machine
// (except the view and the modal). listeners: editor channel 'ui' (useChannels([], ['ui'])).

import { editor } from '../../app/editor';
import { activeDoc } from '../../app/documents';

export type LeftTab = 'agent' | 'assets';
export type SettingsSection =
  | 'profile' | 'appearance' | 'notifications' | 'shortcuts'
  | 'models' | 'runs' | 'connections'
  | 'members' | 'fonts'
  | 'updates' | 'figma';

const KEY = 'motion.ui';
interface UiState {
  /** the Home view (start screen) covers the editor */
  view: 'editor' | 'home';
  settingsOpen: boolean;
  leftTab: LeftTab;
  leftOpen: boolean;
  section: SettingsSection;
  /** timeline height in css px (the splitter on its top edge); 0 = default */
  tlH: number;
  /** full-screen preview: only the canvas (not persisted) */
  previewing: boolean;
}

export const TL_MIN = 160;
/** the timeline may grow until the canvas keeps this much height */
export const STAGE_MIN = 200;

function load(): UiState {
  const d: UiState = { view: 'editor', settingsOpen: false, leftTab: 'agent', leftOpen: true, section: 'appearance', tlH: 0, previewing: false };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (localStorage.getItem('motion.agentOpen') === '0' && s.leftOpen === undefined) d.leftOpen = false;
    const out: UiState = { ...d, ...s, view: 'editor', settingsOpen: false, previewing: false };
    // older tabs (library, components) live in Assets now
    if (!['agent', 'assets'].includes(out.leftTab)) out.leftTab = out.leftTab ? 'assets' : 'agent';
    if (typeof out.tlH !== 'number' || !isFinite(out.tlH)) out.tlH = 0;
    return out;
  } catch { return d; }
}

export const ui: UiState = load();

export function setUi(patch: Partial<UiState>) {
  Object.assign(ui, patch);
  // the Home view turns editor shortcuts off (src/app/actions.ts reads this)
  if (typeof document !== 'undefined') document.documentElement.dataset.view = ui.view;
  try {
    const { view: _v, settingsOpen: _s, previewing: _p, ...rest } = ui;
    localStorage.setItem(KEY, JSON.stringify(rest));
    localStorage.setItem('motion.agentOpen', ui.leftOpen ? '1' : '0');
  } catch { /* private mode */ }
  editor.emit('ui');
}

export function openSettings(section?: SettingsSection) { setUi({ settingsOpen: true, ...(section ? { section } : {}) }); }
export function closeSettings() { setUi({ settingsOpen: false }); }
export function showEditor() { if (activeDoc()) setUi({ view: 'editor' }); }
export function showHome() { setUi({ view: 'home' }); }
/** open the left panel on a tab */
export function openLeft(tab: LeftTab) { setUi({ leftOpen: true, leftTab: tab }); }
/** ⌘I: show the agent (or collapse the panel when the agent is already showing) */
export function toggleAgent() {
  if (ui.leftOpen && ui.leftTab === 'agent') setUi({ leftOpen: false });
  else openLeft('agent');
  requestAnimationFrame(() => (document.querySelector('.agent-input textarea') as HTMLTextAreaElement | null)?.focus());
}

// a document opened or came to the front: show the editor. the last tab closed: Home
editor.on('doc-open', () => { if (ui.view !== 'editor') setUi({ view: 'editor' }); });
editor.on('home', () => setUi({ view: 'home' }));
// an ask from anywhere (Home brief, ⌘K, menus) shows the agent at work
editor.on('agent-ask', () => setUi({ leftOpen: true, leftTab: 'agent', ...(activeDoc() ? { view: 'editor' as const } : {}) }));
