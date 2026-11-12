// Agent eval harness: runs design briefs (evals/briefs/*.json) as REAL agent turns, headless, and scores them.
// Uses the owner's Claude subscription: keep runs few.
//
//   node scripts/agent-eval.mjs [options]
//     --only 01,05-bar       brief ids (prefix match), default all
//     --model sonnet         agent model (claude alias/id), same for every brief; default sonnet
//     --repeat N             runs per brief (default 1)
//     --concurrency 1..3     parallel briefs (one bridge + one editor page each)
//     --out DIR              results dir (default evals/results/<YYYY-MM-DD>)
//     --url URL              vite dev server (default http://localhost:5271/)
//     --port N               first bridge port (default 7891; worker i uses port+i)
//     --seed N               Math.random seed in the editor (ids, random()) (default 1)
//     --timeout-min N        per-turn cap (default 15)
//     --max-cost USD         stop launching briefs once agent+judge cost passes this (default 30)
//     --no-judge             skip the judge; --judge-model opus (default)
//     --no-video             skip the mp4
//     --judge-only DIR       re-judge saved runs in DIR (with --judge-repeat N, --only): calibration
//     --summarize DIR        rebuild summary.md/json of DIR
//     --dry                  no model: a scripted tool sequence (tests the pipeline for free)
//
// Needs: the dev server running (npx vite --port 5271 --strictPort), the `claude` CLI logged in, ffmpeg for mp4.
// Bridges are started in-process (bridge/server.mjs), one per worker.
// Model sampling can't be seeded through the CLI; the seed fixes the editor side (layer ids, expression random()).
import { chromium } from './pw.mjs';
import { startBridge } from '../bridge/server.mjs';
import { computeMetrics, runChecklist, parseJudge, JUDGE_KEYS } from './agent-eval-lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);
const today = new Date().toISOString().slice(0, 10);
const O = {
  only: opt('only', '')?.split(',').filter(Boolean) ?? [],
  model: opt('model', 'sonnet'),
  repeat: Math.max(1, +opt('repeat', 1)),
  concurrency: Math.max(1, Math.min(3, +opt('concurrency', 1))),
  out: path.resolve(opt('out', path.join(ROOT, 'evals', 'results', today))),
  url: opt('url', 'http://localhost:5271/'),
  port: +opt('port', 7891),
  seed: +opt('seed', 1),
  timeoutMin: +opt('timeout-min', 15),
  maxCost: +opt('max-cost', 30),
  judge: !flag('no-judge'),
  judgeModel: opt('judge-model', 'opus'),
  video: !flag('no-video'),
  judgeOnly: opt('judge-only', null),
  judgeRepeat: Math.max(1, +opt('judge-repeat', 1)),
  summarize: opt('summarize', null),
  dry: flag('dry'),
};

const briefs = fs.readdirSync(path.join(ROOT, 'evals', 'briefs')).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'evals', 'briefs', f), 'utf8')))
  .filter((b) => !O.only.length || O.only.some((p) => b.id.startsWith(p)));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let totalCost = 0;

// ---------------------------------------------------------------- judge
function judgeTemplate() {
  const md = fs.readFileSync(path.join(ROOT, 'evals', 'judge.md'), 'utf8');
  const parts = md.split(/^---8<---$/m);
  if (parts.length < 3) throw new Error('evals/judge.md: prompt must sit between two ---8<--- markers');
  return parts[1].trim();
}

function judgeInput(brief, rec) {
  const ck = rec.checklist.items.map((i) => `- ${i.text} [${i.pass === null ? '?' : i.pass ? 'yes' : 'NO'}]`).join('\n');
  const m = rec.metrics;
  const metrics = [
    `layers ${m.drawableLayers} drawable (${Object.entries(m.layerTypes).map(([k, v]) => `${k} ${v}`).join(', ')}), ${m.keys} keys, ${m.segments} moving segments`,
    `eases: ${Object.entries(m.easesUsed).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}; springs ${m.springSegments}, overshooting ${m.overshootSegments}, hold ${m.holdKeys}`,
    `expressions ${m.expressions}, text animators ${m.textAnimators}, precomps ${m.precomps}, paths ${m.pathLayers}, gradients ${m.gradientLayers}, markers ${m.markers}`,
    `palette (${m.paletteSize}): ${m.palette.join(' ')}`,
    `motion from ${m.firstMotion}s to ${m.lastMotion}s (end hold ${m.endHold}s, longest still ${m.longestHold}s), visual activity ${Math.round(m.visualActivity * 100)}% of the comp`,
    `partially off-canvas ${m.offCanvasTime}s${m.clippedAtEnd.length ? `, clipped in the last frame: ${m.clippedAtEnd.join(', ')}` : ''}; text-on-text overlap ${m.textOverlapTime}s; layers never visible: ${m.neverVisible.join(', ') || 'none'}`,
  ].join('\n');
  const fill = { id: brief.id, comp: `${brief.comp.width}x${brief.comp.height}, ${brief.comp.duration}s @${brief.comp.fps}fps`, prompt: brief.prompt, checklist: ck, layers: rec.layerList, timeline: rec.timeline.slice(0, 9000), metrics };
  return judgeTemplate().replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '');
}

function runClaudeOnce({ text, image, model, timeoutMs = 300_000 }) {
  return new Promise((resolve) => {
    const content = [];
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.toString('base64') } });
    content.push({ type: 'text', text });
    const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '', '--disable-slash-commands',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--model', model];
    const cwd = path.join(os.tmpdir(), 'motion-eval-judge'); fs.mkdirSync(cwd, { recursive: true });
    const child = spawn('claude', a, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (c) => { out += c; if (process.env.EVAL_DEBUG) console.error('[judge]', String(c).slice(0, 160)); });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', () => {
      clearTimeout(timer);
      let result = null;
      for (const line of out.split('\n')) { try { const o = JSON.parse(line); if (o.type === 'result') result = o; } catch { /* */ } }
      resolve({ text: result?.result ?? '', cost: result?.total_cost_usd ?? 0, ms: result?.duration_ms ?? 0, models: Object.keys(result?.modelUsage ?? {}), error: result ? (result.is_error ? result.result : null) : `no result: ${err.slice(-300)}` });
    });
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  });
}

async function judge(dir, brief, rec) {
  const text = judgeInput(brief, rec);
  fs.writeFileSync(path.join(dir, 'judge-input.txt'), text);
  const img = fs.readFileSync(path.join(dir, 'contact.jpg'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await runClaudeOnce({ text, image: img, model: O.judgeModel });
    totalCost += r.cost;
    const parsed = parseJudge(r.text);
    if (parsed) return { ...parsed, model: r.models[0] ?? O.judgeModel, cost: r.cost, ms: r.ms, raw: r.text };
    log(`  judge parse failed (${r.error ?? r.text.slice(0, 120)})`);
  }
  return null;
}

// ---------------------------------------------------------------- editor side (runs in the page)
const SEED_SCRIPT = (seed) => {
  let s = seed >>> 0 || 1;
  Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};

async function probe(page) {
  return page.evaluate(async () => {
    const { valueAt } = await import('/src/core/commands.ts');
    const { describeLayerAnimation } = await import('/src/agent/describe.ts');
    const ed = window.editor, st = ed.store, r = ed.renderer, c = st.comp;
    try { ed.pause(); } catch { /* */ }
    const D = c.duration, N = Math.min(240, Math.max(30, Math.round(D * 15)));
    const samples = [];
    for (let i = 0; i <= N; i++) {
      const t = (D * i) / N;
      r.render(t);
      const items = [];
      for (let k = 0; k < r.items.length; k++) {
        const it = r.items[k], L = it.layer;
        if (['group', 'audio', 'precomp'].includes(L.type) || it.hidden || L.mask) continue;
        if (it.tEnd != null && t > it.tEnd) continue;
        const lt = t - (it.tOff ?? 0);
        if (lt < (L.inPoint ?? 0) || lt >= (L.outPoint ?? Infinity)) continue;
        const cs = r.corners(it.id);
        if (!cs) continue;
        const xs = [cs[0], cs[2], cs[4], cs[6]], ys = [cs[1], cs[3], cs[5], cs[7]];
        const rr = (x) => Math.round(x * 10) / 10;
        let o = r.opa[k] ?? 1;
        // text animators fade units, not the layer: approximate (hidden before an "in" starts / after an "out" ends)
        const ta = L.textAnim;
        if (ta && ta.from?.opacity < 50) {
          const n = (L.text?.content ?? '').length, units = ta.by === 'char' ? n : ta.by === 'word' ? n / 5 : 2;
          const s0 = (L.inPoint ?? 0) + (ta.start ?? 0), s1 = s0 + (ta.duration ?? 0.5) + (ta.stagger ?? 0) * units;
          if (ta.mode !== 'out' && lt < s0) o = 0;
          if (ta.mode === 'out' && lt > s1) o = 0;
        }
        items.push([it.id, rr(Math.min(...xs)), rr(Math.min(...ys)), rr(Math.max(...xs)), rr(Math.max(...ys)), Math.round(o * 1000) / 1000]);
      }
      samples.push({ t: Math.round(t * 1000) / 1000, items });
    }
    // pixel stats: loop seam (frame 0 vs frame at the loop point) and mean luminance mid-comp
    const pix = async (t) => {
      const url = r.snapshot(t, 160);
      const im = new Image(); await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = url; });
      const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
      const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(im, 0, 0);
      return g.getImageData(0, 0, cv.width, cv.height).data;
    };
    const a = await pix(0), b = await pix(D), m = await pix(D / 2);
    let diff = 0, luma = 0;
    for (let i = 0; i < a.length; i += 4) { diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); luma += 0.2126 * m[i] + 0.7152 * m[i + 1] + 0.0722 * m[i + 2]; }
    const px = a.length / 4;
    const vals = {};
    for (const l of Object.values(st.project.layers)) {
      const at = (t) => Object.fromEntries(['position', 'size', 'scale', 'rotation', 'opacity', 'fill'].filter((k) => l.props[k]).map((k) => [k, valueAt(l, k, t).map((x) => Math.round(x * 1000) / 1000)]));
      vals[l.id] = { mid: at(D / 2), end: at(D) };
    }
    const hex = (v) => v ? '#' + v.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('') + ((v[3] ?? 1) < 1 ? ` a${Math.round(v[3] * 100) / 100}` : '') : '';
    const mid = samples[Math.floor(samples.length / 2)];
    const order = st.drawOrder ? st.drawOrder() : Object.keys(st.project.layers);
    const layerList = order.map((id) => {
      const l = st.layer(id); if (!l) return '';
      const depth = (() => { let d = 0, p = l.parent; while (p) { d++; p = st.layer(p)?.parent; } return d; })();
      const box = mid.items.find((x) => x[0] === id);
      const fill = l.paints?.some((p) => p.type === 'linear' || p.type === 'radial') ? `gradient(${l.paints.find((p) => p.stops)?.stops?.map((s) => hex(s.color)).join('→')})` : l.props.fill ? hex(valueAt(l, 'fill', D / 2)) : '';
      const extra = [l.text ? `"${l.text.content.slice(0, 60)}" ${l.text.fontFamily} ${l.text.fontSize}px w${l.text.fontWeight}` : '', l.shape ? l.shape.kind : '', l.props.strokeWidth && valueAt(l, 'strokeWidth', 0)[0] > 0 ? `stroke ${hex(valueAt(l, 'stroke', 0))} ${valueAt(l, 'strokeWidth', 0)[0]}px` : ''].filter(Boolean).join(' ');
      return `${'  '.repeat(depth)}- ${l.name} [${l.type}]${box ? ` box ${Math.round(box[1])},${Math.round(box[2])},${Math.round(box[3] - box[1])},${Math.round(box[4] - box[2])}` : ''} ${fill} ${extra}`.trimEnd();
    }).filter(Boolean).join('\n');
    const timeline = [`comp ${c.width}x${c.height} ${D}s @${c.fps}fps, background ${hex(c.background)}${(c.markers ?? []).length ? `, markers ${c.markers.map((m) => m.t + (m.label ? ' ' + m.label : '')).join(', ')}` : ''}`,
      ...order.map((id) => { const l = st.layer(id); return l ? describeLayerAnimation(l) : ''; }).filter(Boolean)].join('\n');
    r.dirty = true; r.render(st.time);
    return { comp: { width: c.width, height: c.height, fps: c.fps, duration: D, background: c.background }, samples, vals, loopDiff: diff / (px * 3 * 255), midLuma: luma / (px * 255), layerList, timeline, comps: Object.keys(st.project.comps).length };
  });
}

async function contactSheet(page) {
  return page.evaluate(async () => {
    const { TOOLS } = await import('/src/agent/tools.ts');
    const st = window.editor.store;
    const t = TOOLS.find((x) => x.name === 'contact_sheet');
    const res = await t.run({ frames: 12, start: 0, end: st.comp.duration, cell: 360 });
    return res.find((x) => x.type === 'image')?.data;
  });
}

async function exportVideo(page, file) {
  const b64 = await page.evaluate(async () => {
    const { exportVideoDetailed } = await import('/src/export/video.ts');
    const c = window.editor.store.comp;
    const scale = Math.min(1, 960 / Math.max(c.width, c.height));
    const res = await exportVideoDetailed({ format: 'mp4', scale, quality: 'medium' });
    const buf = new Uint8Array(await res.blob.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { data: btoa(bin), format: res.format, codec: res.codec, frames: res.frames };
  });
  const raw = file.replace(/\.mp4$/, '.raw.' + b64.format);
  fs.writeFileSync(raw, Buffer.from(b64.data, 'base64'));
  // playwright's chromium has no H.264 encoder (falls back to VP9/webm): transcode for a portable, small mp4
  for (const crf of [30, 36, 42]) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', file]);
    if (fs.statSync(file).size < 1.9e6) break;
  }
  fs.rmSync(raw);
  return { frames: b64.frames, sourceCodec: b64.codec, bytes: fs.statSync(file).size };
}

// ---------------------------------------------------------------- one brief
async function runBrief(worker, brief, rep) {
  const { page, port } = worker;
  const name = brief.id + (O.repeat > 1 ? `-r${rep + 1}` : '');
  const dir = path.join(O.out, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(brief, null, 2));
  await page.goto(`${O.url}?blank&bridge=${port}`);
  await page.waitForFunction(() => window.editor?.store && window.editor.renderer);
  for (let i = 0; i < 100; i++) {
    const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => ({}));
    if (h.editorConnected && h.tools > 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const events = [];
  let done;
  const finished = new Promise((r) => { done = r; });
  worker.onEvent = (ev) => { if (ev.kind !== 'text_delta') events.push(ev); if (ev.kind === 'done') done(); };
  const t0 = Date.now();
  const setup = await page.evaluate(async ({ comp, prompt, model, dry }) => {
    const { agentClient } = await import('/src/agent/client.ts');
    const { composeMessage } = await import('/src/agent/context.ts');
    const { setCompSettings } = await import('/src/core/commands.ts');
    const { TOOLS } = await import('/src/agent/tools.ts');
    const st = window.editor.store;
    setCompSettings(st, { width: comp.width, height: comp.height, fps: comp.fps, duration: comp.duration });
    st.setTime(0); st.select([]);
    window.__evalLog = [];
    const orig = agentClient.runTool.bind(agentClient);
    agentClient.runTool = async (name, a) => {
      const s = performance.now(); let ok = true, error;
      try { return await orig(name, a); } catch (e) { ok = false; error = String(e?.message ?? e).slice(0, 400); throw e; } finally {
        window.__evalLog.push({ name, argsBytes: JSON.stringify(a ?? {}).length, ok, ms: Math.round(performance.now() - s), error, at: Date.now() });
      }
    };
    const message = composeMessage(st, prompt);
    if (dry) {
      // pipeline self-test without a model: a scripted "agent" through the same tool path
      const send = (ev) => window.__evalEvent({ ...ev, at: Date.now() });
      const call = async (id, name, input) => {
        send({ kind: 'tool_use', id, name, input });
        try { const r = await agentClient.runTool(name, input); send({ kind: 'tool_result', id, isError: false, summary: r[0]?.text ?? '' }); return r; } catch (e) { send({ kind: 'tool_result', id, isError: true, summary: String(e.message) }); }
      };
      const ids = [];
      for (let i = 0; i < 3; i++) { const r = await call('a' + i, 'add_layer', { type: i === 1 ? 'ellipse' : 'rect', x: comp.width / 2 - 300 + i * 300, y: comp.height / 2, w: 160, h: 160, fill: ['#4c8dff', '#ff5a6b', '#ffc83f'][i], name: 'Shape ' + i }); ids.push(JSON.parse(r[0].text).id); }
      const t = await call('t', 'add_layer', { type: 'text', text: 'Hello', x: comp.width / 2, y: comp.height / 2 + 200, name: 'Title' });
      await call('p', 'apply_preset', { ids, preset: 'Pop', t: 0.2, stagger: 0.15 });
      await call('x', 'set_text_animation', { ids: [JSON.parse(t[0].text).id], preset: 'Fade up', start: 0.8 });
      await call('e', 'set_keyframes', { id: 'nope', prop: 'scale', keyframes: [] });
      send({ kind: 'text', text: 'dry run' });
      send({ kind: 'done', costUsd: 0, numTurns: 0, usage: { input: 0, cached: 0, output: 0 } });
      window.__chatId = 'dry';
    } else window.__chatId = agentClient.chat({ provider: 'claude', message, model }, (ev) => window.__evalEvent({ ...ev, at: Date.now() }));
    return { message, tools: TOOLS.map((t) => t.name) };
  }, { comp: brief.comp, prompt: brief.prompt, model: O.model, dry: O.dry });
  log(`[w${worker.i}] ${name}: turn started (${setup.tools.length} tools)`);
  let timedOut = false;
  await Promise.race([finished, new Promise((r) => setTimeout(r, O.timeoutMin * 60_000)).then(() => { timedOut = true; })]);
  if (timedOut) {
    log(`[w${worker.i}] ${name}: timeout, cancelling`);
    await page.evaluate(async () => { const { agentClient } = await import('/src/agent/client.ts'); agentClient.cancel(window.__chatId); });
    await Promise.race([finished, new Promise((r) => setTimeout(r, 20_000))]);
  }
  const wallMs = Date.now() - t0;
  const toolLog = await page.evaluate(() => window.__evalLog);
  // stream events → tool calls (with results) + text
  const calls = [];
  const byId = new Map();
  for (const ev of events) {
    if (ev.kind === 'tool_use') { const c = { id: ev.id, name: ev.name, argsBytes: JSON.stringify(ev.input ?? {}).length, input: ev.input, at: ev.at }; calls.push(c); byId.set(ev.id, c); }
    if (ev.kind === 'tool_result') { const c = byId.get(ev.id); if (c) { c.ok = !ev.isError; c.result = ev.summary; c.ms = ev.at - c.at; } }
  }
  // precise in-editor durations, matched in order per tool name
  const queue = {};
  for (const t of toolLog) (queue[t.name] ??= []).push(t);
  for (const c of calls) { const t = queue[c.name]?.shift(); if (t) { c.editorMs = t.ms; if (!t.ok) c.error = t.error; } }
  const doneEv = events.find((e) => e.kind === 'done') ?? {};
  const errors = events.filter((e) => e.kind === 'error').map((e) => e.message);
  const run = {
    id: brief.id, name, model: O.model, seed: O.seed, wallMs, timedOut, turns: doneEv.numTurns ?? null, costUsd: doneEv.costUsd ?? 0,
    durationMs: doneEv.durationMs ?? null, usage: doneEv.usage ?? null, errors,
    toolCalls: calls.length, toolErrors: calls.filter((c) => c.ok === false).length, toolsAvailable: setup.tools.length,
    finalText: events.filter((e) => e.kind === 'text').map((e) => e.text).join('\n').slice(-3000),
  };
  totalCost += run.costUsd;
  fs.writeFileSync(path.join(dir, 'message.txt'), setup.message);
  fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(calls.map((c) => ({ name: c.name, argsBytes: c.argsBytes, ok: c.ok ?? null, ms: c.ms ?? null, editorMs: c.editorMs ?? null, error: c.ok === false ? (c.error ?? c.result) : undefined, input: JSON.stringify(c.input).length > 3000 ? JSON.stringify(c.input).slice(0, 3000) + '…' : c.input, result: c.result })), null, 1));
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(events.map((e) => (e.kind === 'tool_use' ? { ...e, input: JSON.stringify(e.input).slice(0, 1500) } : e)), null, 1));
  // final document + metrics
  const doc = await page.evaluate(() => JSON.parse(JSON.stringify(window.editor.store.project)));
  fs.writeFileSync(path.join(dir, 'document.json'), JSON.stringify(doc));
  const pr = await probe(page);
  const { metrics, derived } = computeMetrics(doc, pr);
  const checklist = runChecklist(brief, metrics, derived);
  const sheet = await contactSheet(page);
  fs.writeFileSync(path.join(dir, 'contact.jpg'), Buffer.from(sheet, 'base64'));
  let video = null;
  if (O.video) {
    try { video = await exportVideo(page, path.join(dir, 'video.mp4')); } catch (e) { video = { error: String(e.message).slice(0, 300) }; log(`  video failed: ${video.error}`); }
  }
  const rec = { run, metrics: { ...metrics, toolErrors: run.toolErrors, toolCalls: run.toolCalls }, checklist, video, layerList: pr.layerList, timeline: pr.timeline };
  fs.writeFileSync(path.join(dir, 'timeline.txt'), `${pr.layerList}\n\n${pr.timeline}\n`);
  fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify({ run, metrics: rec.metrics, checklist, video }, null, 1));
  log(`[w${worker.i}] ${name}: ${Math.round(wallMs / 1000)}s, ${run.toolCalls} tools (${run.toolErrors} err), ${run.turns} turns, $${run.costUsd.toFixed(3)}, checklist ${checklist.hits}/${checklist.checkable}`);
  if (O.judge) {
    const j = await judge(dir, brief, rec);
    if (j) { fs.writeFileSync(path.join(dir, 'judge.json'), JSON.stringify(j, null, 1)); log(`[w${worker.i}] ${name}: judge ${j.overall} — ${j.critique[0]}`); }
  }
  return rec;
}

// ---------------------------------------------------------------- summary
function loadRuns(dir) {
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'metrics.json'))).sort().map((d) => {
    const m = JSON.parse(fs.readFileSync(path.join(dir, d, 'metrics.json'), 'utf8'));
    const jf = path.join(dir, d, 'judge.json');
    const j = fs.existsSync(jf) ? JSON.parse(fs.readFileSync(jf, 'utf8')) : null;
    const b = JSON.parse(fs.readFileSync(path.join(dir, d, 'brief.json'), 'utf8'));
    return { name: d, brief: b, ...m, judge: j };
  });
}

export function summarize(dir) {
  const runs = loadRuns(dir);
  const rows = runs.map((r) => ({
    name: r.name, id: r.run.id, complexity: r.brief.complexity, model: r.run.model, wallS: Math.round(r.run.wallMs / 1000), turns: r.run.turns,
    costUsd: Math.round(r.run.costUsd * 1000) / 1000, tokensIn: r.run.usage?.input ?? null, tokensOut: r.run.usage?.output ?? null,
    toolCalls: r.run.toolCalls, toolErrors: r.run.toolErrors, timedOut: r.run.timedOut, layers: r.metrics.drawableLayers, keys: r.metrics.keys,
    distinctEases: r.metrics.distinctEases, springs: r.metrics.springSegments, textAnimators: r.metrics.textAnimators, expressions: r.metrics.expressions,
    precomps: r.metrics.precomps, coverage: r.metrics.visualActivity, offCanvasS: r.metrics.offCanvasTime, textOverlapS: r.metrics.textOverlapTime,
    checklistHits: r.checklist.hits, checklistCheckable: r.checklist.checkable,
    judge: r.judge ? { ...r.judge.scores, overall: r.judge.overall, critique: r.judge.critique } : null,
  }));
  const mean = (f) => { const v = rows.map(f).filter((x) => typeof x === 'number'); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; };
  const totals = {
    runs: rows.length, costUsd: Math.round(rows.reduce((a, r) => a + r.costUsd, 0) * 100) / 100,
    judgeCostUsd: Math.round(runs.reduce((a, r) => a + (r.judge?.cost ?? 0), 0) * 100) / 100,
    meanWallS: mean((r) => r.wallS), meanTurns: mean((r) => r.turns), meanCost: mean((r) => r.costUsd), meanToolCalls: mean((r) => r.toolCalls),
    toolErrors: rows.reduce((a, r) => a + r.toolErrors, 0), checklistRate: Math.round((rows.reduce((a, r) => a + r.checklistHits, 0) / Math.max(1, rows.reduce((a, r) => a + r.checklistCheckable, 0))) * 1000) / 1000,
    judgeOverall: mean((r) => r.judge?.overall), ...Object.fromEntries(JUDGE_KEYS.map((k) => ['judge_' + k, mean((r) => r.judge?.[k])])),
  };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ generated: new Date().toISOString(), totals, rows }, null, 1));
  const J = (r, k) => (r.judge ? r.judge[k] : '–');
  const md = [
    `# Agent eval — ${path.basename(dir)}`, '',
    `${rows.length} runs, model ${[...new Set(rows.map((r) => r.model))].join(', ')}. Agent cost $${totals.costUsd} (judge $${totals.judgeCostUsd}); mean ${totals.meanWallS}s, ${totals.meanTurns} turns, ${totals.meanToolCalls} tool calls, $${totals.meanCost} per brief. Tool errors ${totals.toolErrors}. Checklist ${Math.round(totals.checklistRate * 100)}% of machine-checkable items. Judge overall **${totals.judgeOverall ?? '–'}**/10 (${JUDGE_KEYS.map((k) => `${k} ${totals['judge_' + k] ?? '–'}`).join(', ')}).`, '',
    '| brief | time | turns | cost | tools (err) | layers | keys | eases | spr/txt/expr/pre | activity | off-canvas | txt overlap | checklist | fit | style | timing | comp | rich | polish | **overall** |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${r.wallS}s${r.timedOut ? ' ⏱' : ''} | ${r.turns ?? '–'} | $${r.costUsd.toFixed(2)} | ${r.toolCalls} (${r.toolErrors}) | ${r.layers} | ${r.keys} | ${r.distinctEases} | ${r.springs}/${r.textAnimators}/${r.expressions}/${r.precomps} | ${Math.round(r.coverage * 100)}% | ${r.offCanvasS}s | ${r.textOverlapS}s | ${r.checklistHits}/${r.checklistCheckable} | ${J(r, 'brief_fit')} | ${J(r, 'style_match')} | ${J(r, 'timing_easing')} | ${J(r, 'composition')} | ${J(r, 'richness')} | ${J(r, 'polish')} | **${J(r, 'overall')}** |`),
    '', '## Judge critique', '',
    ...rows.map((r) => `- **${r.name}**: ${r.judge ? r.judge.critique.join(' / ') : '–'}`), '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'summary.md'), md);
  return { totals, rows };
}

// ---------------------------------------------------------------- judge-only (calibration)
async function judgeOnly(dir) {
  const runs = loadRuns(dir).filter((r) => !O.only.length || O.only.some((p) => r.name.startsWith(p)));
  const cal = [];
  for (const r of runs) {
    const d = path.join(dir, r.name);
    // rebuilt from the saved run, so rubric edits in evals/judge.md apply
    const tl = fs.readFileSync(path.join(d, 'timeline.txt'), 'utf8');
    const cut = tl.indexOf('\n\n');
    const text = judgeInput(r.brief, { checklist: r.checklist, metrics: r.metrics, layerList: tl.slice(0, cut), timeline: tl.slice(cut + 2) });
    fs.writeFileSync(path.join(d, 'judge-input.txt'), text);
    const img = fs.readFileSync(path.join(d, 'contact.jpg'));
    const scores = r.judge ? [r.judge] : [];
    for (let i = 0; i < O.judgeRepeat; i++) {
      const res = await runClaudeOnce({ text, image: img, model: O.judgeModel });
      totalCost += res.cost;
      const p = parseJudge(res.text);
      if (p) scores.push({ ...p, cost: res.cost });
      if (p && !r.judge && !fs.existsSync(path.join(d, 'judge.json'))) fs.writeFileSync(path.join(d, 'judge.json'), JSON.stringify({ ...p, model: res.models[0] ?? O.judgeModel, cost: res.cost, ms: res.ms, raw: res.text }, null, 1));
      log(`${r.name}: judge #${scores.length} ${p?.overall ?? 'parse failed: ' + (res.error ?? res.text.slice(0, 300))}`);
    }
    const spread = Object.fromEntries([...JUDGE_KEYS, 'overall'].map((k) => {
      const v = scores.map((s) => (k === 'overall' ? s.overall : s.scores[k]));
      return [k, { values: v, range: Math.round((Math.max(...v) - Math.min(...v)) * 100) / 100 }];
    }));
    cal.push({ name: r.name, runs: scores.length, spread, critiques: scores.map((s) => s.critique) });
  }
  const crit = [...JUDGE_KEYS, 'overall'];
  const meanRange = Object.fromEntries(crit.map((k) => [k, Math.round((cal.reduce((a, c) => a + c.spread[k].range, 0) / Math.max(1, cal.length)) * 100) / 100]));
  const exact = cal.length ? Math.round((cal.reduce((a, c) => a + JUDGE_KEYS.filter((k) => c.spread[k].range === 0).length, 0) / (cal.length * JUDGE_KEYS.length)) * 100) : 0;
  const within1 = cal.length ? Math.round((cal.reduce((a, c) => a + JUDGE_KEYS.filter((k) => c.spread[k].range <= 1).length, 0) / (cal.length * JUDGE_KEYS.length)) * 100) : 0;
  const out = { judgeModel: O.judgeModel, briefs: cal, meanRange, exactAgreementPct: exact, within1Pct: within1, costUsd: Math.round(totalCost * 1000) / 1000 };
  fs.writeFileSync(path.join(dir, 'calibration.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ meanRange, exactAgreementPct: exact, within1Pct: within1 }, null, 1));
  for (const c of cal) console.log(c.name, crit.map((k) => `${k}:${c.spread[k].values.join('/')}`).join(' '));
}

// ---------------------------------------------------------------- main
async function main() {
  if (O.summarize) { const s = summarize(path.resolve(O.summarize)); console.log(s.totals); return; }
  if (O.judgeOnly) { await judgeOnly(path.resolve(O.judgeOnly)); return; }
  fs.mkdirSync(O.out, { recursive: true });
  log(`${briefs.length} briefs × ${O.repeat}, model ${O.model}, concurrency ${O.concurrency}, out ${path.relative(ROOT, O.out)}`);
  const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const workDir = path.join(os.tmpdir(), 'motion-eval-agent'); fs.mkdirSync(workDir, { recursive: true });
  const workers = [];
  for (let i = 0; i < O.concurrency; i++) {
    const bridge = await startBridge({ port: O.port + i, log: () => {}, workDir });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(SEED_SCRIPT, O.seed);
    const page = await ctx.newPage();
    const w = { i, port: bridge.port, bridge, page, onEvent: null, pageErrors: [] };
    page.on('pageerror', (e) => w.pageErrors.push(e.message));
    await page.exposeFunction('__evalEvent', (ev) => w.onEvent?.(ev));
    workers.push(w);
  }
  const queue = [];
  for (let r = 0; r < O.repeat; r++) for (const b of briefs) queue.push([b, r]);
  let aborted = false;
  await Promise.all(workers.map(async (w) => {
    while (queue.length) {
      if (totalCost > O.maxCost) { if (!aborted) log(`cost $${totalCost.toFixed(2)} > --max-cost ${O.maxCost}: stopping`); aborted = true; return; }
      const [b, r] = queue.shift();
      try { await runBrief(w, b, r); } catch (e) { log(`[w${w.i}] ${b.id} failed: ${e.stack ?? e}`); }
    }
  }));
  for (const w of workers) { if (w.pageErrors.length) log(`[w${w.i}] page errors: ${[...new Set(w.pageErrors)].slice(0, 5).join(' | ')}`); await w.bridge.close(); }
  await browser.close();
  const s = summarize(O.out);
  log(`done: ${JSON.stringify(s.totals)}`);
}

await main();
process.exit(0); // keep-alive sockets (health checks) would keep the bridges open
