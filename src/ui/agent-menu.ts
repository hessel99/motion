// "Ask agent…" and a few one-click asks for context menus (canvas, timeline layers, keyframes,
// the ruler / preview range). they all go to the same agent chat (./agent-bridge.ts).

import { editor } from '../app/editor';
import { askAgent, selectionContext } from './agent-bridge';
import type { MenuItem } from './menu';

export type AskTarget = 'layers' | 'keys' | 'range' | 'comp';

const QUICK: Record<AskTarget, (n: number) => [string, string][]> = {
  layers: n => [
    ['Animate this in', n > 1 ? 'Animate the selected layers in with a clean, staggered entrance.' : 'Animate the selected layer in with a clean entrance.'],
    ['Add follow-through', 'Add follow-through and overlapping action to the selected layers so the motion settles naturally.'],
    ...(n > 1 ? [['Stagger these', 'Stagger the animation of the selected layers.'] as [string, string]] : []),
  ],
  keys: () => [
    ['Make snappier', 'Make the motion between the selected keyframes snappier.'],
    ['Add overshoot', 'Add a little overshoot and settle to the selected keyframes.'],
    ['Smooth it out', 'Smooth out the easing of the selected keyframes.'],
  ],
  range: () => [
    ['Make this part snappier', 'Make the animation in this time range snappier.'],
    ['Fill this gap', 'Add some secondary motion in this time range so nothing feels static.'],
  ],
  comp: () => [
    ['Animate everything in', 'Animate the layers of this composition in with a clear hierarchy.'],
    ['Critique the motion', 'Critique the motion in this composition and suggest improvements (numbered, so I can say "do 1 and 3"). Do not change anything.'],
  ],
};

/** quick asks that only look and advise */
const READ_ONLY = new Set(['Critique the motion']);

/** the agent's part of a context menu: one-click asks, then "Ask agent…" (the ⌘K bar) */
export function agentMenuItems(target: AskTarget): MenuItem[] {
  const s = editor.store;
  const quick = QUICK[target](s.selection.length);
  return [
    // critiques look and advise: read-only (the editor refuses editing tools for that turn)
    ...quick.map(([label, text]) => ({ label, hint: 'agent', action: () => askAgent(text, { chip: label, context: selectionContext(), ...(READ_ONLY.has(label) ? { mode: 'ask' as const } : {}) }) })),
    { label: 'Ask agent…', shortcut: '⌘K', action: () => editor.emit('ask-bar') },
  ];
}
