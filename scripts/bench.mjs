// runs bench/canvas-bench.html in chromium and prints a table. usage: node scripts/bench.mjs [--headed]
import { chromium } from './pw.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const headed = process.argv.includes('--headed');
const browser = await chromium.launch({ headless: !headed, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
await page.goto('file://' + path.join(here, '../bench/canvas-bench.html'));
console.log('gl renderer:', await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); }));
const res = await page.evaluate(() => window.runBench(['dom','svg','canvas2d','webgl2_naive','webgl2_instanced'], [1000, 5000, 20000], 2));
console.table(res);
await browser.close();
