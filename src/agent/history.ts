// conversation persistence per project (localStorage). the key is the id of the project's first
// composition, which is saved in the file, so reopening a project brings its conversation back
// (and the cli session id, so the agent remembers it too).

import type { Project } from '../core/model';
import type { TurnDiff } from './diff';
import type { Storyboard } from './storyboard';

export interface ToolInfo { id: string; name: string; input: any; result?: string; isError?: boolean; image?: string; startedAt?: number; ms?: number }
/** startId / endId: the store's top undo entry id before / after the turn (Store.topEntryId). the
 *  card can revert/compare only while endId is still on top, i.e. the document is exactly as the
 *  turn left it (a step count could match after the user undid the turn and made own edits) */
export interface ReviewInfo { startId?: number; endId?: number; steps: number; diff: TurnDiff; state: 'pending' | 'kept' | 'reverted' | 'stale'; range?: [number, number] }

/** the document is exactly as the turn left it: the turn's last undo entry is on top. (a step
 *  count is not enough: undo the turn, make as many own edits, and the count matches again) */
export function reviewAtEnd(r: ReviewInfo, topEntryId: number) {
  return r.endId !== undefined && r.startId !== undefined && r.endId !== r.startId && topEntryId === r.endId;
}

export interface Msg {
  role: 'user' | 'assistant' | 'tool' | 'error' | 'info' | 'review' | 'storyboard';
  text: string;
  mode?: 'edit' | 'ask';
  tool?: ToolInfo;
  review?: ReviewInfo;
  errorKind?: string;
  hint?: string;
  /** quick action label when the message came from a chip */
  chip?: string;
  /** user text to resend for "Retry" */
  retry?: string;
  /** role 'storyboard': the plan card (a snapshot, updated in place as progress arrives) */
  storyboard?: Storyboard;
  /** role 'review': contact sheet of the result (data url; not persisted) */
  preview?: string;
  /** user message: the style picked with the style picker (guide name) */
  style?: string;
}

export interface SavedChat { v: 1; msgs: Msg[]; sessions: Record<string, string | undefined>; savedAt: number }

const PREFIX = 'motion.agent.chat:';
const MAX_MSGS = 200;

export function projectKey(p: Project): string {
  return Object.keys(p.comps)[0] ?? p.name ?? 'default';
}

const trimJson = (v: any, max = 1500) => {
  try { const s = JSON.stringify(v); return s.length > max ? { _truncated: s.slice(0, max) + '…' } : v; } catch { return undefined; }
};

/** what is persisted: no images, truncated tool payloads, review cards become stale (undo history is gone after reload) */
export function serializeChat(msgs: Msg[], sessions: Record<string, string | undefined>): SavedChat {
  const out = msgs.slice(-MAX_MSGS).map(m => {
    if (m.tool) return { ...m, tool: { ...m.tool, image: undefined, input: trimJson(m.tool.input), result: m.tool.result?.slice(0, 600) } };
    if (m.review) return { ...m, preview: undefined, review: { ...m.review, state: m.review.state === 'pending' ? 'stale' as const : m.review.state } };
    return m;
  });
  return { v: 1, msgs: out, sessions, savedAt: Date.now() };
}

export function saveChat(key: string, msgs: Msg[], sessions: Record<string, string | undefined>) {
  try {
    if (!msgs.length) { localStorage.removeItem(PREFIX + key); return; }
    localStorage.setItem(PREFIX + key, JSON.stringify(serializeChat(msgs, sessions)));
  } catch { /* quota / private mode: persistence is best effort */ }
}

export function loadChat(key: string): SavedChat | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (c?.v !== 1 || !Array.isArray(c.msgs)) return null;
    // anything still "pending" after a reload can no longer be reverted through the undo history
    c.msgs = c.msgs.map((m: Msg) => (m.review && m.review.state === 'pending' ? { ...m, review: { ...m.review, state: 'stale' } } : m));
    return c;
  } catch { return null; }
}
