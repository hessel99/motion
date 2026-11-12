// the Assets tab of the left panel: what the file is made of. compositions (open one as a timeline
// tab, rename, use as a layer), components, colors and numbers (styles), and imported files
// (images, audio) with their use counts. rows are soft pills; counts sit right-aligned in grey.

import { useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { toast } from '../../app/actions';
import { addPrecompLayer, newComposition, ownerRoot, renameComp } from '../../core/commands';
import { useChannels } from '../hooks';
import { showContextMenu } from '../menu';
import { ComponentsSection, StylesSection } from '../LibraryPanel';
import { Button, Section } from '../ui';
import { AudioLines, Clapperboard, Image, Plus } from './icons';

export function Assets() {
  useChannels(['doc', 'comps', 'components', 'tokens', 'selection']);
  return (
    <div class="assets library">
      <Compositions />
      <ComponentsSection />
      <StylesSection />
      <Files />
    </div>
  );
}

function Compositions() {
  const s = editor.store;
  const comps = Object.values(s.project.comps);
  const [renaming, setRenaming] = useState<string | null>(null);
  const commit = (id: string, v: string) => { setRenaming(null); const n = v.trim(); if (n) renameComp(s, id, n); };
  const add = () => { const c = newComposition(s, { width: s.comp.width, height: s.comp.height, fps: s.comp.fps }); s.openComp(c.id); };
  const menu = (e: MouseEvent, id: string) => {
    e.preventDefault();
    const active = id === s.comp.id;
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Open', action: () => s.openComp(id) },
      { label: 'Rename', action: () => setRenaming(id) },
      { label: `Add to ${s.comp.name} as a layer`, disabled: active, action: () => { try { addPrecompLayer(s, id); } catch (err: any) { toast(err.message, 'error'); } } },
    ]);
  };
  return (
    <Section title="Compositions" right={<Button variant="ghost" icon size="sm" tip="New composition" onClick={add}><Plus size={14} /></Button>}>
      {comps.map(c => {
        const on = c.id === s.comp.id;
        return (
          <div class={'list-row' + (on ? ' on' : '')} role="button" tabIndex={0} title={`Open ${c.name} (double-click to rename, right-click for more)`}
            onClick={() => s.openComp(c.id)} onDblClick={() => setRenaming(c.id)} onContextMenu={e => menu(e as any, c.id)}
            onKeyDown={e => { if (e.key === 'Enter') s.openComp(c.id); }}>
            <Clapperboard class="list-icon" size={14} />
            {renaming === c.id
              ? <input class="list-rename" aria-label="Composition name" defaultValue={c.name} spellcheck={false} ref={el => { if (el) requestAnimationFrame(() => { if (document.activeElement !== el) { el.focus(); el.select(); } }); }}
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commit(c.id, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(null); }}
                  onBlur={e => commit(c.id, (e.target as HTMLInputElement).value)} />
              : <span class="list-name">{c.name}</span>}
            <span class="list-count">{c.width}×{c.height}</span>
          </div>
        );
      })}
    </Section>
  );
}

function Files() {
  const s = editor.store;
  const assets = Object.values(s.project.assets);
  if (!assets.length) return (
    <Section title="Files">
      <p class="lib-hint muted">Images and audio you drop on the canvas or open show up here.</p>
    </Section>
  );
  const users = (id: string) => Object.values(s.project.layers).filter(l => l.imageRef === id);
  return (
    <Section title="Files">
      {assets.map((a, i) => {
        const u = users(a.id);
        const inComp = u.filter(l => { let top = l; while (top.parent && s.layer(top.parent)) top = s.layer(top.parent)!; return ownerRoot(s, top.id)?.comp.id === s.comp.id; }).map(l => l.id);
        return (
          <div class="list-row" role="button" tabIndex={0} title={u.length ? 'Select the layers that use it' : 'Not used by any layer'}
            onClick={() => { if (inComp.length) s.select(inComp); }} onKeyDown={e => { if (e.key === 'Enter' && inComp.length) s.select(inComp); }}>
            {a.kind === 'audio' ? <AudioLines class="list-icon" size={14} /> : <Image class="list-icon" size={14} />}
            <span class="list-name">{a.kind === 'audio' ? 'Audio' : 'Image'} {i + 1}{a.kind === 'image' && a.width ? <span class="muted"> · {a.width}×{a.height}</span> : null}</span>
            <span class="list-count">{u.length}</span>
          </div>
        );
      })}
    </Section>
  );
}
