// left panel: the agent (conversation + composer card), with the library (colors and numbers)
// and the components one tab away, and a collapse button. layers live in the timeline and
// compositions in the top bar's switcher: this panel is no file browser.

import { AgentPanel } from '../AgentPanel';
import { ComponentsSection, StylesSection } from '../LibraryPanel';
import { useChannels } from '../hooks';
import { Button } from '../ui';
import { Component, Hexagon, PanelLeftClose, Sparkles, type LucideIcon } from './icons';
import { setUi, ui, type LeftTab } from './ui-state';

const TABS: { id: LeftTab; label: string; Icon: LucideIcon; tip: string }[] = [
  { id: 'agent', label: 'Agent', Icon: Sparkles, tip: 'Agent (⌘I)' },
  { id: 'components', label: 'Components', Icon: Component, tip: 'Components' },
  { id: 'library', label: 'Library', Icon: Hexagon, tip: 'Colors and numbers (styles and variables)' },
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
        <Button variant="ghost" icon size="sm" class="lp-collapse" tip="Hide panel (⌘I)" onClick={() => setUi({ leftOpen: false })}><PanelLeftClose /></Button>
      </div>
      <AgentPanel chat={tab === 'agent'} onSent={() => setUi({ leftTab: 'agent' })}>
        {tab === 'components' && <div class="lp-scroll"><ComponentsTab /></div>}
        {tab === 'library' && <div class="lp-scroll"><LibraryTab /></div>}
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
