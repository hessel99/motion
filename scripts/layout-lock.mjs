// layout lock: the guard for the window's structure (title bar, rail, sidebars, stage, timeline).
// for every state × window size × frame (mac with traffic lights / plain browser) it checks:
//   - the regions (title bar, mac traffic-light zone, rail, left sidebar, canvas, timeline,
//     inspector) are inside the window and never overlap
//   - nothing interactive sits in the traffic-light zone
//   - no horizontal scroll on the page
//   - primary controls (title bar, rail, panel headers, transport) are not clipped / ellipsized
// and compares 1x screenshots against tests/layout-baselines/*.png (pixel tolerance).
//
//   npm run layout:check                 check (starts its own vite + fake-agent bridge)
//   node scripts/layout-lock.mjs --update   rewrite the baselines after an intended change
//   URL=http://localhost:5173/ node scripts/layout-lock.mjs   against a running dev server
//   ONLY=shape,home node scripts/layout-lock.mjs              a subset of the states
//
// the sizes and states are the contract: change the layout tokens (src/ui/tokens.css "app
// shell") and this suite tells you which window it breaks.
import { chromium } from './pw.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE = process.argv.includes('--update');
const BASE_DIR = join(root, 'tests/layout-baselines');
const OUT_DIR = join(root, 'tests/layout-baselines/.out'); // failing shots + diffs (gitignored)
const SIZES = [[1100, 700], [1280, 800], [1440, 900], [1728, 1117], [1920, 1080], [2560, 1440]];
const FRAMES = ['mac', 'web'];
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
// pixels whose channels differ by more than THRESH count as changed; a shot fails above MAX_RATIO
const THRESH = 40, MAX_RATIO = 0.001;
/** which shots get a committed baseline (all of them are checked for overlap) */
const hasBaseline = (state, frame, w, h) => (w === 1440 && h === 900) || (frame === 'mac' && state === 'shape') || (frame === 'mac' && w === 1100 && state !== 'agent');

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

// ---------------- servers ----------------
let vite = null, bridge = null;
let base = process.env.URL;
if (!base) {
  const { createServer } = await import('vite');
  vite = await createServer({ root, logLevel: 'error', server: { port: await freePort(), strictPort: true } });
  await vite.listen();
  base = vite.resolvedUrls.local[0];
}
const bridgePort = await freePort();
bridge = spawn(process.execPath, [join(root, 'bridge/server.mjs')], {
  env: { ...process.env, PATH: join(root, 'tests/fixtures/fake-claude') + ':' + process.env.PATH, MOTION_BRIDGE_PORT: String(bridgePort) },
  stdio: 'ignore',
});
const cleanup = async () => { bridge?.kill(); await vite?.close(); };
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

// ---------------- states ----------------
// each: the url query and what to do once the editor is up. all start dark.
const selectByName = (p, name) => p.evaluate(n => { const l = Object.values(editor.store.project.layers).find(x => x.name === n); editor.store.select(l ? [l.id] : []); editor.store.setTime(1.2); }, name);
const STATES = {
  empty: { q: '&blank&nobridge' },
  shape: { q: '&demo&nobridge', run: p => selectByName(p, 'Pill') },
  agent: {
    q: `&blank&bridge=${bridgePort}`,
    run: async p => {
      await p.waitForSelector('.dot.connected', { timeout: 20000 });
      await p.fill('.agent-input textarea', 'slow: tighten the timing of the reveal');
      await p.keyboard.press('Enter');
      await p.waitForSelector('[data-testid=agent-working]', { timeout: 10000 });
      await p.waitForTimeout(600);
    },
    after: async p => { await p.click('.send-btn.stop').catch(() => {}); },
  },
  home: { q: '&nobridge' },
  settings: { q: '&demo&nobridge', run: async p => { await p.evaluate(() => document.querySelector('.rail .rail-btn[aria-label^="Settings"]')?.click()); await p.waitForSelector('.settings-modal'); } },
  share: { q: '&demo&nobridge', run: async p => { await p.click('.tb-share'); await p.waitForSelector('.ctx-menu'); } },
};

// ---------------- checks in the page ----------------
function measure() {
  const vw = innerWidth, vh = innerHeight;
  const box = sel => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); if (cs.display === 'none' || el.hidden) return null; const r = el.getBoundingClientRect(); return r.width < 1 || r.height < 1 ? null : { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const regions = {
    titlebar: box('.titlebar'), rail: box('.rail'), left: box('aside.left'), canvas: box('main.center'),
    timeline: box('section.bottom'), inspector: box('aside.right'), home: box('.home-host'),
  };
  const traffic = document.documentElement.hasAttribute('data-traffic-lights') ? { x: 0, y: 0, w: 80, h: 40 } : null;
  // the traffic lights draw over the title bar's reserved end: that one pair may overlap
  const tl = box('.tb-traffic');
  const problems = [];
  const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const names = Object.keys(regions).filter(k => regions[k]);
  for (const k of names) {
    const r = regions[k];
    if (r.x < -0.5 || r.y < -0.5 || r.x + r.w > vw + 0.5 || r.y + r.h > vh + 0.5) problems.push(`${k} leaves the window ${JSON.stringify(r)}`);
  }
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = names[i], b = names[j];
    if ([a, b].includes('home') && [a, b].some(n => n === 'canvas' || n === 'timeline')) continue; // Home covers the stage by design
    if (inter(regions[a], regions[b]) > 1) problems.push(`${a} overlaps ${b}`);
  }
  if (traffic) {
    if (!tl || tl.w < 79.5 || tl.x > 0.5) problems.push('the title bar does not reserve the traffic-light zone');
    for (const k of names) if (k !== 'titlebar' && inter(regions[k], traffic) > 0) problems.push(`${k} reaches into the traffic-light zone`);
    for (const el of document.querySelectorAll('button, [role=tab], input, textarea, select, a[href]')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && getComputedStyle(el).visibility !== 'hidden' && inter({ x: r.left, y: r.top, w: r.width, h: r.height }, traffic) > 0 && !el.closest('.settings-modal, .ctx-menu, .dialog'))
        problems.push(`control under the traffic lights: ${el.className || el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`);
    }
  }
  const se = document.scrollingElement;
  if (se.scrollWidth > vw + 0.5) problems.push(`horizontal scroll: ${se.scrollWidth} > ${vw}`);
  if (se.scrollHeight > vh + 0.5) problems.push(`vertical page scroll: ${se.scrollHeight} > ${vh}`);
  // primary controls must show their whole label
  const PRIMARY = '.titlebar button, .tb-name, .ct-name, .rail-btn, .lp-title, .rp-name, .tl-head button, .tp-time, .agent-head button, .composer-foot button';
  for (const el of document.querySelectorAll(PRIMARY)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
    // the label's laid-out text (a Range: tooltips are ::after content and do not count) must fit
    // the element's content box, so neither an ellipsis nor overflow hides part of it
    const text = (el.textContent || '').trim();
    if (text && el.clientWidth > 0) {
      const range = document.createRange(); range.selectNodeContents(el);
      const tr = range.getBoundingClientRect(), er = el.getBoundingClientRect();
      const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
      if (tr.width > 0 && (tr.right > er.right - padR + 1.5 || tr.left < er.left + padL - 1.5)) problems.push(`clipped text: ${el.className} "${text.slice(0, 30)}" (${Math.round(tr.width)}px in ${Math.round(er.width - padL - padR)}px)`);
    }
    // a control's box must not be cut by its container
    const r = el.getBoundingClientRect(), host = el.closest('.titlebar, .rail, .tl-head, .agent-head, .composer-foot, .rp-title');
    if (host) { const h = host.getBoundingClientRect(); if (r.right > h.right + 1 || r.left < h.left - 1) problems.push(`control cut off: ${el.className || el.tagName} in ${host.className}`); }
  }
  // inside the chrome rows, the controls must not run into each other
  for (const row of document.querySelectorAll('.titlebar, .tl-head, .tp, .tt, .rp-title, .agent-head, .composer-foot, .lp-head, .rail')) {
    const kids = [...row.children].filter(k => { const cs = getComputedStyle(k); return cs.position !== 'absolute' && cs.position !== 'fixed' && cs.display !== 'none' && cs.visibility !== 'hidden' && k.getClientRects().length; })
      .map(k => { const r = k.getBoundingClientRect(); return { k, b: { x: r.left, y: r.top, w: r.width, h: r.height } }; }).filter(o => o.b.w > 0 && o.b.h > 0);
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++)
      if (inter(kids[i].b, kids[j].b) > 2) problems.push(`controls overlap in ${row.className.split(' ')[0]}: ${kids[i].k.className || kids[i].k.tagName} / ${kids[j].k.className || kids[j].k.tagName}`);
  }
  return { problems, regions };
}

// pixel comparison in the browser (no image libraries needed): ratio of changed pixels + a diff png
async function compare(page, a, b) {
  return page.evaluate(async ({ a, b, THRESH }) => {
    const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { ratio: 1, size: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, c.width, c.height);
    g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, c.width, c.height);
    const out = g.createImageData(c.width, c.height);
    let n = 0;
    for (let i = 0; i < da.data.length; i += 4) {
      const d = Math.max(Math.abs(da.data[i] - db.data[i]), Math.abs(da.data[i + 1] - db.data[i + 1]), Math.abs(da.data[i + 2] - db.data[i + 2]));
      const v = da.data[i] * 0.3;
      if (d > THRESH) { n++; out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 80; } else { out.data[i] = out.data[i + 1] = out.data[i + 2] = v; }
      out.data[i + 3] = 255;
    }
    g.putImageData(out, 0, 0);
    return { ratio: n / (c.width * c.height), diff: c.toDataURL('image/png') };
  }, { a, b, THRESH });
}

// ---------------- run ----------------
mkdirSync(BASE_DIR, { recursive: true });
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--font-render-hinting=none'] });
let failed = 0, shots = 0;
const fail = msg => { failed++; console.log('FAIL ' + msg); };
const states = Object.keys(STATES).filter(s => !ONLY || ONLY.includes(s));
for (const frame of FRAMES) for (const state of states) for (const [w, h] of SIZES) {
  const name = `${state}-${frame}-${w}x${h}`;
  const st = STATES[state];
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.addInitScript(() => { try { localStorage.setItem('motion.welcomed', '1'); for (const k of Object.keys(localStorage)) if (k.startsWith('motion.agent.chat:') || k.startsWith('motion.autosave')) localStorage.removeItem(k); } catch { /* */ } });
    await page.goto(`${base}?theme=dark${frame === 'mac' ? '&platform=mac' : ''}${st.q}`);
    await page.waitForFunction(() => window.editor?.renderer);
    await page.waitForTimeout(700);
    if (st.run) await st.run(page);
    await page.waitForTimeout(300);
    const { problems } = await page.evaluate(measure);
    for (const p of problems) fail(`${name}: ${p}`);
    if (errors.length) fail(`${name}: page errors: ${errors.join(' | ').slice(0, 300)}`);
    if (hasBaseline(state, frame, w, h)) {
      // things that change between runs: the agent's elapsed seconds, carets, the live canvas
      await page.addStyleTag({ content: '.ag-working > .ag-muted:last-child, .vp-canvas { visibility: hidden !important; } *, *::before, *::after { caret-color: transparent !important; }' });
      await page.waitForTimeout(100);
      const png = await page.screenshot({ animations: 'disabled' });
      shots++;
      const file = join(BASE_DIR, name + '.png');
      if (UPDATE || !existsSync(file)) { console.log(`${existsSync(file) ? 'UPDATED' : 'NEW'} baseline ${name}`); writeFileSync(file, png); }
      else {
        const r = await compare(page, 'data:image/png;base64,' + readFileSync(file).toString('base64'), 'data:image/png;base64,' + png.toString('base64'));
        if (process.env.VERBOSE) console.log(`  ${name}: ${(r.ratio * 100).toFixed(3)}% changed`);
        if (r.ratio > MAX_RATIO) {
          mkdirSync(OUT_DIR, { recursive: true });
          writeFileSync(join(OUT_DIR, name + '.png'), png);
          if (r.diff) writeFileSync(join(OUT_DIR, name + '.diff.png'), Buffer.from(r.diff.split(',')[1], 'base64'));
          fail(`${name}: ${(r.ratio * 100).toFixed(2)}% of pixels changed${r.size ? ' (' + r.size + ')' : ''}; see tests/layout-baselines/.out/ (intended? run with --update)`);
        }
      }
    }
    if (!problems.length && !errors.length) console.log(`PASS ${name}`);
    if (st.after) await st.after(page);
  } catch (e) {
    fail(`${name}: ${e.message.split('\n')[0]}`);
  }
  await page.close();
}
await browser.close();
await cleanup();
console.log(`\n${failed ? `${failed} layout problem(s)` : 'layout locked: no overlaps, no clipping, baselines match'} (${shots} screenshots compared)`);
process.exit(failed ? 1 : 0);
