// renders every cached figma shader (.figma-cache/<id>/, gitignored: figma's source is never
// committed) with its default params through the real shader worker (src/render/shader-worker.ts)
// in headless chromium + webgpu (swiftshader), saves PNGs to bench/results/shaders/ and reports
// errors per shader. effects get a synthetic input image. exits 1 when any shader fails.
//
// usage: node scripts/shader-check.mjs [name filter] [--size=WxH] [--scale=1]
import { build } from 'esbuild';
import http from 'node:http';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from './pw.mjs';

const root = new URL('..', import.meta.url).pathname;
const cacheDir = join(root, '.figma-cache');
const outDir = join(root, 'bench/results/shaders');
const args = process.argv.slice(2);
const filter = (args.find(a => !a.startsWith('--')) ?? '').toLowerCase();
const size = (args.find(a => a.startsWith('--size='))?.slice(7) ?? '240x160').split('x').map(Number);
const scale = Number(args.find(a => a.startsWith('--scale='))?.slice(8) ?? 1);

mkdirSync(outDir, { recursive: true });

const bundle = async (entry, format) => (await build({ entryPoints: [join(root, entry)], bundle: true, write: false, format, target: 'es2022', logLevel: 'silent' })).outputFiles[0].text;
const workerJs = await bundle('src/render/shader-worker.ts', 'iife');
const coreJs = await bundle('src/core/shaders.ts', 'esm');

const shaders = (existsSync(cacheDir) ? readdirSync(cacheDir) : []).filter(d => existsSync(join(cacheDir, d, 'main.ts'))).map(d => {
  const meta = JSON.parse(readFileSync(join(cacheDir, d, 'meta.json'), 'utf8'));
  return { id: d, name: meta.name, kind: meta.type, code: readFileSync(join(cacheDir, d, 'main.ts'), 'utf8'), features: readFileSync(join(cacheDir, d, 'features.json'), 'utf8') };
});
if (args.includes('--fixtures') || !shaders.length) {
  // motion's own test shaders (committed): always available, also without the figma cache
  const fx = await import('data:text/javascript;base64,' + Buffer.from(await bundle('tests/shader-fixtures.ts', 'esm')).toString('base64'));
  shaders.push({ id: 'test-stripes', name: 'Test stripes', kind: 'fill', code: fx.TEST_FILL_MAIN, features: fx.TEST_FILL_FEATURES });
  shaders.push({ id: 'test-invert', name: 'Test invert', kind: 'effect', code: fx.TEST_EFFECT_MAIN, features: fx.TEST_EFFECT_FEATURES });
}
const selected = shaders.filter(s => !filter || s.name.toLowerCase().includes(filter) || s.kind === filter).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

const srv = http.createServer((q, r) => {
  if (q.url === '/worker.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); r.end(workerJs); return; }
  if (q.url === '/core.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); r.end(coreJs); return; }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>shader check</title>');
});
await new Promise(res => srv.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${srv.address().port}/`;

let browser, page;
/** (re)start chromium: a gpu process crash (software webgpu watchdog) takes the whole adapter down */
async function open() {
  if (browser) await browser.close().catch(() => {});
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader'] });
  page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('  [page]', m.text().slice(0, 300)); });
  await page.goto(base);
  return await page.evaluate(async () => {
    window.core = await import('/core.js');
    window.pending = new Map();
    let seq = 1;
    window.nextJob = () => seq++;
    // a fresh worker per shader: a hung or crashed module can't take the next ones down
    window.newWorker = () => new Promise(res => {
      window.worker?.terminate();
      window.worker = new Worker('/worker.js');
      worker.onmessage = e => {
        const m = e.data;
        if (m.type === 'ready') { res(m); return; }
        const p = pending.get(m.job);
        if (p) { pending.delete(m.job); p(m); }
      };
    });
    const r = await newWorker();
    // synthetic effect input: colorful shapes on transparency (premultiplied rgba8, top-down)
    window.makeInput = (w, h) => {
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
      const lg = g.createLinearGradient(0, 0, w, h);
      lg.addColorStop(0, '#ff5a36'); lg.addColorStop(0.5, '#ffd23f'); lg.addColorStop(1, '#3a86ff');
      g.fillStyle = lg; g.beginPath(); g.roundRect(w * 0.08, h * 0.1, w * 0.84, h * 0.8, 24); g.fill();
      g.fillStyle = '#111'; g.font = `bold ${Math.round(h * 0.22)}px sans-serif`; g.fillText('Motion', w * 0.18, h * 0.58);
      g.fillStyle = 'rgba(255,255,255,0.8)'; g.beginPath(); g.arc(w * 0.78, h * 0.3, h * 0.12, 0, Math.PI * 2); g.fill();
      const d = g.getImageData(0, 0, w, h).data; // straight alpha -> premultiply
      for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; d[i] = Math.round(d[i] * a); d[i + 1] = Math.round(d[i + 1] * a); d[i + 2] = Math.round(d[i + 2] * a); }
      return d.buffer;
    };
    window.render = (s, w, h, scale, time) => new Promise(res => {
      const schema = core.parseShaderSchema(s.code) ?? [];
      const params = {};
      for (const def of schema) params[def.key] = core.unflattenValue(def, core.flattenValue(def, undefined));
      const job = nextJob();
      pending.set(job, res);
      const input = s.kind === 'effect' ? { w, h, data: makeInput(w, h) } : null;
      worker.postMessage({ type: 'render', job, w, h, renderScale: scale, time, deltaTime: 16, mouse: { x: w * 0.4, y: h * 0.5 }, passes: [{ inst: s.id, mod: { key: s.id, code: s.code }, params }], input, out: 'pixels' }, input ? [input.data] : []);
      setTimeout(() => { if (pending.has(job)) { pending.delete(job); res({ type: 'failed', error: 'timeout (90s, software webgpu)' }); } }, 90000);
    });
    window.toPng = async (buf, w, h) => {
      // composite over a checkerboard so transparency is visible
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
      for (let y = 0; y < h; y += 16) for (let x = 0; x < w; x += 16) { g.fillStyle = ((x + y) / 16) % 2 ? '#d8d8d8' : '#f4f4f4'; g.fillRect(x, y, 16, 16); }
      const px = new Uint8ClampedArray(buf);
      const st = new Uint8ClampedArray(px.length);
      let opaque = 0, sum = 0;
      for (let i = 0; i < px.length; i += 4) { const a = px[i + 3]; if (a > 8) opaque++; sum += px[i] + px[i + 1] + px[i + 2]; const k = a ? 255 / a : 0; st[i] = px[i] * k; st[i + 1] = px[i + 1] * k; st[i + 2] = px[i + 2] * k; st[i + 3] = a; }
      const tmp = new OffscreenCanvas(w, h); tmp.getContext('2d').putImageData(new ImageData(st, w, h), 0, 0);
      g.drawImage(tmp, 0, 0);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const u8 = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      const b64 = btoa(bin);
      return { b64, coverage: opaque / (w * h), mean: sum / (w * h * 3) };
    };
    return r;
  });
}
const ready = await open();
console.log('webgpu:', JSON.stringify(ready));
if (!ready.ok) { await browser.close(); srv.close(); process.exit(1); }

const [W, H] = size;
const results = [];
for (const s of selected) {
  const schemaOk = await page.evaluate(code => !!window.core.parseShaderSchema(code), s.code).catch(() => true);
  const features = JSON.parse(s.features);
  const times = features.isAnimated ? [0, 1500] : [0];
  let status = 'ok', detail = '', ms = 0;
  const gpuDied = e => /adapter|Instance|lost|crash|Target|closed/i.test(String(e));
  const run = async (fn, arg) => { try { return await page.evaluate(fn, arg); } catch (e) { return { error: String(e?.message ?? e) }; } };
  await run(() => window.newWorker());
  for (const time of times) {
    const r = await run(async ([s, W, H, scale, time]) => {
      const m = await window.render(s, W * scale, H * scale, scale, time);
      if (m.type !== 'done') return { error: m.error };
      const png = await window.toPng(m.pixels, m.w, m.h);
      return { ms: m.ms, errors: m.errors, ...png };
    }, [s, W, H, scale, time]);
    if (r.error && gpuDied(r.error)) await open();
    if (r.error?.startsWith('timeout') || (r.error && gpuDied(r.error))) {
      // software webgpu is ~100x slower than a gpu (and its watchdog kills long frames):
      // retry the heaviest modules small
      await run(() => window.newWorker());
      const small = await run(async ([s, time]) => {
        const m = await window.render(s, 64, 48, 0.25, time);
        return m.type === 'done' ? { ms: m.ms, errors: m.errors } : { error: m.error };
      }, [s, time]);
      if (small.error && gpuDied(small.error)) {
        // even tiny frames kill software webgpu (its jit / watchdog gives up on very large shaders)
        await open();
        status = 'SLOW'; detail = 'software webgpu loses the device on this module (huge shader): needs a hardware gpu to verify';
        break;
      }
      if (!small.error && !small.errors?.length) { status = 'SLOW'; detail = `too slow for software webgpu at ${W}x${H}; ok at 64x48 (${Math.round(small.ms)} ms)`; break; }
    }
    if (r.error || r.errors?.length) { status = 'FAIL'; detail = r.error ?? r.errors.map(e => e.error).join('; '); break; }
    ms = Math.max(ms, r.ms);
    const file = join(outDir, `${s.kind}-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${times.length > 1 ? `-t${time}` : ''}.png`);
    writeFileSync(file, Buffer.from(r.b64, 'base64'));
    if (r.coverage < 0.001) { status = 'EMPTY'; detail = 'output is fully transparent'; }
    else detail = `coverage ${(r.coverage * 100).toFixed(0)}% mean ${r.mean.toFixed(0)}`;
  }
  if (!schemaOk) { detail += ' (schema: not a plain literal)'; }
  results.push({ name: s.name, kind: s.kind, status, ms: Math.round(ms), detail });
  console.log(`${status.padEnd(5)} ${s.kind.padEnd(6)} ${s.name.padEnd(24)} ${String(Math.round(ms)).padStart(6)} ms  ${detail}`);
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify(results, null, 1));
await browser.close();
srv.close();
const bad = results.filter(r => r.status === 'FAIL' || r.status === 'EMPTY');
console.log(`\n${results.length - bad.length}/${results.length} ok${bad.length ? `, failing: ${bad.map(b => b.name).join(', ')}` : ''}`);
process.exit(bad.length ? 1 : 0);
