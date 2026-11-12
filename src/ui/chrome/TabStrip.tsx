// window tab strip: home (app menu), the open document, Settings (when open), "+".
// in the mac desktop app the window has no title bar (electron/main.cjs: hiddenInset): the
// traffic lights sit at the strip's left and the empty strip drags the window.

import { useRef, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { confirmDiscard, isDirty, newProject } from '../../app/actions';
import { setProjectName } from '../../core/commands';
import { useChannels } from '../hooks';
import { File, House, Plus, Settings, X } from './icons';
import { closeSettings, openSettings, showEditor, ui } from './ui-state';

const native = (globalThis as any).motionNative as { platform?: string } | undefined;
const MAC_APP = native?.platform === 'darwin';

export function TabStrip(props: { appMenu: (x: number, y: number) => void }) {
  useChannels(['doc', 'history'], ['ui']);
  const s = editor.store;
  const [renaming, setRenaming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const editorOn = ui.view === 'editor';
  const commit = (v: string) => { setRenaming(false); const n = v.trim(); if (n && n !== s.project.name) setProjectName(s, n); };
  const tabKey = (e: KeyboardEvent, fn: () => void) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
  return (
    <header class={'tabstrip' + (MAC_APP ? ' mac-app' : '')}>
      {MAC_APP && <div class="ts-traffic" aria-hidden="true" />}
      <button type="button" class="ts-home" aria-label="Menu" aria-haspopup="menu" title="Menu"
        onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); props.appMenu(r.left, r.bottom + 4); }}>
        <House />
      </button>
      <div class="ts-tabs" role="tablist" aria-label="Open documents">
        <div role="tab" tabIndex={0} aria-selected={editorOn} class={'ts-tab' + (editorOn ? ' on' : '')}
          title={`${s.project.name} (double-click to rename)`}
          onClick={showEditor} onKeyDown={e => tabKey(e, showEditor)} onDblClick={() => { setRenaming(true); requestAnimationFrame(() => input.current?.select()); }}>
          <File class="ts-icon" />
          {renaming
            ? <input ref={input} class="ts-rename" aria-label="Project name" defaultValue={s.project.name} spellcheck={false}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(false); }}
                onBlur={e => commit((e.target as HTMLInputElement).value)} />
            : <span class="ts-name">{s.project.name}</span>}
          {isDirty() && <span class="ts-dirty" title="Unsaved changes" aria-label="Unsaved changes" />}
        </div>
        {ui.settingsOpen && (
          <div role="tab" tabIndex={0} aria-selected={!editorOn} class={'ts-tab ts-settings' + (!editorOn ? ' on' : '')}
            onClick={() => openSettings()} onKeyDown={e => tabKey(e, () => openSettings())}>
            <Settings class="ts-icon" />
            <span class="ts-name">Settings</span>
            <button type="button" class="ts-close" aria-label="Close Settings" title="Close"
              onClick={e => { e.stopPropagation(); closeSettings(); }}><X size={14} /></button>
          </div>
        )}
        <button type="button" class="ts-add" aria-label="New file" title="New file"
          onClick={() => { if (confirmDiscard()) { newProject(); showEditor(); } }}><Plus /></button>
      </div>
      <div class="ts-drag" />
    </header>
  );
}
