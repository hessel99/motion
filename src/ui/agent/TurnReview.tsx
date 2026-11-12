// review card shown after every agent turn that changed the document: what changed (click a layer
// to select it), hold-to-compare with the state before the turn, replay, keep or revert.
import { useRef, useState } from 'preact/hooks';
import { editor } from '../../app/editor';
import type { ReviewInfo } from '../../agent/history';
import { summarizeDiff, type LayerChange } from '../../agent/diff';

export function TurnReview(props: { review: ReviewInfo; onState: (s: ReviewInfo['state'], note?: string) => void }) {
  const r = props.review;
  const s = editor.store;
  const live = r.state === 'pending' || r.state === 'kept';
  const atEnd = s.historyLength === r.endMarker;
  const canAct = live && atEnd;
  const [comparing, setComparing] = useState(false);
  const undone = useRef(0);
  const [open, setOpen] = useState(r.diff.added.length + r.diff.changed.length + r.diff.removed.length <= 6);

  const startCompare = () => {
    if (!canAct || comparing) return;
    editor.pause();
    undone.current = s.undoTo(r.marker);
    setComparing(true);
  };
  const endCompare = () => {
    if (!comparing) return;
    for (let i = 0; i < undone.current; i++) s.redo();
    undone.current = 0;
    setComparing(false);
  };
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
        <span class="ag-review-icon">{r.state === 'reverted' ? '↶' : r.state === 'kept' ? '✓' : '◆'}</span>
        <span class="ag-grow">
          {r.state === 'reverted' ? 'Reverted: ' : ''}{summarizeDiff(r.diff)}
          <span class="ag-muted"> · {r.steps} step{r.steps === 1 ? '' : 's'}</span>
        </span>
        {total > 0 && <button class="ag-icon-btn" title={open ? 'Hide details' : 'Show details'} onClick={() => setOpen(o => !o)}>{open ? '▾' : '▸'}</button>}
      </div>
      {open && total > 0 && (
        <div class="ag-diff">
          {r.diff.added.map(c => row(c, '+'))}
          {r.diff.changed.map(c => row(c, '~'))}
          {r.diff.removed.map(c => row(c, '−'))}
          {r.diff.comp.length > 0 && <div class="ag-diff-row chg"><span class="ag-diff-sign">~</span><span class="ag-diff-name">Composition</span><span class="ag-diff-fields">{r.diff.comp.join(', ')}</span></div>}
        </div>
      )}
      {live && (
        <div class="ag-review-actions">
          <button
            class={'ag-btn' + (comparing ? ' on' : '')}
            disabled={!canAct && !comparing}
            title="Hold to see the document as it was before this turn"
            onPointerDown={e => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); startCompare(); }}
            onPointerUp={endCompare}
            onPointerCancel={endCompare}
            onLostPointerCapture={endCompare}
            onKeyDown={e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startCompare(); } }}
            onKeyUp={e => { if (e.key === ' ' || e.key === 'Enter') endCompare(); }}
          >{comparing ? 'Showing before' : 'Hold to compare'}</button>
          {r.range && <button class="ag-btn" title="Play the changed part" onClick={replay}>▶ Replay</button>}
          <span class="ag-grow" />
          <button
            class="ag-btn danger"
            disabled={!canAct}
            title={canAct ? 'Undo everything the agent did in this turn' : 'You made changes after this turn; use Undo (⌘Z) instead'}
            onClick={() => { const n = s.undoTo(r.marker); props.onState('reverted', `reverted ${n} change${n === 1 ? '' : 's'}`); }}
          >Revert</button>
          {r.state === 'pending' && <button class="ag-btn primary" onClick={() => props.onState('kept')}>Keep</button>}
        </div>
      )}
      {r.state === 'stale' && <div class="ag-muted ag-small">From an earlier session: use Undo history to revert.</div>}
    </div>
  );
}
