import { chromium } from './pw.mjs';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Debugger.enable');
page.goto('http://localhost:5173/?nobridge&blank&stress=5000&kinds=rect,ellipse,text,path&nested&play').catch(() => {});
await new Promise(r => setTimeout(r, 12000));
for (let k = 0; k < 3; k++) {
  const p = new Promise(res => cdp.once('Debugger.paused', e => res(e.callFrames.slice(0, 8).map(f => `${f.functionName || '(anon)'} ${f.url.split('/').pop().split('?')[0]}:${f.location.lineNumber + 1}`).join(' < '))));
  await cdp.send('Debugger.pause');
  console.log(await Promise.race([p, new Promise(r => setTimeout(() => r('no pause'), 5000))]));
  await cdp.send('Debugger.resume').catch(() => {});
  await new Promise(r => setTimeout(r, 1000));
}
process.exit(0);
