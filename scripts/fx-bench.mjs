// effects headroom benchmark (prototype in src/render/fx-proto.ts, loaded from the DEV server).
// per scene size and comp resolution, measures: plain render, temporal-supersampled motion blur,
// per-instance velocity motion blur, separable gaussian blur of the whole comp at 1, 1/2, 1/4 res.
// cpu = main thread time of the call; gpu+cpu = until a 1px readPixels returns (finish).
// on a software gpu (swiftshader) the gpu numbers are pessimistic by 1-2 orders of magnitude:
// compare them RELATIVE to the plain render of the same row.
// usage: URL=http://localhost:5181/ node scripts/fx-bench.mjs [counts=1000,5000,10000] [--sizes 1920x1080,3840x2160] [--frames 3] [--shot out.png]
import { chromium } from './pw.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const counts = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '1000,5000,10000').split(',').map(Number);
const sizes = arg('--sizes', '1920x1080,3840x2160').split(',').map(s => s.split('x').map(Number));
const frames = +arg('--frames', 3);
const only = arg('--only', '');
const shot = arg('--shot', '');
const url = process.env.URL || 'http://localhost:5173/';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const rows = [];
for (const n of counts) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', e => console.error('page error', e.message));
  await page.goto(`${url}?nobridge&blank&stress=${n}`);
  await page.waitForFunction(() => (window.editor?.renderer?.stats?.layers ?? 0) > 0, null, { timeout: 120000 });
  for (const [W, H] of sizes) {
    const r = await page.evaluate(async ({ W, H, frames, only, shot }) => {
      const { FxProto } = await import('/src/render/fx-proto.ts');
      const ed = window.editor, R = ed.renderer, gl = R.gl;
      ed.stop();
      const fx = window.__fx ?? (window.__fx = new FxProto(R));
      const scene = fx.target(W, H), accum = fx.target(W, H, true), out = fx.target(W, H), dummy = fx.target(1, 1);
      const half = [fx.target(W >> 1, H >> 1), fx.target(W >> 1, H >> 1)];
      const quarter = [fx.target(W >> 2, H >> 2), fx.target(W >> 2, H >> 2)];
      const full = [fx.target(W, H), fx.target(W, H)];
      R.dpr = 1;
      R.setView(W / ed.store.comp.width, 0, 0);
      R.setTarget(scene);
      const px = new Uint8Array(4);
      // a 1px read from an rgba8 target waits for every queued command (gl is in order)
      const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, dummy.fb); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); gl.bindFramebuffer(gl.FRAMEBUFFER, null); };
      let t = 1.0;
      const dt = 1 / 60, shutter = 0.5 / 60; // 180 degree shutter
      R.render(t); sync();
      const measure = (fn) => {
        fn(); sync(); // warm (shader compile, allocation)
        const cpu = [], tot = [];
        for (let f = 0; f < frames; f++) {
          t += dt;
          const a = performance.now(); fn(); const b = performance.now(); sync(); const c = performance.now();
          cpu.push(b - a); tot.push(c - a);
        }
        const med = x => +[...x].sort((p, q) => p - q)[x.length >> 1].toFixed(1);
        return `${med(cpu)} / ${med(tot)}`;
      };
      const res = { comp: `${W}x${H}` };
      const want = k => !only || only.split(',').includes(k);
      if (want('plain')) res['plain'] = measure(() => { R.setTarget(scene); R.render(t); });
      if (want('accum8')) res['accum x8'] = measure(() => fx.accumulate(t, 8, shutter, scene, accum));
      if (want('accum16')) res['accum x16'] = measure(() => fx.accumulate(t, 16, shutter, scene, accum));
      if (want('vel')) res['velocity<=16'] = measure(() => fx.velocity(t, shutter, 16, out, dummy));
      if (want('blur')) {
        R.setTarget(scene); R.render(t);
        res['blur r20 @1'] = measure(() => fx.blur(scene, 20, 1, full[0], full[1], out));
        res['blur r20 @1/2'] = measure(() => fx.blur(scene, 20, 0.5, half[0], half[1], out));
        res['blur r50 @1/2'] = measure(() => fx.blur(scene, 50, 0.5, half[0], half[1], out));
        res['blur r50 @1/4'] = measure(() => fx.blur(scene, 50, 0.25, quarter[0], quarter[1], out));
      }
      let img = null;
      if (shot) {
        // visual check: velocity blur and accumulation at the same time, side by side
        const cw = 960, ch = Math.round(960 * H / W);
        const c2 = document.createElement('canvas'); c2.width = cw * 2; c2.height = ch;
        const g = c2.getContext('2d');
        const grab = (tg) => {
          const buf = new Uint8Array(tg.w * tg.h * 4);
          gl.bindFramebuffer(gl.FRAMEBUFFER, tg.fb); gl.readPixels(0, 0, tg.w, tg.h, gl.RGBA, gl.UNSIGNED_BYTE, buf); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          const im = new ImageData(new Uint8ClampedArray(buf.buffer), tg.w, tg.h);
          const cv = new OffscreenCanvas(tg.w, tg.h); cv.getContext('2d').putImageData(im, 0, 0);
          return cv;
        };
        const T = 2.0, sh = 4 / 60; // long shutter so the blur is visible
        fx.velocity(T, sh, 32, out, dummy);
        g.save(); g.scale(1, -1); g.drawImage(grab(out), 0, -ch, cw, ch);
        // accumulation into accum (float) -> copy to rgba8 'out' for readback
        fx.accumulate(T, 32, sh, scene, accum); fx.copy(accum.tex, out);
        g.drawImage(grab(out), cw, -ch, cw, ch); g.restore();
        img = c2.toDataURL('image/png');
      }
      for (const tg of [scene, accum, out, dummy, ...half, ...quarter, ...full]) fx.dispose(tg);
      R.setTarget(null);
      return { res, img };
    }, { W, H, frames, only, shot });
    if (r.img) { const fs = await import('node:fs'); fs.writeFileSync(shot, Buffer.from(r.img.split(',')[1], 'base64')); console.log('wrote', shot); }
    rows.push({ layers: n, ...r.res });
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
  await page.close();
}
console.log('cells: cpu ms / cpu+gpu ms (median)');
console.table(rows);
await browser.close();
