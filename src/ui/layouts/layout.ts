// window layouts (docs/layouts.md). every layout composes the SAME mounted panels (viewport,
// timeline, inspector, agent): switching only changes classes on .app, so no canvas, renderer,
// timeline or agent conversation is ever re-created. `?layout=stage|score|director|classic`
// (or a / b / c) picks one at startup; the choice is remembered.
import { editor } from '../../app/editor';

export type LayoutId = 'classic' | 'stage' | 'score' | 'director';

export const LAYOUTS: { id: LayoutId; label: string; short: string; blurb: string }[] = [
  { id: 'classic', label: 'Classic', short: 'Classic', blurb: 'Agent left, canvas, inspector right, timeline below' },
  { id: 'stage', label: 'A · Stage', short: 'Stage', blurb: 'Canvas first: properties float by the selection, the timeline follows it' },
  { id: 'score', label: 'B · Score', short: 'Score', blurb: 'Time is the main axis: every property is a row with its value, ease and keys' },
  { id: 'director', label: 'C · Director', short: 'Director', blurb: 'Talk to the agent, steer by key moments; panels are summoned' },
];

const KEY = 'motion.layout';
const ALIAS: Record<string, LayoutId> = { a: 'stage', b: 'score', c: 'director', classic: 'classic', stage: 'stage', score: 'score', director: 'director' };

function initial(): LayoutId {
  const q = new URLSearchParams(location.search).get('layout');
  if (q && ALIAS[q.toLowerCase()]) return ALIAS[q.toLowerCase()];
  try { const v = localStorage.getItem(KEY); if (v && ALIAS[v]) return ALIAS[v]; } catch { /* */ }
  return 'classic';
}

let current: LayoutId = initial();
export const layout = () => current;

export function setLayout(id: LayoutId) {
  if (id === current) return;
  current = id;
  try { localStorage.setItem(KEY, id); } catch { /* */ }
  editor.emit('layout');
}

/** summoned panels (stage drawer, director sheets). per layout, not persisted */
export const summon = { timeline: false, inspector: false, palette: false };
export function toggleSummon(k: keyof typeof summon, on = !summon[k]) {
  if (summon[k] === on) return;
  summon[k] = on;
  editor.emit('layout');
}

/** a prompt handed to the agent panel by another surface (storyboard, palette). read once */
let pending: string | null = null;
export function askAgent(text: string) {
  pending = text;
  editor.emit('agent-open');
  editor.emit('agent-prompt');
}
export function takeAgentPrompt() { const p = pending; pending = null; return p; }
