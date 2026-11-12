// fetch the fidelity test file through the figma REST api instead of the mcp/plugin route:
// node json (geometry=paths) + ground-truth renders at 1x / 2x + image fill bytes, written in the
// same layout unpack.mjs produces (bench/results/figma-truth/rest-<section>/), with format "rest" so
// the runner converts it with restNodesToMessage.
//
//   FIGMA_TOKEN=figd_... node scripts/figma-fidelity/rest-fetch.mjs <fileKey> [--sections paint,text]
//
// the token is a personal access token (figma settings -> security), read scope on file content is
// enough. it is only sent to api.figma.com, never written anywhere. needs network access to
// api.figma.com (and the s3 render / image urls the api answers with).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const KEY = args.find(a => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ONLY = opt('sections', '') ? new Set(opt('sections', '').split(',')) : null;
const OUT = resolve(opt('out', 'bench/results/figma-truth'));
const TOKEN = process.env.FIGMA_TOKEN;
if (!KEY || !TOKEN) { console.error('usage: FIGMA_TOKEN=... node scripts/figma-fidelity/rest-fetch.mjs <fileKey> [--sections a,b]'); process.exit(2); }

const api = async path => {
  const r = await fetch('https://api.figma.com' + path, { headers: { 'X-Figma-Token': TOKEN } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
const bytes = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return Buffer.from(await r.arrayBuffer()); };

// sections (top-level SECTION nodes) and their frames
const file = await api(`/v1/files/${KEY}?depth=3`);
const page = file.document.children[0];
const sections = page.children.filter(n => n.type === 'SECTION' && (!ONLY || ONLY.has(n.name)));
const fills = (await api(`/v1/files/${KEY}/images`)).meta?.images ?? {};
for (const sec of sections) {
  const frames = (sec.children ?? []).filter(n => n.type === 'FRAME');
  if (!frames.length) continue;
  const ids = frames.map(f => f.id).join(',');
  const nodes = (await api(`/v1/files/${KEY}/nodes?ids=${encodeURIComponent(ids)}&geometry=paths`)).nodes;
  const dir = join(OUT, 'rest-' + sec.name);
  mkdirSync(join(dir, 'truth'), { recursive: true });
  const images = {};
  const refs = new Set();
  JSON.stringify(nodes, (k, v) => { if (k === 'imageRef' && typeof v === 'string') refs.add(v); return v; });
  for (const ref of refs) if (fills[ref]) images[ref] = (await bytes(fills[ref])).toString('base64');
  for (const s of [1, 2]) {
    const urls = (await api(`/v1/images/${KEY}?ids=${encodeURIComponent(ids)}&scale=${s}&format=png`)).images;
    for (const f of frames) if (urls[f.id]) writeFileSync(join(dir, 'truth', f.name.replace(/\//g, '__') + `@${s}x.png`), await bytes(urls[f.id]));
  }
  const meta = { kind: 'motion-figma-fidelity-dump', version: 2, format: 'rest', fileKey: KEY, section: sec.name, images, frames: frames.map(f => {
    const doc = nodes[f.id]?.document ?? f;
    return { name: f.name, id: f.id, w: doc.size?.x ?? doc.absoluteBoundingBox?.width, h: doc.size?.y ?? doc.absoluteBoundingBox?.height, node: doc };
  }) };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  console.log(`${sec.name}: ${frames.length} frames -> ${dir}`);
}
