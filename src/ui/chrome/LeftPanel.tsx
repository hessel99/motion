// left sidebar: the agent or the assets (the rail picks which; clicking the active icon collapses it). the agent's conversation is the hero; Assets
// holds what the file is made of (compositions, components, colors and numbers, imported files).
// layers live in the timeline, so there is no layer tree here. the composer stays at the bottom
// on both tabs (AgentPanel renders it).

import { AgentPanel } from '../AgentPanel';
import { useChannels } from '../hooks';
import { Assets } from './Assets';
import { setUi, ui } from './ui-state';

export function LeftPanel() {
  useChannels([], ['ui']);
  const tab = ui.leftTab;
  return (
    <div class={'left-panel lp-' + tab}>
      <div class="lp-head">
        <h2 class="lp-title">{tab === 'agent' ? 'Agent' : 'Assets'}</h2>
      </div>
      <AgentPanel chat={tab === 'agent'} onSent={() => setUi({ leftTab: 'agent' })}>
        {tab === 'assets' && <div class="lp-scroll"><Assets /></div>}
      </AgentPanel>
    </div>
  );
}
