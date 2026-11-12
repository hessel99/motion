// the small door into the agent chat for the rest of the ui: the Home prompt, the ⌘K ask bar,
// "Ask agent…" in context menus and the suggestions after an import all call askAgent(); the
// AgentPanel (left card) picks the ask up and sends it as a normal turn (the editor's selection
// is its context, as for a typed message). the panel publishes its running turn here, so the
// timeline header can show the agent's progress while the panel is collapsed.
// listeners: editor channels 'agent-ask' (to the panel) and 'agent-turn' (progress).

import { editor } from '../app/editor';

export interface AgentAsk {
  text: string;
  /** a short label for the chat bubble ("Make snappier") */
  chip?: string;
  /** what the ask refers to beyond the layer selection (keys, a time range), added to the message */
  context?: string;
}

let pending: AgentAsk | null = null;

/** send a brief / question to the agent chat (opens the agent panel) */
export function askAgent(text: string, opts: Omit<AgentAsk, 'text'> = {}) {
  pending = { text, ...opts };
  editor.emit('agent-ask');
}

/** the AgentPanel takes the pending ask (once) */
export function takeAsk(): AgentAsk | null { const a = pending; pending = null; return a; }

export interface AgentProgress { activity: string; live: number; startedAt: number; /** the storyboard beat being built (the timeline highlights it) */ range?: [number, number] }
let progress: AgentProgress | null = null;
export function agentProgress() { return progress; }
/** the open document's conversation has messages (the empty-canvas brief box steps aside) */
export let chatStarted = false;
export function setChatStarted(v: boolean) { if (v !== chatStarted) { chatStarted = v; editor.emit('agent-turn'); } }
export function setAgentProgress(p: AgentProgress | null) {
  if (p === progress || (p && progress && p.activity === progress.activity && p.live === progress.live && p.range?.[0] === progress.range?.[0] && p.range?.[1] === progress.range?.[1])) return;
  progress = p;
  editor.emit('agent-turn');
}

/** a sentence describing what is selected beyond layers: keyframes, the preview range */
export function selectionContext(): string | undefined {
  const s = editor.store;
  const parts: string[] = [];
  if (s.keySelection.size) {
    const props = new Set([...s.keySelection].map(k => k.split('|')[1]));
    parts.push(`${s.keySelection.size} selected keyframe${s.keySelection.size === 1 ? '' : 's'} (${[...props].join(', ')})`);
  }
  if (s.workArea) parts.push(`the time range ${s.workArea[0].toFixed(2)}s–${s.workArea[1].toFixed(2)}s`);
  return parts.length ? parts.join(' and ') : undefined;
}
