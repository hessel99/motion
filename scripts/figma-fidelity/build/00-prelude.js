// shared helpers for the figma test file builder. every part (01-*.js ...) is run through
// use_figma (figma plugin api) as `prelude + part`; parts are idempotent: they delete and rebuild
// their own section. everything here is synthetic (no external content).
const W = 400, H = 300, COLS = 8;
const hex = h => { h = h.replace('#', ''); return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 }; };
const solid = (h, o = 1) => ({ type: 'SOLID', color: hex(h), opacity: o });
const rgba = (h, a = 1) => ({ ...hex(h), a });
const stops = (...l) => l.map(([p, h, a = 1]) => ({ position: p, color: rgba(h, a) }));
// gradient transform: unit gradient space -> box. figma's gradientTransform is the inverse (box -> gradient)
function gradT(angleDeg = 0, cx = 0.5, cy = 0.5, sx = 1, sy = 1) {
  const a = (angleDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  // forward: p = C + R*S*(u - .5)
  const m = [[c * sx, -s * sy, 0], [s * sx, c * sy, 0]];
  m[0][2] = cx - (m[0][0] * 0.5 + m[0][1] * 0.5);
  m[1][2] = cy - (m[1][0] * 0.5 + m[1][1] * 0.5);
  const [[A, B, E], [C, D, F]] = m, det = A * D - B * C;
  return [[D / det, -B / det, (B * F - D * E) / det], [-C / det, A / det, (C * E - A * F) / det]];
}
const grad = (type, st, angle = 0, cx = 0.5, cy = 0.5, sx = 1, sy = 1, extra = {}) => ({ type, gradientStops: st, gradientTransform: gradT(angle, cx, cy, sx, sy), ...extra });
const created = [];
async function section(name) {
  for (const n of figma.currentPage.children) if (n.type === 'SECTION' && n.name === name) n.remove();
  let y = 0;
  for (const n of figma.currentPage.children) if (n.type === 'SECTION') y = Math.max(y, n.y + n.height + 200);
  const s = figma.createSection();
  s.name = name; s.x = 0; s.y = y;
  s.fills = [solid('#E9E9EE')];
  created.push(s.id);
  return s;
}
let cellIndex = 0;
function cell(sec, name, bg = '#FFFFFF') {
  const i = cellIndex++;
  const f = figma.createFrame();
  f.name = name; f.resize(W, H);
  f.fills = bg ? [solid(bg)] : [];
  f.clipsContent = true;
  sec.appendChild(f);
  f.x = 40 + (i % COLS) * 440; f.y = 80 + Math.floor(i / COLS) * 340;
  created.push(f.id);
  return f;
}
function finish(sec) {
  const n = cellIndex, rows = Math.ceil(n / COLS);
  sec.resizeWithoutConstraints(40 + Math.min(n, COLS) * 440, 80 + rows * 340);
  cellIndex = 0;
  return { section: sec.id, frames: n };
}
function rect(parent, x, y, w, h, fills, props = {}) {
  const r = figma.createRectangle();
  parent.appendChild(r);
  r.x = x; r.y = y; r.resize(w, h);
  r.fills = fills;
  Object.assign(r, props);
  return r;
}
function ellipse(parent, x, y, w, h, fills, props = {}) {
  const r = figma.createEllipse();
  parent.appendChild(r);
  r.x = x; r.y = y; r.resize(w, h);
  r.fills = fills;
  Object.assign(r, props);
  return r;
}
async function vec(parent, x, y, w, h, d, fills, props = {}, winding = 'NONZERO') {
  const v = figma.createVector();
  parent.appendChild(v);
  v.vectorPaths = [{ windingRule: winding, data: d }];
  v.x = x; v.y = y;
  if (w && h && v.width > 0 && v.height > 0) v.resize(w, h);
  v.fills = fills;
  Object.assign(v, props);
  return v;
}
const fontsLoaded = new Set();
async function font(family, style = 'Regular') {
  const k = family + '|' + style;
  if (!fontsLoaded.has(k)) { await figma.loadFontAsync({ family, style }); fontsLoaded.add(k); }
  return { family, style };
}
async function text(parent, x, y, chars, opts = {}) {
  const t = figma.createText();
  parent.appendChild(t);
  t.fontName = await font(opts.family ?? 'Inter', opts.style ?? 'Regular');
  t.characters = chars;
  t.fontSize = opts.size ?? 32;
  t.fills = opts.fills ?? [solid(opts.color ?? '#111111')];
  t.x = x; t.y = y;
  for (const k of ['textAlignHorizontal', 'textAlignVertical', 'letterSpacing', 'lineHeight', 'textDecoration', 'textCase', 'paragraphSpacing', 'paragraphIndent', 'textAutoResize']) if (opts[k] !== undefined) t[k] = opts[k];
  if (opts.w) { t.textAutoResize = opts.textAutoResize ?? 'HEIGHT'; t.resize(opts.w, opts.h ?? t.height); if (opts.textAutoResize) t.textAutoResize = opts.textAutoResize; }
  return t;
}
// tiny png encoder (stored deflate) so image fills are generated, not downloaded
function png(w, h, px) {
  const crcT = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b, s, e) => { let c = 0xffffffff; for (let i = s; i < e; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(px.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const blocks = Math.ceil(raw.length / 65535);
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let o = 0; z[o++] = 0x78; z[o++] = 0x01;
  for (let b = 0; b < blocks; b++) {
    const s = b * 65535, len = Math.min(65535, raw.length - s);
    z[o++] = b === blocks - 1 ? 1 : 0; z[o++] = len & 255; z[o++] = len >> 8; z[o++] = ~len & 255; z[o++] = (~len >> 8) & 255;
    z.set(raw.subarray(s, s + len), o); o += len;
  }
  let a = 1, bb = 0; for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; bb = (bb + a) % 65521; }
  z[o++] = bb >> 8; z[o++] = bb & 255; z[o++] = a >> 8; z[o++] = a & 255;
  const chunk = (type, data) => { const c = new Uint8Array(12 + data.length); const dv = new DataView(c.buffer); dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i); c.set(data, 8); dv.setUint32(8 + data.length, crc(c, 4, 8 + data.length)); return c; };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z.subarray(0, o)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let q = 0; for (const p of parts) { out.set(p, q); q += p.length; }
  return out;
}
// synthetic test image: hue sweep + checker + circle, 160x120
function testImage(w = 160, h = 120) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, u = x / w, v = y / h;
    let r = 255 * (0.5 + 0.5 * Math.cos(6.283 * (u + 0.0))), g = 255 * (0.5 + 0.5 * Math.cos(6.283 * (u + 0.33))), b = 255 * (0.5 + 0.5 * Math.cos(6.283 * (u + 0.67)));
    const k = ((x >> 4) + (y >> 4)) & 1; const f = 0.55 + 0.45 * v; r *= f; g *= f; b *= f;
    if (k && y < h / 3) { r = 255 - r; g = 255 - g; b = 255 - b; }
    const dx = x - w * 0.7, dy = y - h * 0.6; if (dx * dx + dy * dy < (h * 0.22) ** 2) { r = 250; g = 245; b = 230; }
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
  return figma.createImage(png(w, h, px)).hash;
}
// logo-like test pattern used under effects and shaders: gradient bg + mark + text + shapes
const MARK = 'M 40 0 L 80 70 L 56 70 L 40 40 L 24 70 L 0 70 Z M 40 52 L 50 70 L 30 70 Z';
async function pattern(parent) {
  rect(parent, 0, 0, W, H, [grad('GRADIENT_LINEAR', stops([0, '#1B1F3B'], [0.55, '#5B3CC4'], [1, '#FF8A5B']), 30)]);
  ellipse(parent, 250, 30, 120, 120, [solid('#FFD84D')]);
  rect(parent, 30, 200, 140, 60, [solid('#2EC4B6')], { cornerRadius: 14 });
  await vec(parent, 40, 40, 100, 88, MARK, [solid('#FFFFFF')], {}, 'EVENODD');
  await text(parent, 170, 140, 'Motion', { style: 'Bold', size: 56, color: '#FFFFFF' });
  for (let i = 0; i < 6; i++) rect(parent, 200 + i * 30, 230, 18, 50, [solid(i % 2 ? '#0B0B0B' : '#F5F5F5')]);
}
