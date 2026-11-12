// end to end interaction test in chromium: drives the real ui with mouse + keyboard.
import { chromium } from './pw.mjs';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5173/?nobridge&blank');
await page.waitForFunction(() => window.editor?.renderer);
const ev = (fn, arg) => page.evaluate(fn, arg);
let _lw = 300; const timeline_leftW = () => _lw;
const results = [];
const check = (name, ok, info = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); };
const vp = await page.locator('.viewport').boundingBox();
const cx = vp.x + vp.width / 2, cy = vp.y + vp.height / 2;

// draw a rectangle with the R tool
await page.keyboard.press('r');
await page.mouse.move(cx - 100, cy - 60); await page.mouse.down();
await page.mouse.move(cx, cy, { steps: 5 }); await page.mouse.move(cx + 100, cy + 60, { steps: 5 }); await page.mouse.up();
let s = await ev(() => ({ n: editor.store.comp.root.length, sel: editor.store.selection.length, tool: editor.tool, size: editor.store.layer(editor.store.comp.root[0])?.props.size.v }));
check('draw rect', s.n === 1 && s.sel === 1 && s.tool === 'select', JSON.stringify(s));
const undoAfterDraw = await ev(() => editor.store.undoLabel);
check('draw is one undo step', undoAfterDraw === 'Add rect' || undoAfterDraw === 'Resize', undoAfterDraw);

// drag move
const before = await ev(() => editor.store.layer(editor.store.selection[0]).props.position.v.slice());
await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 80, cy + 40, { steps: 8 }); await page.mouse.up();
const after = await ev(() => editor.store.layer(editor.store.selection[0]).props.position.v.slice());
const zoom = await ev(() => viewport.zoom);
check('drag moves layer', Math.abs((after[0] - before[0]) * zoom - 80) < 2 && Math.abs((after[1] - before[1]) * zoom - 40) < 2, `${before} -> ${after}`);
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
const undone = await ev(() => editor.store.layer(editor.store.selection[0]).props.position.v.slice());
check('undo move in one step', undone[0] === before[0] && undone[1] === before[1], `${undone}`);

await page.waitForTimeout(100);
// snapping: drag the rect so its center lands ~3px (screen) away from the comp center -> snaps exactly
{
  const r = await ev(() => { const id = editor.store.selection[0]; const c = editor.renderer.corners(id); return { cx: (c[0] + c[4]) / 2, cy: (c[1] + c[5]) / 2, z: viewport.zoom, px: viewport.panX, py: viewport.panY, W: editor.store.comp.width, H: editor.store.comp.height }; });
  const sx = vp.x + r.px + r.cx * r.z, sy = vp.y + r.py + r.cy * r.z; // current screen center of the rect
  const tx = vp.x + r.px + (r.W / 2) * r.z + 3, ty = vp.y + r.py + (r.H / 2 + 40) * r.z; // 3px right of comp center x
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(tx, ty, { steps: 6 });
  const guides = await ev(() => viewport.guides.x.length);
  await page.mouse.up();
  const c2 = await ev(() => { const c = editor.renderer.corners(editor.store.selection[0]); return (c[0] + c[4]) / 2; });
  check('snaps to comp center with guide', Math.abs(c2 - r.W / 2) < 0.01 && guides > 0, `center x ${c2}, guides ${guides} start ${JSON.stringify(r)} sx ${sx} tx ${tx}`);
  await page.keyboard.press('Control+z');
}

// keyframe via inspector diamond (position), then move time and drag again -> 2 keyframes
await page.locator('.inspector .keybtn').first().click();
await ev(() => editor.store.setTime(1));
await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 120, cy, { steps: 8 }); await page.mouse.up();
const kfs = await ev(() => editor.store.layer(editor.store.selection[0]).props.position.kf?.map(k => [k.t, k.v.map(Math.round)]));
check('auto keyframe on drag when animated', kfs?.length === 2, JSON.stringify(kfs));
const mid = await ev(() => { editor.store.setTime(0.5); editor.renderer.render(0.5); return editor.renderer.worldMatrix(editor.store.selection[0]); });
check('interpolates at 0.5s', mid && mid[4] > kfs[0][1][0] - 200, JSON.stringify(mid?.map(Math.round)));

// timeline shows prop rows, select keys by marquee in timeline and apply ease via F9
const tl = await page.locator('.timeline').boundingBox();
await page.mouse.move(tl.x + tl.width - 60, tl.y + 28 + 24 + 6); await page.mouse.down(); await page.mouse.move(tl.x + 306, tl.y + 120, { steps: 6 }); await page.mouse.up();
const ksel = await ev(() => editor.store.keySelection.size);
check('timeline marquee selects keys', ksel >= 2, `selected ${ksel}`);
await page.keyboard.press('F9');
const ease = await ev(() => editor.store.layer(editor.store.selection[0]).props.position.kf[0].out);
check('F9 easy ease', ease[0] === 0.333 && ease[1] === 0, JSON.stringify(ease));
await page.waitForTimeout(200);
const curve = await page.locator('.curve').count();
check('easing editor visible with keys selected', curve === 1);

// drag a keyframe in timeline (move second key to the right)
const keyMoved = await ev(() => {
  const l = editor.store.layer(editor.store.selection[0]);
  return { t: l.props.position.kf[1].t, x: timeline.tToX(l.props.position.kf[1].t), rows: timeline.rows.map(r => r.kind + ':' + (r.prop || '')) };
});
const rowIdx = keyMoved.rows.indexOf('prop:position');
const ky = tl.y + 28 + rowIdx * 24 + 12;
await page.mouse.click(tl.x + 200, tl.y + 300); // deselect keys (empty area)
await page.mouse.move(tl.x + keyMoved.x, ky); await page.mouse.down(); await page.mouse.move(tl.x + keyMoved.x + 100, ky, { steps: 6 }); await page.mouse.up();
const newT = await ev(() => editor.store.layer(editor.store.selection[0])?.props.position.kf?.[1]?.t);
check('drag keyframe in timeline', newT > keyMoved.t + 0.2, `${keyMoved.t} -> ${newT}`);

// drag layer bar: moves the whole layer + keys in time
{
  const k0 = await ev(() => editor.store.layer(editor.store.selection[0]).props.position.kf.map(k => k.t));
  const bx = tl.x + 700, by = tl.y + 28 + 12;
  await page.mouse.move(bx, by); await page.mouse.down(); await page.mouse.move(bx + 60, by, { steps: 5 }); await page.mouse.up();
  const k1 = await ev(() => { const l = editor.store.layer(editor.store.selection[0]); return { t: l.props.position.kf.map(k => k.t), inP: l.inPoint }; });
  const dt = k1.t[0] - k0[0];
  check('drag layer bar shifts keys + in point', dt > 0.1 && Math.abs((k1.t[1] - k0[1]) - dt) < 1e-9 && Math.abs(k1.inP - dt) < 1e-9, `${k0} -> ${k1.t} in ${k1.inP}`);
  await page.keyboard.press('Control+z');
}

// keyframe copy/paste: select both position keys, copy, move playhead, paste -> 4 keys
{
  await ev(() => { const id = editor.store.selection[0]; editor.store.keySelection = new Set([id + '|position|0', id + '|position|1']); editor.store.emit('keys'); editor.store.setTime(3); });
  await page.mouse.move(cx, cy - 250);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(100);
  const ts = await ev(() => editor.store.layer(editor.store.selection[0]).props.position.kf.map(k => +k.t.toFixed(3)));
  check('copy/paste keyframes at playhead', ts.length === 4 && ts[2] === 3, JSON.stringify(ts));
  await page.keyboard.press('Control+z');
  await ev(() => { editor.store.keySelection.clear(); editor.store.emit('keys'); });
}

// graph editor: switch to graph, select first position key, drag its out handle -> ease changes
{
  const lid = await ev(() => editor.store.selection[0]);
  await ev((id) => { editor.store.keySelection = new Set([id + '|position|0']); editor.store.emit('keys'); timeline.expand(id, true); }, lid);
  await page.mouse.click(tl.x + timeline_leftW() - 30, tl.y + 14);
  await page.waitForTimeout(150);
  const before = await ev((id) => editor.store.layer(id).props.position.kf[0].out.slice(), lid);
  const h = await ev(() => { const gv = timeline.graph; const c = gv.curves.find(c => c.handles); const kf = c.layer.props[c.key].kf; return gv.handlePos(c, kf, 0); });
  await page.mouse.move(tl.x + h.ox, tl.y + h.oy); await page.mouse.down(); await page.mouse.move(tl.x + h.ox + 40, tl.y + h.oy - 30, { steps: 5 }); await page.mouse.up();
  const after = await ev((id) => editor.store.layer(id).props.position.kf[0].out.slice(), lid);
  check('graph editor handle drag edits easing', after[0] !== before[0] || after[1] !== before[1], `${before} -> ${after}`);
  await page.mouse.click(tl.x + timeline_leftW() - 90, tl.y + 14); // back to keys
}

// motion path: drag the 2nd position keyframe on the canvas, alt-click the 1st to curve it
{
  await page.keyboard.press('Escape');
  const lid = await ev(() => { const id = Object.values(editor.store.project.layers).find(l => l.props.position?.kf?.length >= 2).id; editor.store.select([id]); return id; });
  await page.waitForTimeout(100);
  const pts = await ev(() => viewport.pathPoints().filter(p => p.part === 'key'));
  const v0 = await ev((id) => editor.store.layer(id).props.position.kf[1].v.slice(), lid);
  await page.mouse.move(vp.x + pts[1].x, vp.y + pts[1].y); await page.mouse.down(); await page.mouse.move(vp.x + pts[1].x + 40, vp.y + pts[1].y - 20, { steps: 4 }); await page.mouse.up();
  const v1 = await ev((id) => editor.store.layer(id).props.position.kf[1].v.slice(), lid);
  const z = await ev(() => viewport.zoom);
  check('drag motion path keyframe', Math.abs((v1[0] - v0[0]) * z - 40) < 1.5 && Math.abs((v1[1] - v0[1]) * z + 20) < 1.5, `${v0} -> ${v1}`);
  await page.keyboard.down('Alt'); await page.mouse.click(vp.x + pts[0].x, vp.y + pts[0].y); await page.keyboard.up('Alt');
  const so = await ev((id) => editor.store.layer(id).props.position.kf[0].sOut, lid);
  check('alt-click curves a motion path key', !!so && (so[0] !== 0 || so[1] !== 0), JSON.stringify(so));
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
}

// scrub ruler
await page.mouse.click(tl.x + 700, tl.y + 10);
const tScrub = await ev(() => editor.store.time);
check('ruler scrub sets time', tScrub > 0, String(tScrub));

// play / pause with space
await page.mouse.move(cx, cy - 200);
await page.keyboard.press('Space');
await page.waitForTimeout(400);
const playing = await ev(() => editor.store.playing);
await page.keyboard.press('Space');
check('space toggles play', playing === true);

// copy paste
await page.keyboard.press('Escape');
await ev(() => editor.store.select([editor.store.comp.root[0]]));
await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v');
const n2 = await ev(() => editor.store.comp.root.length);
check('copy/paste layer', n2 === 2, String(n2));
// duplicate + group + ungroup
await page.keyboard.press('Control+a'); await page.keyboard.press('Control+g');
const grouped = await ev(() => ({ root: editor.store.comp.root.length, kids: editor.store.layer(editor.store.comp.root[0])?.children.length }));
check('group', grouped.root === 1 && grouped.kids === 2, JSON.stringify(grouped));
await page.keyboard.press('Control+Shift+g');
const ung = await ev(() => editor.store.comp.root.length);
check('ungroup', ung === 2, String(ung));
// text tool
await page.keyboard.press('t');
await page.mouse.click(cx - 300, cy - 200);
await page.waitForTimeout(100);
await page.keyboard.type('Hello');
await page.mouse.click(cx + 300, cy + 200);
const txt = await ev(() => Object.values(editor.store.project.layers).find(l => l.type === 'text')?.text.content);
check('text tool + typing', txt === 'Hello', String(txt));
// pen: triangle with one curved point, closed by clicking the first point
{
  await page.keyboard.press('Escape');
  await page.keyboard.press('p');
  await page.mouse.click(cx - 200, cy + 150);
  await page.mouse.move(cx - 100, cy - 100); await page.mouse.down(); await page.mouse.move(cx - 40, cy - 100, { steps: 3 }); await page.mouse.up();
  await page.mouse.click(cx, cy + 150);
  await page.mouse.click(cx - 200, cy + 150);
  const pth = await ev(() => { const l = editor.store.layer(editor.store.selection[0]); return l && { type: l.type, cmds: l.geometry?.[0].cmds.map(c => c[0]).join(''), tool: editor.tool }; });
  check('pen draws a closed path', pth?.type === 'path' && pth.cmds.startsWith('M') && pth.cmds.includes('C') && pth.cmds.endsWith('Z') && pth.tool === 'select', JSON.stringify(pth));
  // edit mode: double click the path, drag its first anchor
  await page.waitForTimeout(100);
  await page.mouse.dblclick(cx - 170, cy + 140);
  const before = await ev(() => editor.store.layer(editor.store.selection[0]).geometry[0].cmds[0].slice());
  await page.mouse.move(cx - 200, cy + 150); await page.mouse.down(); await page.mouse.move(cx - 260, cy + 190, { steps: 4 }); await page.mouse.up();
  const after = await ev(() => editor.store.layer(editor.store.selection[0]).geometry[0].cmds[0].slice());
  check('path point edit', Math.abs((after[1] - before[1]) * (await ev(() => viewport.zoom)) + 60) < 2, `${before} -> ${after}`);
  await page.keyboard.press('Escape');
}

// delete
await ev(() => editor.store.select(editor.store.comp.root.slice()));
await page.keyboard.press('Delete');
check('delete', (await ev(() => editor.store.comp.root.length)) === 0);
await page.screenshot({ path: process.argv[2] || 'e2e.png' });
console.log(results.join('\n'));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
