// stage layout chrome: the timeline drawer's handle bar and the agent pill. the panels themselves
// (viewport, inspector card, timeline drawer, agent card) are the app's mounted panels.
import { editor } from '../../app/editor';
import { useChannels } from '../hooks';
import { Kbd } from '../ui';
import { summon, toggleSummon } from './layout';

export function StageChrome(props: { agentOpen: boolean; openAgent: () => void }) {
  useChannels(['selection', 'doc'], ['layout']);
  const s = editor.store;
  const sel = s.selection.map(id => s.layer(id)?.name).filter(Boolean) as string[];
  const full = summon.timeline;
  const what = full || sel.length === 0 ? 'All layers' : sel.length === 1 ? sel[0] : `${sel.length} layers`;
  return (
    <>
      <div class="stage-drawer-bar" role="toolbar" aria-label="Timeline drawer">
        <button type="button" class="stage-drawer-grip" aria-expanded={full} title={full ? 'Back to the selection (`)' : 'Show every layer (`)'} onClick={() => toggleSummon('timeline')}>
          <span class="stage-grip-line" />
        </button>
        <span class="stage-drawer-what"><span class="muted">Timing ·</span> {what}{!full && sel.length > 0 && <span class="muted"> — the drawer follows the selection</span>}</span>
        <span class="grow" />
        <button type="button" class="ghost btn-sm" aria-expanded={full} onClick={() => toggleSummon('timeline')}>
          {full ? '▾ Follow selection' : '▴ Full timeline'} <Kbd>`</Kbd>
        </button>
      </div>
      {!props.agentOpen && (
        <button type="button" class="stage-agent-pill" title="AI agent (⌘I)" onClick={props.openAgent}>
          <span class="stage-agent-spark">✦</span> Ask Motion…
        </button>
      )}
    </>
  );
}
