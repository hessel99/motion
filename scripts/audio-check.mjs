// audio layer: import a generated wav, play/pause scheduling, and video export with an audio track
import { chromium } from './pw.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const url = process.env.URL || 'http://localhost:5173';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(url + '/?blank&nobridge');
await page.waitForFunction(() => window.editor?.renderer);
const res = await page.evaluate(async () => {
  // 1s 440Hz sine wav
  const sr = 44100, n = sr, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / sr * 2 * Math.PI * 440) * 16000, true);
  const A = await import('/src/app/actions.ts');
  const C = await import('/src/core/commands.ts');
  const s = editor.store;
  C.setCompSettings(s, { width: 320, height: 240, duration: 2 });
  C.addLayer(s, 'rect', { x: 100, y: 80, w: 100, h: 80, color: [1, 0, 0, 1] });
  await A.openBrowserFile(new File([b], 'beat.wav', { type: 'audio/wav' }));
  const al = Object.values(s.project.layers).find(l => l.type === 'audio');
  const E = await import('/src/export/video.ts');
  const blob = await E.exportVideo({ format: 'mp4' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { layer: !!al, type: blob.type, size: blob.size, b64: btoa(bin) };
});
const out = '/tmp/motion-audio-check.' + (res.type.includes('mp4') ? 'mp4' : 'webm');
writeFileSync(out, Buffer.from(res.b64, 'base64'));
let streams = '';
try { streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration', '-of', 'csv=p=0', out]).toString().trim(); } catch (e) { streams = 'ffprobe failed: ' + e.message; }
console.log(JSON.stringify({ layer: res.layer, type: res.type, size: res.size, streams, errs }, null, 1));
const ok = res.layer && /audio/.test(streams) && /video/.test(streams) && !errs.length;
await browser.close();
process.exit(ok ? 0 : 1);
