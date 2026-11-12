// electron smoke for the QA suite: launches the real app (built renderer, run `npm run build` first)
// and fails on main / preload / renderer errors: the window opens, motionNative is exposed, the
// updater answers, a new file renders, the window takes a small size.
//   xvfb-run -a node scripts/qa-electron.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const req = createRequire(execSync('npm root -g').toString().trim() + '/');
const { _electron } = req('playwright');
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : info}`); if (!ok) failed++; };
const benign = t => /GL Driver Message|GPU stall|Autofill\.|DevTools/.test(t);
const userData = mkdtempSync(join(tmpdir(), 'motion-qa-'));
const mainLog = [];
const app = await _electron.launch({
  executablePath: (await import('electron')).default,
  args: ['.', '--no-sandbox', `--user-data-dir=${userData}`],
  cwd: process.cwd(),
  env: { ...process.env, MOTION_BRIDGE_PORT: String(7900 + Math.floor(Math.random() * 90)), MOTION_TEST: '1' },
});
app.process().stderr?.on('data', d => mainLog.push(String(d)));
const win = await app.firstWindow();
const errs = [];
win.on('pageerror', e => errs.push(e.message));
win.on('console', m => { if (m.type() === 'error' && !benign(m.text())) errs.push(m.text()); });
await win.waitForFunction(() => window.editor?.renderer, null, { timeout: 30000 });
await win.waitForTimeout(1500);
const info = await win.evaluate(async () => ({
  native: !!window.motionNative, platform: window.motionNative?.platform,
  bridgePort: await window.motionNative?.bridgePort?.(),
  updates: await window.motionNative?.updates?.state?.().then(s => !!s, e => 'err ' + e.message),
}));
check('preload exposes motionNative', info.native, JSON.stringify(info));
check('bridge started', info.bridgePort > 0, JSON.stringify(info));
check('updater answers', info.updates === true, JSON.stringify(info));
await win.click('.preset-card >> nth=0').catch(() => {});
await win.waitForTimeout(800);
check('new file from Home', await win.evaluate(() => !document.querySelector('.home') && editor.store.comp.width === 1920));
const bw = await app.browserWindow(win);
await bw.evaluate(w => w.setSize(800, 600));
await win.waitForTimeout(500);
check('no horizontal overflow at 800×600', await win.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
check('no renderer errors', errs.length === 0, JSON.stringify(errs.slice(0, 5)));
const mainErrs = mainLog.join('').split('\n').filter(l => /Error|Unhandled|TypeError/.test(l) && !benign(l));
check('no main-process errors', mainErrs.length === 0, mainErrs.slice(0, 5).join('\n'));
await app.close();
console.log(failed ? `${failed} FAILED` : 'OK');
process.exit(failed ? 1 : 0);
