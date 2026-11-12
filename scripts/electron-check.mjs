// launches the real electron app (built renderer), checks bridge + rendering, screenshots.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const req = createRequire(execSync('npm root -g').toString().trim() + '/');
const { _electron } = req('playwright');
const app = await _electron.launch({ executablePath: process.env.EXE || (await import('electron')).default, args: process.env.EXE ? ['--no-sandbox'] : ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, MOTION_BRIDGE_PORT: '7830' } });
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
await win.evaluate(() => editor.store.setTime(2));
await win.waitForTimeout(300);
await win.screenshot({ path: process.argv[2] || 'electron.png' });
console.log(errs.length ? errs : 'no errors');
await app.close();
