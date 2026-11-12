// import fidelity runner: figma frames (ground truth exported from figma) + nasty svgs (ground truth
// = chromium's own svg rendering) + real pasted figma payloads, rendered through motion's importers
// and renderer in headless chromium, compared per pixel. writes bench/results/figma-fidelity/
// report.html (truth / ours / diff per case, worst first) and report.json.
//
//   npm run fidelity                       # everything that has inputs
//   node scripts/figma-fidelity.mjs --only figma,svg,paste --filter text/ --scale 1,2
//   URL=http://localhost:5391/ node scripts/figma-fidelity.mjs   # reuse a running dev server
//
// inputs (all gitignored, see docs/figma-fidelity-report.md):
//   bench/results/figma-truth/<section>/{meta.json,truth/*.png}   from the figma test file
//     (scripts/figma-fidelity/build/*.js through use_figma + unpack.mjs, or rest-fetch.mjs with a token)
//   fixtures/figma-paste/*.html | *.figcapture.json [+ same-name .png truth]   real pastes
import { chromium } from './pw.mjs';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, cpSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { SVG_CASES } from './svg-fidelity/cases.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ONLY = new Set(opt('only', 'figma,svg,paste').split(','));
const FILTER = opt('filter', '');
const SCALES = opt('scale', '1,2').split(',').map(Number);
const TRUTH = resolve(ROOT, opt('truth', 'bench/results/figma-truth'));
const PASTES = resolve(ROOT, opt('pastes', 'fixtures/figma-paste'));
const OUT = resolve(ROOT, opt('out', 'bench/results/figma-fidelity'));
const slug = s => s.replace(/[^a-zA-Z0-9._-]+/g, '_');
// --peer <checkout>: measure another checkout's importer + renderer (e.g. a branch in progress) with
// this harness: its src/ is copied next to the results and served by our vite; rest.ts is added if
// that checkout doesn't have it yet
const PEER = opt('peer', '');
let SERVE = ROOT;
if (PEER) {
  SERVE = resolve(ROOT, 'bench/results/figma-fidelity-peer', slug(basename(resolve(PEER))));
  rmSync(SERVE, { recursive: true, force: true });
  mkdirSync(SERVE, { recursive: true });
  for (const f of ['src', 'index.html', 'vite.config.ts', 'package.json', 'tsconfig.json']) cpSync(join(resolve(PEER), f), join(SERVE, f), { recursive: true });
  const rest = join(SERVE, 'src/import/figma/rest.ts');
  if (!existsSync(rest)) cpSync(join(ROOT, 'src/import/figma/rest.ts'), rest);
}

// ---------------- dev server (our own, on a free port) ----------------
async function freePort(start) {
  for (let p = start; p < start + 200; p++) {
    const ok = await new Promise(res => { const s = createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(p, '127.0.0.1'); });
    if (ok) return p;
  }
  throw new Error('no free port');
}
let server = null, BASE = process.env.URL;
if (!BASE) {
  const port = await freePort(5391);
  server = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: SERVE, stdio: ['ignore', 'pipe', 'pipe'] });
  BASE = `http://127.0.0.1:${port}/`;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(BASE); if (r.ok) break; } catch { /* starting */ }
    if (Date.now() - t0 > 60000) throw new Error('dev server did not start');
    await new Promise(r => setTimeout(r, 300));
  }
}
const stop = () => { try { server?.kill(); } catch { /* gone */ } };
process.on('exit', stop);

// ---------------- collect cases ----------------
const cases = [];
if (ONLY.has('figma') && existsSync(TRUTH)) {
  for (const sec of readdirSync(TRUTH).sort()) {
    const metaPath = join(TRUTH, sec, 'meta.json');
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    for (const f of meta.frames) {
      if (FILTER && !f.name.includes(FILTER)) continue;
      const truth = {};
      for (const s of SCALES) { const p = join(TRUTH, sec, 'truth', f.name.replace(/\//g, '__') + `@${s}x.png`); if (existsSync(p)) truth[s] = p; }
      const hasShader = JSON.stringify(f.node).includes('"SHADER"');
      const note = f.name.startsWith('shader-') && !hasShader ? 'shader not applied in the figma file (first-party shaders can only be added by hand; see docs)' : '';
      cases.push({ suite: 'figma', name: f.name, section: sec, w: Math.round(f.w), h: Math.round(f.h), node: f.node, images: meta.images ?? {}, format: meta.format ?? 'plugin', truth, note, excluded: !!note });
    }
  }
}
if (ONLY.has('svg')) for (const c of SVG_CASES) if (!FILTER || c.name.includes(FILTER)) cases.push({ suite: 'svg', name: c.name, w: c.w, h: c.h, svg: c.svg, truth: {} });
if (ONLY.has('paste') && existsSync(PASTES)) {
  for (const f of readdirSync(PASTES).sort()) {
    if (!/\.(html|figcapture\.json)$/.test(f)) continue;
    if (FILTER && !f.includes(FILTER)) continue;
    const p = join(PASTES, f);
    let html = readFileSync(p, 'utf8');
    if (f.endsWith('.json')) { try { html = JSON.parse(html).html ?? ''; } catch { html = ''; } }
    const base = f.replace(/\.(html|figcapture\.json)$/, '');
    const truth = {};
    for (const s of SCALES) { const t = [join(PASTES, `${base}@${s}x.png`), s === 1 ? join(PASTES, `${base}.png`) : ''].find(x => x && existsSync(x)); if (t) truth[s] = t; }
    cases.push({ suite: 'paste', name: 'paste/' + base, html, truth, w: 0, h: 0 });
  }
}
if (!cases.length) { console.log('nothing to run: no figma truth in', TRUTH, '(see docs/figma-fidelity-report.md)'); stop(); process.exit(0); }

// ---------------- browser ----------------
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--font-render-hinting=none', '--enable-unsafe-webgpu'] });
// figma shader sources (figma payloads never carry them): the local mcp cache, gitignored
const SHADER_CACHE = join(ROOT, '.figma-cache');
const shaderSources = existsSync(SHADER_CACHE) ? readdirSync(SHADER_CACHE).filter(d => existsSync(join(SHADER_CACHE, d, 'main.ts'))).map(d => {
  const m = JSON.parse(readFileSync(join(SHADER_CACHE, d, 'meta.json'), 'utf8'));
  return { id: m.id, name: m.name, kind: m.type, version: m.version, files: { 'main.ts': readFileSync(join(SHADER_CACHE, d, 'main.ts'), 'utf8'), 'features.json': readFileSync(join(SHADER_CACHE, d, 'features.json'), 'utf8') } };
}) : [];
const pageErrors = [];
let page = null, pageUses = 0;
async function freshPage() {
  if (page) await page.close().catch(() => {});
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  pageUses = 0;
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(`${BASE}?nobridge&blank`);
  await page.waitForFunction(() => window.editor?.renderer, null, { timeout: 60000 });
  await page.evaluate(SETUP);
  if (shaderSources.length) await page.evaluate(list => window.__fidShaders(list), shaderSources);
}
// installed in the page: window.__fid (render through motion's importers, compare)
const SETUP = async () => {
  const actions = await import('/src/app/actions.ts');
  const model = await import('/src/core/model.ts');
  const commands = await import('/src/core/commands.ts');
  const figma = await import('/src/import/figma/index.ts');
  const rest = await import('/src/import/figma/rest.ts');
  const svgm = await import('/src/import/svg.ts');
  const fonts = await import('/src/render/fonts.ts');
  await fonts.loadBundledFonts();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ed = window.editor;
  ed.pause(); ed.stop();

  async function renderRes(res, w, h, scales, bg = [1, 1, 1, 1]) {
    ed.load(model.createProject('fidelity'));
    const st = ed.store;
    commands.setCompSettings(st, { width: Math.max(1, w), height: Math.max(1, h), background: bg });
    actions.insertLayers(res, { label: 'fidelity', fitCompIfEmpty: true });
    const W = st.comp.width, H = st.comp.height;
    const r = ed.renderer, out = {};
    await sleep(30);
    for (const s of scales) {
      r.syncRaster = true;
      r.resize(W, H, s); r.setView(1, 0, 0);
      for (let k = 0; k < 60; k++) { r.dirty = true; r.render(0); if (!r.asyncRasters && k > 2) break; await sleep(20); }
      r.dirty = true; r.render(0);
      // figma shaders render asynchronously (webgpu worker): wait for this exact frame
      if (r.settleShaders) { await r.settleShaders(0); r.render(0); }
      out[s] = r.canvas.toDataURL('image/png');
    }
    r.syncRaster = false;
    const layers = Object.values(st.project.layers);
    return { shots: out, w: W, h: H, layers: layers.length, types: layers.map(l => l.type).join(',') };
  }

  window.__fidShaders = list => figma.registerShaderSources?.(list);
  window.__fid = {
    async figma(node, images, format, w, h, scales) {
      const msg = format === 'rest' ? rest.restNodesToMessage([node], images) : rest.pluginNodesToMessage([node], images);
      const res = figma.figmaMessageToLayers(msg);
      return renderRes(res, w, h, scales);
    },
    async paste(html, scales) {
      const res = figma.parseFigmaClipboard(html);
      if (!res || !res.roots.length) throw new Error('payload did not decode');
      return renderRes(res, 0, 0, scales);
    },
    async svgOurs(text, w, h, scales) {
      const res = svgm.svgToLayers(text);
      return renderRes(res, w, h, scales);
    },
    async svgTruth(text, w, h, scales) {
      const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
      const im = new Image(); im.src = url; await im.decode();
      const out = {};
      for (const s of scales) {
        const c = document.createElement('canvas'); c.width = w * s; c.height = h * s;
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
        out[s] = c.toDataURL('image/png');
      }
      URL.revokeObjectURL(url);
      return out;
    },
    /** per-pixel compare over white: mean delta, share of clearly wrong pixels, block ssim, diff image */
    async compare(truthUrl, oursUrl) {
      const load = async src => { const im = new Image(); im.src = src; await im.decode(); return im; };
      const [a, b] = await Promise.all([load(truthUrl), load(oursUrl)]);
      const w = a.naturalWidth, h = a.naturalHeight;
      const px = im => { const c = new OffscreenCanvas(w, h), g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(im, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; };
      const A = px(a), B = px(b);
      const n = w * h, la = new Float32Array(n), lb = new Float32Array(n);
      const diff = new ImageData(w, h);
      let sum = 0, bad = 0, soft = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        const dr = Math.abs(A[o] - B[o]), dg = Math.abs(A[o + 1] - B[o + 1]), db = Math.abs(A[o + 2] - B[o + 2]);
        const m = Math.max(dr, dg, db);
        sum += (dr + dg + db) / 3;
        if (m > 32) bad++;
        if (m > 8) soft++;
        la[i] = 0.299 * A[o] + 0.587 * A[o + 1] + 0.114 * A[o + 2];
        lb[i] = 0.299 * B[o] + 0.587 * B[o + 1] + 0.114 * B[o + 2];
        const base = 255 - (255 - la[i]) * 0.25, k = Math.min(1, m / 64);
        diff.data[o] = base * (1 - k) + 255 * k; diff.data[o + 1] = base * (1 - k); diff.data[o + 2] = base * (1 - k) + 40 * k; diff.data[o + 3] = 255;
      }
      // ssim over 8x8 windows (stride 4) on luminance
      const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
      let ss = 0, cnt = 0;
      for (let y = 0; y + 8 <= h; y += 4) for (let x = 0; x + 8 <= w; x += 4) {
        let ma = 0, mb = 0;
        for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const p = (y + j) * w + x + i; ma += la[p]; mb += lb[p]; }
        ma /= 64; mb /= 64;
        let va = 0, vb = 0, cv = 0;
        for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const p = (y + j) * w + x + i; const da = la[p] - ma, dbb = lb[p] - mb; va += da * da; vb += dbb * dbb; cv += da * dbb; }
        va /= 63; vb /= 63; cv /= 63;
        ss += ((2 * ma * mb + C1) * (2 * cv + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); cnt++;
      }
      const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(diff, 0, 0);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const diffUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
      return { w, h, oursW: b.naturalWidth, oursH: b.naturalHeight, meanDelta: sum / n, badPct: (100 * bad) / n, softPct: (100 * soft) / n, ssim: cnt ? ss / cnt : 1, diffUrl };
    },
  };
};
await freshPage();

// ---------------- run ----------------
mkdirSync(join(OUT, 'img'), { recursive: true });
const writeUrl = (url, file) => writeFileSync(file, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
const toUrl = p => 'data:image/png;base64,' + readFileSync(p).toString('base64');
const results = [];
let i = 0;
for (const c of cases) {
  i++;
  const id = slug(c.name);
  const r = { suite: c.suite, name: c.name, section: c.section, note: c.note || '', excluded: !!c.excluded, scales: {}, error: null };
  const t0 = Date.now();
  // the webgl context leaks a little per project load on swiftshader: recycle the page now and then,
  // and retry a case once on a fresh page if the renderer process died
  if (++pageUses > 20) await freshPage();
  for (let attempt = 0; attempt < 2; attempt++) try {
    let ours, truthUrls = {};
    if (c.suite === 'figma') {
      ours = await page.evaluate(([n, im, f, w, h, sc]) => window.__fid.figma(n, im, f, w, h, sc), [c.node, c.images, c.format, c.w, c.h, SCALES]);
      for (const s of SCALES) if (c.truth[s]) truthUrls[s] = toUrl(c.truth[s]);
    } else if (c.suite === 'svg') {
      [ours, truthUrls] = await Promise.all([
        page.evaluate(([t, w, h, sc]) => window.__fid.svgOurs(t, w, h, sc), [c.svg, c.w, c.h, SCALES]),
        page.evaluate(([t, w, h, sc]) => window.__fid.svgTruth(t, w, h, sc), [c.svg, c.w, c.h, SCALES]),
      ]);
      writeFileSync(join(OUT, 'img', id + '.svg'), c.svg);
    } else {
      ours = await page.evaluate(([html, sc]) => window.__fid.paste(html, sc), [c.html, SCALES]);
      for (const s of SCALES) if (c.truth[s]) truthUrls[s] = toUrl(c.truth[s]);
    }
    r.layers = ours.layers; r.layerTypes = ours.types; r.size = [ours.w, ours.h];
    for (const s of SCALES) {
      const e = { ours: `img/${id}@${s}x-ours.png` };
      writeUrl(ours.shots[s], join(OUT, e.ours));
      if (truthUrls[s]) {
        e.truth = `img/${id}@${s}x-truth.png`;
        writeUrl(truthUrls[s], join(OUT, e.truth));
        const m = await page.evaluate(([a, b]) => window.__fid.compare(a, b), [truthUrls[s], ours.shots[s]]);
        e.diff = `img/${id}@${s}x-diff.png`;
        writeUrl(m.diffUrl, join(OUT, e.diff));
        Object.assign(e, { ssim: +m.ssim.toFixed(4), meanDelta: +m.meanDelta.toFixed(2), badPct: +m.badPct.toFixed(2), softPct: +m.softPct.toFixed(2), sizeMismatch: m.w !== m.oursW || m.h !== m.oursH ? `${m.oursW}x${m.oursH} vs ${m.w}x${m.h}` : undefined });
      }
      r.scales[s] = e;
    }
    const m1 = r.scales[SCALES[0]];
    r.score = m1?.ssim != null ? +(100 * (0.4 * m1.ssim + 0.3 * (1 - m1.badPct / 100) + 0.3 * (1 - m1.softPct / 100))).toFixed(1) : null;
    r.error = null;
    break;
  } catch (e) {
    r.error = String(e?.message ?? e).split('\n')[0];
    r.score = 0;
    if (/crash|closed|Target/i.test(r.error) && attempt === 0) { await freshPage(); continue; }
    break;
  }
  r.ms = Date.now() - t0;
  results.push(r);
  process.stdout.write(`\r${i}/${cases.length} ${c.name.padEnd(48).slice(0, 48)} ${r.error ? 'ERROR ' + r.error.slice(0, 60) : r.score ?? '-'}      `);
}
process.stdout.write('\n');
await browser.close();
stop();

// ---------------- report ----------------
const ranked = results.filter(r => r.score != null).sort((a, b) => (a.excluded - b.excluded) || a.score - b.score);
const unscored = results.filter(r => r.score == null);
const suites = {};
for (const r of results) {
  if (r.excluded || r.score == null) continue;
  const k = r.suite === 'figma' ? r.name.split('/')[0] : r.suite;
  (suites[k] ??= []).push(r.score);
}
const summary = Object.fromEntries(Object.entries(suites).map(([k, v]) => [k, { n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1), min: Math.min(...v) }]));
const report = { generatedAt: new Date().toISOString(), url: BASE, peer: PEER || undefined, scales: SCALES, summary, pageErrors: [...new Set(pageErrors)].slice(0, 50), results: [...ranked, ...unscored] };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const s0 = SCALES[0];
const row = r => {
  const e = r.scales?.[s0] ?? {};
  const alt = SCALES.slice(1).map(s => r.scales?.[s]?.ssim != null ? `${s}x ssim ${r.scales[s].ssim} · bad ${r.scales[s].badPct}%` : '').filter(Boolean).join(' · ');
  return `<section class="case${r.excluded ? ' excluded' : ''}" id="${esc(slug(r.name))}">
  <header><b>${esc(r.name)}</b> <span class="score">${r.score ?? '–'}</span>
  <span class="m">ssim ${e.ssim ?? '–'} · Δ ${e.meanDelta ?? '–'} · bad ${e.badPct ?? '–'}% · soft ${e.softPct ?? '–'}% ${alt ? '· ' + esc(alt) : ''} · ${r.layers ?? 0} layers ${e.sizeMismatch ? '· size ' + esc(e.sizeMismatch) : ''}</span>
  ${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}${r.error ? `<div class="err">${esc(r.error)}</div>` : ''}</header>
  <div class="imgs">${e.truth ? `<figure><img src="${e.truth}" loading="lazy"><figcaption>truth</figcaption></figure>` : ''}${e.ours ? `<figure><img src="${e.ours}" loading="lazy"><figcaption>motion</figcaption></figure>` : ''}${e.diff ? `<figure><img src="${e.diff}" loading="lazy"><figcaption>diff</figcaption></figure>` : ''}</div>
</section>`;
};
const html = `<!doctype html><meta charset="utf-8"><title>Import fidelity</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#f6f6f7;--fg:#111;--mut:#666;--card:#fff;--line:#e3e3e6;--bad:#c62828;--ok:#2e7d32}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#eee;--mut:#9a9aa2;--card:#1d1d21;--line:#2c2c31}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:13px/1.4 system-ui,sans-serif}
h1{font-size:18px} table{border-collapse:collapse;margin:8px 0 20px} td,th{padding:3px 10px;border-bottom:1px solid var(--line);text-align:left}
.case{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;margin:0 0 12px}
.case.excluded{opacity:.55} .score{font-weight:700;margin:0 8px} .m{color:var(--mut)} .note{color:#b26a00} .err{color:var(--bad)}
.imgs{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px} figure{margin:0} figcaption{color:var(--mut);font-size:11px}
img{max-width:min(400px,100%);height:auto;border:1px solid var(--line);image-rendering:auto;background:#fff}
</style>
<h1>Import fidelity (${results.length} cases, scales ${SCALES.join(', ')})${PEER ? ' · ' + esc(basename(resolve(PEER))) : ''}</h1>
<p class="m">score = 100 × (0.4·ssim + 0.3·(1 − bad) + 0.3·(1 − soft)); bad / soft = share of pixels whose max channel delta over white is &gt; 32 / &gt; 8. ${esc(report.generatedAt)}</p>
<table><tr><th>group</th><th>cases</th><th>mean score</th><th>worst</th></tr>${Object.entries(summary).sort((a, b) => a[1].mean - b[1].mean).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${v.mean}</td><td>${v.min}</td></tr>`).join('')}</table>
${ranked.map(row).join('\n')}
${unscored.length ? `<h2>no ground truth (render only)</h2>${unscored.map(row).join('\n')}` : ''}`;
writeFileSync(join(OUT, 'report.html'), html);
console.log(`report: ${join(OUT, 'report.html')}`);
for (const [k, v] of Object.entries(summary).sort((a, b) => a[1].mean - b[1].mean)) console.log(`  ${k.padEnd(14)} n=${String(v.n).padStart(3)}  mean ${v.mean}  worst ${v.min}`);
if (pageErrors.length) console.log(`page errors: ${[...new Set(pageErrors)].length} (see report.json)`);
void statSync; void basename;
