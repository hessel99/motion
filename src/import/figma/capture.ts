// "save last paste for debugging": keeps the raw clipboard html of the last figma paste plus the
// decoded kiwi message, and turns them into one capture file (format below) so real payloads can be
// collected and replayed (tests/figma-capture.test.ts shows how to load one).
//
// capture file (json):
//   { format: 'motion-figma-capture', version: 1, capturedAt, warnings, error,
//     html: <the clipboard text/html exactly as received>,
//     decoded: { nodeChanges: [...], blobs: [{ bytes: <n> }...], ... } }   // byte arrays as { $bytes: n, base64? }
// captures contain the user's design: they are written only where the user says (save dialog or the
// dev-only auto-save folder) and *.figcapture.json is git-ignored.

export interface PasteRecord { html: string; message: any; warnings: string[] | null; error: string | null; at: number }

let last: PasteRecord | null = null;
const listeners = new Set<(r: PasteRecord) => void>();

export function rememberPaste(html: string, message: any, warnings: string[] | null, error: string | null) {
  last = { html, message, warnings, error, at: Date.now() };
  for (const fn of listeners) { try { fn(last); } catch { /* listener errors never break a paste */ } }
}

/** the last figma paste (decoded or not), or null */
export function lastPaste(): PasteRecord | null { return last; }

/** called after every figma paste (dev auto-save) */
export function onPaste(fn: (r: PasteRecord) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** json text of a decoded kiwi message: byte arrays become { $bytes: length } (and their base64
 *  when `withBytes`), everything else as decoded */
export function captureJson(message: any, withBytes = false, space?: number): string {
  return JSON.stringify(message, (_k, v) => {
    if (v instanceof Uint8Array) return withBytes ? { $bytes: v.length, base64: b64(v) } : { $bytes: v.length };
    if (typeof v === 'bigint') return Number(v);
    return v;
  }, space);
}

/** the capture file for a paste record */
export function buildCaptureFiles(r: PasteRecord | null = last): { name: string; text: string } | null {
  if (!r) return null;
  const d = new Date(r.at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `figma-paste-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.figcapture.json`;
  // the decoded tree is for reading; the html already holds every byte (blobs are summarized)
  const decoded = r.message ? JSON.parse(captureJson(r.message)) : null;
  const text = JSON.stringify({ format: 'motion-figma-capture', version: 1, capturedAt: d.toISOString(), warnings: r.warnings, error: r.error, html: r.html, decoded }, null, 1);
  return { name, text };
}
