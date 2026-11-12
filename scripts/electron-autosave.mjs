import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const req = createRequire(execSync('npm root -g').toString().trim() + '/');
const { _electron } = req('playwright');
const exe = (await import('electron')).default;
const launch = () => _electron.launch({ executablePath: exe, args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, MOTION_BRIDGE_PORT: '7831', MOTION_TEST: '1' } });
let app = await launch();
let win = await app.firstWindow();
await win.waitForFunction(() => window.editor?.renderer, null, { timeout: 20000 });
await win.waitForTimeout(800);
const name = 'autosave-probe-' + Date.now();
await win.evaluate(async (name) => { const { addLayer } = await import(document.querySelector('script[type=module]').src.replace(/index-[^/]+\.js$/, '') + 'index-' + 'x').catch(() => ({})); void addLayer; }, name).catch(() => {});
// add via the store directly (works with the bundled build)
await win.evaluate((name) => { const st = window.editor.store; const id = 'probe_' + Math.random().toString(36).slice(2); st.transact('probe', tx => { const l = JSON.parse(JSON.stringify(Object.values(st.project.layers)[0])); l.id = id; l.name = name; l.children = []; l.parent = null; tx.set(st.project.layers, id, l); tx.set(st.comp, 'root', [...st.comp.root, id]); tx.structure(); }); }, name);
await win.waitForTimeout(3500); // debounce + idle callback
await win.evaluate(() => { window.__noUnloadGuard = true; });
await app.close();
app = await launch();
win = await app.firstWindow();
await win.waitForFunction(() => window.editor?.renderer, null, { timeout: 20000 });
await win.waitForTimeout(1500);
const found = await win.evaluate((name) => Object.values(window.editor.store.project.layers).some(l => l.name === name), name);
console.log('layer survived restart:', found);
await app.close();
