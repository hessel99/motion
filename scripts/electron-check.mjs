// launches the real electron app (built renderer), checks bridge + rendering, screenshots.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const req = createRequire(execSync('npm root -g').toString().trim() + '/');
const { _electron } = req('playwright');
const app = await _electron.launch({ executablePath: process.env.EXE || (await import('electron')).default, args: process.env.EXE ? ['--no-sandbox'] : ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, MOTION_BRIDGE_PORT: '7830', MOTION_TEST: '1' } });
const win = await app.firstWindow();
const errs = []; win.on('pageerror', e => errs.push(e.message)); win.on('console', m => m.type() === 'error' && errs.push(m.text()));
await win.waitForFunction(() => window.editor?.renderer, null, { timeout: 20000 });
await win.waitForTimeout(2500);
const info = await win.evaluate(async () => ({
  native: !!window.motionNative,
  bridgePort: await window.motionNative?.bridgePort?.(),
  agentDot: document.querySelector('.dot')?.className,
  gl: (() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; })(),
  layers: Object.keys(editor.store.project.layers).length,
}));
console.log(JSON.stringify(info));
const w = await win.evaluate(async () => {
  const { loadStress } = await import('./assets/' + [...document.scripts].map(s => s.src).find(x => x.includes('index'))?.split('/').pop()).catch(() => ({}));
  void loadStress;
  editor.store.setTime(2); await new Promise(r => setTimeout(r, 300)); viewport.setZoom(viewport.zoom * 4);
  await new Promise(r => setTimeout(r, 2500));
  const R = editor.renderer; return { workersOk: R.workersOk, asyncRasters: R.asyncRasters, workers: R.workers.length, pending: R.pending.size, errs: R.workerErrors, fonts: [...document.fonts].filter(f => f.family === 'Inter' && f.status === 'loaded').length };
});
console.log('workers/fonts:', JSON.stringify(w));
await win.evaluate(() => { viewport.fit(); editor.store.setTime(2); });
await win.waitForTimeout(300);
await win.screenshot({ path: process.argv[2] || 'electron.png' });
console.log(errs.length ? errs : 'no errors');
await app.close();
