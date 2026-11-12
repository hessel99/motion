// dump one section: node data (plugin api json, the shape src/import/figma/rest.ts reads) plus the
// ground-truth renders of every frame at 1x and 2x, packed into a binary container that is split
// into "data pngs" (raw bytes in rgba pixels) which use_figma hands back as image files.
// use_figma can't return more than 48KB of text, but io.write images come back byte-exact (up to
// ~1MB each, ~3MB per call), so this is the only bulk channel out of the plugin sandbox.
// decode with scripts/figma-fidelity/unpack.mjs. set SECTION (and optionally CHUNKS = [i, ...] to
// re-emit only some chunks, 4 per call) before running.
const MIXED = v => (typeof v === 'symbol' ? 'MIXED' : v);
const KEYS = ['visible', 'opacity', 'blendMode', 'isMask', 'maskType', 'width', 'height', 'rotation', 'relativeTransform', 'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'strokeCap', 'strokeJoin', 'strokeMiterLimit', 'dashPattern',
  'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight', 'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius', 'cornerSmoothing', 'effects', 'clipsContent',
  'arcData', 'booleanOperation', 'pointCount', 'innerRadius', 'fillGeometry', 'strokeGeometry', 'characters', 'fontSize', 'fontName', 'fontWeight', 'textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'textTruncation', 'maxLines',
  'letterSpacing', 'lineHeight', 'textCase', 'textDecoration', 'paragraphSpacing', 'paragraphIndent', 'leadingTrim', 'layoutMode', 'constrainProportions'];
const images = {};
async function ser(n) {
  const o = { id: n.id, type: n.type, name: n.name };
  for (const k of KEYS) {
    if (!(k in n)) continue;
    try { const v = n[k]; if (v !== undefined) o[k] = JSON.parse(JSON.stringify(MIXED(v))); } catch (e) { /* unreadable on this node */ }
  }
  if (n.type === 'VECTOR') { try { o.vectorNetwork = JSON.parse(JSON.stringify(n.vectorNetwork)); } catch (e) {} }
  if (n.type === 'TEXT') {
    try { o.segments = JSON.parse(JSON.stringify(n.getStyledTextSegments(['fontName', 'fontSize', 'fontWeight', 'fills', 'textDecoration', 'textCase', 'letterSpacing', 'lineHeight', 'listOptions', 'indentation', 'paragraphSpacing']))); } catch (e) {}
  }
  if (n.type === 'INSTANCE') { try { const m = await n.getMainComponentAsync(); o.mainComponent = m ? { id: m.id, name: m.name } : null; } catch (e) {} }
  for (const list of [o.fills, o.strokes]) if (Array.isArray(list)) for (const p of list) {
    if (p.type === 'IMAGE' && p.imageHash && !images[p.imageHash]) {
      const im = figma.getImageByHash(p.imageHash);
      if (im) images[p.imageHash] = figma.base64Encode(await im.getBytesAsync());
    }
  }
  if ('children' in n) { o.children = []; for (const c of n.children) o.children.push(await ser(c)); }
  return o;
}
function utf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00); }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}
const sec = figma.currentPage.children.find(n => n.type === 'SECTION' && n.name === SECTION);
if (!sec) throw new Error('no section ' + SECTION);
// binary container: "MFD2", u32 entry count, entries of [u32 name len][name][u32 data len][data]
const entries = [];
const frames = [];
for (const f of sec.children) {
  if (f.type !== 'FRAME') continue;
  frames.push({ name: f.name, id: f.id, w: f.width, h: f.height, node: await ser(f) });
  for (const s of [1, 2]) entries.push(['truth/' + f.name + '@' + s + 'x.png', await f.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: s } })]);
}
const meta = { kind: 'motion-figma-fidelity-dump', version: 2, fileKey: figma.fileKey, section: SECTION, frames, images };
entries.unshift(['meta.json', utf8(JSON.stringify(meta))]);
let total = 8;
for (const [k, d] of entries) total += 8 + utf8(k).length + d.length;
const box = new Uint8Array(total), bv = new DataView(box.buffer);
box.set([0x4d, 0x46, 0x44, 0x32]); bv.setUint32(4, entries.length);
let o = 8;
for (const [k, d] of entries) { const kb = utf8(k); bv.setUint32(o, kb.length); box.set(kb, o + 4); o += 4 + kb.length; bv.setUint32(o, d.length); box.set(d, o + 4); o += 4 + d.length; }
// split into data pngs of <= CHUNK bytes (use_figma drops images around 1MB): chunk header
// "MFC1", u32 index, u32 count, u32 total, u8 name len, section name, then the slice
const CHUNK = 560000, count = Math.ceil(total / CHUNK), nameB = utf8(SECTION), written = [];
const only = typeof CHUNKS !== 'undefined' ? CHUNKS : null;
for (let i = 0; i < count; i++) {
  if (only && !only.includes(i)) continue;
  const slice = box.subarray(i * CHUNK, Math.min(total, (i + 1) * CHUNK));
  const head = 17 + nameB.length, len = head + slice.length;
  const WD = 1024, HT = Math.ceil(len / 4 / WD), px = new Uint8Array(WD * HT * 4), dv = new DataView(px.buffer);
  px.set([0x4d, 0x46, 0x43, 0x31]); dv.setUint32(4, i); dv.setUint32(8, count); dv.setUint32(12, total); px[16] = nameB.length; px.set(nameB, 17);
  px.set(slice, head);
  figma.io.write('fidelity-' + SECTION + '-' + i + '.png', png(WD, HT, px));
  written.push(i);
}
return { section: SECTION, frames: frames.length, bytes: total, chunks: count, written };
