// Share (top right): a small popover with the two ways out of the app.
// - Share a preview: a self-contained html player page (src/app/share/player.ts), saved as a file
//   or, with link sharing set up (Settings → Connections), uploaded with the link copied.
// - Export a file: the export dialog (MP4 / WebM / GIF / PNG / Lottie).

import { exportFileName, openExport, saveExportFile, toast } from '../../app/actions';
import { setBusy } from '../../app/updates';
import { activeProvider } from '../../app/share';
import { buildPreviewPage } from '../../app/share/player';
import { menuFrom } from '../menu';
import { openSettings } from './ui-state';

let running = false;

/** render the preview page with a progress toast; returns null when it failed */
async function makePage() {
  if (running) { toast('A preview is already being made'); return null; }
  running = true;
  setBusy('share-preview', true);
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = 'Making the preview… 0%';
  (document.querySelector('.toasts') ?? document.body.appendChild(Object.assign(document.createElement('div'), { className: 'toasts' }))).appendChild(el);
  try {
    return await buildPreviewPage(p => { el.textContent = `Making the preview… ${Math.round(p.progress * 100)}%`; });
  } catch (e: any) {
    toast('Preview failed: ' + (e?.message ?? e), 'error');
    return null;
  } finally { el.remove(); running = false; setBusy('share-preview', false); }
}

/** save the preview page (desktop: a save dialog; browser: a download) */
export async function sharePreviewFile() {
  const page = await makePage();
  if (!page) return;
  await saveExportFile(exportFileName('html'), page.html, `Preview saved (${Math.round(page.bytes / 1024)} KB): open it in any browser or send it`);
}

/** upload the preview page with the configured provider and copy the link */
export async function sharePreviewLink() {
  const prov = activeProvider();
  if (!prov) { openSettings('connections'); return; }
  const page = await makePage();
  if (!page) return;
  try {
    const url = await prov.upload(new Blob([page.html], { type: 'text/html' }), exportFileName('html'));
    await navigator.clipboard?.writeText(url).catch(() => {});
    toast('Link copied: ' + url);
  } catch (e: any) { toast('Link sharing failed: ' + (e?.message ?? e), 'error'); }
}

export function openShare(anchor: HTMLElement) {
  const prov = activeProvider();
  menuFrom(anchor, [
    { label: 'Share a preview file', hint: 'a player page anyone can open', action: () => { sharePreviewFile(); } },
    prov
      ? { label: 'Copy a preview link', hint: prov.name, action: () => { sharePreviewLink(); } }
      : { label: 'Set up link sharing…', hint: 'Settings', action: () => openSettings('connections') },
    { separator: true },
    { label: 'Export a file…', shortcut: '⌘E', hint: 'MP4, GIF, PNG, Lottie', action: openExport },
  ], { align: 'right' });
}
