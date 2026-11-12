// imports real-world lottie files (bodymovin exports from after effects) and reports what came through
import { readFileSync, readdirSync } from 'node:fs';
import { lottieToProject, type LottieImportStats } from '../src/import/lottie';
const dir = process.argv[2];
for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
  try {
    const json = JSON.parse(readFileSync(dir + '/' + f, 'utf8'));
    lottieToProject(JSON.parse(JSON.stringify(json)), f); // warm up the jit
    const st: LottieImportStats = { mattes: 0, invertedMattes: 0, invertedApprox: 0, lumaMattes: 0, masks: 0, maskRegions: 0, animatedPaths: 0, trims: 0, expressions: 0, timeRemaps: 0, unsupported: {} };
    const t0 = performance.now();
    const p = lottieToProject(json, f, st);
    const ms = performance.now() - t0;
    const ls = Object.values(p.layers);
    const types: Record<string, number> = {};
    let animated = 0;
    for (const l of ls) { types[l.type] = (types[l.type] || 0) + 1; if (Object.values(l.props).some(x => x?.kf?.length) || l.pathKf?.length) animated++; }
    const c = p.comps[p.activeComp];
    console.log(`${f.padEnd(24)} ${ms.toFixed(1).padStart(6)}ms  comp ${c.width}x${c.height} ${c.fps}fps ${c.duration.toFixed(2)}s  lottie layers ${json.layers?.length}, ours ${ls.length} (${animated} animated) ${JSON.stringify(types)}`);
    const { unsupported, ...counts } = st;
    console.log(`${''.padEnd(32)}${Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}${Object.keys(unsupported).length ? '  | skipped: ' + Object.entries(unsupported).map(([k, v]) => `${k} ${v}`).join(', ') : ''}`);
  } catch (e: any) {
    console.log(`${f}: ERROR ${e.message}`);
  }
}
