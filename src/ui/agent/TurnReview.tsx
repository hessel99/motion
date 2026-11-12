import type { ComponentChildren } from 'preact';
// review card shown after every agent turn that changed the document: what changed (click a layer
// to select it), hold-to-compare with the state before the turn, replay, keep or revert.
import { useEffect, useRef, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import { reviewAtEnd, type ReviewInfo } from '../../agent/history';
import { summarizeDiff, type LayerChange } from '../../agent/diff';
import { Check, ChevronDown, ChevronRight, Play, Sparkles, Undo2, Eye } from '../chrome/icons';

export function TurnReview(props: { review: ReviewInfo; busy?: boolean; onState: (s: ReviewInfo['state'], note?: string) => void; /** the turn's steps, shown with the details */ children?: ComponentChildren }) {
  const r = props.review;
  const s = editor.store;
  const live = r.state === 'pending' || r.state === 'kept';
  const atEnd = reviewAtEnd(r, s.topEntryId);
  // no compare / revert while another turn runs: its next edit would clear the redo stack
  const canCompare = live && atEnd && !props.busy;
  const canRevert = r.state === 'pending' && atEnd && !props.busy; // Keep is final
  const [comparing, setComparing] = useState(false);
  const cmp = useRef(false); // synchronous mirror of `comparing` (events can arrive before a re-render)
  const self = useRef(false); // our own undo/redo is running: its 'history' events are not foreign
  const [open, setOpen] = useState(r.diff.added.length + r.diff.changed.length + r.diff.removed.length <= 6);

  const startCompare = () => {
    if (!canCompare || cmp.current) return;
    editor.pause();
    self.current = true;
    try { s.undoToEntry(r.startId ?? 0); } finally { self.current = false; }
    cmp.current = true;
    setComparing(true);
  };
  /** back to the turn's end state. if something else changed history meanwhile (an edit cleared
   *  the redo stack), redoToEntry does nothing and the document stays as it is now */
  const endCompare = () => {
    if (!cmp.current) return;
    cmp.current = false;
    self.current = true;
    try { if (r.endId !== undefined) s.redoToEntry(r.endId); } finally { self.current = false; }
    setComparing(false);
  };
  const endRef = useRef(endCompare);
  endRef.current = endCompare;
  // while comparing: any foreign history change (⌘Z, an agent edit), losing window focus or a
  // new turn ends the compare, so the document is never left in the "before" state
  useEffect(() => {
    if (!comparing) return;
    const end = () => endRef.current();
    const offH = s.on('history', () => { if (!self.current) end(); });
    window.addEventListener('blur', end);
    return () => { offH(); window.removeEventListener('blur', end); };
  }, [comparing]);
  useEffect(() => { if (props.busy) endRef.current(); }, [props.busy]);
  useEffect(() => () => endRef.current(), []);
  const replay = () => {
    const [a] = r.range ?? [0, 0];
    s.setTime(Math.max(0, a - 0.1));
    editor.play();
  };

  const row = (c: LayerChange, kind: '+' | '~' | '−') => (
    <div class={'ag-diff-row ' + (kind === '+' ? 'add' : kind === '−' ? 'del' : 'chg')}>
      <span class="ag-diff-sign">{kind}</span>
      {kind === '−' ? <span class="ag-diff-name">{c.name}</span> : (
        <button class="ag-link ag-diff-name" title="Select this layer" onClick={() => s.layer(c.id) && s.select([c.id])}>{c.name}</button>
      )}
      <span class="ag-diff-fields">{c.fields.join(', ')}</span>
    </div>
  );
  const total = r.diff.added.length + r.diff.changed.length + r.diff.removed.length;

  return (
    <div class={'ag-review ' + r.state + (comparing ? ' comparing' : '')} data-testid="turn-review">
      <div class="ag-review-head">
        <span class="ag-review-icon">{r.state === 'reverted' ? <Undo2 size={14} /> : r.state === 'kept' ? <Check size={14} /> : <Sparkles size={14} />}</span>
        <span class="ag-grow">
          {r.state === 'reverted' ? 'Reverted: ' : ''}{summarizeDiff(r.diff)}
          <span class="ag-muted"> · {r.steps} step{r.steps === 1 ? '' : 's'}</span>
        </span>
        {(total > 0 || props.children) && <button class="ag-icon-btn" title={open ? 'Hide details' : 'Show details'} aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>}
      </div>
      {open && total > 0 && (
        <div class="ag-diff">
          {r.diff.added.map(c => row(c, '+'))}
          {r.diff.changed.map(c => row(c, '~'))}
          {r.diff.removed.map(c => row(c, '−'))}
          {r.diff.comp.length > 0 && <div class="ag-diff-row chg"><span class="ag-diff-sign">~</span><span class="ag-diff-name">Composition</span><span class="ag-diff-fields">{r.diff.comp.join(', ')}</span></div>}
        </div>
      )}
      {open && props.children}
      {live && (
        <div class="ag-review-actions">
          <button
            class={'ag-btn ag-icon-only' + (comparing ? ' on' : '')}
            disabled={!canCompare && !comparing}
            aria-label="Hold to compare with before"
            title="Hold to see the document as it was before this turn"
            onPointerDown={e => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); startCompare(); }}
            onPointerUp={endCompare}
            onPointerCancel={endCompare}
            onLostPointerCapture={endCompare}
            onBlur={endCompare}
            onKeyDown={e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startCompare(); } }}
            onKeyUp={e => { if (e.key === ' ' || e.key === 'Enter') endCompare(); }}
          ><Eye size={13} /></button>
          {r.range && <button class="ag-btn ag-icon-only" aria-label="Replay" title="Play the changed part" onClick={replay}><Play size={12} /></button>}
          <span class="ag-grow" />
          <button
            class="ag-btn danger"
            disabled={!canRevert}
            title={canRevert ? 'Undo everything the agent did in this turn' : r.state === 'kept' ? 'Kept: use Undo (⌘Z) to go back' : props.busy ? 'The agent is working' : 'You made changes after this turn; use Undo (⌘Z) instead'}
            onClick={() => { if (!canRevert) return; const n = s.undoToEntry(r.startId ?? 0); props.onState('reverted', `reverted ${n} change${n === 1 ? '' : 's'}`); }}
          >Revert</button>
          {r.state === 'pending' && <button class="ag-btn primary" onClick={() => props.onState('kept')}>Keep</button>}
        </div>
      )}
      {r.state === 'stale' && <div class="ag-muted ag-small">From an earlier session: use Undo history to revert.</div>}
    </div>
  );
}
