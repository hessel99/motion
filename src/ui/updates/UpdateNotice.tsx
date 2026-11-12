// Small, unobtrusive notice in the corner when an update is ready (or a broken one was rolled
// back). It never takes focus, never opens anything by itself, and hides while exporting.
// Mounted on its own root from main.tsx so it stays independent of the editor layout.
import { useEffect, useState } from 'preact/hooks';
import { flushAutosave, toast } from '../../app/actions';
import { isBusy, onUpdateStatus, restartToUpdate, type UpdateStatus } from '../../app/updates';
import { openSettings } from '../chrome/ui-state';
import './update-notice.css';

export function UpdateNotice() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState('');
  useEffect(() => onUpdateStatus(s => setSt(s ? { ...s } : null)), []);
  if (!st || isBusy()) return null;
  const key = st.ready ? `ready:${st.ready.version}` : st.notice ? `notice:${st.notice.kind}:${st.notice.version}` : '';
  if (!key || dismissed === key) return null;
  const close = () => setDismissed(key);
  if (st.ready) {
    const restart = async () => { const err = await restartToUpdate(flushAutosave); if (err) toast(err, 'error'); };
    return (
      <div class="upd-pill" role="status">
        <button type="button" class="upd-pill-text" onClick={() => openSettings('updates')} title="What's new">Motion {st.ready.version} is ready</button>
        <button type="button" class="upd-pill-act" onClick={restart}>Restart</button>
        <button type="button" class="upd-pill-x" aria-label="Later" title="Later (installs on the next start)" onClick={close}>×</button>
      </div>
    );
  }
  return (
    <div class="upd-pill" role="status">
      <button type="button" class="upd-pill-text" onClick={() => openSettings('updates')}>{st.notice!.text}</button>
      <button type="button" class="upd-pill-x" aria-label="Dismiss" onClick={close}>×</button>
    </div>
  );
}
