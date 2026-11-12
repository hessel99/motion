import { readFileSync } from 'node:fs';
import { parseAep, aepToProject } from '../src/import/aep';
for (const f of process.argv.slice(2)) {
  const buf = readFileSync(f);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try {
    const t0 = performance.now();
    const raw: any = parseAep(ab);
    const p = aepToProject(ab);
    const ms = performance.now() - t0;
    console.log(`\n== ${f.split('/').pop()}  ${(buf.length / 1024).toFixed(0)}KB  ${ms.toFixed(1)}ms  warnings: ${(raw.warnings ?? []).length}`);
    for (const c of Object.values(p.comps)) console.log(`  comp "${c.name}" ${c.width}x${c.height} ${c.fps}fps ${c.duration.toFixed(2)}s root=${c.root.length}`);
    const ls = Object.values(p.layers);
    const types: Record<string, number> = {};
    let kfs = 0, animated = 0;
    for (const l of ls) { types[l.type] = (types[l.type] || 0) + 1; const n = Object.values(l.props).reduce((s, x) => s + (x?.kf?.length ?? 0), 0); kfs += n; if (n) animated++; }
    console.log(`  layers ${ls.length} ${JSON.stringify(types)}  animated ${animated}  keyframes ${kfs}`);
    for (const l of ls.filter(l => Object.values(l.props).some(x => x?.kf?.length)).slice(0, 6)) {
      const anim = Object.entries(l.props).filter(([, x]) => x?.kf?.length).map(([k, x]) => `${k}:${x!.kf!.map(f => `${f.t.toFixed(2)}s=${f.v.map(v => +v.toFixed(1)).join('/')}${f.interp === 'hold' ? 'H' : ''}`).join(' ')}`);
      console.log(`   - ${l.type} "${l.name}": ${anim.join(' | ').slice(0, 220)}`);
    }
    if (raw.warnings?.length) console.log('  warnings:', raw.warnings.slice(0, 5));
  } catch (e: any) { console.log(f, 'ERROR', e.message); }
}
