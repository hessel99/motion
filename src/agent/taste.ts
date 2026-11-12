// the taste layer: quality that comes from the app, not from the model or the user.
//  - a setting (on by default): Settings → Models → Directing → "Polish automatically"
//  - quality-first defaults for the high-level tools when the model leaves timing / eases / stagger
//    unspecified (handbook timing tables by size, distance and role; the style's easing family)
//  - the automatic critique loop: after a build, the critic (critic.ts) scores the piece and the top
//    fixes go back to the agent as a follow-up (max 2 rounds), the same for every CLI provider.
// docs: docs/taste-layer.md

import type { Store } from '../core/store';
import { critique, formatCritique, type Critique, type Issue } from './critic';
import { storyboards } from './storyboard';

const PREF = 'motion.agent.taste';

/** taste layer on? (default on). the eval harness can force it with globalThis.__motionTaste */
export function tasteOn(): boolean {
  const g = (globalThis as any).__motionTaste;
  if (typeof g === 'boolean') return g;
  try { return localStorage.getItem(PREF) !== 'off'; } catch { return true; }
}
/** tools only advertised with the taste layer on, and the get_guide sentence about the gold examples */
export const TASTE_TOOLS = ['critique'];
export const TASTE_GUIDE_HINT = ' "examples" + brief: the 1-2 most similar proven pieces (brief, exact tool-call sequence, why it works) — imitate them.';
export function setTaste(on: boolean) { try { localStorage.setItem(PREF, on ? 'on' : 'off'); } catch { /* */ } }

// ---------------------------------------------------------------- feel (style → easing family, tempo)

export interface Feel {
  name: string;
  /** entrance / exit / on-screen ease names (our presets) */
  enter: string; exit: string; move: string;
  /** big entrances settle with this (an overshooting curve or a spring), '' = none */
  settle: string;
  /** duration multiplier vs the handbook table (luxury 1.3, snappy 0.8) */
  tempo: number;
  /** stagger step for lists */
  step: number;
}
// eases follow the handbook "Easing vocabulary" table and each style recipe's "Easing & timing"
const FEELS: { match: RegExp; feel: Feel }[] = [
  { match: /lux|editorial|calm|elegant/i, feel: { name: 'calm', enter: 'Sine Out', exit: 'Sine In', move: 'Sine In Out', settle: '', tempo: 1.35, step: 0.12 } },
  { match: /swiss|brutal|data|chart|kinetic/i, feel: { name: 'precise', enter: 'Expo Out', exit: 'Expo In', move: 'Quart In Out', settle: '', tempo: 0.9, step: 0.07 } },
  { match: /play|bouncy|cartoon|sticker|paper|blob|liquid|y2k|flat|explainer/i, feel: { name: 'playful', enter: 'Back Out', exit: 'Back In', move: 'Cubic In Out', settle: 'spring:0.35', tempo: 1, step: 0.08 } },
  { match: /glitch|retro|neon|cyber/i, feel: { name: 'snappy', enter: 'Expo Out', exit: 'Expo In', move: 'Expo In Out', settle: '', tempo: 0.75, step: 0.05 } },
  { match: /corporate|smooth|ui|product|parallax/i, feel: { name: 'smooth', enter: 'Quart Out', exit: 'Cubic In', move: 'Cubic In Out', settle: 'Settle', tempo: 1, step: 0.08 } },
];
const NEUTRAL: Feel = { name: 'neutral', enter: 'Quart Out', exit: 'Cubic In', move: 'Cubic In Out', settle: 'Settle', tempo: 1, step: 0.08 };
/** a gentle ~4% overshoot-and-settle curve for big entrances (cubic-bezier) */
export const SETTLE_CURVE: [number, number, number, number] = [0.22, 1.12, 0.36, 1];

let lastStyle = '';
/** remember the style recipe the agent loaded (get_guide "styles/<name>"): it sets the feel */
export function noteStyle(name: string) { lastStyle = name; }

/** the piece's feel: the storyboard's style, else the last style guide loaded, else neutral */
export function feel(): Feel {
  const s = `${storyboards.current?.style ?? ''} ${lastStyle}`;
  return FEELS.find(f => f.match.test(s))?.feel ?? NEUTRAL;
}
/** the feel as the logo critic's pace (timing ranges of logo stings) */
export function logoPace(): 'fast' | 'medium' | 'calm' { const n = feel().name; return n === 'calm' ? 'calm' : n === 'snappy' ? 'fast' : 'medium'; }

/** an ease name of the feel as the tool format accepts it */
export function easeArg(e: string): any { return e === 'Settle' ? SETTLE_CURVE : e; }

// ---------------------------------------------------------------- timing table (handbook §2)

/** comp scale factor: distances in the tables are for 1080p */
export const unit = (store: Store) => Math.min(store.comp.width, store.comp.height) / 1080;

/** seconds for one entrance of an element: by travel distance, size and role (handbook §2) */
export function moveDuration(store: Store, o: { distance?: number; size?: number; role?: 'primary' | 'secondary' | 'text' | 'decoration'; exit?: boolean }): number {
  const u = unit(store);
  let d: number;
  if (o.distance && o.distance > 1) d = Math.min(1, 0.25 + o.distance / u / 2000);
  else {
    const sz = (o.size ?? 200) / u;
    d = sz <= 120 ? 0.32 : sz <= 400 ? 0.5 : sz <= 900 ? 0.7 : 0.9;
  }
  if (o.role === 'decoration') d *= 0.8;
  if (o.exit) d *= 0.7;
  d *= feel().tempo;
  return Math.round(Math.max(0.15, Math.min(1.4, d)) * 100) / 100;
}

/** the default ease of a keyframe segment the model left unspecified: entrances decelerate, exits
 *  accelerate, on-screen moves ease both ends; opacity fades softer. null = keep the old default */
export function defaultEaseFor(key: string, from: number[], to: number[]): any {
  if (!tasteOn()) return null;
  const f = feel();
  if (key === 'opacity') return to[0] > from[0] ? 'Ease Out' : 'Ease In';
  if (key === 'scale') {
    const a = Math.max(from[0], from[1] ?? from[0]), b = Math.max(to[0], to[1] ?? to[0]);
    if (a < 60 && b >= 80) return easeArg(f.settle && b - a >= 60 ? f.settle : f.enter);
    if (b < 60 && a >= 80) return f.exit;
    return f.move;
  }
  if (key === 'trimEnd' || key === 'trimStart') return 'Cubic In Out';
  if (key === 'fill' || key === 'stroke') return 'Cubic In Out';
  if (key === 'position' || key === 'rotation' || key === 'size') return f.move;
  return null;
}

// ---------------------------------------------------------------- automatic critique loop

export const POLISH = {
  /** follow up when the score is below this, or when a high-severity issue is left */
  threshold: 80,
  maxRounds: 2,
  /** fixes per round */
  maxFixes: 3,
};

export interface PolishPlan { message: string; count: number; score: number; issues: Issue[]; critique: Critique }

/** the follow-up for polishing round `round` (1-based), or null when the piece is good enough */
export function polishPlan(store: Store, round: number, opts: { fontOk?: (f: string) => boolean } = {}): PolishPlan | null {
  if (round > POLISH.maxRounds) return null;
  const c = critique(store, { max: 20, fontOk: opts.fontOk, pace: logoPace() });
  if (!c.stats.animated) return null;
  const high = c.issues.filter(i => i.severity === 'high');
  if (c.score >= POLISH.threshold && !high.length) return null;
  // the worst first; skip summary lines without a fix unless they are high
  const pick = c.issues.filter(i => i.fix.length || i.severity === 'high').slice(0, POLISH.maxFixes);
  if (!pick.length) return null;
  const shown: Critique = { ...c, issues: pick };
  const message = [
    `[Automatic quality check · polishing round ${round} of ${POLISH.maxRounds}] The editor's motion critic scored the piece ${c.score}/100. Fix these ${pick.length} issue${pick.length > 1 ? 's' : ''} (worst first).`,
    'The → lines are tool calls that work as written: run them, or a better fix for the same problem. Keep everything else (content, layout, the brief\'s duration). Then call critique once to verify and reply with ONE short line, no summary.',
    '',
    formatCritique(shown, { max: POLISH.maxFixes }).split('\n').slice(1).join('\n'),
  ].join('\n');
  return { message, count: pick.length, score: c.score, issues: pick, critique: c };
}

/** a short critic note for one storyboard beat (appended to update_progress "done") */
export function beatNote(store: Store, range: [number, number]): string {
  if (!tasteOn()) return '';
  const c = critique(store, { range, max: 3, pace: logoPace() });
  const worst = c.issues.filter(i => i.severity !== 'low').slice(0, 2);
  if (!worst.length) return '';
  return `\ncritic on this beat (${Math.round(range[0] * 100) / 100}–${Math.round(range[1] * 100) / 100}s): ${worst.map(i => `[${i.severity}] ${i.message}${i.fix[0] ? ` → ${i.fix[0].tool} ${JSON.stringify(i.fix[0].args)}` : ''}`).join(' | ')}. Fix before the next beat if it is quick.`;
}
