// the agent on the canvas: the brief box on an empty composition, and the small suggestion after
// artwork or audio comes in ("Animate this" / "Sync to music"). both are opt-in: nothing runs
// until it is clicked, and both get out of the way (a tool other than select, ✕, any edit).

import { useEffect, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { lastImport } from '../../app/actions';
import { activeDoc } from '../../app/documents';
import { askAgent } from '../agent-bridge';
import { useChannels } from '../hooks';
import { PromptBox } from './PromptBox';
import { AudioLines, Sparkles, X } from './icons';

const dismissed = new Set<string>();

/** an empty composition shows the brief box instead of a blank grey area */
export function EmptyCanvas() {
  useChannels(['doc', 'comps', 'playing'], ['tool', 'docs', 'ui']);
  const s = editor.store;
  const d = activeDoc();
  const key = (d?.id ?? '') + ':' + s.comp.id;
  if (!d || s.comp.root.length || s.playing || (editor.tool !== 'select' && editor.tool !== 'hand') || dismissed.has(key)) return null;
  return (
    <div class="vp-empty">
      <div class="vp-empty-card">
        <PromptBox fresh={false} />
        <button type="button" class="link vp-empty-skip" onClick={() => { dismissed.add(key); editor.emit('docs'); }}>Start with a blank canvas</button>
      </div>
    </div>
  );
}

/** after a paste / drop / open of artwork or audio: one suggestion, until used, dismissed or ~20s */
export function ImportSuggestion() {
  const [imp, setImp] = useState<typeof lastImport>(null);
  useEffect(() => {
    let timer = 0;
    const off = editor.on('imported', () => {
      setImp(lastImport);
      clearTimeout(timer);
      timer = window.setTimeout(() => setImp(null), 20000);
    });
    const offDoc = editor.on('docs', () => setImp(null));
    return () => { off(); offDoc(); clearTimeout(timer); };
  }, []);
  if (!imp) return null;
  const audio = imp.kind === 'audio';
  const go = () => {
    const s = editor.store;
    if (imp.ids.every(id => s.layer(id))) s.select(imp.ids);
    askAgent(audio
      ? `Sync the animation to the music in "${imp.name}": find its beats and time the key moments to them.`
      : `Animate ${imp.name} that I just brought in: a clear entrance with good hierarchy and timing.`, { chip: audio ? 'Sync to music' : 'Animate this' });
    setImp(null);
  };
  return (
    <div class="vp-suggest vp-ui" role="status">
      {audio ? <AudioLines size={14} /> : <Sparkles size={14} />}
      <span class="vp-suggest-text">{audio ? 'Music added' : 'Artwork added'}</span>
      <button type="button" class="vp-suggest-go" onClick={go}>{audio ? 'Sync to music' : 'Animate this'}</button>
      <button type="button" class="vp-suggest-x" aria-label="Dismiss" onClick={() => setImp(null)}><X size={13} /></button>
    </div>
  );
}
