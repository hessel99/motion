// gold examples (src/agent/guides/examples/*.md): parse the tool-call sequence of an example and
// replay it (tests, scripts/gold-examples.ts). "<key>" strings in arguments are the ids build_scene
// returned for that key (the model sees the same convention in the example text).

import { EXAMPLES, type Guide } from './guides';

export interface ExampleCall { tool: string; args: any }

/** the ```json tool-call array under "## Tool calls" */
export function exampleCalls(g: Guide): ExampleCall[] {
  const sec = g.text.split(/^## /m).find(p => /^Tool calls/i.test(p));
  const m = sec?.match(/```json\s*([\s\S]*?)```/);
  if (!m) throw new Error(`${g.name}: no json block under "## Tool calls"`);
  const calls = JSON.parse(m[1]);
  if (!Array.isArray(calls) || !calls.every(c => c && typeof c.tool === 'string' && c.args && typeof c.args === 'object')) throw new Error(`${g.name}: tool calls must be [{tool, args}]`);
  return calls;
}

/** "<key>" → id, recursively */
export function resolveKeys(v: any, ids: Record<string, string>): any {
  if (typeof v === 'string') { const m = v.match(/^<([\w-]+)>$/); if (m) { if (!ids[m[1]]) throw new Error(`unknown key <${m[1]}>`); return ids[m[1]]; } return v; }
  if (Array.isArray(v)) return v.map(x => resolveKeys(x, ids));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveKeys(x, ids)]));
  return v;
}

/** run an example's calls through a tool runner; returns the key → id map */
export async function replayExample(g: Guide, run: (tool: string, args: any) => Promise<string>): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const c of exampleCalls(g)) {
    const out = await run(c.tool, resolveKeys(c.args, ids));
    if (c.tool === 'build_scene') { try { Object.assign(ids, JSON.parse(out).ids); } catch { /* */ } }
  }
  return ids;
}

export { EXAMPLES };
