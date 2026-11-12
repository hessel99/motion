// debugging aid for the figma importer: save the last figma paste (raw clipboard html + decoded
// node tree) to a file the user picks, and (dev only) auto-save every paste into a folder.
//
//  - command: "Save last Figma paste for debugging…" (Import menu, Settings → Figma import)
//  - desktop: native save dialog; browser: a download
//  - auto-save: MOTION_FIGMA_CAPTURE_DIR=/some/folder npm run electron(:dev), or for the browser dev
//    server VITE_FIGMA_CAPTURE_DIR=/some/folder npm run dev (the dev server writes the files)

import { toast } from './actions';

const native = () => (globalThis as any).motionNative as undefined | {
  saveFileAs?(o: any): Promise<string | null>;
  saveFile?(o: any): Promise<string | null>;
  figmaCaptureDir?(): Promise<string | null>;
  figmaCaptureWrite?(name: string, text: string): Promise<string | null>;
};

async function captureMod() {
  // same module instance the importer uses (index.ts re-exports the capture state)
  return import('../import/figma');
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** save the last figma paste (html + decoded tree) to a user-chosen file */
export async function saveLastFigmaPaste() {
  const m = await captureMod();
  const f = m.buildCaptureFiles(m.lastPaste());
  if (!f) { toast('No Figma paste yet: copy something in Figma and paste it here first', 'error'); return; }
  const n = native();
  const save = n?.saveFileAs ?? n?.saveFile;
  if (save) {
    const p = await save({ defaultPath: f.name, data: f.text, encoding: 'utf8', filters: [{ name: 'Figma paste capture', extensions: ['json'] }] });
    if (p) toast(`Saved the last Figma paste to ${p}`);
    return;
  }
  download(f.name, f.text);
  toast(`Saved the last Figma paste as ${f.name}`);
}

let autoSaveOn = false;
/** dev only: write every figma paste to the capture folder (when one is configured) */
export async function setupFigmaCaptureAutoSave() {
  if (autoSaveOn) return;
  const n = native();
  let write: ((name: string, text: string) => Promise<unknown>) | null = null;
  if (n?.figmaCaptureDir && n.figmaCaptureWrite) {
    const dir = await n.figmaCaptureDir().catch(() => null);
    if (dir) write = (name, text) => n.figmaCaptureWrite!(name, text);
  } else if (import.meta.env.DEV && import.meta.env.VITE_FIGMA_CAPTURE_DIR) {
    write = (name, text) => fetch('/__figma-capture?name=' + encodeURIComponent(name), { method: 'POST', body: text });
  }
  if (!write) return;
  autoSaveOn = true;
  const m = await captureMod();
  const { onPaste } = await import('../import/figma/capture');
  onPaste(r => {
    const f = m.buildCaptureFiles(r);
    if (f) write!(f.name, f.text).catch(err => console.warn('[figma capture] auto-save failed', err));
  });
  console.info('[figma capture] auto-saving every Figma paste');
}
