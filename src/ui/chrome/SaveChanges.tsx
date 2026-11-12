// "Save changes to “Demo”?": closing a file with unsaved changes asks here (Save / Don't save /
// Cancel) instead of the browser's OK / Cancel prompt. registered with documents.setCloseGuard.

import { render } from 'preact';
import { saveProject } from '../../app/actions';
import { setCloseGuard, type CloseAnswer } from '../../app/documents';
import { Button, Dialog } from '../ui';

function ask(name: string): Promise<CloseAnswer> {
  return new Promise(resolve => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const done = (a: CloseAnswer) => { render(null, host); host.remove(); resolve(a); };
    render(
      <Dialog title={`Save changes to “${name}”?`} width={420} onClose={() => done('cancel')} closeButton={false}
        actions={<>
          <Button class="save-changes-discard" onClick={() => done('discard')}>Don’t save</Button>
          <span class="grow" />
          <Button onClick={() => done('cancel')}>Cancel</Button>
          <Button variant="primary" autofocus onClick={() => done('save')}>Save</Button>
        </>}>
        <p class="save-changes-text">Your changes are lost if you don’t save them.</p>
      </Dialog>,
      host,
    );
  });
}

export function setupSaveChanges() {
  setCloseGuard({ ask, save: () => saveProject(false) });
}
