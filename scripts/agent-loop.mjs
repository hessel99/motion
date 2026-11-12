// opens the editor (connected to the bridge) and drives it through MCP exactly like an agent would.
import { chromium } from './pw.mjs';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('http://localhost:5173/?blank');
await page.waitForFunction(async () => (await fetch('http://127.0.0.1:7823/health').then(r => r.json())).tools > 0, null, { timeout: 15000 });
let id = 0;
const rpc = async (method, params) => (await fetch('http://127.0.0.1:7823/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json();
const call = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); if (r.result?.isError) throw new Error(name + ': ' + r.result.content[0].text); return r.result.content; };
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
const tools = (await rpc('tools/list')).result.tools.map(t => t.name);
console.log('tools:', tools.join(', '));
const ids = [];
for (let i = 0; i < 3; i++) {
  const r = JSON.parse((await call('add_layer', { type: i === 1 ? 'ellipse' : 'rect', x: 660 + i * 220, y: 440, w: 180, h: 180, fill: ['#4c8dff', '#ff5a6b', '#ffc83f'][i], radius: 30, name: 'Shape ' + i }))[0].text);
  ids.push(r.id);
  await call('set_keyframes', { id: r.id, prop: 'scale', keyframes: [{ t: 0.2 + i * 0.15, v: 0, ease: 'spring Bouncy' }, { t: 1 + i * 0.15, v: 100 }] });
  await call('set_keyframes', { id: r.id, prop: 'rotation', keyframes: [{ t: 0.2 + i * 0.15, v: -90, ease: 'Expo Out' }, { t: 1.2 + i * 0.15, v: 0 }] });
}
const doc = JSON.parse((await call('get_document', {}))[0].text);
console.log('doc layers:', doc.layers.map(l => `${l.name}:${JSON.stringify(l.animated)}`).join(' '));
const shots = await call('screenshot', { times: [0.5, 1.5] });
console.log('screenshots:', shots.map(s => `${s.type} ${s.mimeType} ${Math.round(s.data.length / 1024)}KB`).join(', '));
const fs = await import('node:fs');
fs.writeFileSync(process.argv[2] || 'agent-shot.png', Buffer.from(shots[1].data, 'base64'));
// error path
try { await call('set_keyframes', { id: 'nope', prop: 'scale', keyframes: [] }); } catch (e) { console.log('error path ok:', e.message); }
// undo through history: agent changes are undoable
const before = await page.evaluate(() => editor.store.comp.root.length);
await page.keyboard.press('Control+z');
console.log('undo works on agent edits:', before, '->', await page.evaluate(() => Object.values(editor.store.project.layers).find(l => l.name === 'Shape 2')?.props.rotation.kf?.length ?? 'removed'));
console.log(errs.length ? errs : 'no page errors');
await browser.close();
