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
};

export function setAgentPref<K extends keyof typeof agentPrefs>(k: K, v: (typeof agentPrefs)[K]) {
  agentPrefs[k] = v;
  save(k, v);
  editor.emit('agent-prefs');
}

/** claude models the CLI accepts as aliases */
export const CLAUDE_MODELS: { id: string; label: string; hint: string }[] = [
  { id: '', label: 'Default', hint: "Your Claude Code default" },
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
