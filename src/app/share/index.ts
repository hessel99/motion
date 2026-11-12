// sharing a preview. two paths:
// - a preview FILE: one self-contained html page (the animation as an embedded video + a small
//   player: play / pause, scrub, loop, time). works offline, can be mailed or dropped anywhere.
// - a LINK: the same page uploaded through a pluggable provider (ShareProvider). none is set up by
//   default: Settings → Connections → Link sharing configures one; until then the share popover
//   offers "Set up link sharing…" instead of a dead button.
// listeners: editor channel 'share' (provider settings changed).

import { editor } from '../editor';

export interface ShareProvider {
  id: string;
  name: string;
  /** one line for Settings */
  description: string;
  /** ready to upload with the current settings */
  configured(): boolean;
  /** upload the page, resolve to a public url */
  upload(file: Blob, name: string): Promise<string>;
}

const KEY = 'motion.share';
interface ShareSettings { provider: string; endpoint: string; header: string }
function load(): ShareSettings {
  try { return { provider: '', endpoint: '', header: '', ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { provider: '', endpoint: '', header: '' }; }
}
export const shareSettings: ShareSettings = load();
export function setShareSettings(p: Partial<ShareSettings>) {
  Object.assign(shareSettings, p);
  try { localStorage.setItem(KEY, JSON.stringify(shareSettings)); } catch { /* private mode */ }
  editor.emit('share');
}

/** your own upload endpoint: the page is POSTed as the request body (content-type text/html,
 *  file name in the X-File-Name header, an optional Authorization header). the response is the url,
 *  as plain text or json { url }. fits a small serverless function, a bucket presigner, etc. */
const httpProvider: ShareProvider = {
  id: 'http',
  name: 'Your upload endpoint',
  description: 'POSTs the preview page to a url you control; the response is the link.',
  configured: () => /^https:\/\//.test(shareSettings.endpoint),
  async upload(file, name) {
    const headers: Record<string, string> = { 'Content-Type': 'text/html', 'X-File-Name': name };
    if (shareSettings.header.trim()) headers.Authorization = shareSettings.header.trim();
    const res = await fetch(shareSettings.endpoint, { method: 'POST', headers, body: file });
    if (!res.ok) throw new Error(`upload failed (${res.status})`);
    const text = (await res.text()).trim();
    try { const j = JSON.parse(text); if (typeof j.url === 'string') return j.url; } catch { /* plain text */ }
    if (!/^https?:\/\//.test(text)) throw new Error('the endpoint did not answer with a url');
    return text;
  },
};

export const SHARE_PROVIDERS: ShareProvider[] = [httpProvider];

/** the provider set up in Settings, when it is ready */
export function activeProvider(): ShareProvider | null {
  const p = SHARE_PROVIDERS.find(x => x.id === shareSettings.provider);
  return p && p.configured() ? p : null;
}
