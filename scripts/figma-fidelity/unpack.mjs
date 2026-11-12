// unpacks the "data png" chunks written by scripts/figma-fidelity/build/90-dump.js (run through the
// figma mcp use_figma tool, which returns io.write images as files) into
// bench/results/figma-truth/<section>/{meta.json,truth/*.png}.
// usage: node scripts/figma-fidelity/unpack.mjs <dir-or-png>... [--out bench/results/figma-truth]
// chunks may be spread over several directories / runs; the newest export of a section wins.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

const args = process.argv.slice(2);
let out = resolve('bench/results/figma-truth');
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = resolve(args[++i]);
  else inputs.push(args[i]);
}
if (!inputs.length) { console.error('usage: unpack.mjs <dir-or-png>... [--out dir]'); process.exit(2); }

/** decode an 8-bit rgba png with filter type 0 rows (what the dump writes) */
export function decodeDataPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  let o = 8, w = 0, h = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(o + 8); h = buf.readUInt32BE(o + 12); if (buf[o + 16] !== 8 || buf[o + 17] !== 6) return null; }
    else if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 4), stride = w * 4 + 1;
  for (let y = 0; y < h; y++) {
    if (raw[y * stride] !== 0) return null; // not one of ours
    raw.copy(px, y * w * 4, y * stride + 1, (y + 1) * stride);
  }
  return px;
}

function* pngs(p) {
  const st = statSync(p);
  if (st.isDirectory()) { for (const f of readdirSync(p)) if (f.endsWith('.png')) yield join(p, f); }
  else yield p;
}

const groups = new Map(); // key section|total -> { section, count, total, chunks: Map, mtime }
for (const inp of inputs) {
  for (const f of pngs(inp)) {
    const buf = readFileSync(f);
    if (buf.length < 64) continue;
    let px;
    try { px = decodeDataPng(buf); } catch { continue; }
    if (!px || px.toString('latin1', 0, 4) !== 'MFC1') continue;
    const idx = px.readUInt32BE(4), count = px.readUInt32BE(8), total = px.readUInt32BE(12), nl = px[16];
    const section = px.toString('utf8', 17, 17 + nl);
    const CHUNK = 560000;
    const len = Math.min(CHUNK, total - idx * CHUNK);
    const data = px.subarray(17 + nl, 17 + nl + len);
    const key = `${section}|${total}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { section, count, total, chunks: new Map(), mtime: 0 }));
    g.chunks.set(idx, data);
    g.mtime = Math.max(g.mtime, statSync(f).mtimeMs);
  }
}

// newest complete group per section
const best = new Map();
const incomplete = [];
for (const g of groups.values()) {
  if (g.chunks.size !== g.count) { incomplete.push(`${g.section}: have ${[...g.chunks.keys()].sort((a, b) => a - b).join(',')} of ${g.count}`); continue; }
  const cur = best.get(g.section);
  if (!cur || g.mtime > cur.mtime) best.set(g.section, g);
}
for (const g of best.values()) {
  const box = Buffer.alloc(g.total);
  for (const [i, d] of g.chunks) d.copy(box, i * 560000);
  if (box.toString('latin1', 0, 4) !== 'MFD2') { console.error(`${g.section}: bad container`); continue; }
  const n = box.readUInt32BE(4);
  let o = 8;
  const dir = join(out, g.section);
  for (let k = 0; k < n; k++) {
    const kl = box.readUInt32BE(o), name = box.toString('utf8', o + 4, o + 4 + kl); o += 4 + kl;
    const dl = box.readUInt32BE(o), data = box.subarray(o + 4, o + 4 + dl); o += 4 + dl;
    // frame names contain "/" (category/feature): keep them as flat file names
    const file = name.startsWith('truth/') ? join(dir, 'truth', name.slice(6).replace(/\//g, '__')) : join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  console.log(`${g.section}: ${n - 1} truth images + meta.json -> ${dir}`);
}
for (const s of incomplete) if (!best.has(s.split(':')[0])) console.log(`incomplete: ${s}`);
if (!best.size && !incomplete.length) console.log('no fidelity chunks found');
void existsSync;
