// left card: soft segmented tabs (Agent | Assets). the agent's conversation is the hero; Assets
// holds what the file is made of (compositions, components, colors and numbers, imported files).
// layers live in the timeline, so there is no layer tree here. the composer stays at the bottom
// on both tabs (AgentPanel renders it).

import { AgentPanel } from '../AgentPanel';
import { useChannels } from '../hooks';
import { Segmented } from '../ui';
import { Assets } from './Assets';
import { setUi, ui, type LeftTab } from './ui-state';

export function LeftPanel() {
  useChannels([], ['ui']);
  const tab = ui.leftTab;
  return (
    <div class={'left-panel lp-' + tab}>
      <div class="lp-head">
        <Segmented<LeftTab> class="lp-tabs" label="Side panel" value={tab}
          options={[{ value: 'agent', label: 'Agent', title: 'Agent (⌘I)' }, { value: 'assets', label: 'Assets', title: 'Compositions, components, styles, files' }]}
          onChange={v => setUi({ leftTab: v })} />
      </div>
      <AgentPanel chat={tab === 'agent'} onSent={() => setUi({ leftTab: 'agent' })}>
        {tab === 'assets' && <div class="lp-scroll"><Assets /></div>}
      </AgentPanel>
    </div>
  );
}
