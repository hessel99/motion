// the agent's provider / model / mode, shared by the composer's model picker and
// Settings > Models. same storage keys as before (motion.agent.provider / .model / .mode).
// listeners: editor channel 'agent-prefs'.

import { editor } from '../../app/editor';
import type { ChatMode } from '../../agent/client';

const STORAGE = 'motion.agent';
const pref = (k: string, d: string) => { try { return localStorage.getItem(STORAGE + '.' + k) || d; } catch { return d; } };
const save = (k: string, v: string) => { try { localStorage.setItem(STORAGE + '.' + k, v); } catch { /* */ } };

export const agentPrefs = {
  provider: pref('provider', 'claude'),
  /** claude model alias ('' = the CLI's default) */
  model: pref('model', ''),
  mode: (pref('mode', 'edit') === 'ask' ? 'ask' : 'edit') as ChatMode,
  /** model "auto": the alias used for full pieces (storyboards, styles, multi-beat briefs) */
  autoFull: pref('autoFull', 'opus'),
  /** model "auto": the alias used for edits, quick actions and small builds */
  autoQuick: pref('autoQuick', 'sonnet'),
  /** storyboards: 'ask' = wait for the user's approval, 'auto' = build right away (read by src/agent/storyboard.ts) */
  storyboard: (pref('storyboard', 'ask') === 'auto' ? 'auto' : 'ask') as 'ask' | 'auto',
  /** max agentic turns per message ('' = the bridge default) */
  turns: pref('turns', ''),
};

export function setAgentPref<K extends keyof typeof agentPrefs>(k: K, v: (typeof agentPrefs)[K]) {
  agentPrefs[k] = v;
  save(k, v);
  editor.emit('agent-prefs');
}

/** claude models the CLI accepts as aliases */
export const CLAUDE_MODELS: { id: string; label: string; hint: string }[] = [
  { id: '', label: 'Default', hint: "Your Claude Code default" },
  { id: 'auto', label: 'Auto', hint: 'Strongest for full pieces, faster for edits' },
  { id: 'opus', label: 'Opus', hint: 'Most capable, slower' },
  { id: 'sonnet', label: 'Sonnet', hint: 'Fast and capable' },
  { id: 'haiku', label: 'Haiku', hint: 'Fastest, lightest' },
];

export const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };

/** short label for the picker: "Opus", "Claude", "Codex" */
export function modelLabel(provider = agentPrefs.provider, model = agentPrefs.model) {
  if (provider === 'claude') return model ? CLAUDE_MODELS.find(m => m.id === model)?.label ?? model : 'Claude';
  return PROVIDER_LABEL[provider] ?? provider;
}

/** the claude model alias to run a message with: "auto" picks by scope (see briefScope) */
export function resolveModel(scope: 'edit' | 'build' | 'piece', model = agentPrefs.model): string | undefined {
  if (model !== 'auto') return model || undefined;
  const m = scope === 'piece' ? agentPrefs.autoFull : agentPrefs.autoQuick;
  return m && m !== 'auto' ? m : undefined;
}

/** turn budget to send with a message (undefined = bridge default) */
export function turnBudget(): number | undefined {
  const n = parseInt(agentPrefs.turns, 10);
  return n > 0 ? n : undefined;
}
