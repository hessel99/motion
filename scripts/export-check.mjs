// end-to-end check of video export (src/export/video.ts) in chromium against the dev server.
// usage: node scripts/export-check.mjs [scale=0.5] [formats=mp4,webm] [url]
// for each format: exports the demo comp, then verifies the file by demuxing it (mediabunny),
// decoding the first frame (VideoDecoder) and loading it in a <video> element.
// note: playwright's chromium build usually lacks H.264 (proprietary codecs); mp4 then falls back
// to webm/VP9 and is reported as such. electron ships H.264 (see scripts/electron-check.mjs).
import { chromium } from './pw.mjs';
import { writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// independent check with ffprobe when installed: codec, size, exact frame count, duration
function ffprobe(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,profile,width,height,nb_read_frames,avg_frame_rate:format=duration', '-of', 'json', file]).toString();
    const j = JSON.parse(out);
    return { ...j.streams[0], duration: +j.format.duration };
  } catch (e) { return { error: String(e.message).slice(0, 200) }; }
}

const electronMode = process.argv.includes('--electron');
const argv = process.argv.slice(2).filter(a => !a.startsWith('--'));
const scale = Number(argv[0] || 0.5);
const formats = (argv[1] || 'mp4,webm').split(',');
const url = argv[2] || 'http://localhost:5173/?demo&nobridge';

// opens the dialog through the File menu (also loads the lazy export chunk)
async function openDialog(page) {
  await page.click('.logo');
  await page.click('.ctx-item:has-text("Export video")');
  await page.waitForSelector('.xv-dialog');
}

if (electronMode) {
  // real app (run `npm run build` first; under xvfb-run -a). exports via window.motionVideo, checks with ffprobe
  const { createRequire } = await import('node:module');
  const { execSync } = await import('node:child_process');
  const { _electron } = createRequire(execSync('npm root -g').toString().trim() + '/')('playwright');
  const app = await _electron.launch({ executablePath: (await import('electron')).default, args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, MOTION_BRIDGE_PORT: '7831' } });
  const win = await app.firstWindow();
  const errs = []; win.on('pageerror', e => errs.push(e.message));
  await win.waitForFunction(() => window.editor?.renderer, null, { timeout: 20000 });
  await win.waitForTimeout(1000);
  await win.click('.logo'); await win.click('.ctx-item:has-text("Load demo animation")');
  await win.waitForTimeout(500);
  await openDialog(win);
  const support = await win.evaluate(() => window.motionVideo.probeVideoSupport(editor.store.comp.width, editor.store.comp.height, editor.store.comp.fps));
  const dialogFormat = await win.$eval('.xv-dialog select', s => s.value);
  await win.keyboard.press('Escape');
  console.log('electron support', JSON.stringify(support), 'dialog default format', dialogFormat);
  let ok = !!support.mp4;
  for (const format of formats) {
    const r = await win.evaluate(async ({ format, scale }) => {
      const res = await window.motionVideo.exportVideoDetailed({ format, scale, quality: 'high' });
      const video = document.createElement('video'); video.muted = true; video.src = URL.createObjectURL(res.blob);
      const vid = await new Promise(ok => { video.onloadedmetadata = () => ok({ duration: video.duration, w: video.videoWidth }); video.onerror = () => ok({ error: String(video.error?.code) }); setTimeout(() => ok({ error: 'timeout' }), 5000); });
      const b64 = await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result.split(',')[1]); fr.readAsDataURL(res.blob); });
      return { format: res.format, codec: res.codec, width: res.width, height: res.height, fps: res.fps, frames: res.frames, size: res.blob.size, elapsedMs: Math.round(res.elapsedMs), encodeFps: +(res.frames / res.elapsedMs * 1000).toFixed(1), compDuration: editor.store.comp.duration, video: vid, b64 };
    }, { format, scale });
    const { b64, ...info } = r;
    const file = `/tmp/export-electron.${info.format}`;
    writeFileSync(file, Buffer.from(b64, 'base64'));
    info.ffprobe = ffprobe(file);
    const pass = info.format === format && info.ffprobe.nb_read_frames == info.frames && Math.abs(info.ffprobe.duration - info.compDuration) < 0.1 && !info.video.error;
    ok &&= pass;
    console.log(`[electron ${format} ${scale}x] ${pass ? 'PASS' : 'FAIL'}`, JSON.stringify(info));
  }
  console.log(errs.length ? errs : 'no page errors');
  await app.close();
  process.exit(ok ? 0 : 1);
}

const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => m.type() === 'error' && errs.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => window.editor?.renderer, null, { timeout: 20000 });
await page.waitForTimeout(1000);

let ok = true;
for (const format of formats) {
  const r = await page.evaluate(async ({ format, scale }) => {
    const m = await import('/src/export/video.ts');
    // import mediabunny through the same (vite-optimized) url that video.ts uses, so it is loaded once
    const src = await (await fetch('/src/export/video.ts')).text();
    const mb = await import(src.match(/from\s+["']([^"']*mediabunny[^"']*)["']/)[1]);
    const comp = editor.store.comp;
    const support = await m.probeVideoSupport(comp.width, comp.height, comp.fps);
    const res = await m.exportVideoDetailed({ format, scale, quality: 'high' });
    const blob = res.blob;
    const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
    const ascii = String.fromCharCode(...head);
    // demux + count packets
    const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    const duration = await input.computeDuration();
    const sink = new mb.EncodedPacketSink(track);
    let packets = 0, keys = 0;
    for await (const p of sink.packets()) { packets++; if (p.type === 'key') keys++; }
    // decode the first and a middle frame
    const vs = new mb.VideoSampleSink(track);
    const first = await vs.getSample(0);
    const mid = await vs.getSample(duration / 2);
    const px = (s) => { const c = new OffscreenCanvas(s.displayWidth, s.displayHeight); const g = c.getContext('2d'); s.draw(g, 0, 0); const d = g.getImageData(c.width / 2 | 0, c.height / 2 | 0, 1, 1).data; return [...d]; };
    const decoded = { first: first && { w: first.displayWidth, h: first.displayHeight, ts: first.timestamp, center: px(first) }, mid: mid && { ts: mid.timestamp, center: px(mid) } };
    // compare the decoded middle frame with the editor's own render of that time (mean abs diff, 0..255)
    let diff = null;
    if (mid) {
      const W = 64, H = Math.round(64 * res.height / res.width);
      const a = new OffscreenCanvas(W, H).getContext('2d'); mid.draw(a, 0, 0, W, H);
      const img = new Image(); img.src = editor.renderer.snapshot(mid.timestamp, Math.max(res.width, res.height)); await img.decode();
      const b = new OffscreenCanvas(W, H).getContext('2d'); b.drawImage(img, 0, 0, W, H);
      const da = a.getImageData(0, 0, W, H).data, db = b.getImageData(0, 0, W, H).data;
      let sum = 0; for (let i = 0; i < da.length; i += 4) sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      diff = +(sum / (W * H * 3)).toFixed(2);
    }
    decoded.diffVsEditor = diff;
    first?.close(); mid?.close();
    // <video> element playback
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(blob);
    const vid = await new Promise(res => {
      video.onloadedmetadata = () => res({ duration: video.duration, w: video.videoWidth, h: video.videoHeight });
      video.onerror = () => res({ error: video.error?.message || String(video.error?.code) });
      setTimeout(() => res({ error: 'timeout' }), 5000);
    });
    let played = null;
    if (!vid.error) {
      try { await video.play(); await new Promise(r => setTimeout(r, 400)); played = video.currentTime; video.pause(); } catch (e) { played = 'play failed: ' + e.message; }
    }
    // export-time drift check: the editor loop must be running again
    const t0 = editor.store.time;
    return {
      support,
      format: res.format, codec: res.codec, width: res.width, height: res.height, fps: res.fps, frames: res.frames,
      bitrate: res.bitrate, elapsedMs: Math.round(res.elapsedMs), encodeFps: +(res.frames / (res.elapsedMs / 1000)).toFixed(1),
      size: blob.size, type: blob.type, compDuration: comp.duration,
      boxes: { ftyp: ascii.indexOf('ftyp'), moov: ascii.indexOf('moov'), ebml: head[0] === 0x1a && head[1] === 0x45 },
      demux: { duration, packets, keys, codec: await track.getCodecParameterString() },
      decoded, video: vid, played, t0,
      b64: blob.size < 30e6 ? await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(blob); }) : null,
    };
  }, { format, scale });
  const { b64, ...info } = r;
  if (b64) writeFileSync(`/tmp/export-check.${r.format}`, Buffer.from(b64, 'base64'));
  info.ffprobe = b64 ? ffprobe(`/tmp/export-check.${r.format}`) : null;
  const checks = {
    size: info.size > 0,
    container: info.format === 'mp4' ? info.boxes.ftyp >= 0 && info.boxes.moov >= 0 : info.boxes.ebml,
    frames: Math.abs(info.demux.packets - info.fps * info.compDuration) <= 1,
    duration: Math.abs(info.demux.duration - info.compDuration) < 1.5 / info.fps,
    decodes: !!info.decoded.first && info.decoded.first.w === info.width,
    matchesEditor: info.decoded.diffVsEditor !== null && info.decoded.diffVsEditor < 4,
    videoElement: !info.video.error && Math.abs(info.video.duration - info.compDuration) < 0.1,
  };
  const pass = Object.values(checks).every(Boolean);
  ok &&= pass;
  console.log(`[${format}] ${pass ? 'PASS' : 'FAIL'}`, JSON.stringify(checks));
  console.log(JSON.stringify(info, null, 1));
}

// the dialog itself: File menu -> Export video… -> 0.5x -> Export -> browser download
{
  await openDialog(page);
  await page.click('.xv-seg button:has-text("0.5×")');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('.xv-actions button.primary')]);
  const file = '/tmp/export-check-ui' + (dl.suggestedFilename().match(/\.\w+$/)?.[0] ?? '');
  await dl.saveAs(file);
  await page.waitForSelector('.xv-dialog', { state: 'detached' });
  const toastText = await page.$eval('.toast', t => t.textContent).catch(() => null);
  const probe = ffprobe(file);
  const pass = statSync(file).size > 0 && !probe.error && probe.width === 960;
  ok &&= pass;
  console.log(`[dialog] ${pass ? 'PASS' : 'FAIL'}`, dl.suggestedFilename(), JSON.stringify(probe), toastText);
}
console.log(errs.length ? errs : 'no page errors');
await browser.close();
process.exit(ok ? 0 : 1);
