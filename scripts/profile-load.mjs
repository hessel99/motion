// cpu profile of loading a big project (stress scene): where does the time to first frame go?
// usage: URL=http://localhost:5173/ node scripts/profile-load.mjs [count=10000] [extra query]
import { chromium } from './pw.mjs';
const n = +(process.argv[2] || 10000);
const extra = process.argv[3] || '';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${process.env.URL || 'http://localhost:5173/'}?nobridge&blank`);
await page.waitForFunction(() => window.editor?.renderer);
await page.waitForTimeout(500);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 }); await cdp.send('Profiler.start');
const ms = await page.evaluate(async ({ n, extra }) => {
  const { stressProject } = await import('/src/app/demo.ts');
  const t0 = performance.now();
  const p = stressProject({ count: n, ...(extra ? JSON.parse(extra) : {}) });
  const t1 = performance.now();
  editor.load(p);
  const t2 = performance.now();
  editor.renderer.render(editor.store.time);
  const t3 = performance.now();
  // first frame of the whole ui (timeline, overlay, panels)
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const t4 = performance.now();
  return { generate: +(t1 - t0).toFixed(0), load: +(t2 - t1).toFixed(0), firstRender: +(t3 - t2).toFixed(0), uiFrames: +(t4 - t3).toFixed(0) };
}, { n, extra });
const { profile } = await cdp.send('Profiler.stop');
console.log(JSON.stringify(ms));
const byId = new Map(profile.nodes.map(nd => [nd.id, nd])); const self = new Map();
profile.samples.forEach((s, i) => { const nd = byId.get(s); const k = `${nd.callFrame.functionName || '(anon)'} ${nd.callFrame.url.split('/').pop().split('?')[0]}:${nd.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + (profile.timeDeltas[i] || 0)); });
console.log([...self].filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)')).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, us]) => `${(us / 1000).toFixed(1).padStart(7)}ms  ${k}`).join('\n'));
await browser.close();
