// permanent QA flows (npm run qa): drives the real UI in chromium, dark mode, at 1440×900 and
// 1280×800, like a designer would, and fails on regressions found in the v0.3.2 QA sweep
// (docs/qa-report.md). every check names the bug it guards.
// usage: URL=http://localhost:5173/ node scripts/qa-flows.mjs
import { chromium } from './pw.mjs';
const base = process.env.URL || 'http://localhost:5173/';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] });
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : info}`); if (!ok) failed++; };
// noise from the software gl driver, not from the app
const benign = t => /GL Driver Message|GPU stall due to ReadPixels/.test(t);

for (const [w, h] of [[1440, 900], [1280, 800]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !benign(m.text())) errors.push(m.text()); });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  await page.goto(`${base}?nobridge&theme=dark`);
  await page.waitForFunction(() => window.editor?.renderer);
  await page.waitForTimeout(300);

  // QA-1: a file opened from Home was fitted against the full-width (Home) stage, so the comp
  // overflowed the canvas once the sidebars came back
  await page.click('.preset-card >> nth=0');
  await page.waitForTimeout(400);
  const fit = await ev(() => {
    const r = document.querySelector('.viewport').getBoundingClientRect();
    const c = editor.store.comp;
    return { x0: viewport.panX, y0: viewport.panY, x1: viewport.panX + c.width * viewport.zoom, y1: viewport.panY + c.height * viewport.zoom, w: r.width, h: r.height };
  });
  check(`${w}: new file from Home fits the canvas`, fit.x0 >= 0 && fit.y0 >= 0 && fit.x1 <= fit.w + 0.5 && fit.y1 <= fit.h + 0.5, JSON.stringify(fit));
  // the fit follows a window resize until the user zooms or pans
  await page.setViewportSize({ width: w - 200, height: h });
  await page.waitForTimeout(300);
  const fit2 = await ev(() => { const r = document.querySelector('.viewport').getBoundingClientRect(); return viewport.panX >= 0 && viewport.panX + editor.store.comp.width * viewport.zoom <= r.width + 0.5; });
  check(`${w}: untouched view stays fitted after a window resize`, fit2);
  await page.setViewportSize({ width: w, height: h });

  // QA-2: a pasted Lottie opened in a tab called "clipboard"
  await ev(() => {
    const j = { v: '5.7.0', nm: 'Bounce', fr: 30, ip: 0, op: 30, w: 200, h: 200, layers: [{ ty: 4, ind: 1, ip: 0, op: 30, st: 0, ks: { p: { a: 0, k: [100, 100] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }, shapes: [{ ty: 'gr', it: [{ ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [40, 40] }, r: { a: 0, k: 0 } }, { ty: 'fl', c: { a: 0, k: [1, 0.5, 0, 1] }, o: { a: 0, k: 100 } }, { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }] }] }] };
    const dt = new DataTransfer(); dt.setData('text/plain', JSON.stringify(j));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  // the lottie importer loads lazily (slow on a cold dev server): wait for the tab, not a fixed time
  await page.waitForFunction(() => editor.store.project.name === 'Bounce', null, { timeout: 8000 }).catch(() => {});
  const lot = await ev(() => ({ name: editor.store.project.name, n: editor.store.comp.root.length, tabs: document.querySelectorAll('.tb-tab').length }));
  check(`${w}: pasted Lottie opens in a tab named after it`, lot.name === 'Bounce' && lot.n === 1, JSON.stringify(lot));

  // no horizontal page overflow
  const overflow = await ev(() => document.documentElement.scrollWidth - innerWidth);
  check(`${w}: no horizontal page overflow`, overflow <= 0, `${overflow}px`);

  check(`${w}: no page errors`, errors.length === 0, JSON.stringify(errors.slice(0, 5)));
  await ctx.close();
}
// motion-designer QA (MD-xx, docs/next-up.md): one blank document, real keyboard / mouse
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const ev = (fn, arg) => page.evaluate(fn, arg);
  await page.goto(`${base}?nobridge&theme=dark&blank`);
  await page.waitForFunction(() => window.editor?.renderer);
  await page.waitForTimeout(300);

  // MD-13: Shift+P / Alt+Shift+P / Shift+S / Shift+A never delete keys
  await ev(async () => {
    const c = await import('/src/core/commands.ts');
    const s = editor.store;
    const l = c.addLayer(s, 'rect', { x: 100, y: 100, w: 200, h: 120 });
    s.setTime(0); c.toggleAnimated(s, [l.id], 'position');
    s.setTime(1); c.setProp(s, l.id, 'position', [600, 200]);
    s.setTime(2); c.setProp(s, l.id, 'position', [900, 400]);
    s.setTime(0.5); s.select([l.id]);
    window.__md13 = l.id;
  });
  await page.mouse.click(5, 5); // focus the page, not a field
  await ev(() => editor.store.select([window.__md13]));
  const keys = () => ev(() => editor.store.layer(window.__md13).props.position.kf?.map(k => k.t) ?? []);
  for (const k of ['Shift+P', 'Shift+S', 'Shift+A', 'Shift+R', 'Shift+T']) await page.keyboard.press(k);
  await page.waitForTimeout(100);
  check('MD-13: Shift+P/S/A/R/T keep every keyframe', JSON.stringify(await keys()) === '[0,1,2]', JSON.stringify(await keys()));
  const shown = await ev(() => [...(timeline.shownProps.get(window.__md13) ?? [])].sort().join());
  check('MD-13: Shift+<prop> reveals the property rows', shown === 'anchor,opacity,position,rotation,scale', shown);
  await page.keyboard.press('Alt+Shift+P');
  check('MD-13: Alt+Shift+P adds a key at the playhead', JSON.stringify(await keys()) === '[0,0.5,1,2]', JSON.stringify(await keys()));
  await page.keyboard.press('Alt+Shift+P');
  check('MD-13: Alt+Shift+P again removes only that key', JSON.stringify(await keys()) === '[0,1,2]', JSON.stringify(await keys()));
  const tool = await ev(() => editor.tool);
  check('MD-13: Shift+R / Shift+T on a selection do not switch tools', tool === 'select', tool);

  // a full-bleed frame (a group with a fill, like a pasted figma frame) with a ring + a star inside
  const scene = await ev(async () => {
    const c = await import('/src/core/commands.ts');
    const s = editor.store;
    for (const id of s.comp.root.slice()) c.deleteLayers(s, [id]);
    s.setTime(0);
    const W = s.comp.width, H = s.comp.height;
    const ring = c.addLayer(s, 'ellipse', { x: W / 2 - 300, y: H / 2 - 300, w: 600, h: 600, name: 'Ring', color: [0.9, 0.5, 0.2, 1] });
    const star = c.addLayer(s, 'rect', { x: W / 2 - 60, y: H / 2 - 60, w: 120, h: 120, name: 'Star', color: [1, 1, 1, 1] });
    const word = c.addLayer(s, 'rect', { x: W / 2 + 400, y: H / 2 - 40, w: 300, h: 80, name: 'Word', color: [1, 1, 1, 1] });
    const gr = c.groupLayers(s, [ring.id, star.id, word.id], { x: 0, y: 0, w: W, h: H }); const g = gr?.id ?? gr;
    c.renameLayer?.(s, g, 'Frame');
    c.setProp(s, g, 'fill', [0.1, 0.12, 0.2, 1]);
    s.select([]);
    editor.renderer.render(s.time);
    return { ring: ring.id, star: star.id, word: word.id, frame: g, W, H };
  });
  await page.waitForTimeout(200);
  const vpb = await page.locator('.viewport').boundingBox();
  const scr = async (x, y) => { const [sx, sy] = await ev(([x, y]) => viewport.toScreen(x, y), [x, y]); return [vpb.x + sx, vpb.y + sy]; };
  const sel = () => ev(() => editor.store.selection.slice());
  const pos = id => ev(id => editor.store.layer(id).props.position?.v.slice(), id);
  // MD-05: drag on the frame background marquees its children; the frame stays put
  const fpos = await pos(scene.frame);
  let a = await scr(scene.W / 2 - 400, scene.H / 2 - 380), b = await scr(scene.W / 2 + 500, scene.H / 2 + 100);
  await page.mouse.move(a[0], a[1]); await page.mouse.down(); await page.mouse.move(b[0], b[1], { steps: 8 }); await page.mouse.up();
  const msel = await sel();
  check('MD-05: drag on a frame background marquee-selects its children', msel.length === 3 && [scene.ring, scene.star, scene.word].every(id => msel.includes(id)), JSON.stringify(msel));
  check('MD-05: ... and does not move the frame', JSON.stringify(await pos(scene.frame)) === JSON.stringify(fpos), JSON.stringify([fpos, await pos(scene.frame)]));
  // a click on the background selects the frame; dragging the selected frame moves it
  await page.mouse.click(a[0], a[1]);
  check('MD-05: click on a frame background selects the frame', JSON.stringify(await sel()) === JSON.stringify([scene.frame]), JSON.stringify(await sel()));
  await page.mouse.move(a[0], a[1]); await page.mouse.down(); await page.mouse.move(a[0] + 40, a[1] + 20, { steps: 4 }); await page.mouse.up();
  check('MD-05: dragging the selected frame moves it', JSON.stringify(await pos(scene.frame)) !== JSON.stringify(fpos));
  await ev(() => editor.store.undo());
  // cmd-drag on the background moves the (unselected) frame
  await ev(() => editor.store.select([]));
  await page.keyboard.down('Control');
  await page.mouse.move(a[0], a[1]); await page.mouse.down(); await page.mouse.move(a[0] + 40, a[1] + 20, { steps: 4 }); await page.mouse.up();
  await page.keyboard.up('Control');
  check('MD-05: cmd-drag on the background moves the frame', JSON.stringify(await pos(scene.frame)) !== JSON.stringify(fpos), JSON.stringify(await sel()));
  await ev(() => editor.store.undo());

  // MD-04: with the star selected, a press on the ring just outside the star's corner selects the
  // ring (no rotation); outside every other layer the corner zone still rotates
  await ev(id => editor.store.select([id]), scene.star);
  await page.waitForTimeout(50);
  const corner = await ev(id => { const c = editor.renderer.corners(id); return [c[6], c[7]]; }, scene.star); // bottom-left (the selection bar sits above)
  let p = await scr(corner[0], corner[1]);
  const off = 14; // screen px, inside the rotation ring
  const cur = await (async () => { await page.mouse.move(p[0] - off, p[1] + off); await page.waitForTimeout(50); return ev(() => document.querySelector('.viewport').style.cursor); })();
  check('MD-04: no rotate cursor over a neighbouring layer', cur !== 'alias', cur);
  await page.mouse.down(); await page.mouse.move(p[0] - off + 30, p[1] + off + 30, { steps: 5 }); await page.mouse.up();
  const rot = await ev(id => editor.store.layer(id).props.rotation?.v[0] ?? 0, scene.star);
  check('MD-04: pressing next to the corner over another layer does not rotate', rot === 0, String(rot));
  check('MD-04: ... it selects that layer', JSON.stringify(await sel()) === JSON.stringify([scene.ring]), JSON.stringify(await ev(() => editor.store.selection.map(id => editor.store.layer(id).name))));
  await ev(() => { for (let i = 0; i < 3; i++) editor.store.undo(); });
  // the word sits over the frame background only: its corner zone rotates
  await ev(id => editor.store.select([id]), scene.word);
  const wc = await ev(id => { const c = editor.renderer.corners(id); return [c[2], c[3]]; }, scene.word);
  p = await scr(wc[0], wc[1]);
  await page.mouse.move(p[0] + off, p[1] - off); await page.waitForTimeout(50);
  check('MD-04: rotate cursor outside other layers (over the frame background)', await ev(() => document.querySelector('.viewport').style.cursor) === 'alias');
  await page.mouse.down(); await page.mouse.move(p[0] + off + 30, p[1] + 20, { steps: 5 }); await page.mouse.up();
  const rot2 = await ev(id => editor.store.layer(id).props.rotation?.v[0] ?? 0, scene.word);
  check('MD-04: the corner zone rotates there', Math.abs(rot2) > 1, String(rot2));

  // MD-02 / MD-03: one save flow for every export, named after the saved document. a fake desktop
  // shell records what the app asks the native side for
  await ev(() => {
    window.__nat = [];
    window.motionNative = {
      platform: 'darwin', onMenu() {},
      saveFile: async o => { window.__nat.push({ fn: 'saveFile', ...o, data: undefined }); return o.path ?? '/Users/me/Work/Logo reveal.motion'; },
      saveFileAs: async o => { window.__nat.push({ fn: 'saveFileAs', ...o, data: undefined }); return '/Users/me/Exports/' + o.defaultPath; },
      revealFile: async p => { window.__nat.push({ fn: 'reveal', p }); return true; },
    };
  });
  await page.mouse.click(5, 5);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(400);
  const named = await ev(() => ({ name: editor.store.project.name, title: document.title, tab: document.querySelector('.tb-tab[aria-selected="true"]')?.textContent ?? document.querySelector('.tb-tab')?.textContent }));
  check('MD-02: saving names the document after the file', named.name === 'Logo reveal' && named.title.includes('Logo reveal') && named.tab.includes('Logo reveal'), JSON.stringify(named));
  const names = await ev(async () => {
    const a = await import('/src/app/actions.ts');
    const one = [a.exportFileName('mp4'), a.exportFileName('gif'), a.exportFileName('json'), a.exportFileName('png', { frame: 7 })];
    const c = await import('/src/core/commands.ts');
    const p = editor.store.project;
    const two = a.exportFileName('gif', { project: { ...p, comps: { ...p.comps, x: { ...p.comps[p.activeComp], name: 'Other' } } } });
    return { one, two, comp: editor.store.comp.name, hasC: !!c };
  });
  check('MD-02: one naming pattern for every export', JSON.stringify(names.one) === JSON.stringify(['Logo reveal.mp4', 'Logo reveal.gif', 'Logo reveal.json', 'Logo reveal_0007.png']) && names.two === `Logo reveal - ${names.comp}.gif`, JSON.stringify(names));
  await ev(async () => { window.__nat.length = 0; const a = await import('/src/app/actions.ts'); await a.exportLottie(); await a.exportFramePng(0.25); await a.exportGifFile({ maxSize: 64, fps: 10, end: 0.3 }); });
  const calls = await ev(() => window.__nat);
  const want = [['Logo reveal.json', 'json'], ['Logo reveal_0000.png', 'png'], ['Logo reveal.gif', 'gif']];
  check('MD-03: Lottie / PNG / GIF all use the native save dialog with their extension', calls.length === 3 && calls.every((c, i) => c.fn === 'saveFileAs' && c.kind === 'export' && c.defaultPath === want[i][0] && c.filters?.[0]?.extensions?.[0] === want[i][1]), JSON.stringify(calls));
  const btn = page.locator('.toast-action').last();
  check('MD-03: the export toast offers "Show in Finder"', (await btn.count()) > 0 && (await btn.textContent()) === 'Show in Finder');
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(50); }
  check('MD-03: "Show in Finder" reveals the saved file', (await ev(() => window.__nat.at(-1))).p === '/Users/me/Exports/Logo reveal.gif', JSON.stringify(await ev(() => window.__nat.at(-1))));
  // browser: a download with the same name
  await ev(() => { delete window.motionNative; });
  const [dl] = await Promise.all([page.waitForEvent('download'), ev(async () => (await import('/src/app/actions.ts')).exportFramePng(0.25))]);
  check('MD-03: in a browser the export is a download with the same name', dl.suggestedFilename() === 'Logo reveal_0000.png', dl.suggestedFilename());

  // MD-29: typing right after focusing a number field (before the next frame) keeps every digit.
  // the old field selected its text a frame after focus, so the first typed digit got replaced
  await ev(() => editor.store.select([]));
  await page.waitForTimeout(150);
  const fps = await ev(async () => {
    const el = document.querySelector('input[aria-label="Frame rate"]');
    if (!el) return 'no field';
    el.focus();
    document.execCommand('insertText', false, '2'); // same task as the focus: "busy" app
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    document.execCommand('insertText', false, '4');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    return editor.store.comp.fps;
  });
  check('MD-29: a number field keeps the first digit typed right after focus', fps === 24, String(fps));
  await ev(() => editor.store.undo());
  // a click still selects the whole value: typing replaces it
  const fr = page.locator('input[aria-label="Frame rate"]');
  await fr.click();
  await page.keyboard.type('25');
  await page.keyboard.press('Enter');
  check('MD-29: click + type replaces the value', (await ev(() => editor.store.comp.fps)) === 25, String(await ev(() => editor.store.comp.fps)));
  await ev(() => editor.store.undo());

  // MD-38: an SVG imported into a comp the user chose keeps the comp; a brand-new untouched
  // document takes the SVG's size and fits the view
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect x="20" y="20" width="160" height="160" fill="#f60"/><circle cx="300" cy="100" r="80" fill="#06f"/></svg>';
  const chosen = await ev(async svg => {
    const d = await import('/src/app/documents.ts'), a = await import('/src/app/actions.ts');
    d.newDocument({ width: 1920, height: 1080 });
    await a.openData('logo.svg', svg);
    const c = editor.store.comp;
    return { w: c.width, h: c.height, n: c.root.length };
  }, svg);
  check('MD-38: importing an SVG into a chosen 1920×1080 comp keeps the comp size', chosen.w === 1920 && chosen.h === 1080 && chosen.n === 1, JSON.stringify(chosen));
  const fresh = await ev(async svg => {
    const a = await import('/src/app/actions.ts');
    a.newProject();
    await a.openData('logo.svg', svg);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = editor.store.comp, r = document.querySelector('.viewport').getBoundingClientRect();
    const x1 = viewport.panX + c.width * viewport.zoom, y1 = viewport.panY + c.height * viewport.zoom;
    return { w: c.width, h: c.height, fits: viewport.panX >= 0 && viewport.panY >= 0 && x1 <= r.width + 0.5 && y1 <= r.height + 0.5, centered: Math.abs(viewport.panX - (r.width - x1)) < 2 };
  }, svg);
  check('MD-38: a brand-new untouched document adopts the SVG size and fits the view', fresh.w === 400 && fresh.h === 200 && fresh.fits && fresh.centered, JSON.stringify(fresh));

  // MD-10: effects can be hidden (eye) and removed in the inspector
  await ev(async () => {
    const c = await import('/src/core/commands.ts');
    const s = editor.store;
    const l = c.addLayer(s, 'rect', { x: 50, y: 50, w: 100, h: 100, name: 'Fx' });
    s.select([l.id]);
    window.__fx = l.id;
  });
  await page.waitForTimeout(200);
  await page.locator('select[aria-label="Add effect"]').selectOption('Drop shadow');
  await page.waitForTimeout(150);
  const fx = () => ev(() => { const l = editor.store.layer(window.__fx); return { color: !!l.props.shadowColor, effects: l.effects ?? null }; });
  check('MD-10: Add effect adds a drop shadow', (await fx()).color, JSON.stringify(await fx()));
  await page.locator('button[aria-label="Hide Drop shadow"]').click();
  await page.waitForTimeout(100);
  const hidden = await fx();
  check('MD-10: the eye hides the effect and keeps its values', hidden.color && hidden.effects?.[0]?.visible === false && (await page.locator('button[aria-label="Show Drop shadow"]').count()) === 1, JSON.stringify(hidden));
  await page.locator('button[aria-label="Show Drop shadow"]').click();
  await page.waitForTimeout(100);
  check('MD-10: ... and shows it again', (await fx()).effects?.[0]?.visible === true);
  await page.locator('button[aria-label="Remove Drop shadow"]').click();
  await page.waitForTimeout(100);
  const gone = await fx();
  check('MD-10: remove deletes the effect', !gone.color && !gone.effects && (await page.locator('button[aria-label="Remove Drop shadow"]').count()) === 0, JSON.stringify(gone));
  await ev(() => editor.store.undo());
  check('MD-10: remove is one undo step', (await fx()).color);

  check('MD: no page errors', errors.length === 0, JSON.stringify(errors.slice(0, 5)));
  await ctx.close();
}
await browser.close();
console.log(failed ? `${failed} FAILED` : 'OK');
process.exit(failed ? 1 : 0);
