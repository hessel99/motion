import { describe, it, expect, beforeEach } from 'vitest';
import { TOOLS, READ_ONLY_TOOLS, AGENT_SYSTEM_PROMPT } from '../src/agent/tools';
import { toolManifest } from '../src/agent/client';
import { editor } from '../src/app/editor';
import { createProject } from '../src/core/model';
import { addLayer, valueAt } from '../src/core/commands';
import { snapshotDoc, diffDocs, summarizeDiff, diffIsEmpty } from '../src/agent/diff';
import { describeTrack, easeName, fmtValue } from '../src/agent/describe';
import { editorContext, resolveMentions, composeMessage } from '../src/agent/context';
import { variations } from '../src/agent/variations';
import { serializeChat } from '../src/agent/history';
import { availableActions, targetPhrase, QUICK_ACTIONS } from '../src/agent/quick';
import { toolLabel } from '../src/agent/labels';

// ---------- JSON Schema validation of every tool (Claude rejects invalid tool schemas) ----------

const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const KEYWORDS = new Set(['type', 'properties', 'required', 'items', 'enum', 'description', 'default', 'anyOf', 'additionalProperties', 'minItems', 'maxItems', 'minimum', 'maximum', 'title']);

function typeOf(v: unknown) { return v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v; }

/** strict structural validator: returns a list of problems ("path: message") */
function checkSchema(s: any, path: string, out: string[]) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) { out.push(`${path}: schema must be an object`); return; }
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) out.push(`${path}: unsupported keyword "${k}"`);
  if (s.type === undefined && s.enum === undefined && s.anyOf === undefined) out.push(`${path}: needs type, enum or anyOf`);
  if (s.type !== undefined && !TYPES.includes(s.type)) out.push(`${path}: invalid type ${JSON.stringify(s.type)}`);
  if (s.description !== undefined && typeof s.description !== 'string') out.push(`${path}: description must be a string`);
  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum) || !s.enum.length) out.push(`${path}: enum must be a non-empty array`);
    else if (new Set(s.enum).size !== s.enum.length) out.push(`${path}: enum has duplicates`);
    else if (s.enum.some((v: unknown) => typeof v === 'object' && v !== null)) out.push(`${path}: enum values must be primitives`);
  }
  if (s.anyOf !== undefined) {
    if (!Array.isArray(s.anyOf) || !s.anyOf.length) out.push(`${path}: anyOf must be a non-empty array`);
    else s.anyOf.forEach((x: any, i: number) => checkSchema(x, `${path}.anyOf[${i}]`, out));
  }
  if (s.type === 'object' || s.properties) {
    if (s.properties !== undefined) {
      if (typeof s.properties !== 'object' || Array.isArray(s.properties)) out.push(`${path}: properties must be an object`);
      else for (const [k, v] of Object.entries(s.properties)) checkSchema(v, `${path}.${k}`, out);
    }
    if (s.required !== undefined) {
      if (!Array.isArray(s.required)) out.push(`${path}: required must be an array`);
      else for (const r of s.required) if (!s.properties || !(r in s.properties)) out.push(`${path}: required "${r}" is not a property`);
    }
    if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') checkSchema(s.additionalProperties, `${path}.additionalProperties`, out);
  }
  if (s.type === 'array') {
    if (s.items === undefined) out.push(`${path}: array needs items (Gemini/OpenAI reject arrays without items)`);
    else checkSchema(s.items, `${path}[]`, out);
  }
  if (s.items !== undefined && s.type !== 'array') out.push(`${path}: items without type array`);
  for (const k of ['minItems', 'maxItems'] as const) if (s[k] !== undefined && !(Number.isInteger(s[k]) && s[k] >= 0)) out.push(`${path}: ${k} must be a non-negative integer`);
  if (s.default !== undefined && s.type !== undefined) {
    const t = typeOf(s.default);
    if (!(t === s.type || (s.type === 'number' && t === 'integer'))) out.push(`${path}: default ${JSON.stringify(s.default)} does not match type ${s.type}`);
  }
}

describe('agent tool schemas', () => {
  it('every tool has a valid name, description and JSON Schema', () => {
    const problems: string[] = [];
    const names = new Set<string>();
    for (const t of TOOLS) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) problems.push(`${t.name}: invalid tool name`);
      if (names.has(t.name)) problems.push(`${t.name}: duplicate name`);
      names.add(t.name);
      if (!t.description || t.description.length < 10) problems.push(`${t.name}: missing description`);
      if (t.inputSchema?.type !== 'object') problems.push(`${t.name}: root schema must be type object`);
      // must survive the trip over the websocket unchanged (no undefined / functions)
      if (JSON.stringify(JSON.parse(JSON.stringify(t.inputSchema))) !== JSON.stringify(t.inputSchema)) problems.push(`${t.name}: schema not JSON-stable`);
      checkSchema(t.inputSchema, t.name, problems);
    }
    expect(problems).toEqual([]);
  });

  it('the validator catches the mistakes it is meant to catch', () => {
    const p: string[] = [];
    checkSchema({ type: 'object', properties: { a: { type: 'array' }, b: { enum: [] }, c: { type: 'list' } }, required: ['zzz'] }, 'x', p);
    expect(p.length).toBe(4);
  });

  it('manifest carries MCP annotations; read-only set excludes editing tools', () => {
    const m = toolManifest();
    expect(m.find(t => t.name === 'get_animation')!.annotations.readOnlyHint).toBe(true);
    expect(m.find(t => t.name === 'delete_layers')!.annotations.destructiveHint).toBe(true);
    const ro = READ_ONLY_TOOLS();
    expect(ro).toContain('contact_sheet');
    expect(ro).toContain('get_editor_context');
    for (const bad of ['add_layer', 'update_layer', 'animate', 'retime', 'delete_layers', 'set_keyframes', 'save_variation']) expect(ro).not.toContain(bad);
    for (const name of ['animate', 'retime', 'stagger', 'contact_sheet', 'get_animation', 'save_variation']) expect(AGENT_SYSTEM_PROMPT).toContain(name);
  });
});

// ---------- tools against a real store ----------

const tool = (name: string) => TOOLS.find(t => t.name === name)!;
const run = async (name: string, args: any) => {
  const c = await tool(name).run(args);
  return c[0].type === 'text' ? c[0].text : '';
};

function fresh() {
  editor.store.load(createProject());
  variations.clear();
  const s = editor.store;
  const a = addLayer(s, 'rect', { x: 0, y: 0, w: 100, h: 100, name: 'Logo' });
  const b = addLayer(s, 'ellipse', { x: 200, y: 0, w: 100, h: 100, name: 'Big title' });
  return { s, a, b };
}

describe('agent tools', () => {
  beforeEach(() => { fresh(); });

  it('animate sets many tracks in one undo step, with stagger', async () => {
    const s = editor.store;
    const [a, b] = s.comp.root.map(id => s.layer(id)!);
    const h = s.historyLength;
    const r = await run('animate', {
      stagger: 0.1,
      tracks: [
        { id: a.id, prop: 'scale', keyframes: [{ t: 0, v: 0, ease: 'Back Out' }, { t: 0.5, v: 100 }] },
        { id: a.id, prop: 'opacity', keyframes: [{ t: 0, v: 0 }, { t: 0.3, v: 100 }] },
        { id: b.id, prop: 'rotation', keyframes: [{ t: 0, v: -90, ease: 'spring Bouncy' }, { t: 0.6, v: 0 }] },
      ],
    });
    expect(r).toMatch(/3 tracks on 2 layers/);
    expect(s.historyLength).toBe(h + 1);
    expect(a.props.scale!.kf!.map(k => k.t)).toEqual([0, 0.5]);
    expect(b.props.rotation!.kf!.map(k => k.t)).toEqual([0.1, 0.7]); // staggered
    expect(b.props.rotation!.kf![0].interp).toBe('spring');
    expect(valueAt(a, 'scale', 0.5)).toEqual([100, 100]);
    s.undo();
    expect(a.props.scale?.kf).toBeUndefined();
  });

  it('animate is atomic: a bad track leaves the document untouched', async () => {
    const s = editor.store;
    const [a] = s.comp.root.map(id => s.layer(id)!);
    expect(() => tool('animate').run({ tracks: [{ id: a.id, prop: 'scale', keyframes: [{ t: 0, v: 0 }] }, { id: a.id, prop: 'wobble', keyframes: [{ t: 0, v: 1 }] }] })).toThrow(/unknown property/);
    expect(a.props.scale?.kf).toBeUndefined();
  });

  it('get_animation describes keys compactly with ease names', async () => {
    const s = editor.store;
    const [a] = s.comp.root.map(id => s.layer(id)!);
    await run('animate', { tracks: [{ id: a.id, prop: 'scale', keyframes: [{ t: 0.2, v: 0, ease: 'Back Out' }, { t: 0.8, v: 100, ease: 'Linear' }, { t: 1.2, v: 90 }] }] });
    const out = await run('get_animation', { ids: [a.id] });
    expect(out).toContain('"Logo" (rect');
    expect(out).toContain('scale: 0.2s 0 ─Back Out→ 0.8s 100 ─linear→ 1.2s 90');
    // default (no selection): all animated layers only
    const all = await run('get_animation', {});
    expect(all).not.toContain('Big title');
  });

  it('retime scales around the first key and stagger offsets whole layers', async () => {
    const s = editor.store;
    const [a, b] = s.comp.root.map(id => s.layer(id)!);
    await run('animate', { tracks: [{ id: a.id, prop: 'opacity', keyframes: [{ t: 1, v: 0 }, { t: 2, v: 100 }] }, { id: b.id, prop: 'opacity', keyframes: [{ t: 1, v: 0 }, { t: 1.5, v: 100 }] }] });
    await run('retime', { ids: [a.id], scale: 1.5 });
    expect(a.props.opacity!.kf!.map(k => k.t)).toEqual([1, 2.5]);
    await run('stagger', { ids: [a.id, b.id], step: 0.25 });
    expect(b.props.opacity!.kf!.map(k => k.t)).toEqual([1.25, 1.75]);
    expect(a.props.opacity!.kf!.map(k => k.t)).toEqual([1, 2.5]);
    expect(() => tool('stagger').run({ ids: [a.id], step: 0.1 })).toThrow(/at least two/);
  });

  it('variations capture and re-apply animation state (undoable)', async () => {
    const s = editor.store;
    const [a] = s.comp.root.map(id => s.layer(id)!);
    await run('animate', { tracks: [{ id: a.id, prop: 'scale', keyframes: [{ t: 0, v: 0 }, { t: 0.4, v: 100 }] }] });
    await run('save_variation', { ids: [a.id], label: 'A · Snappy' });
    await run('animate', { tracks: [{ id: a.id, prop: 'scale', keyframes: [{ t: 0, v: 0, ease: 'spring Bouncy' }, { t: 1, v: 100 }] }] });
    const r = await run('save_variation', { ids: [a.id], label: 'B · Bouncy' });
    expect(r).toMatch(/2 variations/);
    const [va, vb] = variations.list;
    expect(variations.active).toBe(vb.id);
    variations.apply(s, va.id);
    expect(a.props.scale!.kf!.map(k => k.t)).toEqual([0, 0.4]);
    expect(variations.range(va)).toEqual([0, 0.4]);
    s.undo();
    expect(a.props.scale!.kf!.map(k => k.t)).toEqual([0, 1]);
  });

  it('get_layer summarizes big geometry unless full', async () => {
    const s = editor.store;
    const d = 'M0 0 ' + Array.from({ length: 60 }, (_, i) => `L${i} ${i % 7}`).join(' ') + ' Z';
    const id = JSON.parse(await run('add_layer', { type: 'path', d, w: 60, h: 10 })).id;
    expect(await run('get_layer', { id })).toMatch(/commands \(pass full:true\)/);
    expect(JSON.parse(await run('get_layer', { id, full: true })).geometry[0].cmds.length).toBeGreaterThan(60);
    expect(s.layer(id)).toBeTruthy();
  });
});

// ---------- diff / describe / context / persistence ----------

describe('turn diff', () => {
  it('lists added, changed (with key counts) and removed layers', async () => {
    const { s, a, b } = fresh();
    const before = snapshotDoc(s.project);
    await run('animate', { tracks: [{ id: a.id, prop: 'scale', keyframes: [{ t: 0, v: 0 }, { t: 1, v: 100 }] }] });
    await run('update_layer', { id: b.id, name: 'Renamed' });
    await run('add_layer', { type: 'rect', name: 'New one' });
    await run('delete_layers', { ids: [b.id] });
    const d = diffDocs(before, snapshotDoc(s.project));
    expect(d.added.map(x => x.name)).toEqual(['New one']);
    expect(d.removed.map(x => x.name)).toEqual(['Big title']);
    expect(d.changed).toEqual([{ id: a.id, name: 'Logo', type: 'rect', fields: ['scale (animated, 2 keys)'] }]);
    expect(summarizeDiff(d)).toBe('added 1 layer · changed 1 layer · removed 1 layer');
    expect(diffIsEmpty(diffDocs(before, before))).toBe(true);
  });
});

describe('describe', () => {
  it('formats values and names eases', () => {
    expect(fmtValue('scale', [100, 100])).toBe('100');
    expect(fmtValue('position', [10.123, 20])).toBe('[10.12,20]');
    expect(fmtValue('fill', [1, 0, 0, 1])).toBe('#ff0000');
    const k = (t: number, o: [number, number], i: [number, number], interp: any = 'bezier') => ({ t, v: [0], interp, out: o, in: i });
    expect(easeName(k(0, [0.16, 1], [0, 0]), k(1, [0, 0], [0.3, 1]))).toBe('Expo Out');
    expect(easeName({ ...k(0, [0, 0], [0, 0], 'spring'), bounce: 0.45 })).toBe('spring Bouncy');
    expect(describeTrack('opacity', [k(0, [0, 0], [0, 0], 'hold'), k(1, [0, 0], [0, 0])])).toBe('0s 0 ─hold→ 1s 0');
  });
});

describe('editor context + mentions', () => {
  it('includes selection, playhead, markers and mentioned layers', async () => {
    const { s, a, b } = fresh();
    await run('set_markers', { add: [{ t: 0.5, label: 'beat' }] });
    s.select([a.id]);
    s.setTime(1.25);
    const ctx = editorContext(s, resolveMentions(s, 'move it next to @[Big title]'));
    expect(ctx).toContain('playhead 1.25s');
    expect(ctx).toContain('markers: 0.5s "beat"');
    expect(ctx).toContain(`"Logo" rect id=${a.id}`);
    expect(ctx).toContain('mentioned:');
    expect(ctx).toContain(`id=${b.id}`);
    expect(resolveMentions(s, 'make @logo spin').map(l => l.id)).toEqual([a.id]);
    expect(composeMessage(s, 'hi')).toMatch(/^hi\n\n<editor_context>/);
    expect(targetPhrase(s)).toBe('the selected layer "Logo"');
  });
});

describe('quick actions + labels + persistence', () => {
  it('filters actions by selection and labels tools for humans', () => {
    expect(availableActions(0).map(a => a.id)).not.toContain('stagger');
    expect(availableActions(2).map(a => a.id)).toContain('stagger');
    expect(QUICK_ACTIONS.filter(a => a.mode === 'ask').map(a => a.id)).toEqual(['critique', 'explain']);
    const names: Record<string, string> = { l1: 'Logo' };
    expect(toolLabel('mcp__motion__set_keyframes', { id: 'l1', prop: 'scale' }, id => names[id])).toBe('Keyframe scale on Logo');
    expect(toolLabel('apply_preset', { ids: ['l1'], preset: 'Pop' }, id => names[id])).toBe('Apply “Pop” to Logo');
  });

  it('serializes chats without images and with stale review cards', () => {
    const c = serializeChat([
      { role: 'tool', text: '', tool: { id: 't', name: 'screenshot', input: { big: 'x'.repeat(5000) }, image: 'data:...' } },
      { role: 'review', text: '', review: { marker: 1, endMarker: 2, steps: 1, diff: { added: [], removed: [], changed: [], comp: [] }, state: 'pending' } },
    ], { claude: 's1' });
    expect(c.msgs[0].tool!.image).toBeUndefined();
    expect(JSON.stringify(c.msgs[0].tool!.input).length).toBeLessThan(1700);
    expect(c.msgs[1].review!.state).toBe('stale');
    expect(c.sessions.claude).toBe('s1');
  });
});
