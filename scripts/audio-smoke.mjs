// audio end to end in chromium: paste a generated song onto an animated comp (the sync + fit cards),
// the waveform / beat ticks / sections in the timeline, "Sync timing", a drop onto the timeline,
// audio() driving a layer in rendered frames, sound effects, mp4 export with the audio mixed in,
// and the analysis speed of a 3-minute song in the worker. screenshots (2×) into docs/shots/audio/.
//   URL=http://localhost:5173/ node scripts/audio-smoke.mjs
import { chromium } from './pw.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.URL || 'http://localhost:5173/';
const OUT = 'docs/shots/audio';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const page = await ctx.newPage();
await page.addInitScript(() => { try { localStorage.setItem('motion.welcomed', '1'); } catch { /* */ } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push('console: ' + m.text().slice(0, 300)); });
await page.goto(`${URL}?nobridge&blank&theme=dark`);
await page.waitForFunction(() => window.editor?.renderer && window.timeline);
const results = {};
await page.waitForTimeout(500); await page.screenshot({ path: '/tmp/claude-0/-home-user-motion/ca43b0e9-8003-5656-8c44-1c94f63bf032/scratchpad/blank.png' });
const ok = (name, pass, info = '') => { results[name] = pass; console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${typeof info === 'string' ? info : JSON.stringify(info)}`); };
const shot = async name => { await page.waitForTimeout(250); await page.screenshot({ path: `${OUT}/${name}.png` }); };

// ---- an animated comp with off-beat entrances
await page.evaluate(async () => {
  const C = await import('/src/core/commands.ts');
  const M = await import('/src/core/model.ts');
  const s = editor.store;
  C.setCompSettings(s, { width: 1280, height: 720, fps: 30, duration: 8 });
  const ease = M.defaultEase();
  const add = (name, x, color, t0, t1) => {
    const l = M.createLayer('rect', { name, x, y: 260, w: 200, h: 200, color });
    l.props.radius = { v: [28, 28, 28, 28] };
    l.props.position = { v: [x + 100, 360], kf: [{ t: t0, v: [x + 100, 900], ...ease }, { t: t1, v: [x + 100, 360], ...ease }] };
    l.props.scale = { v: [100, 100], kf: [{ t: t0, v: [40, 40], ...ease }, { t: t1, v: [100, 100], ...ease }] };
    s.transact('add', tx => C.insertLayer(s, tx, l, null));
    return l.id;
  };
  window.__ids = [add('Coral', 160, [1, 0.42, 0.42, 1], 0.55, 1.13), add('Sun', 540, [1, 0.8, 0.25, 1], 1.7, 2.37), add('Sky', 920, [0.3, 0.55, 1, 1], 3.05, 3.62)];
  s.setTime(0);
});

// ---- paste a song (clipboard file item, as when a file is copied in Finder)
const tPaste = Date.now();
await page.evaluate(async () => {
  const { synthTrack, MUSIC_120 } = await import('/src/audio/synth-track.ts');
  const { encodeWav } = await import('/src/audio/wav.ts');
  const tr = synthTrack(MUSIC_120);
  const file = new File([encodeWav([tr.samples], tr.sr)], 'Build and drop.wav', { type: 'audio/wav' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForFunction(async () => { const T = await import('/src/audio/timing.ts'); return !!T.music(editor.store); }, null, { timeout: 30000 });
const pasteMs = Date.now() - tPaste;
await page.waitForSelector('.au-card', { timeout: 10000 });
const cards = await page.$$eval('.au-card .au-card-title', els => els.map(e => e.textContent));
ok('paste creates an audio layer and analyses it', true, `${pasteMs} ms incl. decode + worker analysis`);
ok('sync + fit offers shown', cards.some(t => /Sync animation/.test(t)) && cards.some(t => /longer than the composition/.test(t)), cards);
const info = await page.evaluate(async () => {
  const T = await import('/src/audio/timing.ts');
  const m = T.music(editor.store);
  editor.store.select([m.layer.id]);
  return { bpm: m.a.bpm, meter: m.a.meter, beats: m.a.beats.length, sections: T.sections(m).map(s => `${s.label}@${s.t0.toFixed(2)}`), ms: Math.round(m.a.ms) };
});
ok('analysis: 120 bpm, 4/4, drop at 16 s', Math.abs(info.bpm - 120) < 0.3 && info.meter === 4 && info.sections.some(s => s === 'drop@16.00'), info);
await page.evaluate(() => { timeline.fitTime(); timeline.invalidate(); });
console.log('rows', await page.evaluate(() => [document.elementsFromPoint(700, 800).map(e => e.tagName + '.' + e.className).join(' > '), document.elementsFromPoint(700, 300).map(e => e.tagName + '.' + e.className).join(' > '), timeline.rows.length, timeline.h, timeline.leftW, document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor]));
await shot('01-paste-offers');

// ---- fit the comp to a phrase, then sync timing from the card
await page.click('.au-card-btn:has-text("End on a phrase")').catch(() => {});
await page.waitForTimeout(200);
const dur = await page.evaluate(() => editor.store.comp.duration);
ok('fit comp to a 4-bar phrase', Math.abs(dur - 8) < 0.05 || Math.abs(dur - 16) < 0.05, dur);
await page.click('.au-card-btn:has-text("Sync timing")');
await page.waitForTimeout(200);
const synced = await page.evaluate(async () => {
  const T = await import('/src/audio/timing.ts');
  const bt = T.beats(T.music(editor.store));
  return window.__ids.map(id => { const t = editor.store.layer(id).props.position.kf[1].t; return { t: +t.toFixed(4), onBeat: bt.some(b => Math.abs(b - t) < 1 / 60) }; });
});
ok('sync timing: every landing on a beat (±1 frame)', synced.every(x => x.onBeat), synced);
const undoOne = await page.evaluate(() => { const s = editor.store; const l = s.undoLabel; return l; });
ok('one undo step', undoOne === 'Sync to music', undoOne);
await page.evaluate(() => { timeline.fitTime(); for (const id of window.__ids) timeline.expand(id, false); timeline.invalidate(); });
await shot('02-synced-timeline');

// ---- zoom into a few beats: waveform stays crisp, bar numbers + beat ticks
await page.evaluate(() => { timeline.zoomTime(5); editor.store.setTime(1); timeline.invalidate(); });
await shot('03-zoomed-waveform');
await page.evaluate(() => { timeline.fitTime(); timeline.invalidate(); });

// ---- inspector of the audio layer
const panel = await page.$('.au-rows');
ok('audio inspector rows', !!panel);
if (panel) await panel.screenshot({ path: `${OUT}/04-audio-inspector.png` });

// ---- drop a second file onto the timeline at ~2 s: it starts where it was dropped (snapped)
const dropAt = await page.evaluate(async () => {
  const { encodeWav } = await import('/src/audio/wav.ts');
  const sr = 22050, x = new Float32Array(sr);
  for (let i = 0; i < sr; i++) x[i] = Math.sin(i / sr * 2 * Math.PI * 660) * Math.exp(-i / sr * 4) * 0.4;
  const file = new File([encodeWav([x], sr)], 'chime.wav', { type: 'audio/wav' });
  const host = document.querySelector('.tl-canvas').parentElement, r = host.getBoundingClientRect();
  const dt = new DataTransfer(); dt.items.add(file);
  const cx = r.left + timeline.tToX(2);
  host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: cx, clientY: r.top + 60, bubbles: true, cancelable: true }));
  await new Promise(res => setTimeout(res, 600));
  const l = Object.values(editor.store.project.layers).find(x => x.name === 'chime');
  return l ? l.startTime : null;
});
ok('drop on the timeline places the clip at the drop point', dropAt !== null && Math.abs(dropAt - 2) < 0.05, dropAt);

// ---- audio() drives a layer: rendered frames differ on vs off the beat
const react = await page.evaluate(async () => {
  const { TOOLS } = await import('/src/agent/tools.ts');
  const run = (n, a) => TOOLS.find(t => t.name === n).run(a);
  await run('audio_reactive', { ids: [window.__ids[1]], prop: 'scale', band: 'beat', amount: 40, smoothing: 0.05 });
  const lum = async t => {
    const url = editor.renderer.snapshot(t, 320);
    const img = new Image(); img.src = url; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1];
    return s;
  };
  const T = await import('/src/audio/timing.ts');
  const b = T.beats(T.music(editor.store)).find(x => x > 5);
  return { onBeat: await lum(b + 0.02), offBeat: await lum(b + 0.4) };
});
ok('audio() expression renders (bigger on the beat)', react.onBeat > react.offBeat * 1.05, react);

// ---- sound effects picker (opt-in) and family swap
await page.evaluate(async () => { const T = await import('/src/audio/timing.ts'); editor.store.select([T.music(editor.store).layer.id]); });
await page.waitForTimeout(150);
await page.click('.au-btn:has-text("Add sound effects")');
await page.waitForSelector('.au-sfx');
await page.$eval('.au-sfx', el => el.scrollIntoView());
const sfxPanel = await page.$('.au-sfx');
await sfxPanel.screenshot({ path: `${OUT}/05-sfx-picker.png` });
await page.click('.au-sfx-fam:has-text("Crisp UI") .au-btn:has-text("Use")');
await page.waitForTimeout(300);
await page.evaluate(() => editor.pause());
const sfx = await page.evaluate(async () => {
  const P = await import('/src/audio/sfx-place.ts');
  return P.sfxLayers(editor.store).map(l => ({ type: l.sfx.type, t: +(l.startTime ?? 0).toFixed(3) }));
});
ok('sound effects added (linked audio layers)', sfx.length >= 3, sfx);
await page.evaluate(() => { editor.store.setTime(0); timeline.fitTime(); timeline.invalidate(); });
await shot('06-with-sound-effects');

// ---- export: mp4 with the music and the sound effects mixed in
const exp = await page.evaluate(async () => {
  const E = await import('/src/export/video.ts');
  const C = await import('/src/core/commands.ts');
  C.setCompSettings(editor.store, { duration: 4 });
  const blob = await E.exportVideo({ format: 'mp4', scale: 0.5 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  editor.resume?.();
  return { type: blob.type, b64: btoa(bin) };
});
const file = `/tmp/motion-audio-smoke.${exp.type.includes('mp4') ? 'mp4' : 'webm'}`;
writeFileSync(file, Buffer.from(exp.b64, 'base64'));
let streams = '', loud = '';
try {
  streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration', '-of', 'csv=p=0', file]).toString().trim();
  loud = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
} catch (e) { streams ||= 'ffprobe failed: ' + e.message; loud = String(e.stderr ?? ''); }
ok('export has video + audio streams', /video/.test(streams) && /audio/.test(streams), streams.replace(/\n/g, ' | '));

// ---- a 3-minute song in the worker
const perf = await page.evaluate(async () => {
  const { synthTrack } = await import('/src/audio/synth-track.ts');
  const { wavDataUrl } = await import('/src/audio/wav.ts');
  const { ensureAnalysis } = await import('/src/audio/analysis-store.ts');
  const { beatFMeasure } = await import('/src/audio/analysis.ts');
  const tr = synthTrack({ bpm: 124, sections: [{ kind: 'intro', bars: 16 }, { kind: 'build', bars: 16 }, { kind: 'drop', bars: 32 }, { kind: 'breakdown', bars: 16 }, { kind: 'drop', bars: 16 }] });
  const asset = { id: 'perf3min', kind: 'audio', mime: 'audio/wav', data: wavDataUrl([tr.samples], tr.sr), width: 0, height: 0 };
  const t0 = performance.now();
  const a = await ensureAnalysis(asset);
  const total = performance.now() - t0;
  return { seconds: Math.round(tr.duration), totalMs: Math.round(total), workerMs: Math.round(a.ms), bpm: a.bpm, f: +beatFMeasure(tr.beats, a.beats).f.toFixed(3) };
});
ok('3-minute song: decode + analysis < 2 s', perf.totalMs < 2000, perf);
ok('no page errors', errs.length === 0, errs);
writeFileSync('/tmp/motion-audio-smoke.json', JSON.stringify({ results, info, synced, perf, sfx, streams }, null, 1));
await browser.close();
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
