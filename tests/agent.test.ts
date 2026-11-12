import { describe, it, expect, beforeEach } from 'vitest';
import { TOOLS, READ_ONLY_TOOLS, AGENT_SYSTEM_PROMPT } from '../src/agent/tools';
import { toolManifest } from '../src/agent/client';
import { editor } from '../src/app/editor';
import { createProject } from '../src/core/model';
import { addLayer, valueAt } from '../src/core/commands';
import { snapshotDoc, diffDocs, summarizeDiff, diffIsEmpty } from '../src/agent/diff';
import { describeTrack, easeName, fmtValue } from '../src/agent/describe';
import { editorContext, resolveMentions, composeMessage } from '../src/agent/context';
import { serializeChat, reviewAtEnd, type ReviewInfo } from '../src/agent/history';
import { agentClient } from '../src/agent/client';
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
    for (const bad of ['add_layer', 'update_layer', 'animate', 'retime', 'delete_layers', 'set_keyframes']) expect(ro).not.toContain(bad);
    for (const name of ['animate', 'retime', 'stagger', 'contact_sheet', 'get_animation']) expect(AGENT_SYSTEM_PROMPT).toContain(name);
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

  it('retime / stagger refuse to push keys before 0 instead of stacking them on 0', async () => {
    const s = editor.store;
    const [a, b] = s.comp.root.map(id => s.layer(id)!);
    await run('animate', { tracks: [{ id: a.id, prop: 'opacity', keyframes: [{ t: 0.2, v: 0 }, { t: 0.5, v: 50 }, { t: 0.8, v: 100 }] }, { id: b.id, prop: 'opacity', keyframes: [{ t: 0.2, v: 0 }, { t: 0.6, v: 100 }] }] });
    expect(() => tool('retime').run({ ids: [a.id], offset: -1 })).toThrow(/before 0/);
    expect(a.props.opacity!.kf!.map(k => k.t)).toEqual([0.2, 0.5, 0.8]);
    await run('retime', { ids: [a.id], offset: -0.2 });
    expect(a.props.opacity!.kf!.map(k => +k.t.toFixed(6))).toEqual([0, 0.3, 0.6]);
    expect(() => tool('stagger').run({ ids: [a.id, b.id], step: 0.1, start: -0.5 })).toThrow(/before 0/);
    expect(() => tool('retime').run({ ids: [a.id], scale: NaN })).toThrow();
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
  it('includes selection, playhead and mentioned layers', async () => {
    const { s, a, b } = fresh();
    s.select([a.id]);
    s.setTime(1.25);
    const ctx = editorContext(s, resolveMentions(s, 'move it next to @[Big title]'));
    expect(ctx).toContain('playhead 1.25s');
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
      { role: 'review', text: '', review: { startId: 1, endId: 2, steps: 1, diff: { added: [], removed: [], changed: [], comp: [] }, state: 'pending' } },
    ], { claude: 's1' });
    expect(c.msgs[0].tool!.image).toBeUndefined();
    expect(JSON.stringify(c.msgs[0].tool!.input).length).toBeLessThan(1700);
    expect(c.msgs[1].review!.state).toBe('stale');
    expect(c.sessions.claude).toBe('s1');
  });
});

describe('history markers past the undo cap', () => {
  it('historyLength stays monotonic and undoTo returns to the marker after 500+ steps', () => {
    const { s, a } = fresh();
    for (let i = 0; i < 520; i++) s.transact('x', tx => tx.set(a, 'name', 'n' + i));
    const marker = s.historyLength;
    expect(marker).toBeGreaterThan(500);
    s.transact('agent', tx => tx.set(a, 'name', 'agent'));
    s.transact('agent2', tx => tx.set(a, 'name', 'agent2'));
    expect(s.historyLength).toBe(marker + 2);
    expect(s.undoTo(marker)).toBe(2);
    expect(a.name).toBe('n519');
  });
});

describe('review card identity (undo entry ids)', () => {
  const review = (startId: number, endId: number): ReviewInfo => ({ startId, endId, steps: 2, diff: { added: [], removed: [], changed: [], comp: [] }, state: 'pending' });

  it('undoing the turn and making as many own edits does not re-enable revert/compare', () => {
    const { s, a } = fresh();
    const startId = s.topEntryId;
    const h0 = s.historyLength;
    s.transact('agent', tx => tx.set(a, 'name', 'agent1'));
    s.transact('agent', tx => tx.set(a, 'name', 'agent2'));
    const r = review(startId, s.topEntryId);
    expect(reviewAtEnd(r, s.topEntryId)).toBe(true);
    s.undo(); s.undo();
    s.transact('mine', tx => tx.set(a, 'name', 'mine1'));
    s.transact('mine', tx => tx.set(a, 'name', 'mine2'));
    expect(s.historyLength).toBe(h0 + 2); // the old step-count check matched here
    expect(reviewAtEnd(r, s.topEntryId)).toBe(false);
  });

  it('redoing the turn re-enables it; undoToEntry / redoToEntry go exactly between the two states', () => {
    const { s, a } = fresh();
    const startId = s.topEntryId;
    s.transact('agent', tx => tx.set(a, 'name', 'agent1'));
    s.transact('agent', tx => tx.set(a, 'name', 'agent2'));
    const r = review(startId, s.topEntryId);
    expect(s.undoToEntry(startId)).toBe(2);
    expect(a.name).toBe('Logo');
    expect(s.redoToEntry(r.endId!)).toBe(2);
    expect(a.name).toBe('agent2');
    expect(reviewAtEnd(r, s.topEntryId)).toBe(true);
    // an edit while "comparing" clears the redo stack: ending the compare must not redo anything
    s.undoToEntry(startId);
    s.transact('mine', tx => tx.set(a, 'name', 'mine'));
    expect(s.redoToEntry(r.endId!)).toBe(0);
    expect(a.name).toBe('mine');
  });

  it('merging into the top entry gives it a new id (the state changed)', () => {
    const { s, a } = fresh();
    s.transact('drag', tx => tx.set(a, 'name', 'x1'), 'k');
    const id = s.topEntryId, h = s.historyLength;
    s.transact('drag', tx => tx.set(a, 'name', 'x2'), 'k');
    expect(s.historyLength).toBe(h);
    expect(s.topEntryId).not.toBe(id);
  });

  it('agentClient.forget lifts an Ask-mode lock left by a locally finished turn', async () => {
    fresh();
    (agentClient as any).readOnlyChats.add('c-test');
    await expect(agentClient.runTool('add_layer', { type: 'rect' })).rejects.toThrow(/Ask/);
    agentClient.forget('c-test');
    expect(agentClient.readOnlyCount).toBe(0);
    await expect(agentClient.runTool('add_layer', { type: 'rect' })).resolves.toBeTruthy();
  });
});

describe('agent tools: styles and components', () => {
  it('creates, lists, links and switches styles; makes components and instances', async () => {
    const { s, a, b } = fresh();
    await run('set_style', { name: 'Brand/Primary', value: '#ff0000' });
    await run('set_style', { name: 'Radius/M', value: 12 });
    expect(await run('link_style', { ids: [a.id, b.id], prop: 'fill', style: 'Brand / Primary' })).toContain('Brand/Primary');
    await run('link_style', { ids: [a.id], prop: 'radius', style: 'Radius/M' });
    expect(a.props.radius!.v).toEqual([12, 12, 12, 12]);
    const listed = JSON.parse(await run('list_styles', {}));
    expect(listed.styles.find((x: any) => x.name === 'Brand/Primary')).toMatchObject({ value: '#ff0000', usedBy: 2 });
    await run('set_style', { name: 'Brand/Primary', value: '#0000ff' });
    expect(b.props.fill!.v).toEqual([0, 0, 1, 1]);
    const layer = await run('get_layer', { id: a.id });
    expect(layer).toContain('Brand/Primary');
    await run('link_style', { ids: [a.id], prop: 'fill', style: null });
    expect(a.props.fill!.bind).toBeUndefined();
    await expect(run('link_style', { ids: [a.id], prop: 'fill', style: 'Nope' })).rejects.toThrow(/no style/);

    await run('create_component', { id: a.id, name: 'Logo' });
    const inst = JSON.parse(await run('add_instance', { component: 'Logo', x: 500, y: 300, delay: 0.25 }));
    expect(s.layer(inst.id)!.link!.main).toBe(a.id);
    expect(s.layer(inst.id)!.props.position!.v).toEqual([500, 300]);
    expect(JSON.parse(await run('list_styles', {})).components).toEqual([{ id: a.id, name: 'Logo', instances: 1 }]);
    expect(READ_ONLY_TOOLS()).toContain('list_styles');
  });
});

// ---------- director: guides, storyboard, prompt ----------

import { GUIDES, STYLE_GUIDES, findGuide, guideSections } from '../src/agent/guides';
import { storyboards, approvalMessage, normalizeStoryboard } from '../src/agent/storyboard';
import { briefScope } from '../src/agent/quick';
import { resourceManifest } from '../src/agent/client';
import { checkExpr } from '../src/core/expr';
import { EASE_PRESETS, SPRING_PRESETS } from '../src/core/easing';

describe('agent guides (get_guide)', () => {
  it('all guides load with a title and a one-line summary; the index lists every name', async () => {
    for (const n of ['handbook', 'workflow', 'cookbook']) expect(findGuide(n)?.text.length).toBeGreaterThan(2000);
    expect(STYLE_GUIDES.length).toBeGreaterThanOrEqual(16);
    for (const g of GUIDES) {
      expect(g.title.length, g.name).toBeGreaterThan(2);
      expect(g.summary.length, g.name).toBeGreaterThan(20);
    }
    const index = await run('get_guide', {});
    for (const n of ['handbook', 'workflow', 'cookbook', 'styles']) expect(index).toContain(n);
    const styles = await run('get_guide', { name: 'styles' });
    for (const g of STYLE_GUIDES) expect(styles).toContain(g.name);
    for (const g of GUIDES) expect(await run('get_guide', { name: g.name })).toBe(g.text);
  });

  it('every style recipe has the full template and real hex colors', () => {
    for (const g of STYLE_GUIDES) {
      for (const h of ['Palette', 'Shapes', 'Typography', 'Easing & timing', 'Signature moves', 'Transitions', 'Do / Don', 'Mini scene plan']) expect(guideSections(g).some(s => s.startsWith(h)), `${g.name}: ${h}`).toBe(true);
      expect((g.text.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).length, g.name).toBeGreaterThanOrEqual(4);
    }
  });

  it('finds guides loosely, loads single sections, and errors helpfully', async () => {
    expect(findGuide('swiss')?.name).toBe('styles/swiss');
    expect(findGuide('Neo brutalist')?.name).toBe('styles/neo-brutalist');
    expect(findGuide('Swiss / International')?.name).toBe('styles/swiss');
    const sec = await run('get_guide', { name: 'handbook', section: 'Critique' });
    expect(sec).toMatch(/^## 11\. Critique rubric/);
    expect(sec.length).toBeLessThan(findGuide('handbook')!.text.length / 4);
    await expect(run('get_guide', { name: 'nope' })).rejects.toThrow(/guides: .*handbook/);
    await expect(run('get_guide', { name: 'handbook', section: 'zzz' })).rejects.toThrow(/sections: /);
  });

  it('the guides only name eases, springs and presets that exist', () => {
    const eases = new Set(EASE_PRESETS.map(p => p.name));
    const springs = new Set(SPRING_PRESETS.map(p => p.name));
    const bad: string[] = [];
    for (const g of GUIDES) {
      for (const m of g.text.matchAll(/`spring ([A-Z][a-z]+)`/g)) if (!springs.has(m[1])) bad.push(`${g.name}: spring ${m[1]}`);
      for (const m of g.text.matchAll(/`((?:Sine|Quad|Cubic|Quart|Expo|Back|Ease) (?:In Out|In|Out)|Easy Ease|Linear|Snappy|Gentle)`/g)) if (!eases.has(m[1])) bad.push(`${g.name}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });

  it('expressions quoted in the guides compile', () => {
    const exprs = ['value + 3*Math.sin(time*2*Math.PI/1.5)', 'Math.floor(time*2)%2*100', 'value + (time % 2 < 0.15 ? [random(-12,12), 0] : [0,0])', 'value + (Math.floor(time*12)%2 ? 0.6 : -0.6)', 'wiggle(8, 0.8)', 'value + 8*Math.sin(time*2*Math.PI/5)', 'time*360/4'];
    for (const e of exprs) expect(GUIDES.some(g => g.text.includes(e)), e).toBe(true);
    for (const e of exprs) expect(checkExpr(e, /\[/.test(e) ? 2 : 1), e).toBeNull();
    expect(checkExpr('value + [30*Math.sin((time/4 + index*0.33)*2*Math.PI), 20*Math.cos((time/2 + index*0.2)*2*Math.PI)]', 2)).toBeNull();
  });

  it('guides are served as MCP resources', () => {
    const r = resourceManifest();
    expect(r.length).toBe(GUIDES.length);
    expect(r.find(x => x.uri === 'motion://guides/styles/swiss')).toMatchObject({ mimeType: 'text/markdown', title: 'Swiss / International' });
  });
});

describe('agent system prompt', () => {
  it('stays a small, stable core (< 1,200 words) that points to the guides and the director tools', () => {
    const words = AGENT_SYSTEM_PROMPT.split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThan(1200);
    for (const name of ['get_guide', 'propose_storyboard', 'update_progress', 'contact_sheet', 'handbook', 'styles', 'cookbook', 'workflow']) expect(AGENT_SYSTEM_PROMPT).toContain(name);
    // nothing per-turn or time-dependent in the cached prefix
    expect(AGENT_SYSTEM_PROMPT).not.toMatch(/\$\{|\d{4}-\d{2}-\d{2}/);
  });

  it('briefScope: storyboards / styles / long briefs are pieces; quick actions are edits', () => {
    expect(briefScope('Make a 12 second explainer about our app')).toBe('piece');
    expect(briefScope('anything', { style: true })).toBe('piece');
    expect(briefScope('Make it bouncier', { chip: 'Bouncier' })).toBe('edit');
    expect(briefScope('slower please', { selCount: 1 })).toBe('edit');
    expect(briefScope('Add a red circle that pops in')).toBe('build');
  });
});

describe('director tools: storyboard flow', () => {
  beforeEach(() => { fresh(); storyboards.clear(); });
  const plan = { title: 'Launch', style: 'Swiss / International', styleReason: 'grid-strict brand', duration: 6, beats: [
    { name: 'Hook', start: 0, end: 2, description: 'Red bar wipes in', style: 'Expo Out' },
    { name: 'Reveal', start: 2, end: 6, description: 'Logo lands' },
  ] };

  it('schemas: beats need name/start/end/description; status is an enum', () => {
    const p = tool('propose_storyboard').inputSchema;
    expect(p.required).toEqual(['title', 'beats']);
    expect(p.properties.beats.items.required).toEqual(['name', 'start', 'end', 'description']);
    expect(tool('update_progress').inputSchema.properties.status.enum).toEqual(['active', 'done', 'skipped']);
    expect(READ_ONLY_TOOLS()).toContain('get_guide');
    expect(READ_ONLY_TOOLS()).not.toContain('propose_storyboard');
  });

  it('validates beats with actionable errors', () => {
    expect(() => normalizeStoryboard({ title: 'x', beats: [] })).toThrow(/non-empty/);
    expect(() => normalizeStoryboard({ title: 'x', beats: [{ name: 'a', start: 2, end: 1, description: '' }] })).toThrow(/start < end/);
    expect(() => normalizeStoryboard({ title: 'x', beats: [{ name: 'a', start: 2, end: 3 }, { name: 'b', start: 0, end: 1 }] })).toThrow(/time order/);
    expect(normalizeStoryboard({ title: 'x', beats: [{ name: 'a', start: 0, end: 3 }] }).duration).toBe(3);
  });

  it('propose → wait (ask mode) → approve with edits → progress per beat, each beat one undo step', async () => {
    const seen: any[] = [];
    const off = storyboards.on(sb => seen.push(sb));
    const r = await run('propose_storyboard', plan);
    expect(r).toMatch(/Wait for approval: end your turn/);
    expect(storyboards.current).toMatchObject({ title: 'Launch', state: 'proposed' });
    expect(seen.at(-1).beats.map((b: any) => b.status)).toEqual(['todo', 'todo']);

    // the user renames beat 2 and approves: the message back to the agent carries the edited plan
    const edited = { ...storyboards.current!, beats: storyboards.current!.beats.map((b, i) => (i === 1 ? { ...b, name: 'Logo resolve' } : b)), edited: true };
    const msg = approvalMessage(storyboards.approve(edited));
    expect(msg).toMatch(/approved with my edits/);
    expect(JSON.parse(msg.match(/<storyboard>(.*)<\/storyboard>/)![1]).beats[1].name).toBe('Logo resolve');

    const s = editor.store;
    const h0 = s.historyLength;
    expect(await run('update_progress', { beat: 1, status: 'active' })).toMatch(/beat 1 "Hook" active/);
    await run('add_layer', { type: 'rect', name: 'Bar', x: 96, y: 200, w: 1728, h: 24, fill: '#E30613' });
    await run('add_layer', { type: 'text', name: 'Head', text: { content: 'FORM' } });
    const bar = s.comp.root.map(id => s.layer(id)!).find(l => l.name === 'Bar')!;
    await run('animate', { tracks: [{ id: bar.id, prop: 'scale', keyframes: [{ t: 0, v: [0, 100], ease: 'Expo Out' }, { t: 0.6, v: [100, 100] }] }] });
    expect(s.historyLength - h0).toBeGreaterThanOrEqual(3);
    expect(await run('update_progress', { beat: 'hook', status: 'done', note: 'bar + head' })).toMatch(/1\/2 beats/);
    expect(s.historyLength - h0).toBe(1);
    expect(s.undoLabel).toBe('Beat 1 · Hook');

    // beat 2 by name; "done" without a separate "active" call starts where beat 1 ended
    await run('add_layer', { type: 'ellipse', name: 'Logo' });
    await run('add_layer', { type: 'rect', name: 'Logo bar' });
    expect(await run('update_progress', { beat: 'Logo resolve', status: 'done' })).toMatch(/2\/2 beats finished — now critique/);
    expect(s.undoLabel).toBe('Beat 2 · Logo resolve');
    expect(storyboards.current!.state).toBe('done');
    expect(seen.at(-1).beats.map((b: any) => b.status)).toEqual(['done', 'done']);

    // one undo removes a whole beat; redo brings it back
    const n = s.comp.root.length;
    s.undo();
    expect(s.comp.root.length).toBe(n - 2);
    s.undo();
    expect(s.comp.root.length).toBe(n - 4);
    s.redo(); s.redo();
    expect(s.comp.root.length).toBe(n);
    await expect(run('update_progress', { beat: 7, status: 'done' })).rejects.toThrow(/1\.\.2/);
    off();
  });

  it('auto-approval mode tells the agent to build right away', async () => {
    const g = globalThis as any;
    const prev = Object.getOwnPropertyDescriptor(g, 'localStorage');
    const mem: Record<string, string> = { 'motion.agent.storyboard': 'auto' };
    Object.defineProperty(g, 'localStorage', { configurable: true, writable: true, value: { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; } } });
    try {
      expect(await run('propose_storyboard', plan)).toMatch(/Auto-approved: build it now/);
      expect(storyboards.current!.state).toBe('approved');
    } finally {
      if (prev) Object.defineProperty(g, 'localStorage', prev); else delete g.localStorage;
    }
  });

  it('store.squashSince merges entries into one labeled step and is a no-op for unknown ids', () => {
    const s = editor.store;
    const top = s.topEntryId;
    addLayer(s, 'rect', { name: 'A' });
    addLayer(s, 'rect', { name: 'B' });
    expect(s.squashSince(top, 'Both')).toBe(2);
    expect(s.undoLabel).toBe('Both');
    expect(s.squashSince(123, 'x')).toBe(0);
    expect(s.squashSince(s.topEntryId, 'x')).toBe(0);
  });

  it('tool labels for the director tools', () => {
    expect(toolLabel('mcp__motion__get_guide', { name: 'styles/swiss' }, () => undefined)).toBe('Read guide “styles/swiss”');
    expect(toolLabel('propose_storyboard', plan, () => undefined)).toBe('Storyboard “Launch” · 2 beats');
    expect(toolLabel('update_progress', { beat: 2, status: 'done' }, () => undefined)).toBe('Beat 2 done');
  });
});

// ---------- concept-driven motion ----------

import conceptBriefs from '../src/agent/guides/evals/concept-briefs.json';

describe('concept-driven motion', () => {
  beforeEach(() => { fresh(); storyboards.clear(); });

  it('the concepts guide and the prompt rule exist and name the artwork tools', async () => {
    const g = await run('get_guide', { name: 'concepts' });
    for (const w of ['Door opens', 'Leaf grows', 'Rocket launches', 'tittle', 'Anti-patterns', 'inspect_artwork', 'split_shape', 'set_pivot', 'rig']) expect(g).toContain(w);
    for (const w of ['inspect_artwork', 'split_shape', 'set_pivot', 'rig', 'concepts', 'MUST first look']) expect(AGENT_SYSTEM_PROMPT).toContain(w);
    expect(await run('get_guide', {})).toContain('concepts');
  });

  it('storyboards carry 2-3 concepts; the approval names the picked one and flags a switch', async () => {
    await run('propose_storyboard', { title: 'Haven logo', beats: [{ name: 'Door', start: 0, end: 2, description: 'door swings open' }], recommended: 0, concepts: [
      { name: 'Door opens', idea: 'the door swings on its hinge, light spills out', why: 'welcome home' },
      { name: 'House draws itself', idea: 'outline draws on, then fills' },
    ] });
    const sb = storyboards.current!;
    expect(sb.concepts!.length).toBe(2);
    expect(sb.chosen).toBe(0);
    expect(approvalMessage(sb)).toMatch(/Concept: "Door opens"\. Build/);
    const other = approvalMessage({ ...sb, chosen: 1 });
    expect(other).toMatch(/Concept: "House draws itself" \(I picked this instead/);
    expect(JSON.parse(other.match(/<storyboard>(.*)<\/storyboard>/)![1]).concept).toMatch(/^House draws itself: outline/);
    expect(() => normalizeStoryboard({ title: 'x', beats: [{ name: 'a', start: 0, end: 1 }], concepts: [{ name: 'no idea' }] })).toThrow(/needs name and idea/);
  });

  it('eval briefs: every setup call is a valid tool call that builds the artwork', async () => {
    expect(conceptBriefs.briefs.length).toBeGreaterThanOrEqual(4);
    for (const b of conceptBriefs.briefs) {
      fresh();
      for (const c of b.setup) await tool(c.tool).run(c.args);
      expect(editor.store.comp.root.length, b.id).toBeGreaterThanOrEqual(5);
      expect(b.expect.concept.length).toBeGreaterThan(20);
    }
  });

  it('animating trim on a path turns its "Trim paths" switch on (draw-on recipes render)', async () => {
    const { id } = JSON.parse(await run('add_layer', { type: 'path', name: 'Line', d: 'M0 0 L100 0', w: 100, h: 2, stroke: '#000000', strokeWidth: 4 }));
    expect(editor.store.layer(id)!.trimOn).toBeFalsy();
    await run('animate', { tracks: [{ id, prop: 'trimEnd', keyframes: [{ t: 0, v: 0 }, { t: 1, v: 100 }] }] });
    expect(editor.store.layer(id)!.trimOn).toBe(true);
  });
});
