// the agent's storyboard (director workflow) as a card in the chat: while proposed, every beat is
// editable (name, time range, description, style notes; add / remove) and "Approve & build" sends
// the edited plan back to the agent. once approved it shows per-beat progress (update_progress).
import { useEffect, useState } from 'preact/hooks';
import type { Beat, Storyboard } from '../../agent/storyboard';
import { editor } from '../../app/editor';
import { Check, Circle, Clapperboard, LoaderCircle, Minus, Plus, X } from '../chrome/icons';

const fmt = (t: number) => `${Math.round(t * 10) / 10}s`;

export function StoryboardCard(props: { sb: Storyboard; busy: boolean; onApprove: (sb: Storyboard) => void }) {
  const { sb } = props;
  const editable = sb.state === 'proposed';
  const [draft, setDraft] = useState<Storyboard>(sb);
  const [dirty, setDirty] = useState(false);
  // the agent re-proposed / progress arrived: follow it unless the user is mid-edit
  useEffect(() => { if (!dirty || !editable) setDraft(sb); }, [sb]);
  const view = editable ? draft : sb;

  const setBeat = (i: number, patch: Partial<Beat>) => {
    setDirty(true);
    setDraft(d => ({ ...d, beats: d.beats.map((b, j) => (j === i ? { ...b, ...patch } : b)) }));
  };
  const addBeat = () => {
    setDirty(true);
    setDraft(d => {
      const last = d.beats[d.beats.length - 1];
      const start = last ? last.end : 0;
      return { ...d, beats: [...d.beats, { name: `Beat ${d.beats.length + 1}`, start, end: start + 2, description: '', status: 'todo' }] };
    });
  };
  const removeBeat = (i: number) => { setDirty(true); setDraft(d => ({ ...d, beats: d.beats.filter((_, j) => j !== i) })); };
  const valid = view.beats.length > 0 && view.beats.every(b => b.name.trim() && b.end > b.start && b.start >= 0);
  const approve = () => {
    const end = Math.max(...draft.beats.map(b => b.end));
    // edited beats define the length; untouched, the agent's total (which may include a rest) stands
    props.onApprove({ ...draft, duration: dirty ? end : Math.max(end, draft.duration ?? end), edited: dirty || undefined });
    setDirty(false);
  };
  const done = view.beats.filter(b => b.status === 'done' || b.status === 'skipped').length;
  const seek = (t: number) => { editor.pause(); editor.store.setTime(t); };

  return (
    <div class={'ag-sb ' + sb.state} data-testid="storyboard">
      <div class="ag-sb-head">
        <span class="ag-sb-icon"><Clapperboard size={14} /></span>
        <span class="ag-grow">
          <b>{view.title}</b>
          <span class="ag-muted"> · {fmt(view.duration ?? Math.max(...view.beats.map(b => b.end)))}{view.style ? ` · ${view.style}` : ''}</span>
        </span>
        <span class="ag-sb-state">{sb.state === 'proposed' ? 'Storyboard' : sb.state === 'done' ? 'Built' : `${done}/${view.beats.length} beats`}</span>
      </div>
      {view.styleReason && <div class="ag-muted ag-small">{view.styleReason}</div>}
      {sb.state !== 'proposed' && <div class="ag-sb-bar" aria-hidden="true"><span style={{ width: `${(done / Math.max(1, view.beats.length)) * 100}%` }} /></div>}
      <ol class="ag-sb-beats">
        {view.beats.map((b, i) => (
          <li class={'ag-sb-beat ' + (b.status ?? 'todo')} data-testid="storyboard-beat">
            <span class="ag-sb-num" title={b.status ?? 'todo'}>
              {b.status === 'done' ? <Check size={12} /> : b.status === 'active' ? <LoaderCircle size={12} /> : b.status === 'skipped' ? <Minus size={12} /> : editable ? i + 1 : <Circle size={10} />}
            </span>
            {editable ? (
              <div class="ag-sb-fields">
                <div class="ag-sb-row">
                  <input class="ag-sb-name" aria-label={`Beat ${i + 1} name`} value={b.name} onInput={e => setBeat(i, { name: (e.target as HTMLInputElement).value })} />
                  <button type="button" class="ag-icon-btn" title="Remove beat" aria-label={`Remove beat ${i + 1}`} disabled={view.beats.length < 2} onClick={() => removeBeat(i)}><X size={12} /></button>
                </div>
                <div class="ag-sb-row ag-sb-times">
                  <input class="ag-sb-time" type="number" step="0.1" min="0" aria-label={`Beat ${i + 1} start`} value={b.start} onInput={e => setBeat(i, { start: +(e.target as HTMLInputElement).value })} />
                  <span class="ag-muted">–</span>
                  <input class="ag-sb-time" type="number" step="0.1" min="0" aria-label={`Beat ${i + 1} end`} value={b.end} onInput={e => setBeat(i, { end: +(e.target as HTMLInputElement).value })} />
                  <span class="ag-muted ag-small">s</span>
                  <input class="ag-sb-style" aria-label={`Beat ${i + 1} style notes`} value={b.style ?? ''} placeholder="Style notes" title="Style notes: eases, signature move, palette" onInput={e => setBeat(i, { style: (e.target as HTMLInputElement).value })} />
                </div>
                <textarea rows={2} aria-label={`Beat ${i + 1} description`} value={b.description} placeholder="What happens" onInput={e => setBeat(i, { description: (e.target as HTMLTextAreaElement).value })} />
              </div>
            ) : (
              <div class="ag-sb-fields">
                <div class="ag-sb-row">
                  <button type="button" class="ag-link ag-sb-name-ro" title="Go to this beat" onClick={() => seek(b.start)}>{b.name}</button>
                  <span class="ag-muted ag-small">{fmt(b.start)}–{fmt(b.end)}</span>
                </div>
                {b.description && <div class="ag-sb-desc">{b.description}</div>}
                {(b.note || b.style) && <div class="ag-muted ag-small">{b.note ?? b.style}</div>}
              </div>
            )}
          </li>
        ))}
      </ol>
      {editable && (
        <div class="ag-review-actions">
          <button type="button" class="ag-btn" onClick={addBeat}><Plus size={12} /> Beat</button>
          <span class="ag-grow ag-muted ag-small">{dirty ? 'Edited · ' : ''}or reply with changes</span>
          <button type="button" class="ag-btn primary" disabled={props.busy || !valid} title={props.busy ? 'Wait for the agent to finish' : 'Send this plan to the agent and build it'} onClick={approve}>Approve &amp; build</button>
        </div>
      )}
    </div>
  );
}
