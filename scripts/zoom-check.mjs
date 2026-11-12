// deep zoom check: atlas churn + frame cost during a zoom sweep while playing, and crispness of
// zoomed renders against a direct canvas2d render of the same view.
// scenes come as project json (scripts/zoom-dump.mjs) so any build can load them.
// usage: URL=http://localhost:4211/ SCENES=dir OUT=dir [TAG=before] [DPR=1] node scripts/zoom-check.mjs
import { chromium } from './pw.mjs';
import fs from 'node:fs';
const URL = process.env.URL || 'http://localhost:5173/';
const SCENES = process.env.SCENES || '.', OUT = process.env.OUT || '.', TAG = process.env.TAG || 'run';
const DPR = +(process.env.DPR || 1);
const ONLY = process.env.ONLY || 'perf,crisp,shots';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: DPR });
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto(`${URL}?nobridge&blank`);
await page.waitForFunction(() => (window.editor?.renderer) && window.viewport, null, { timeout: 60000 });
const result = { tag: TAG, url: URL, dpr: DPR };

async function load(name) {
  const json = fs.readFileSync(`${SCENES}/${name}.json`, 'utf8');
  await page.evaluate(j => { window.editor.pause(); window.editor.load(JSON.parse(j)); }, json);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    // count every texture upload byte (atlas, dyn canvas, ramps) + keep atlas counters reachable
    const gl = window.editor.renderer.gl;
    if (gl.__counted) return;
    gl.__counted = true; window.__up = 0;
    const wrap = (f, bytes) => { const o = gl[f].bind(gl); gl[f] = (...a) => { window.__up += bytes(a); return o(...a); }; };
    wrap('texSubImage3D', a => a[5] * a[6] * a[7] * 4);
    wrap('texSubImage2D', a => (typeof a[4] === 'number' && typeof a[5] === 'number' && a.length >= 9) ? a[4] * a[5] * 4 : 0);
    wrap('texImage2D', a => (a.length >= 9 ? a[3] * a[4] * 4 : (a[5]?.width ?? 0) * (a[5]?.height ?? 0) * 4));
  });
}

async function settle(maxMs = 6000) {
  return page.evaluate(async maxMs => {
    const R = window.editor.renderer, t0 = performance.now();
    let quiet = 0;
    while (performance.now() - t0 < maxMs) {
      await new Promise(r => requestAnimationFrame(r));
      const busy = R.dirty || (R.pending && R.pending.size > 0) || R.pendingUpgrade;
      quiet = busy ? 0 : quiet + 1;
      if (quiet > 10) break;
    }
    return performance.now() - t0;
  }, maxMs);
}

if (ONLY.includes('perf')) {
  await load('zoomMix');
  await page.waitForTimeout(1500);
  const perf = await page.evaluate(async () => {
    const ed = window.editor, R = ed.renderer, A = R.atlas, vp = window.viewport;
    const host = document.querySelector('.viewport').getBoundingClientRect();
    vp.fit();
    const fitZ = vp.zoom;
    ed.store.setTime(0); ed.play();
    await new Promise(r => setTimeout(r, 1000));
    const snap = () => ({ ev: A.evictions, comp: A.compactions, gen: A.generation, up: window.__up, t: performance.now() });
    const phase = async (ms, perFrame) => {
      const s0 = snap(), frames = [], ticks = [];
      const orig = ed.tick.bind(ed);
      ed.tick = now => { const t = performance.now(); orig(now); ticks.push(performance.now() - t); frames.push(R.stats.frameMs); };
      const t0 = performance.now();
      let maxPages = A.pages;
      for (;;) {
        const now = performance.now();
        if (now - t0 >= ms) break;
        perFrame?.((now - t0) / ms);
        await new Promise(r => requestAnimationFrame(r));
        maxPages = Math.max(maxPages, A.pages);
      }
      ed.tick = orig;
      const s1 = snap(), sec = (s1.t - s0.t) / 1000;
      frames.sort((a, b) => a - b); ticks.sort((a, b) => a - b);
      const pct = (a, p) => a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2) : 0;
      const mean = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0;
      return {
        seconds: +sec.toFixed(2), frames: frames.length,
        evictionsPerSec: +((s1.ev - s0.ev) / sec).toFixed(1), compactionsPerSec: +((s1.comp - s0.comp) / sec).toFixed(2), evictAll: s1.gen - s0.gen,
        uploadMBPerSec: +((s1.up - s0.up) / sec / 1e6).toFixed(1),
        atlasPagesMax: maxPages, atlasMB: +(maxPages * 2048 * 2048 * 4 / 1e6).toFixed(0), shadowMB: +(A.shadowBytes / 1e6).toFixed(0), entries: A.size,
        frameMs: { mean: mean(frames), p50: pct(frames, 0.5), p95: pct(frames, 0.95), max: pct(frames, 1) },
        tickMs: { mean: mean(ticks), p95: pct(ticks, 0.95), max: pct(ticks, 1) },
      };
    };
    // anchor: the first headline (comp ~ 300, 220)
    const anchor = () => [vp.panX + 300 * vp.zoom, vp.panY + 220 * vp.zoom];
    const out = {};
    // sweep 0.05x -> 64x -> 0.05x (log space, 5 s each way) while playing
    vp.setZoom(0.05, ...anchor());
    out.sweep = await phase(10000, p => {
      const u = p < 0.5 ? p * 2 : (1 - p) * 2;
      const z = Math.exp(Math.log(0.05) + (Math.log(64) - Math.log(0.05)) * u);
      const [ax, ay] = anchor();
      vp.setZoom(z, ax, ay);
    });
    // hold 4x around the comp center while playing (atlas churn case)
    vp.fit();
    vp.setZoom(fitZ * 4 / fitZ * 1, host.width / 2, host.height / 2);
    await new Promise(r => setTimeout(r, 500));
    out.hold4x = await phase(4000);
    // hold 32x on the headline while playing
    vp.setZoom(32, ...anchor());
    await new Promise(r => setTimeout(r, 500));
    out.hold32x = await phase(3000);
    ed.pause();
    vp.fit();
    return out;
  });
  result.perf = perf;
  console.log(JSON.stringify(perf, null, 1));
}

/** render the current view and read it back (rgba, top row first) */
const READ = `(() => {
  const R = window.editor.renderer, gl = R.gl;
  R.dirty = true; R.render(window.editor.store.time);
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { w, h, px };
})()`;

async function savePng(file) {
  const b64 = await page.evaluate(async src => {
    const { w, h, px } = eval(src);
    const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    g.putImageData(img, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, READ);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
}

/** view so that comp point (x, y) sits at the canvas center at zoom z (renderer only: no ui zoom limit) */
async function view(z, x, y) {
  await page.evaluate(([z, x, y]) => {
    const R = window.editor.renderer;
    R.setView(z, R.cssW / 2 - x * z, R.cssH / 2 - y * z);
    window.viewport.zoom = z; window.viewport.panX = R.panX; window.viewport.panY = R.panY;
    window.editor.emit?.('view');
  }, [z, x, y]);
}

if (ONLY.includes('crisp')) {
  await load('crisp');
  await page.evaluate(() => window.editor.store.setTime(0));
  await page.waitForTimeout(1500);
  const rows = [];
  // targets sit on an edge: scan a line through each layer in a 16x reference for the first 50% crossing
  const targets = await page.evaluate(() => {
    const R = window.editor.renderer, st = window.editor.store;
    const find = (name, x0, y0, dx, dy) => {
      const id = st.comp.root.find(i => st.project.layers[i].name === name), l = st.project.layers[id];
      const W = R.world.subarray(R.index.get(id) * 6, R.index.get(id) * 6 + 6);
      const c = new OffscreenCanvas(1024, 4), g = c.getContext('2d');
      for (let k = 0; k < 1024; k++) {
        const x = x0 + dx * k / 16, y = y0 + dy * k / 16;
        g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 4, 4);
        g.setTransform(W[0], W[1], W[2], W[3], W[4] - x + 1, W[5] - y + 1);
        g.fillStyle = '#fff';
        if (l.type === 'text') { const t = l.text; g.font = `${t.fontWeight} ${t.fontSize}px ${t.fontFamily}, Inter, system-ui, sans-serif`; g.fillText(t.content, 0, (t.fontSize * t.lineHeight - t.fontSize) / 2 + t.fontSize * 0.8); }
        else { const p = new Path2D(); for (const cm of l.geometry[0].cmds) cm[0] === 'M' ? p.moveTo(cm[1], cm[2]) : cm[0] === 'L' ? p.lineTo(cm[1], cm[2]) : p.closePath(); g.fill(p); }
        if (g.getImageData(1, 1, 1, 1).data[3] > 127) return [x + 0.37, y + 0.29];
      }
      return [x0, y0];
    };
    return { text: find('Text', 160, 290, 1, 0), small: find('Small', 175, 474, 1, 0), star: find('Star', 1380, 115, 0, 1), ellipse: [450.3, 600.2] };
  });
  console.log('targets', JSON.stringify(targets));
  for (const z of [1, 8, 32, 128]) {
    for (const [name, [x, y]] of Object.entries(targets)) {
      await view(z, x, y);
      const settleMs = await settle();
      const r = await page.evaluate(async src => {
        const { w, h, px } = eval(src);
        const R = window.editor.renderer, st = window.editor.store;
        // reference: the same layers drawn straight with canvas2d at the view transform
        const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
        g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#fff';
        const z = R.zoom * R.dpr, px0 = R.panX * R.dpr, py0 = R.panY * R.dpr;
        for (const id of st.comp.root) {
          const l = st.project.layers[id], i = R.index.get(id), W = R.world.subarray(i * 6, i * 6 + 6);
          g.setTransform(z * W[0], z * W[1], z * W[2], z * W[3], z * W[4] + px0, z * W[5] + py0);
          if (l.type === 'text') {
            const t = l.text, fs = t.fontSize, lh = fs * t.lineHeight;
            g.font = `${t.fontWeight} ${fs}px ${t.fontFamily}, Inter, system-ui, sans-serif`;
            g.letterSpacing = '0px'; g.textBaseline = 'alphabetic';
            g.fillText(t.content, 0, (lh - fs) / 2 + fs * 0.8);
          } else if (l.type === 'path') {
            const p = new Path2D();
            for (const cm of l.geometry[0].cmds) cm[0] === 'M' ? p.moveTo(cm[1], cm[2]) : cm[0] === 'L' ? p.lineTo(cm[1], cm[2]) : p.closePath();
            g.fill(p, 'nonzero');
          } else if (l.type === 'ellipse') {
            const [ew, eh] = l.props.size.v;
            g.beginPath(); g.ellipse(ew / 2, eh / 2, ew / 2, eh / 2, 0, 0, Math.PI * 2); g.fill();
          }
        }
        const ref = g.getImageData(0, 0, w, h).data;
        // row 'probe': coverage along the canvas center row, out vs ref (debugging offsets)
        const my = h >> 1, probe = [];
        for (let x = 0; x < w; x++) { const a = px[((h - 1 - my) * w + x) * 4], b = ref[(my * w + x) * 4]; if (a || b) probe.push(x + ':' + a + '/' + b); }
        window.__probe = probe.slice(0, 40).join(' ');
        let max = 0, sum = 0, n = 0, edge = 0, eSum = 0;
        // only pixels inside the comp (outside is the editor pasteboard)
        const cx0 = Math.max(0, Math.ceil(px0)), cy0 = Math.max(0, Math.ceil(py0));
        const cx1 = Math.min(w, Math.floor(px0 + st.comp.width * z)), cy1 = Math.min(h, Math.floor(py0 + st.comp.height * z));
        for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) {
          const a = px[((h - 1 - y) * w + x) * 4], b = ref[(y * w + x) * 4];
          const d = Math.abs(a - b);
          if (a > 0 || b > 0) { sum += d; n++; if (d > max) max = d; }
          // edge pixels: partially covered in the reference
          if (b > 8 && b < 247) { edge++; eSum += d; }
        }
        return { max, mean: n ? sum / n : 0, edgeMean: edge ? eSum / edge : 0, edgePx: edge, covered: n };
      }, READ);
      if (process.env.PROBE) console.log(z, name, await page.evaluate(() => window.__probe));
      rows.push({ zoom: z, target: name, settleMs: Math.round(settleMs), max: r.max, mean: +r.mean.toFixed(2), edgeMean: +r.edgeMean.toFixed(1), edgePx: r.edgePx });
      await savePng(`${OUT}/${TAG}-crisp-${name}-${z}x.png`);
    }
  }
  console.table(rows);
  result.crisp = rows;
}

if (ONLY.includes('shots')) {
  await load('zoomMix');
  await page.evaluate(() => window.editor.store.setTime(1));
  await page.waitForTimeout(2000);
  for (const z of [1, 8, 32, 128]) {
    await view(z, 300, 220); // the first headline
    await settle();
    await savePng(`${OUT}/${TAG}-zoommix-${z}x.png`);
  }
}

fs.writeFileSync(`${OUT}/${TAG}.json`, JSON.stringify(result, null, 1));
await browser.close();
