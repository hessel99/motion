// writes the zoomMix / crisp lab scenes as project json (so builds without them can load the same scenes)
// usage: URL=http://localhost:5211/ OUT=dir node scripts/zoom-dump.mjs   (URL must be a dev server)
import { chromium } from './pw.mjs';
import fs from 'node:fs';
const URL = process.env.URL || 'http://localhost:5173/', OUT = process.env.OUT || '.';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto(`${URL}?nobridge&blank&lab`);
await page.waitForFunction(() => !!window.motionLab, null, { timeout: 60000 });
for (const name of ['zoomMix', 'crisp']) {
  const json = await page.evaluate(async n => { const m = await import('/src/lab/scenes.ts'); return JSON.stringify(m.SCENES[n]({})); }, name);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(`${OUT}/${name}.json`, json);
  console.log(name, json.length);
}
await browser.close();
