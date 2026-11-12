import { describe, it, expect, beforeEach } from 'vitest';
import { TOOLS, READ_ONLY_TOOLS } from '../src/agent/tools';
import { editor } from '../src/app/editor';
import { createProject } from '../src/core/model';
import { stripTimes } from '../src/agent/tools-preview';
// @ts-expect-error untyped bridge module (plain node esm)
import { materializeFiles } from '../bridge/server.mjs';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = async (name: string, args: any) => {
  const c = await TOOLS.find(t => t.name === name)!.run(args);
  return c[0].type === 'text' ? c[0].text : '';
};

beforeEach(() => { editor.store.load(createProject()); });

async function scene() {
  return JSON.parse(await run('build_scene', {
    comp: { duration: 4, background: '#000000' },
    layers: [
      { key: 'title', text: 'Title', fontSize: 80, x: 200, y: 200, fill: '#ffffff', enter: { t: 0, duration: 0.6, from: { opacity: 0, dy: 80 } } },
      { key: 'dim', text: 'low contrast', fontSize: 16, x: 200, y: 400, fill: '#111111' },
      { key: 'box', x: 1800, y: 900, w: 300, h: 300, fill: '#ff0000', animate: { position: [{ t: 1, v: [0, 0], ease: 'Linear' }, { t: 1.5, v: [1000, 0] }] } },
      { key: 'bouncy', x: 500, y: 500, w: 100, h: 100, animate: { scale: [{ t: 2, v: 0, ease: 'Back Out' }, { t: 2.6, v: 100 }] } },
      { key: 'spin', x: 800, y: 500, w: 100, h: 100, expr: { rotation: 'time*90' } },
    ],
  }));
}

describe('analysis tools', () => {
  it('inspect_motion classifies eases, measures overshoot and warns about hard stops', async () => {
    const r = await scene();
    const out = await run('inspect_motion', {});
    expect(out).toMatch(/"title"/);
    expect(out).toMatch(/position: 0s→0.6s Δ80px ease-out/);
    expect(out).toMatch(/scale: 2s→2.6s Δ100% ease-out .*overshoot \d+%/);
    expect(out).toMatch(/1s→1.5s Δ1000px linear/);
    expect(out).toMatch(/stops abruptly/);
    expect(out).toMatch(/rotation: expr "time\*90" → 0..360°, peak 90°\/s/);
    const one = await run('inspect_motion', { ids: [r.ids.box], props: ['position'] });
    expect(one).not.toMatch(/title/);
  });

  it('check_frame finds off-canvas, low contrast and safe-area problems', async () => {
    await scene();
    const out = await run('check_frame', { times: [2] });
    expect(out).toMatch(/box: \d+% off-canvas/);
    expect(out).toMatch(/dim: low contrast 1\.\d+:1/);
    expect(out).not.toMatch(/Title: low contrast/);
    const clean = await run('check_frame', { times: [2], ids: [(await scene()).ids.spin] });
    expect(clean).toMatch(/2s: ok/);
  });

  it('timeline_summary gives beats, layer spans and a density strip', async () => {
    await scene();
    const out = await run('timeline_summary', {});
    expect(out).toMatch(/beats \(3\)/);
    expect(out).toMatch(/0s–0.6s title: position, opacity \[in\]/);
    expect(out).toMatch(/rotation\(expr\)/);
    expect(out).toMatch(/density .*\|.+\|/);
  });

  it('preview tools are read-only; frame times are clamped and snapped', () => {
    for (const n of ['inspect_motion', 'check_frame', 'timeline_summary', 'preview_strip', 'preview_video']) expect(READ_ONLY_TOOLS()).toContain(n);
    editor.store.comp.duration = 2;
    editor.store.comp.fps = 10;
    expect(stripTimes({ frames: 3 }, 24)).toEqual([0, 1, 2]);
    expect(stripTimes({ times: [-1, 0.33, 5] }, 24)).toEqual([0, 0.3, 2]);
    expect(stripTimes({ frames: 100 }, 24)).toHaveLength(24);
  });

  it('the bridge saves file content to a temp file and returns its path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-'));
    const out = materializeFiles([{ type: 'file', name: '../../evil name.gif', data: Buffer.from('GIF89a').toString('base64'), mimeType: 'image/gif' }], dir);
    expect(out[0].type).toBe('text');
    const path = out[0].text.match(/: (\S+) \(/)![1];
    expect(path.startsWith(dir)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('GIF89a');
  });
});
