// screenshot + console errors. usage: node scripts/shot.mjs "<query>" out.png [waitMs] [--headed] [--eval "js"]
import { chromium } from './pw.mjs';
const [,, query = '', out = 'shot.png', wait = '1500'] = process.argv;
const headed = process.argv.includes('--headed');
const evalIdx = process.argv.indexOf('--eval');
const browser = await chromium.launch({ headless: !headed, args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.goto('http://localhost:5173/?' + query);
await page.waitForTimeout(+wait);
if (evalIdx > 0) console.log('eval:', JSON.stringify(await page.evaluate(process.argv[evalIdx + 1])));
await page.screenshot({ path: out });
console.log(errors.slice(0, 20).join('\n') || 'no console errors');
await browser.close();
