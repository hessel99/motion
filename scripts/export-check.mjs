// end-to-end check of video export (src/export/video.ts) in chromium against the dev server.
// usage: node scripts/export-check.mjs [scale=0.5] [formats=mp4,webm] [url]
// for each format: exports the demo comp, then verifies the file by demuxing it (mediabunny),
// decoding the first frame (VideoDecoder) and loading it in a <video> element.
// note: playwright's chromium build usually lacks H.264 (proprietary codecs); mp4 then falls back
// to webm/VP9 and is reported as such. electron ships H.264 (see scripts/electron-check.mjs).
import { chromium } from './pw.mjs';
import { writeFileSync } from 'node:fs';

const scale = Number(process.argv[2] || 0.5);
const formats = (process.argv[3] || 'mp4,webm').split(',');
const url = process.argv[4] || 'http://localhost:5173/?demo&nobridge';

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
  const checks = {
    size: info.size > 0,
    container: info.format === 'mp4' ? info.boxes.ftyp >= 0 && info.boxes.moov >= 0 : info.boxes.ebml,
    frames: Math.abs(info.demux.packets - info.fps * info.compDuration) <= 1,
    duration: Math.abs(info.demux.duration - info.compDuration) < 1.5 / info.fps,
    decodes: !!info.decoded.first && info.decoded.first.w === info.width,
    videoElement: !info.video.error && Math.abs(info.video.duration - info.compDuration) < 0.1,
  };
  const pass = Object.values(checks).every(Boolean);
  ok &&= pass;
  console.log(`[${format}] ${pass ? 'PASS' : 'FAIL'}`, JSON.stringify(checks));
  console.log(JSON.stringify(info, null, 1));
}
console.log(errs.length ? errs : 'no page errors');
await browser.close();
process.exit(ok ? 0 : 1);
