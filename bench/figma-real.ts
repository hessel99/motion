// runs real figma clipboard captures (from darknoon/figma-format-parse test data) through our importer
import { readFileSync, readdirSync } from 'node:fs';
import { parseFigmaClipboard, extractFigmaBuffer, decodeFigKiwi } from '../src/import/figma';
const dir = process.argv[2];
for (const f of readdirSync(dir).filter(f => f.endsWith('.html'))) {
  const html = readFileSync(dir + '/' + f, 'utf8');
  try {
    const raw = extractFigmaBuffer(html);
    let types = '';
    if (raw) {
      const { message } = decodeFigKiwi(raw.buffer);
      const counts: Record<string, number> = {};
      for (const n of message.nodeChanges ?? []) counts[n.type] = (counts[n.type] || 0) + 1;
      types = JSON.stringify(counts);
    }
    const t0 = performance.now();
    const res = parseFigmaClipboard(html);
    const ms = (performance.now() - t0).toFixed(1);
    console.log(`${f}: ${res ? `${res.layers.length} layers, roots ${res.roots.length}, ${ms}ms` : 'null'}  nodes ${types}`);
    if (res) for (const l of res.layers.slice(0, 6)) console.log('   ', l.type, JSON.stringify(l.name), 'pos', l.props.position?.v.map(v => +v.toFixed(1)), 'size', l.props.size?.v.map(v => +v.toFixed(1)), 'fill', l.props.fill?.v.map(v => +v.toFixed(2)), l.text ? JSON.stringify(l.text.content.slice(0, 30)) : '', l.geometry ? `geom ${l.geometry.length}` : '');
  } catch (e: any) {
    console.log(`${f}: ERROR ${e.message}`);
  }
}
