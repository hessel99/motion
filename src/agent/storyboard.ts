// the director workflow's plan: the agent proposes a storyboard (propose_storyboard), the chat shows
// it as an editable card, the user approves (the approved version goes back to the agent as the next
// message), then the agent builds beat by beat and reports progress (update_progress). every beat
// becomes ONE undo step labeled with the beat's name.

import type { Store } from '../core/store';

export interface Beat {
  name: string;
  start: number;
  end: number;
  description: string;
  /** easing / signature move / palette notes for this beat */
  style?: string;
  status?: 'todo' | 'active' | 'done' | 'skipped';
  note?: string;
}

/** one idea for a logo / brand / artwork piece, rooted in what the artwork depicts */
export interface Concept { name: string; idea: string; why?: string }

export interface Storyboard {
  id: string;
  title: string;
  style?: string;
  styleReason?: string;
  duration?: number;
  beats: Beat[];
  notes?: string;
  /** logo / brand briefs: 2-3 concepts the user picks from (the beats describe `recommended`) */
  concepts?: Concept[];
  recommended?: number;
  /** the concept the user picked on the card */
  chosen?: number;
  /** proposed: waiting for the user; approved: sent back to the agent; building / done: progress */
  state: 'proposed' | 'approved' | 'building' | 'done';
  /** the user changed something before approving */
  edited?: boolean;
}

/** 'ask': the agent stops after proposing and waits for approval; 'auto': it builds right away */
export type ApprovalMode = 'ask' | 'auto';
const PREF = 'motion.agent.storyboard';
export function approvalMode(): ApprovalMode {
  try { return localStorage.getItem(PREF) === 'auto' ? 'auto' : 'ask'; } catch { return 'ask'; }
}
export function setApprovalMode(m: ApprovalMode) { try { localStorage.setItem(PREF, m); } catch { /* */ } }

const r2 = (x: number) => Math.round(x * 100) / 100;

/** validate + normalize the tool input (throws with a message the agent can act on) */
export function normalizeStoryboard(a: any): Omit<Storyboard, 'id' | 'state'> {
  if (!a || typeof a !== 'object') throw new Error('storyboard must be an object');
  const title = String(a.title ?? '').trim();
  if (!title) throw new Error('title is required');
  if (!Array.isArray(a.beats) || !a.beats.length) throw new Error('beats must be a non-empty array of {name, start, end, description}');
  if (a.beats.length > 12) throw new Error('at most 12 beats; merge some');
  const beats: Beat[] = a.beats.map((b: any, i: number) => {
    const name = String(b?.name ?? '').trim();
    const start = Number(b?.start), end = Number(b?.end);
    if (!name) throw new Error(`beats[${i}].name is required`);
    if (!isFinite(start) || !isFinite(end) || start < 0 || end <= start) throw new Error(`beats[${i}] ("${name}"): needs 0 <= start < end in seconds (got ${b?.start}–${b?.end})`);
    return { name: name.slice(0, 60), start: r2(start), end: r2(end), description: String(b?.description ?? '').trim().slice(0, 400), ...(b?.style ? { style: String(b.style).slice(0, 200) } : {}), status: 'todo' as const };
  });
  for (let i = 1; i < beats.length; i++) if (beats[i].start < beats[i - 1].start) throw new Error('beats must be in time order');
  const last = Math.max(...beats.map(b => b.end));
  let concepts: Concept[] | undefined;
  if (a.concepts !== undefined) {
    if (!Array.isArray(a.concepts) || a.concepts.length > 4) throw new Error('concepts must be an array of 2-3 {name, idea, why}');
    concepts = a.concepts.map((c: any, i: number) => {
      const name = String(c?.name ?? '').trim(), idea = String(c?.idea ?? '').trim();
      if (!name || !idea) throw new Error(`concepts[${i}] needs name and idea`);
      return { name: name.slice(0, 60), idea: idea.slice(0, 300), ...(c?.why ? { why: String(c.why).slice(0, 240) } : {}) };
    });
    if (!concepts?.length) concepts = undefined;
  }
  const recommended = concepts ? Math.min(concepts.length - 1, Math.max(0, Math.round(Number(a.recommended ?? 0)) || 0)) : undefined;
  const duration = a.duration !== undefined && isFinite(+a.duration) ? Math.max(r2(+a.duration), last) : last;
  return {
    title: title.slice(0, 80),
    ...(a.style ? { style: String(a.style).slice(0, 80) } : {}),
    ...(a.styleReason ? { styleReason: String(a.styleReason).slice(0, 240) } : {}),
    duration,
    beats,
    ...(a.notes ? { notes: String(a.notes).slice(0, 400) } : {}),
    ...(concepts ? { concepts, recommended, chosen: recommended } : {}),
  };
}

/** the text the chat sends back to the agent when the user approves (possibly edited) */
export function approvalMessage(sb: Storyboard): string {
  const c = sb.concepts?.[sb.chosen ?? sb.recommended ?? 0];
  const switched = c && sb.chosen !== undefined && sb.chosen !== sb.recommended;
  const plan = { title: sb.title, style: sb.style, duration: sb.duration, ...(c ? { concept: `${c.name}: ${c.idea}` } : {}), beats: sb.beats.map(({ name, start, end, description, style }) => ({ name, start, end, description, ...(style ? { style } : {}) })) };
  const pick = c ? ` Concept: "${c.name}"${switched ? ' (I picked this instead of your recommendation: re-plan the beats for it, keeping the times)' : ''}.` : '';
  return `Storyboard approved${sb.edited ? ' with my edits (follow this version)' : ''}.${pick} Build it now, beat by beat: update_progress {beat, status:"active"} before a beat and {status:"done"} after it, then critique with contact_sheet and fix the worst issues.\n<storyboard>${JSON.stringify(plan)}</storyboard>`;
}

type Listener = (sb: Storyboard) => void;

class Storyboards {
  current: Storyboard | null = null;
  private listeners = new Set<Listener>();
  /** undo entry on top when each beat started (beat index → entry id) */
  private beatStart = new Map<number, number>();
  /** the entry on top when the last beat finished: where the next beat starts if it never said "active" */
  private lastEnd: number | null = null;

  on(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  /** listeners get a copy: the chat keeps it as the card's snapshot */
  private emit() { const c = this.current; if (c) for (const f of this.listeners) f({ ...c, beats: c.beats.map(b => ({ ...b })) }); }

  propose(input: any): Storyboard {
    const sb: Storyboard = { id: 'sb' + Math.random().toString(36).slice(2, 9), state: approvalMode() === 'auto' ? 'approved' : 'proposed', ...normalizeStoryboard(input) };
    this.current = sb;
    this.beatStart.clear();
    this.lastEnd = null;
    this.emit();
    return sb;
  }

  /** the user approved the card (with their edits): it becomes the plan progress refers to */
  approve(edited: Storyboard) {
    this.current = { ...edited, beats: edited.beats.map(b => ({ ...b })), state: 'approved' };
    this.beatStart.clear();
    this.lastEnd = null;
    this.emit();
    return this.current;
  }

  /** resolve a beat reference: 1-based number or (part of) its name */
  beatIndex(ref: any): number {
    const sb = this.current;
    if (!sb) throw new Error('no storyboard yet: call propose_storyboard first');
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const i = Number(ref) - 1;
      if (i < 0 || i >= sb.beats.length) throw new Error(`beat ${ref} does not exist (1..${sb.beats.length})`);
      return i;
    }
    const n = String(ref ?? '').toLowerCase().trim();
    const i = sb.beats.findIndex(b => b.name.toLowerCase() === n);
    const j = i >= 0 ? i : sb.beats.findIndex(b => b.name.toLowerCase().includes(n));
    if (!n || j < 0) throw new Error(`no beat "${ref}". beats: ${sb.beats.map((b, k) => `${k + 1} ${b.name}`).join(', ')}`);
    return j;
  }

  /** progress of one beat. "done" collapses the beat's edits into one undo step "Beat N · name" */
  progress(store: Store, ref: any, status: Beat['status'], note?: string): { beat: Beat; index: number; merged: number } {
    const sb = this.current!;
    const i = this.beatIndex(ref);
    if (!['active', 'done', 'skipped', 'todo'].includes(String(status))) throw new Error('status must be active, done, skipped or todo');
    let merged = 0;
    // a new beat starts while another is still active: close that one first
    if (status === 'active') {
      sb.beats.forEach((b, k) => { if (k !== i && b.status === 'active') merged += this.finish(store, k, 'done'); });
      this.beatStart.set(i, store.topEntryId);
    }
    if (status === 'done') merged += this.finish(store, i, 'done');
    const beats = sb.beats.slice();
    beats[i] = { ...beats[i], status, ...(note ? { note: String(note).slice(0, 200) } : {}) };
    const all = beats.every(b => b.status === 'done' || b.status === 'skipped');
    this.current = { ...sb, beats, state: all ? 'done' : 'building' };
    this.emit();
    return { beat: beats[i], index: i, merged };
  }

  private finish(store: Store, i: number, status: 'done'): number {
    const sb = this.current!;
    const since = this.beatStart.get(i) ?? this.lastEnd;
    let n = 0;
    if (since != null) n = store.squashSince(since, `Beat ${i + 1} · ${sb.beats[i].name}`);
    this.beatStart.delete(i);
    this.lastEnd = store.topEntryId;
    sb.beats[i] = { ...sb.beats[i], status };
    return n;
  }

  clear() { this.current = null; this.beatStart.clear(); this.lastEnd = null; }
}

export const storyboards = new Storyboards();
