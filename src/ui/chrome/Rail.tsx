// the slim icon rail at the far left: Home, new file, ask (⌘K), the side panel's two views (Agent,
// Assets: clicking the active one collapses the sidebar), updates, and Settings at the bottom.
// in the mac desktop app the traffic lights sit above it (it starts lower).

import { useEffect, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { newProject } from '../../app/actions';
import { getUpdateStatus, onUpdateStatus, updatesAvailable } from '../../app/updates';
import { useChannels } from '../hooks';
import { Bell, House, Plus, Search, Settings, Shapes, Sparkles, type LucideIcon } from './icons';
import { openSettings, setUi, showHome, ui, type LeftTab } from './ui-state';

const native = (globalThis as any).motionNative as { platform?: string } | undefined;
const MAC_APP = native?.platform === 'darwin';

function RailBtn(props: { Icon: LucideIcon; tip: string; on?: boolean; dot?: boolean; onClick: () => void; label?: string }) {
  return (
    <button type="button" class={'rail-btn' + (props.on ? ' on' : '')} aria-label={props.label ?? props.tip} aria-pressed={props.on}
      data-tooltip={props.tip} data-tooltip-side="right" onClick={props.onClick}>
      <props.Icon size={18} />
      {props.dot && <span class="rail-dot" aria-hidden="true" />}
    </button>
  );
}

export function Rail() {
  useChannels([], ['ui']);
  const [upd, setUpd] = useState(getUpdateStatus());
  useEffect(() => onUpdateStatus(setUpd), []);
  const home = ui.view === 'home';
  const panel = (tab: LeftTab) => {
    if (ui.leftOpen && ui.leftTab === tab && !home) setUi({ leftOpen: false });
    else setUi({ leftOpen: true, leftTab: tab, ...(home && !!document.querySelector('.tb-tab') ? { view: 'editor' as const } : {}) });
  };
  const sideOn = (tab: LeftTab) => ui.leftOpen && ui.leftTab === tab && !home;
  return (
    <nav class={'rail' + (MAC_APP ? ' mac-app' : '')} aria-label="App">
      <RailBtn Icon={House} tip="Home" on={home} onClick={showHome} />
      <RailBtn Icon={Plus} tip="New file (⌘N)" onClick={() => newProject()} />
      <RailBtn Icon={Search} tip="Ask or run a command (⌘K)" onClick={() => editor.emit('ask-bar')} />
      <span class="rail-sep" aria-hidden="true" />
      <RailBtn Icon={Sparkles} tip="Agent (⌘I)" on={sideOn('agent')} onClick={() => panel('agent')} />
      <RailBtn Icon={Shapes} tip="Assets: compositions, components, styles, files" label="Assets" on={sideOn('assets')} onClick={() => panel('assets')} />
      <span class="grow" />
      {updatesAvailable() && <RailBtn Icon={Bell} tip={upd?.ready ? `Update ${upd.ready.version} is ready` : 'Updates'} dot={!!upd?.ready || !!upd?.notice} onClick={() => openSettings('updates')} />}
      <RailBtn Icon={Settings} tip="Settings (⌘,)" onClick={() => openSettings()} />
    </nav>
  );
}
