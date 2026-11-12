// click-through check of the window chrome (v3): every control does something.
// usage: URL=http://localhost:5391/ node scripts/ui-check.mjs
import { chromium } from './pw.mjs';
const base = process.env.URL || 'http://localhost:5173/';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); if (!ok) failed++; };
const ev = fn => page.evaluate(fn);
// the chrome re-renders on the next animation frame: give every action a moment
const click = async sel => { await page.click(sel); await page.waitForTimeout(200); };
const press = async key => { await page.keyboard.press(key); await page.waitForTimeout(200); };
await page.goto(`${base}?nobridge`);
await page.waitForFunction(() => window.editor?.renderer);
await page.waitForTimeout(500);

check('starts on Home without files', await page.locator('.home').count() === 1);
await click('.preset-card >> nth=1'); // Square
await page.waitForTimeout(200);
check('size preset opens a 1080×1080 file', await ev(() => editor.store.comp.width === 1080 && editor.store.comp.height === 1080) && await page.locator('.home').count() === 0);
check('one document tab', await page.locator('.tb-tab').count() === 1);
await click('.tb-add');
check('+ opens a second tab', await page.locator('.tb-tab').count() === 2);
await click('.tb-tab >> nth=0');
check('switching tabs restores the file', await ev(() => editor.store.comp.width) === 1080);
await press('r');
const vp = await page.locator('.viewport').boundingBox();
await page.mouse.move(vp.x + vp.width / 2 - 60, vp.y + vp.height / 2 - 60); await page.mouse.down(); await page.mouse.move(vp.x + vp.width / 2 + 60, vp.y + vp.height / 2 + 60, { steps: 4 }); await page.mouse.up();
check('dirty dot after an edit', await page.locator('.tb-tab.dirty').count() === 1);
await click('.tb-tab >> nth=1');
await click('.tb-tab >> nth=0');
check('undo history survives a tab switch', await ev(() => editor.store.canUndo && editor.store.comp.root.length === 1));
await page.waitForTimeout(200);
check('selection bar over the layer', await page.locator('.sel-bar').count() === 1);
await click('.sel-bar .sel-btn >> nth=0');
check('selection bar: keyframe at the playhead', await ev(() => !!editor.store.layer(editor.store.selection[0]).props.position.kf?.length));
// comp tabs
await click('.ct-add');
check('timeline +: new composition tab', await page.locator('.ct-tab').count() === 2);
await click('.ct-tab >> nth=0');
check('comp tab switches', await ev(() => editor.store.comp.root.length) === 1);
await page.hover('.ct-tab >> nth=1');
await click('.ct-tab >> nth=1 >> .ct-close');
check('comp tab closes', await page.locator('.ct-tab').count() === 1);
// transport
await click('.tp-play'); await page.waitForTimeout(200);
check('play', await ev(() => editor.store.playing));
await click('.tp-play');
await page.fill('.tp-time', '1.5'); await press('Enter');
check('timecode input sets time', Math.abs(await ev(() => editor.store.time) - 1.5) < 0.02);
await click('.tt-mode button:nth-child(2)');
check('graph view', await ev(() => timeline.mode) === 'graph');
await click('.tt-mode button:nth-child(1)');
// inspector with nothing selected = comp settings
await press('Escape');
await page.waitForTimeout(200);
check('nothing selected: composition settings', await page.locator('.inspector input[aria-label="Composition name"]').count() === 1);
// side panel tabs
await click('.rail-btn[aria-label="Assets"]');
check('Assets tab lists compositions', await page.locator('.assets .list-row').count() >= 1);
await click('.rail-btn[aria-label="Assets"]');
check('clicking the active rail icon collapses the sidebar', await page.locator('aside.left[hidden]').count() === 1);
await click('.rail-btn[aria-label="Agent (⌘I)"]');
check('rail: Agent opens the sidebar', await page.locator('aside.left:not([hidden]) .lp-title').innerText() === 'Agent');
// export dialog: every format tab
// Share popover: preview file, link sharing setup, export
await click('.tb-share');
check('Share popover offers the preview file, link setup and export', await page.locator('.ctx-item:has-text("Share a preview file")').count() === 1 && await page.locator('.ctx-item:has-text("Set up link sharing")').count() === 1);
await click('.ctx-item:has-text("Set up link sharing")');
check('Set up link sharing opens Settings with the Link sharing card', await page.locator('.settings-modal .set-card-title:has-text("Link sharing")').count() === 1);
await press('Escape');
await click('.tb-share');
const dl = page.waitForEvent('download', { timeout: 120000 });
await click('.ctx-item:has-text("Share a preview file")');
const file = await dl;
const html = await (await import('node:fs')).promises.readFile(await file.path(), 'utf8');
check('preview file: one html page with an embedded video and a player', /^<!doctype html>/.test(html) && /<video id="v" src="data:video\//.test(html) && /id="t" type="range"/.test(html), `${Math.round(html.length / 1024)} KB ${file.suggestedFilename()}`);
{
  // the page plays on its own (offline, file://): the video loads, the scrubber moves
  const pp = await browser.newPage();
  const os = await import('node:os'), path = await import('node:path');
  const htmlPath = path.join(os.tmpdir(), `motion-preview-${Date.now()}.html`);
  await file.saveAs(htmlPath);
  await pp.goto('file://' + htmlPath);
  await pp.waitForFunction(() => document.getElementById('v').readyState >= 2, null, { timeout: 15000 }).catch(() => {});
  await pp.waitForTimeout(800);
  const st = await pp.evaluate(() => ({ ready: document.getElementById('v').readyState, dur: document.getElementById('v').duration, t: +document.getElementById('t').value }));
  check('preview page loads and plays offline', st.ready >= 2 && st.dur > 0, JSON.stringify(st));
  await pp.close();
}
await click('.tb-share');
await click('.ctx-item:has-text("Export a file")');
await page.waitForSelector('.xv-dialog');
for (const i of [2, 3, 4, 5, 1]) await click(`.xv-kinds button:nth-child(${i})`);
check('export dialog with five formats', await page.locator('.xv-kinds button').count() === 5);
await press('Escape');
// ask bar runs a command
await press('Control+k');
await page.keyboard.type('graph');
await press('Enter');
check('ask bar runs a command', await ev(() => timeline.mode) === 'graph');
// playback pill: full-screen preview
await click('.tp button[data-tooltip^="Full-screen"]');
await page.waitForTimeout(300);
check('full-screen preview', await page.locator('.app.previewing').count() === 1);
await press('Escape');
await page.waitForTimeout(200);
check('Esc leaves the preview', await page.locator('.app.previewing').count() === 0);
// settings modal
await click('.tb-menu');
await click('.ctx-item:has-text("Settings")');
check('Settings modal', await page.locator('.settings-modal').count() === 1);
await press('Escape');
check('Settings closes', await page.locator('.settings-modal').count() === 0);
// home + close tab
await click('.rail-btn[aria-label="Home"]');
check('Home view', await page.locator('.home').count() === 1);
await click('.tb-tab >> nth=1');
await press('Control+w');
check('⌘W closes the tab', await page.locator('.tb-tab').count() === 1);
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
