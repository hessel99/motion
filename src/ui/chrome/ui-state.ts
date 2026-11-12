// window chrome state: which tab of the tab strip is open (the document or Settings), the left
// panel's tab (agent, library, components) and whether it is collapsed, the timeline's height,
// the open Settings section. persisted per machine.
// listeners: editor channel 'ui' (useChannels([], ['ui'])).

import { editor } from '../../app/editor';

export type LeftTab = 'agent' | 'library' | 'components';
export type SettingsSection =
  | 'profile' | 'appearance' | 'notifications' | 'shortcuts'
  | 'models' | 'runs' | 'connections'
  | 'members' | 'fonts'
  | 'updates' | 'figma';

const KEY = 'motion.ui';
interface UiState { view: 'editor' | 'settings'; settingsOpen: boolean; leftTab: LeftTab; leftOpen: boolean; section: SettingsSection; /** timeline height in css px (the transport's splitter) */ tlH: number }

export const TL_MIN = 160;
/** the timeline may grow until the canvas keeps this much height */
export const STAGE_MIN = 200;

function load(): UiState {
  const d: UiState = { view: 'editor', settingsOpen: false, leftTab: 'agent', leftOpen: true, section: 'appearance', tlH: 0 };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    // the old "agent sidebar closed" flag maps to a collapsed left panel
    if (localStorage.getItem('motion.agentOpen') === '0' && s.leftOpen === undefined) d.leftOpen = false;
    if (localStorage.getItem('motion.rightTab') === 'library' && !s.leftTab) d.leftTab = 'library';
    const out: UiState = { ...d, ...s, view: 'editor' };
    // the layers tree and the comments stub left the left panel (layers live in the timeline)
    if (!['agent', 'library', 'components'].includes(out.leftTab)) out.leftTab = 'agent';
    if (typeof out.tlH !== 'number' || !isFinite(out.tlH)) out.tlH = 0;
    return out;
  } catch { return d; }
}

export const ui: UiState = load();

export function setUi(patch: Partial<UiState>) {
  Object.assign(ui, patch);
  try {
    const { view: _v, ...rest } = ui;
    localStorage.setItem(KEY, JSON.stringify(rest));
    localStorage.setItem('motion.agentOpen', ui.leftOpen ? '1' : '0');
  } catch { /* private mode */ }
  editor.emit('ui');
}

export function openSettings(section?: SettingsSection) { setUi({ view: 'settings', settingsOpen: true, ...(section ? { section } : {}) }); }
export function closeSettings() { setUi({ view: 'editor', settingsOpen: false }); }
export function showEditor() { setUi({ view: 'editor' }); }
/** open the left panel on a tab */
export function openLeft(tab: LeftTab) { setUi({ view: 'editor', leftOpen: true, leftTab: tab }); }
/** ⌘I: show the agent (or collapse the panel when the agent is already showing) */
export function toggleAgent() {
  if (ui.view === 'editor' && ui.leftOpen && ui.leftTab === 'agent') setUi({ leftOpen: false });
  else openLeft('agent');
  requestAnimationFrame(() => (document.querySelector('.agent-input textarea') as HTMLTextAreaElement | null)?.focus());
}
