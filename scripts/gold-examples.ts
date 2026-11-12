// Replays the gold examples (src/agent/guides/examples/*.md) headless and prints the critic's verdict.
//   npx vite-node scripts/gold-examples.ts [name-filter] [--verbose]
// Contact sheets of the same replays in the real renderer: node scripts/gold-examples-shots.mjs
import { TOOLS } from '../src/agent/tools';
import { editor } from '../src/app/editor';
import { createProject } from '../src/core/model';
import { EXAMPLES, replayExample } from '../src/agent/examples';
import { critique, formatCritique } from '../src/agent/critic';

const only = process.argv.slice(2).find(a => !a.startsWith('--'));
const verbose = process.argv.includes('--verbose');
const run = async (name: string, args: any) => {
  const t = TOOLS.find(x => x.name === name);
  if (!t) throw new Error(`unknown tool ${name}`);
  try {
    const c = await t.run(args);
    return c[0]?.type === 'text' ? c[0].text : '';
  } catch (e: any) {
    // headless: no music track (the browser replay, gold-examples-shots.mjs, loads one)
    if (/no audio layer/.test(e.message)) return '';
    throw e;
  }
};
for (const g of EXAMPLES.filter(e => !only || e.name.includes(only))) {
  editor.store.load(createProject());
  try {
    await replayExample(g, run);
    const c = critique(editor.store, { max: 12 });
    console.log(`${g.name.padEnd(40)} ${c.score}${c.stats.logo ? '  (logo mode)' : ''}`);
    if (verbose || c.score < 85) console.log(formatCritique(c, { max: 12 }).split('\n').map(l => '   ' + l).join('\n'));
  } catch (e: any) { console.log(`${g.name.padEnd(40)} FAILED ${e.message}`); }
}
