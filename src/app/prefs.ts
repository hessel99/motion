// app preferences (Settings > Appearance / Models), persisted per machine in localStorage.
// read them as plain properties (`prefs.pixelGrid`): no lookups on hot paths. setPref() saves,
// applies side effects and emits editor 'prefs' so panels and the viewport overlay refresh.

import { editor } from './editor';

export interface Prefs {
  /** draw the comp's pixel grid when zoomed to 400% or more */
  pixelGrid: boolean;
  /** moved layers land on whole pixels */
  snapToPixels: boolean;
  /** fewer animations in panels and menus (also follows the OS setting) */
  reduceMotion: boolean;
  /** stub: short ui sounds (not wired to audio yet) */
  interfaceSounds: boolean;
  /** a sound when an agent run finishes (stub) */
  agentSound: boolean;
}

const KEY = 'motion.prefs';
const DEFAULTS: Prefs = { pixelGrid: true, snapToPixels: false, reduceMotion: false, interfaceSounds: false, agentSound: false };

function load(): Prefs {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

export const prefs: Prefs = load();

function applySideEffects() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (prefs.reduceMotion) root.dataset.reduceMotion = ''; else delete root.dataset.reduceMotion;
}
applySideEffects();

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  prefs[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  applySideEffects();
  editor.emit('prefs');
}
