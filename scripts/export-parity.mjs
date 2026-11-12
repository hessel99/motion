// export ↔ editor parity: every export path, frame by frame, against the editor's own renderer.
//
//   node scripts/export-parity.mjs            quick subset (CI: `npm run parity`), exits 1 on a failure
//   node scripts/export-parity.mjs --full     every scene, every frame, every path
//   options: --scenes a,b  --paths png,mp4,...  --out dir  --url http://localhost:5173/  --no-report
//
// paths: png (single frame, 1x and 2x), pngseq (zip of frames), mp4 (default quality), mp4hq
// (40 Mbit/s; also compared against the reference pushed through the same 4:2:0 chroma round trip,
// which isolates colour handling from chroma subsampling), webm, gif, lottie (lottie-web svg in
// chromium), preview (the share preview page's <video> in chromium, seeked like its scrubber).
// every decoded frame is compared per pixel with the editor frame at the same time; barcode
// scenes also decode the frame index each output frame shows (catches off-by-one and drift).
// video / gif timing comes from ffprobe; audio sync from click onsets in the decoded track.
//
// starts its own vite dev server on a free port unless --url is given (and stops only that one).
import { chromium } from './pw.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const FULL = args.includes('--full');
const OUT = opt('out', join(ROOT, 'bench/results/export-parity'));
const ONLY = opt('scenes', '').split(',').filter(Boolean);
const ALL_PATHS = ['png', 'pngseq', 'mp4', 'mp4hq', 'webm', 'gif', 'lottie', 'lottie-native', 'preview'];
// lottie-native: every preflight item set to Ignore (shapes / text exported natively instead of baked):
// informational, it measures what Ignore costs (never fails the run)
const PATHS = opt('paths', (FULL ? ALL_PATHS : ALL_PATHS.filter(p => p !== 'lottie-native')).join(',')).split(',').filter(Boolean);
const INFO_PATHS = new Set(['lottie-native']);
const TMP = join(OUT, 'tmp');
mkdirSync(TMP, { recursive: true });
mkdirSync(join(OUT, 'img'), { recursive: true });

// ---------------- tolerances (0..255 per channel, premultiplied RGBA) ----------------
// mean = mean absolute error over all channels; bad = share of pixels whose largest channel error
// exceeds 24; colour = mean error inside flat colour patches (5x5 uniform), per channel, against
// the editor frame itself. 4:2:0 video (every encoder webcodecs offers: 4:4:4 H.264 / VP9 profile 1
// are not available in chromium) can't carry full-resolution colour at hard saturated edges, so
// for video each channel may match either the editor frame or the editor frame pushed through an
// ideal BT.709 4:2:0 round trip (ffmpeg, exact): decoders upsample chroma differently. `raw`
// reports the plain error against the editor frame. chromium's H.264 encoder (openh264) ignores
// the bitrate at these sizes (500 kbit/s and 40 Mbit/s give the same stream), so mp4hq can only
// be as close as the encoder's fixed quantizer allows.
const TOL = {
  'lottie-native': { mean: 2.5, bad: 0.02 },
  png: { mean: 0.05, bad: 0, max: 2 },
  pngseq: { mean: 0.05, bad: 0, max: 2 },
  mp4: { mean: 2, bad: 0.02, colour: 1.5 },
  mp4hq: { mean: 1.5, bad: 0.005, colour: 1.5 },
  webm: { mean: 2, bad: 0.02, colour: 1.5 },
  gif: { mean: 3.5, bad: 0.04 },
  lottie: { mean: 2.5, bad: 0.02 },
  preview: { mean: 2.5, bad: 0.03, colour: 2 },
};

// ---------------- dev server ----------------
let server = null, URL_ = opt('url', process.env.URL || '');
// a free port among a few random ones (other agents' servers live on 4173 / 5173 / …)
for (let attempt = 0; !URL_ && attempt < 6; attempt++) {
  const port = 5400 + Math.floor(Math.random() * 400);
  server = spawn(join(ROOT, 'node_modules/.bin/vite'), ['--port', String(port), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const ok = await new Promise(res => {
    const to = setTimeout(() => res(false), 30000);
    server.stdout.on('data', d => { if (String(d).includes('Local')) { clearTimeout(to); res(true); } });
    server.on('exit', () => { clearTimeout(to); res(false); });
  });
  if (ok) URL_ = `http://localhost:${port}/`;
  else { try { server.kill(); } catch { /* */ } server = null; }
}
if (!URL_) throw new Error('could not start vite');
const cleanup = () => { try { server?.kill(); } catch { /* */ } };
process.on('exit', cleanup);

// ---------------- helpers ----------------
const ff = (a, input) => execFileSync('ffmpeg', ['-v', 'error', ...a], { input, maxBuffer: 1 << 30 });
const probe = (file, entries, stream = 'v:0') => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', entries, '-of', 'json', file]).toString());

function decodeImage(buf) { return ff(['-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], buf); }
/** decoded frames of a video/gif file as rgba (straight). matrix / range from the stream's tags
 *  (what a tag-aware player does; untagged streams fall back to ffmpeg's defaults) */
function decodeVideo(file, w, h) {
  const raw = ff(['-i', file, '-fps_mode', 'passthrough', '-vf', 'scale=in_color_matrix=auto:in_range=auto:out_range=full:flags=accurate_rnd+full_chroma_int+bitexact,format=rgba', '-f', 'rawvideo', 'pipe:1']);
  const n = w * h * 4, out = [];
  for (let o = 0; o + n <= raw.length; o += n) out.push(raw.subarray(o, o + n));
  return out;
}
const premul = px => { const o = Buffer.alloc(px.length); for (let i = 0; i < px.length; i += 4) { const a = px[i + 3]; o[i] = Math.round(px[i] * a / 255); o[i + 1] = Math.round(px[i + 1] * a / 255); o[i + 2] = Math.round(px[i + 2] * a / 255); o[i + 3] = a; } return o; };
const flatten = px => { const o = Buffer.alloc(px.length); for (let i = 0; i < px.length; i += 4) { o[i] = px[i]; o[i + 1] = px[i + 1]; o[i + 2] = px[i + 2]; o[i + 3] = 255; } return o; }; // premultiplied over black

/** reference pushed through rgb -> yuv420p (bt.709 limited) -> rgb: what a perfect 4:2:0 encoder could deliver */
function sim420(px, w, h) {
  const raw = ff(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', 'pipe:0', '-vf', 'scale=out_color_matrix=bt709:out_range=limited:flags=accurate_rnd+full_chroma_int+bitexact,format=yuv420p,scale=in_color_matrix=bt709:in_range=limited:out_range=full:flags=accurate_rnd+full_chroma_int+bitexact,format=rgba', '-f', 'rawvideo', 'pipe:1'], px);
  return raw;
}

/** like compare, but a channel counts as matching either reference (the editor frame, or the editor
 *  frame through an ideal 4:2:0 round trip: players upsample chroma differently) */
function compareEither(a1, a2, b, w, h) {
  let sum = 0, max = 0, bad = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let c = 0; c < 4; c++) { const o = i * 4 + c, d = Math.min(Math.abs(a1[o] - b[o]), Math.abs(a2[o] - b[o])); sum += d; if (d > m) m = d; }
    if (m > max) max = m;
    if (m > 24) bad++;
  }
  return { mean: sum / (n * 4), max, bad: bad / n };
}

function compare(a, b, w, h) {
  let sum = 0, max = 0, bad = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let c = 0; c < 4; c++) { const d = Math.abs(a[i * 4 + c] - b[i * 4 + c]); sum += d; if (d > m) m = d; }
    if (m > max) max = m;
    if (m > 24) bad++;
  }
  return { mean: sum / (n * 4), max, bad: bad / n };
}

/** mean per-channel error inside flat patches of the reference (pixels whose 5x5 neighbourhood is uniform) */
function colourError(ref, got, w, h) {
  let sum = 0, cnt = 0, worst = 0;
  for (let y = 3; y < h - 3; y += 2) for (let x = 3; x < w - 3; x += 2) {
    const o = (y * w + x) * 4;
    let flat = true;
    for (let dy = -2; dy <= 2 && flat; dy++) for (let dx = -2; dx <= 2; dx++) {
      const q = ((y + dy) * w + x + dx) * 4;
      if (ref[q] !== ref[o] || ref[q + 1] !== ref[o + 1] || ref[q + 2] !== ref[o + 2]) { flat = false; break; }
    }
    if (!flat) continue;
    for (let c = 0; c < 3; c++) { const d = Math.abs(ref[o + c] - got[o + c]); sum += d; if (d > worst) worst = d; }
    cnt += 3;
  }
  return cnt ? { colour: sum / cnt, colourMax: worst } : null;
}

/** frame index shown by a barcode frame (flattened rgba), or -1 */
function barcodeIndex(px, w, h) {
  const bits = 7, cw = Math.floor(w / (bits + 1)), ch = Math.max(10, Math.floor(h / 8));
  let v = 0, par = 0;
  for (let b = 0; b <= bits; b++) {
    const x = Math.floor(b * cw + cw / 2), y = Math.floor(ch / 2), o = (y * w + x) * 4;
    const on = (px[o] + px[o + 1] + px[o + 2]) / 3 > 127 ? 1 : 0;
    if (b < bits) { v |= on << b; par ^= on; } else if (on !== par) return -1;
  }
  return v;
}

/** a copy with the given boxes (comp px, padded) cleared */
function maskOut(px, boxes, w, h) {
  const o = Buffer.from(px);
  for (const [x0, y0, x1, y1] of boxes) {
    for (let y = Math.max(0, Math.floor(y0) - 3); y < Math.min(h, Math.ceil(y1) + 3); y++) o.fill(0, (y * w + Math.max(0, Math.floor(x0) - 3)) * 4, (y * w + Math.min(w, Math.ceil(x1) + 3)) * 4);
  }
  return o;
}

/** premultiplied rgba with alpha cut at 50%: what any 1-bit-alpha format (GIF) can show */
function oneBit(px) {
  const o = Buffer.alloc(px.length);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a < 128) continue;
    o[i] = Math.min(255, Math.round(px[i] * 255 / a)); o[i + 1] = Math.min(255, Math.round(px[i + 1] * 255 / a)); o[i + 2] = Math.min(255, Math.round(px[i + 2] * 255 / a)); o[i + 3] = 255;
  }
  return o;
}

function savePng(file, px, w, h) { ff(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', 'pipe:0', '-frames:v', '1', file], px); }
function diffImage(a, b, w, h) {
  const o = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let m = 0; for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(a[i * 4 + c] - b[i * 4 + c]));
    const v = Math.min(255, m * 6);
    o[i * 4] = v; o[i * 4 + 1] = m > 24 ? 0 : v >> 1; o[i * 4 + 2] = m > 24 ? 0 : v >> 2; o[i * 4 + 3] = 255;
  }
  return o;
}

const frameCount = (d, fps) => Math.max(1, Math.ceil(d * fps - 1e-6));

// ---------------- browser ----------------
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--font-render-hinting=none', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1, acceptDownloads: true });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.goto(URL_ + '?blank&nobridge');
await page.waitForFunction(() => window.editor?.renderer, null, { timeout: 60000 });
await page.evaluate(() => import('/tests/parity/page.ts'));
const lottieJs = readFileSync(join(ROOT, 'node_modules/lottie-web/build/player/lottie.min.js'), 'utf8');
const aux = await ctx.newPage();

const scenes = (await page.evaluate(() => window.__parity.scenes())).filter(s => ONLY.length ? ONLY.includes(s.id) : (FULL || s.quick));
const results = [];
const findings = [];
const t0 = Date.now();

function record(scene, path, frames, extra = {}) {
  const tol = TOL[path];
  const worst = frames.reduce((w, f) => (!w || f.mean > w.mean ? f : w), null);
  const fails = [];
  for (const f of frames) {
    if (tol.mean != null && f.mean > tol.mean) fails.push(`frame ${f.i}: mean ${f.mean.toFixed(2)} > ${tol.mean}`);
    else if (tol.bad != null && f.bad > tol.bad) fails.push(`frame ${f.i}: ${(f.bad * 100).toFixed(2)}% pixels off by > 24 (max ${(tol.bad * 100).toFixed(1)}%)`);
    else if (tol.max != null && f.max > tol.max) fails.push(`frame ${f.i}: max error ${f.max} > ${tol.max}`);
    if (tol.colour != null && f.colour != null && f.colour > tol.colour) fails.push(`frame ${f.i}: flat colour error ${f.colour.toFixed(2)} > ${tol.colour}`);
    if (f.index != null && f.index !== f.expect) fails.push(`frame ${f.i}: shows editor frame ${f.index}, expected ${f.expect}`);
  }
  for (const c of extra.checks ?? []) if (!c.ok) fails.push(c.msg);
  const r = { scene: scene.id, title: scene.title, path, ok: fails.length === 0 && !extra.error, error: extra.error ?? null, fails, frames: frames.length, worst, checks: extra.checks ?? [], info: extra.info ?? null, imgs: null };
  results.push(r);
  const tag = r.ok ? 'ok  ' : 'FAIL';
  console.log(`  ${tag} ${path.padEnd(8)} ${worst ? `mean ${worst.mean.toFixed(2)} max ${worst.max} bad ${(worst.bad * 100).toFixed(2)}%${worst.colour != null ? ` colour ${worst.colour.toFixed(2)}` : ''}` : ''}${extra.error ? ' ERROR ' + extra.error : ''}${fails.length ? '\n         ' + fails.slice(0, 4).join('\n         ') + (fails.length > 4 ? `\n         … ${fails.length - 4} more` : '') : ''}`);
  return r;
}

function keepImages(r, ref, got, w, h) {
  if (!r.worst) return;
  const base = `${r.scene}-${r.path}`;
  savePng(join(OUT, 'img', base + '-editor.png'), ref, w, h);
  savePng(join(OUT, 'img', base + '-export.png'), got, w, h);
  savePng(join(OUT, 'img', base + '-diff.png'), diffImage(ref, got, w, h), w, h);
  r.imgs = { editor: `img/${base}-editor.png`, export: `img/${base}-export.png`, diff: `img/${base}-diff.png`, frame: r.worst.i };
}

for (const scene of scenes) {
  console.log(`\n${scene.id}: ${scene.title}`);
  const info = await page.evaluate(id => window.__parity.load(id), scene.id);
  const { width: W, height: H, fps, duration } = info;
  const E = info.exportFps;
  const isBarcode = scene.tags.includes('timing');
  const n = frameCount(duration, E);
  const nC = frameCount(duration, fps);
  const pick = (count) => FULL || isBarcode ? [...Array(count).keys()] : [...new Set([0, 1, Math.floor(count / 3), Math.floor(count / 2), Math.floor(2 * count / 3), count - 2, count - 1].filter(i => i >= 0 && i < count))];
  // reference frames at export fps (video, gif, png) and comp fps (lottie)
  const refCache = new Map();
  async function refs(times, w = W, h = H) {
    const need = times.filter(t => !refCache.has(`${w}x${h}@${t}`));
    for (let k = 0; k < need.length; k += 24) {
      const chunk = need.slice(k, k + 24);
      const r = await page.evaluate(([t, w, h]) => window.__parity.reference(t, w, h), [chunk, w, h]);
      chunk.forEach((t, j) => refCache.set(`${w}x${h}@${t}`, Buffer.from(r.frames[j], 'base64')));
    }
    return times.map(t => refCache.get(`${w}x${h}@${t}`));
  }
  const tE = i => Math.min(i / E, duration);
  const tC = i => Math.min(i / fps, duration);

  // ---- png ----
  if (PATHS.includes('png')) {
    try {
      const frames = [], idx = [0, Math.floor(n / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
      const ref = await refs(idx.map(tE));
      let lastGot = null;
      for (let k = 0; k < idx.length; k++) {
        const r = await page.evaluate(([t]) => window.__parity.png(t, 1), [tE(idx[k])]);
        const buf = Buffer.from(r.data, 'base64');
        const size = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', '-i', 'pipe:0'], { input: buf }).toString()).streams[0];
        if (size.width !== W || size.height !== H) { frames.push({ i: idx[k], mean: 255, max: 255, bad: 1, note: `size ${size.width}x${size.height}` }); continue; }
        lastGot = premul(decodeImage(buf));
        frames.push({ i: idx[k], ...compare(ref[k], lastGot, W, H) });
      }
      // 2x
      const checks = [];
      const r2 = await page.evaluate(([t]) => window.__parity.png(t, 2), [tE(0)]);
      const s2 = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', '-i', 'pipe:0'], { input: Buffer.from(r2.data, 'base64') }).toString()).streams[0];
      checks.push({ ok: s2.width === W * 2 && s2.height === H * 2, msg: `2x png is ${s2.width}x${s2.height}, expected ${W * 2}x${H * 2}` });
      if (s2.width === W * 2 && s2.height === H * 2) {
        const [ref2] = await refs([tE(0)], W * 2, H * 2);
        const got2 = premul(decodeImage(Buffer.from(r2.data, 'base64')));
        frames.push({ i: '0@2x', ...compare(ref2, got2, W * 2, H * 2) });
      }
      const rec = record(scene, 'png', frames, { checks });
      if (lastGot) keepImages(rec, ref[ref.length - 1], lastGot, W, H);
    } catch (e) { record(scene, 'png', [], { error: String(e.message ?? e).slice(0, 300) }); }
  }

  // ---- png sequence ----
  if (PATHS.includes('pngseq')) {
    try {
      const r = await page.evaluate(() => window.__parity.pngSequence({}));
      const files = unzipSync(Buffer.from(r.data, 'base64'));
      const names = Object.keys(files).filter(f => f.endsWith('.png')).sort();
      const checks = [{ ok: names.length === nC, msg: `png sequence has ${names.length} frames, expected ${nC}` }];
      // the sequence is at the comp frame rate
      const idx = pick(nC).filter(i => i < names.length);
      const ref = await refs(idx.map(tC));
      const frames = [];
      let last = null;
      idx.forEach((i, k) => { last = premul(decodeImage(Buffer.from(files[names[i]]))); frames.push({ i, ...compare(ref[k], last, W, H) }); });
      const rec = record(scene, 'pngseq', frames, { checks });
      if (last) keepImages(rec, ref[ref.length - 1], last, W, H);
    } catch (e) { record(scene, 'pngseq', [], { error: String(e.message ?? e).slice(0, 300) }); }
  }

  // ---- video ----
  for (const path of ['mp4', 'mp4hq', 'webm']) {
    if (!PATHS.includes(path)) continue;
    try {
      const o = { format: path === 'webm' ? 'webm' : 'mp4', fps: E, quality: 'high' };
      if (path === 'mp4hq') o.bitrate = 40_000_000;
      const r = await page.evaluate(o => window.__parity.video(o), o);
      const file = join(TMP, `${scene.id}.${path}.${r.format}`);
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      const checks = [];
      const st = probe(file, 'stream=codec_name,pix_fmt,width,height,color_range,color_space,color_transfer,color_primaries,r_frame_rate,start_time,duration,time_base').streams[0];
      const fr = probe(file, 'frame=pts_time,duration_time').frames;
      checks.push({ ok: st.width === r.width && st.height === r.height, msg: `size ${st.width}x${st.height} vs ${r.width}x${r.height}` });
      checks.push({ ok: fr.length === n, msg: `${fr.length} frames, expected ${n}` });
      let drift = 0;
      fr.forEach((f, i) => { drift = Math.max(drift, Math.abs(+f.pts_time - i / E)); });
      checks.push({ ok: drift < 0.25 / E, msg: `frame times drift up to ${(drift * 1000).toFixed(2)} ms from i/fps` });
      const lastEnd = fr.length ? +fr[fr.length - 1].pts_time + (+fr[fr.length - 1].duration_time || 1 / E) : 0;
      checks.push({ ok: Math.abs(lastEnd - n / E) < 0.5 / E, msg: `video ends at ${lastEnd.toFixed(4)} s, expected ${(n / E).toFixed(4)} s` });
      const tagged = st.color_space && st.color_space !== 'unknown' && st.color_range && st.color_range !== 'unknown' && st.color_primaries && st.color_primaries !== 'unknown' && st.color_transfer && st.color_transfer !== 'unknown';
      checks.push({ ok: !!tagged, msg: `colour tags missing: space=${st.color_space} range=${st.color_range} primaries=${st.color_primaries} transfer=${st.color_transfer}` });
      const info = { codec: r.codec, pix_fmt: st.pix_fmt, color: `${st.color_space}/${st.color_primaries}/${st.color_transfer}/${st.color_range}`, frames: fr.length, bitrate: r.bitrate };
      // audio sync
      if (scene.tags.includes('audio')) {
        const a = probe(file, 'stream=codec_name,start_time,duration,sample_rate', 'a:0').streams[0];
        if (!a) checks.push({ ok: false, msg: 'no audio stream' });
        else {
          const pcm = ff(['-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
          const s = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
          const onsets = [];
          for (let i = 0; i < s.length; i++) if (Math.abs(s[i]) > 0.25) { onsets.push(i); i += 4800; }
          // the first DECODED sample's time (opus streams start at -pre-skip; decoders drop those samples)
          const af = probe(file, 'frame=pts_time', 'a:0').frames;
          const vStart = +st.start_time || 0, aStart = af.length ? +af[0].pts_time : 0;
          a.duration = s.length / 48000;
          const got = onsets.map(i => i / 48000 + aStart - vStart);
          // onset detection finds the first sample above threshold of a 3 kHz burst: <= 0.1 ms late
          const exp = [0.5, 1.0, 1.5];
          const errs = exp.map((e, k) => got[k] == null ? Infinity : Math.abs(got[k] - e));
          const worst = Math.max(...errs);
          info.audio = { codec: a.codec_name, onsets: got.map(x => +x.toFixed(5)), worstMs: +(worst * 1000).toFixed(3), duration: +a.duration };
          checks.push({ ok: worst < 0.001, msg: `audio clicks off by ${(worst * 1000).toFixed(2)} ms (onsets ${got.map(x => x.toFixed(4)).join(', ')} vs 0.5, 1.0, 1.5)` });
          checks.push({ ok: Math.abs(+a.duration - n / E) < 0.03, msg: `audio lasts ${a.duration} s, video ${(n / E).toFixed(3)} s` });
        }
      }
      const got = decodeVideo(file, r.width, r.height);
      const w = r.width, h = r.height;
      const idx = pick(n).filter(i => i < got.length);
      const ref = (await refs(idx.map(tE), w, h)).map(flatten);
      const frames = [];
      idx.forEach((i, k) => {
        const f = { i, ...compareEither(ref[k], sim420(ref[k], w, h), got[i], w, h), raw: compare(ref[k], got[i], w, h).mean };
        const ce = colourError(ref[k], got[i], w, h);
        if (ce) Object.assign(f, ce);
        if (isBarcode) { f.index = barcodeIndex(got[i], w, h); f.expect = barcodeIndex(ref[k], w, h); }
        frames.push(f);
      });
      const rec = record(scene, path, frames, { checks, info });
      const wi = idx.indexOf(rec.worst?.i);
      if (wi >= 0) keepImages(rec, ref[wi], got[rec.worst.i], w, h);
    } catch (e) { record(scene, path, [], { error: String(e.message ?? e).slice(0, 300) }); }
  }

  // ---- gif ----
  if (PATHS.includes('gif')) {
    try {
      const gfps = Math.min(E, 50);
      const r = await page.evaluate(o => window.__parity.gif(o), { fps: gfps, maxSize: Math.max(W, H) });
      const file = join(TMP, `${scene.id}.gif`);
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      const ng = frameCount(duration, gfps);
      const st = probe(file, 'stream=width,height').streams[0];
      const fr = probe(file, 'frame=pts_time,duration_time').frames;
      const checks = [{ ok: st.width === W && st.height === H, msg: `gif is ${st.width}x${st.height}` }, { ok: fr.length === ng, msg: `${fr.length} frames, expected ${ng}` }];
      // gif delays are centiseconds: each frame must start within 5 ms of i/fps (no accumulated drift)
      let drift = 0; fr.forEach((f, i) => { drift = Math.max(drift, Math.abs(+f.pts_time - i / gfps)); });
      checks.push({ ok: drift <= 0.0051, msg: `frame start times drift up to ${(drift * 1000).toFixed(1)} ms` });
      const total = fr.reduce((s, f) => s + (+f.duration_time || 0), 0);
      checks.push({ ok: Math.abs(total - ng / gfps) <= 0.0051, msg: `gif lasts ${total.toFixed(3)} s, expected ${(ng / gfps).toFixed(3)} s` });
      const got = decodeVideo(file, st.width, st.height);
      const idx = pick(ng).filter(i => i < got.length);
      const ref = await refs(idx.map(i => Math.min(i / gfps, duration)));
      const frames = [];
      const bgOpaque = info.background[3] >= 1;
      idx.forEach((i, k) => {
        const g = premul(got[i]);
        // gif alpha is 1 bit (a format limit): transparent scenes compare against the editor frame cut at 50% alpha
        const f = { i, ...compare(bgOpaque ? ref[k] : oneBit(ref[k]), g, W, H) };
        if (isBarcode) { f.index = barcodeIndex(flatten(g), W, H); f.expect = barcodeIndex(flatten(ref[k]), W, H); }
        frames.push(f);
      });
      const rec = record(scene, 'gif', frames, { checks, info: { frames: fr.length, fps: gfps } });
      const wi = idx.indexOf(rec.worst?.i);
      if (wi >= 0) keepImages(rec, ref[wi], premul(got[rec.worst.i]), W, H);
    } catch (e) { record(scene, 'gif', [], { error: String(e.message ?? e).slice(0, 300) }); }
  }

  // ---- lottie (lottie-web, svg renderer) ----
  for (const lpath of ['lottie', 'lottie-native']) {
    if (!PATHS.includes(lpath)) continue;
    try {
      const native = lpath === 'lottie-native';
      const r = await page.evaluate(native => window.__parity.lottie({ ignoreAll: native }), native);
      if (native && !r.preflight.some(i => i.bakeable)) continue; // identical to 'lottie'
      writeFileSync(join(TMP, `${scene.id}.${lpath}.json`), r.json);
      await aux.setViewportSize({ width: Math.max(W, 100), height: Math.max(H, 100) });
      await aux.setContent(`<html><body style="margin:0;background:transparent"><div id="c" style="width:${W}px;height:${H}px"></div></body></html>`);
      await aux.addScriptTag({ content: lottieJs });
      const ld = await aux.evaluate(j => new Promise(res => {
        window.anim = lottie.loadAnimation({ container: document.getElementById('c'), renderer: 'svg', loop: false, autoplay: false, animationData: JSON.parse(j), rendererSettings: { preserveAspectRatio: 'xMidYMid meet' } });
        const done = () => res({ frames: window.anim.totalFrames, fr: window.anim.frameRate });
        if (window.anim.isLoaded) done(); else { window.anim.addEventListener('DOMLoaded', done); setTimeout(done, 3000); }
      }), r.json);
      // images (data urls) load asynchronously in the svg renderer
      await aux.waitForTimeout(150);
      const checks = [{ ok: ld.frames === nC, msg: `lottie has ${ld.frames} frames, expected ${nC}` }, { ok: Math.abs(ld.fr - fps) < 1e-6, msg: `lottie frame rate ${ld.fr}, expected ${fps}` }];
      const idx = pick(nC);
      const ref0 = await refs(idx.map(tC));
      // what the export dialog reported before exporting as impossible in lottie (not bakeable):
      // those layers' boxes are left out of the comparison (and listed in the report)
      const known = (r.preflight ?? []).filter(i => !i.bakeable && i.feature !== 'audio');
      const boxes = known.length ? await page.evaluate(([ids, t]) => window.__parity.boxes(ids, t), [known.map(i => i.layerId), idx.map(tC)]) : null;
      const ref = boxes ? ref0.map((b, k) => maskOut(b, boxes[k], W, H)) : ref0;
      if (known.length) checks.push({ ok: true, msg: `reported before export (excluded): ${known.map(i => `${i.layer} (${i.feature})`).join(', ')}` });
      const frames = [];
      let lastGot = null, lastK = -1;
      for (let k = 0; k < idx.length; k++) {
        await aux.evaluate(f => window.anim.goToAndStop(f, true), idx[k]);
        const png = await aux.locator('#c').screenshot({ omitBackground: true });
        const got0 = premul(decodeImage(png));
        const got = boxes ? maskOut(got0, boxes[k], W, H) : got0;
        const f = { i: idx[k], ...compare(ref[k], got, W, H) };
        if (isBarcode) { f.index = barcodeIndex(flatten(got), W, H); f.expect = barcodeIndex(flatten(ref[k]), W, H); }
        frames.push(f);
        if (!lastGot || f.mean >= frames[lastK].mean) { lastGot = got; lastK = k; }
      }
      const rec = record(scene, lpath, frames, { checks, info: { preflight: r.preflight, bytes: r.json.length } });
      if (lastGot) keepImages(rec, ref[lastK], lastGot, W, H);
    } catch (e) { record(scene, lpath, [], { error: String(e.message ?? e).slice(0, 300) }); }
  }

  // ---- share preview page ----
  if (PATHS.includes('preview')) {
    try {
      const r = await page.evaluate(() => window.__parity.preview());
      writeFileSync(join(TMP, `${scene.id}.preview.html`), r.html);
      await aux.setViewportSize({ width: 1000, height: 800 });
      await aux.goto('about:blank');
      await aux.setContent(r.html);
      const meta = await aux.evaluate(() => new Promise(res => { const v = document.getElementById('v'); const go = () => { v.pause(); res({ w: v.videoWidth, h: v.videoHeight, d: v.duration }); }; if (v.readyState >= 2) go(); else v.addEventListener('loadeddata', go); setTimeout(() => res({ error: 'video did not load' }), 8000); }));
      if (meta.error) throw new Error(meta.error);
      const checks = [{ ok: Math.abs(meta.w - 2 * W) <= 1 && Math.abs(meta.h - 2 * H) <= 1, msg: `preview video is ${meta.w}x${meta.h}, expected 2x the comp (${2 * W}x${2 * H})` }, { ok: Math.abs(meta.d - nC / fps) < 0.5 / fps, msg: `preview lasts ${meta.d} s, expected ${(nC / fps).toFixed(4)}` }];
      const idx = pick(nC);
      // compared at the video's own size (2x: what a hidpi screen shows 1:1) against the editor frame at that size
      const DW = meta.w, DH = meta.h;
      const ref = (await refs(idx.map(tC), DW, DH)).map(flatten);
      const frames = [];
      let lastGot = null, lastK = -1;
      for (let k = 0; k < idx.length; k++) {
        // what the scrubber / frame-step keys do: the range input's value (multiples of 1/fps)
        const b = await aux.evaluate(async ([i, fps, dw, dh]) => {
          const v = document.getElementById('v'), t = document.getElementById('t');
          // the frame the player presents after the seek (requestVideoFrameCallback), not just 'seeked'
          const shown = new Promise(r => { v.requestVideoFrameCallback(() => r()); setTimeout(r, 1000); });
          t.value = String(i / fps); t.dispatchEvent(new Event('input'));
          await new Promise(r => { if (!v.seeking) r(); else v.addEventListener('seeked', r, { once: true }); });
          await shown;
          const c = document.createElement('canvas'); c.width = dw; c.height = dh;
          const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(v, 0, 0, dw, dh);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let s = ''; for (let o = 0; o < d.length; o += 0x8000) s += String.fromCharCode(...d.subarray(o, o + 0x8000));
          return btoa(s);
        }, [idx[k], fps, DW, DH]);
        const got = Buffer.from(b, 'base64');
        const f = { i: idx[k], ...compareEither(ref[k], sim420(ref[k], DW, DH), got, DW, DH), raw: compare(ref[k], got, DW, DH).mean };
        const ce = colourError(ref[k], got, DW, DH); if (ce) Object.assign(f, ce);
        if (isBarcode) { f.index = barcodeIndex(got, DW, DH); f.expect = barcodeIndex(ref[k], DW, DH); }
        frames.push(f);
        if (!lastGot || f.mean >= frames[lastK].mean) { lastGot = got; lastK = k; }
      }
      const rec = record(scene, 'preview', frames, { checks, info: { bytes: r.html.length } });
      if (lastGot) keepImages(rec, ref[lastK], lastGot, DW, DH);
    } catch (e) { record(scene, 'preview', [], { error: String(e.message ?? e).slice(0, 300) }); }
  }
}

await browser.close();
cleanup();

// ---------------- report ----------------
const failed = results.filter(r => !r.ok && !INFO_PATHS.has(r.path));
const summary = {};
for (const r of results) { const s = summary[r.path] ??= { pass: 0, fail: 0, worstMean: 0 }; r.ok ? s.pass++ : s.fail++; s.worstMean = Math.max(s.worstMean, r.worst?.mean ?? 0); }
const json = { date: new Date().toISOString(), mode: FULL ? 'full' : ONLY.length ? 'subset' : 'quick', seconds: Math.round((Date.now() - t0) / 1000), summary, results, pageErrors };
writeFileSync(join(OUT, FULL ? 'results-full.json' : 'results.json'), JSON.stringify(json, null, 1));
if (!args.includes('--no-report')) writeFileSync(join(OUT, 'report.html'), reportHtml(json));
if (!args.includes('--keep')) rmSync(TMP, { recursive: true, force: true });
console.log('\nsummary (path: pass/fail, worst mean error)');
for (const [p, s] of Object.entries(summary)) console.log(`  ${p.padEnd(8)} ${s.pass}/${s.fail}  ${s.worstMean.toFixed(2)}`);
console.log(`${results.length - failed.length}/${results.length} passed in ${json.seconds}s → ${join(OUT, 'report.html')}`);
if (pageErrors.length) console.log('page errors:', pageErrors.slice(0, 5));
process.exit(failed.length ? 1 : 0);

function reportHtml(j) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const rows = j.results.slice().sort((a, b) => (a.ok - b.ok) || ((b.worst?.mean ?? 0) - (a.worst?.mean ?? 0)));
  const paths = Object.keys(j.summary);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Export parity</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#e3e3e3;--ok:#1f7a3a;--bad:#b42318;--card:#f6f6f6}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--mut:#9a9a9a;--line:#2c2c2c;--ok:#5bd17c;--bad:#ff7b6b;--card:#1d1d1d}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}p{color:var(--mut);margin:0 0 16px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--mut);font-size:12px}.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
.imgs{display:flex;gap:6px;flex-wrap:wrap}.imgs figure{margin:0}.imgs img{display:block;max-width:240px;image-rendering:pixelated;background:repeating-conic-gradient(#8884 0 25%,#0000 0 50%) 0 0/12px 12px;border:1px solid var(--line)}
figcaption{font-size:11px;color:var(--mut)}.fails{font-size:12px;color:var(--bad);margin:4px 0 0;padding-left:16px}.sum{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin:0 0 20px}
.sum div{background:var(--card);border-radius:8px;padding:8px 10px}.sum b{display:block;font-size:12px;color:var(--mut);font-weight:600}
.wrap{overflow-x:auto}.note{font-size:12px;color:var(--mut);font-weight:normal;margin-top:4px}
</style></head><body><main>
<h1>Export ↔ editor parity</h1>
<p>${esc(j.mode)} run · ${esc(j.date)} · ${j.seconds}s · ${j.results.filter(r => r.ok).length}/${j.results.length} passed. Errors are 0–255 per channel (premultiplied RGBA) against the editor's renderer at the same time; worst rows first.</p>
<div class="sum">${paths.map(p => `<div><b>${esc(p)}</b><span class="${j.summary[p].fail ? 'bad' : 'ok'}">${j.summary[p].pass}/${j.summary[p].pass + j.summary[p].fail}</span> · worst ${j.summary[p].worstMean.toFixed(2)}</div>`).join('')}</div>
<div class="wrap"><table><thead><tr><th>scene</th><th>path</th><th>result</th><th>worst frame</th><th>mean</th><th>max</th><th>&gt;24</th><th>raw</th><th>flat colour</th><th>editor / export / diff</th></tr></thead><tbody>
${rows.map(r => `<tr><td>${esc(r.scene)}<br><small style="color:var(--mut)">${esc(r.title)}</small></td><td>${esc(r.path)}${r.info?.codec ? `<br><small style="color:var(--mut)">${esc(r.info.codec)} ${esc(r.info.pix_fmt ?? '')}<br>${esc(r.info.color ?? '')}</small>` : ''}</td>
<td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'pass' : 'FAIL'}${r.error ? `<br><small>${esc(r.error)}</small>` : ''}${r.checks.filter(c => c.ok && c.msg.startsWith('reported')).map(c => `<div class="note">${esc(c.msg)}</div>`).join('')}${r.fails.length ? `<ul class="fails">${r.fails.slice(0, 6).map(f => `<li>${esc(f)}</li>`).join('')}${r.fails.length > 6 ? `<li>… ${r.fails.length - 6} more</li>` : ''}</ul>` : ''}</td>
<td>${r.worst ? esc(r.worst.i) : ''}</td><td>${r.worst ? r.worst.mean.toFixed(2) : ''}</td><td>${r.worst ? r.worst.max : ''}</td><td>${r.worst ? (r.worst.bad * 100).toFixed(2) + '%' : ''}</td><td>${r.worst?.raw != null ? r.worst.raw.toFixed(2) : ''}</td><td>${r.worst?.colour != null ? r.worst.colour.toFixed(2) : ''}</td>
<td>${r.imgs ? `<div class="imgs"><figure><img src="${r.imgs.editor}" alt="editor frame ${esc(r.imgs.frame)}"><figcaption>editor</figcaption></figure><figure><img src="${r.imgs.export}" alt="export"><figcaption>export</figcaption></figure><figure><img src="${r.imgs.diff}" alt="difference"><figcaption>diff ×6</figcaption></figure></div>` : ''}</td></tr>`).join('\n')}
</tbody></table></div></main></body></html>`;
}
