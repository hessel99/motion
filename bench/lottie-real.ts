// imports real-world lottie files (bodymovin exports from after effects) and reports what came through
import { readFileSync, readdirSync } from 'node:fs';
import { lottieToProject } from '../src/import/lottie';
const dir = process.argv[2];
for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
  try {
    const json = JSON.parse(readFileSync(dir + '/' + f, 'utf8'));
    const t0 = performance.now();
    const p = lottieToProject(json, f);
    const ms = performance.now() - t0;
    const ls = Object.values(p.layers);
    const types: Record<string, number> = {};
    let animated = 0;
    for (const l of ls) { types[l.type] = (types[l.type] || 0) + 1; if (Object.values(l.props).some(x => x?.kf?.length)) animated++; }
    const c = p.comps[p.activeComp];
    console.log(`${f.padEnd(24)} ${ms.toFixed(1).padStart(6)}ms  comp ${c.width}x${c.height} ${c.fps}fps ${c.duration.toFixed(2)}s  lottie layers ${json.layers?.length}, ours ${ls.length} (${animated} animated) ${JSON.stringify(types)}`);
  } catch (e: any) {
    console.log(`${f}: ERROR ${e.message}`);
  }
}
