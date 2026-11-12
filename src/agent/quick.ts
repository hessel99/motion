// one-click directions for the agent ("make it bouncier", "stagger these", ...). they act on the
// selection (or the whole animation when nothing is selected) and are written so the agent can
// do them in one or two tool calls.

import type { Store } from '../core/store';

export interface QuickAction {
  id: string;
  label: string;
  title: string;
  mode: 'edit' | 'ask';
  /** minimum number of selected layers (0 = also works on the whole animation) */
  minSel: number;
  prompt: (target: string) => string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'animate-in', label: 'Animate in', title: 'Give the selection a polished entrance', mode: 'edit', minSel: 1, prompt: t => `Give ${t} a polished entrance animation starting at the playhead (staggered if there are several), with eases that fit their role.` },
  { id: 'bouncier', label: 'Bouncier', title: 'More overshoot / springiness', mode: 'edit', minSel: 0, prompt: t => `Make ${t} bouncier: springy overshoot on the main moves (spring presets or Back Out). Keep when things land the same.` },
  { id: 'smoother', label: 'Smoother', title: 'Softer, calmer easing', mode: 'edit', minSel: 0, prompt: t => `Make ${t} smoother and calmer: softer eases (Sine/Cubic In Out), no harsh overshoot. Keep the timing.` },
  { id: 'snappier', label: 'Snappier', title: 'Sharper, more decisive eases', mode: 'edit', minSel: 0, prompt: t => `Make ${t} snappier: strong ease-outs (Expo Out / Snappy) so moves start fast and settle precisely. Keep the start times.` },
  { id: 'slower', label: 'Slower', title: 'About 25% slower', mode: 'edit', minSel: 0, prompt: t => `Make ${t} about 25% slower with retime (keep the start time).` },
  { id: 'faster', label: 'Faster', title: 'About 25% faster', mode: 'edit', minSel: 0, prompt: t => `Make ${t} about 25% faster with retime (keep the start time).` },
  { id: 'stagger', label: 'Stagger', title: 'One after another in selection order', mode: 'edit', minSel: 2, prompt: t => `Stagger ${t} one after another, about 0.08s apart in selection order (use the stagger tool; if they are not animated yet, give them an entrance first).` },
  { id: 'anticipation', label: 'Anticipation', title: 'Small opposite move before each main move', mode: 'edit', minSel: 0, prompt: t => `Add anticipation to ${t}: a small, quick opposite move (or a slight squash/scale-down) right before each main move, without changing when the main move lands.` },
  { id: 'variations', label: '3 variations', title: 'Agent builds A/B/C versions to compare', mode: 'edit', minSel: 0, prompt: t => `Create 3 clearly different variations of the animation of ${t} (for example snappy, bouncy, elegant). For each: build it, then save_variation with a short label like "A · Snappy" and a one-line note. Check the last one with contact_sheet. Reply with one line per variation.` },
  { id: 'critique', label: 'Critique', title: 'Feedback like a senior motion designer (no edits)', mode: 'ask', minSel: 0, prompt: t => `Critique ${t} like a senior motion designer. Look at it with contact_sheet and get_animation, then give 3-5 concrete, prioritized suggestions (timing, easing, spacing, overlap, hierarchy, polish). Number them so I can say "do 1 and 3".` },
  { id: 'explain', label: 'Explain', title: 'How does this animation work? (no edits)', mode: 'ask', minSel: 0, prompt: t => `Explain briefly how ${t} works: what moves when, which eases are used and why it feels the way it does.` },
];

/** "the selected layers (Logo, Title)" / "the whole animation" */
export function targetPhrase(store: Store): string {
  const names = store.selection.map(id => store.layer(id)?.name).filter(Boolean) as string[];
  if (!names.length) return 'the whole animation';
  const shown = names.slice(0, 4).map(n => `"${n}"`).join(', ') + (names.length > 4 ? ` and ${names.length - 4} more` : '');
  return names.length === 1 ? `the selected layer ${shown}` : `the selected layers ${shown}`;
}

export function availableActions(selCount: number): QuickAction[] {
  return QUICK_ACTIONS.filter(a => selCount >= a.minSel && !(a.id === 'animate-in' && selCount === 0));
}

/** how big a brief is: picks the model in "auto" (strongest for pieces) and nothing else.
 *  edit = change what exists / quick action; build = one element or beat; piece = a directed,
 *  multi-beat piece (storyboard, style, explainer, promo, title sequence, long brief) */
export function briefScope(text: string, opts: { chip?: string; selCount?: number; style?: boolean } = {}): 'edit' | 'build' | 'piece' {
  const t = text.toLowerCase();
  if (/<storyboard>|storyboard approved/.test(t) || opts.style) return 'piece';
  if (opts.chip) return /variation/i.test(opts.chip) ? 'build' : 'edit';
  if (/storyboard|explainer|promo|title sequence|intro|trailer|teaser|commercial|\bad\b|beats?\b|scenes?\b|kinetic|style|full piece|video|(\d{2}|[5-9])\s*(s|sec|seconds)\b/.test(t) || t.length > 280) return 'piece';
  if ((opts.selCount ?? 0) > 0 && t.length < 160) return 'edit';
  if (/^(make|set|change|move|slow|speed|add (a )?(bit|little)|more|less|fix|tweak|nudge|bouncier|snappier|smoother)\b/.test(t)) return 'edit';
  return 'build';
}
