import { readFileSync } from 'node:fs';
import { extractFigmaBuffer, decodeFigKiwi } from '../src/import/figma';
const raw = extractFigmaBuffer(readFileSync(process.argv[2], 'utf8'))!;
const { message } = decodeFigKiwi(raw.buffer);
for (const n of message.nodeChanges) if (n.type === (process.argv[3] || 'VECTOR')) {
  const short = (v: any): any => v instanceof Uint8Array ? `<bytes ${v.length}>` : Array.isArray(v) ? v.slice(0, 4).map(short) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, short(x)])) : v;
  console.log(JSON.stringify(short(n), null, 1).slice(0, 4000));
}
console.log('blobs', message.blobs?.length);
