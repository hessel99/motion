// a/b micro-benchmark for the renderer hot spots that structural edits and precomps hit, run
// alternately against two builds (the machine is shared, so interleaving matters more than length):
//   A=http://localhost:4202/ B=http://localhost:4201/ node scripts/compile-bench.mjs [rounds]
// per build: precomps-200x50 (random offsets) and -sync (5 offsets) eval/write ms per frame
// (renderer.render on a fixed time sequence, gpu calls stubbed), and ops-5k (bulk commands: ms until
// the next frame is rendered, minus the command itself = renderer + ui cost).
import { chromium } from './pw.mjs';

const urls = { A: process.env.A, B: process.env.B };
const ROUNDS = +(process.argv[2] || 3);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function open(u) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', e => console.error('pageerror', e.message));
  await page.goto(`${u}?nobridge&blank&lab`);
  await page.waitForFunction(() => window.motionLab && window.editor?.renderer, null, { timeout: 60000 });
  await page.evaluate(() => motionLab.setGpu(false));
  return page;
}

async function precomps(page, offsets) {
  await page.evaluate(o => motionLab.load('precomps', o), { comps: 200, inst: 50, inner: 4, ...(offsets ? { offsets } : {}) });
  return page.evaluate(() => {
    editor.pause();
    const r = editor.renderer;
    const ev = [], wr = [], cpu = [];
    for (let f = 0; f < 120; f++) {
      const t0 = performance.now();
      r.render(1 + f / 60);
      cpu.push(performance.now() - t0); ev.push(r.stats.evalMs); wr.push(r.stats.writeMs);
    }
    const med = a => a.slice(20).sort((x, y) => x - y)[(a.length - 20) >> 1];
    return { eval: med(ev), write: med(wr), cpu: med(cpu) };
  });
}

async function ops(page) {
  await page.evaluate(() => motionLab.load('springs', { n: 5000 }));
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => motionLab.ops());
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, +(v.frameMs - v.ms).toFixed(1)]));
}

const res = { A: [], B: [] };
for (let round = 0; round < ROUNDS; round++) {
  for (const k of round % 2 ? ['B', 'A'] : ['A', 'B']) {
    const page = await open(urls[k]);
    const row = { pc: await precomps(page, 0), pcSync: await precomps(page, 5) };
    await page.close();
    const p2 = await open(urls[k]);
    row.ops = await ops(p2);
    await p2.close();
    res[k].push(row);
    console.error(k, round, JSON.stringify(row));
  }
}
const best = rows => {
  const out = {};
  for (const sec of ['pc', 'pcSync', 'ops']) for (const key of Object.keys(rows[0][sec])) out[`${sec}.${key}`] = Math.min(...rows.map(r => r[sec][key]));
  return out;
};
const a = best(res.A), b = best(res.B);
console.table(Object.fromEntries(Object.keys(a).map(k => [k, { A: +a[k].toFixed(2), B: +b[k].toFixed(2), 'B/A': +(b[k] / a[k]).toFixed(2) }])));
await browser.close();
