// the after effects script runs against a small mock of the ae scripting dom. checks: it is
// es3-safe enough to run, builds the right layers, parents with jump, keyframes and eases.
import { describe, it, expect } from 'vitest';
import { createLayer, createProject } from '../src/core/model';
import { projectToAeScript } from '../src/export/aejsx';

class Prop {
  value: any = undefined;
  keys: { t: number; v: any; inE?: any; outE?: any; tin?: number; tout?: number }[] = [];
  expression = '';
  propertyValueType: number;
  constructor(public name: string) {
    this.propertyValueType = /Position|Anchor/.test(name) ? 6 : /Scale|Size/.test(name) ? 2 : 1;
  }
  setValue(v: any) { this.value = v; }
  setValueAtTime(t: number, v: any) { this.keys.push({ t, v }); }
  setTemporalEaseAtKey(i: number, a: any, b: any) { this.keys[i - 1].inE = a; this.keys[i - 1].outE = b; }
  setInterpolationTypeAtKey(i: number, a: number, b: number) { this.keys[i - 1].tin = a; this.keys[i - 1].tout = b; }
  setSpatialTangentsAtKey() { /* ok */ }
}
class Group {
  children: (Group | Prop)[] = [];
  map: Record<string, Group | Prop> = {};
  name = '';
  constructor(public matchName: string) {}
  property(n: string): any {
    if (!this.map[n]) this.map[n] = /Group|Vectors|Root|Text Properties/.test(n) && !/Shape - Group/.test(n) ? new Group(n) : new Prop(n);
    return this.map[n];
  }
  addProperty(n: string) {
    const g = /Vector Group$/.test(n) || /Shape - |Graphic - /.test(n) ? new Group(n) : new Prop(n);
    this.children.push(g);
    return g;
  }
}
class Layer extends Group {
  parent: Layer | null = null;
  enabled = true; inPoint = 0; outPoint = 0; startTime = 0;
  constructor(public kind: string, public source?: any) { super('layer'); }
  setParentWithJump(p: Layer) { this.parent = p; }
  moveToEnd() { /* ok */ }
}
class Comp {
  list: Layer[] = [];
  opened = false;
  constructor(public name: string, public w: number, public h: number, public dur: number, public fps: number) {}
  private add_(l: Layer) { this.list.unshift(l); return l; }
  layers = {
    addShape: () => this.add_(new Layer('shape')),
    addNull: () => this.add_(new Layer('null')),
    addText: (t: string) => this.add_(new Layer('text:' + t)),
    addBoxText: (_s: any, t: string) => this.add_(new Layer('text:' + t)),
    addSolid: () => this.add_(new Layer('solid')),
    add: (src: any) => this.add_(new Layer('item', src)),
  };
  openInViewer() { this.opened = true; }
}

function run(script: string) {
  const comps: Comp[] = [];
  const app = {
    project: {
      items: { addComp: (n: string, w: number, h: number, _pa: number, d: number, f: number) => { const c = new Comp(n, w, h, d, f); comps.push(c); return c; } },
      importFile: () => ({}),
    },
    beginUndoGroup() {}, endUndoGroup() {},
  };
  const errors: string[] = [];
  const g = {
    app, Shape: class {}, KeyframeEase: class { constructor(public speed: number, public influence: number) {} },
    KeyframeInterpolationType: { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 },
    PropertyValueType: { OneD: 1, TwoD: 2, ThreeD: 3, TwoD_SPATIAL: 6, ThreeD_SPATIAL: 7 },
    ParagraphJustification: { LEFT_JUSTIFY: 1, RIGHT_JUSTIFY: 2, CENTER_JUSTIFY: 3 },
    ImportOptions: class {}, File: class {}, Folder: { temp: { fsName: '/tmp' } },
    alert: (m: string) => errors.push(m),
  };
  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(g), script)(...Object.values(g));
  return { comps, errors };
}

describe('after effects script export', () => {
  it('builds layers, parenting, keyframes and eases', () => {
    const p = createProject('Test');
    const comp = p.comps[p.activeComp];
    const grp = createLayer('group', { x: 100, y: 100, w: 200, h: 200, name: 'G' });
    const r = createLayer('rect', { x: 10, y: 20, w: 50, h: 40, color: [1, 0, 0, 1], name: 'Box' });
    r.parent = grp.id; grp.children.push(r.id);
    r.props.position = { v: [10, 20], kf: [
      { t: 0, v: [10, 20], interp: 'bezier', out: [0.33, 0], in: [0.67, 1] },
      { t: 1, v: [110, 20], interp: 'hold', out: [0.33, 0], in: [0.67, 1] },
      { t: 2, v: [0, 0], interp: 'linear', out: [0, 0], in: [1, 1] },
    ] };
    r.props.rotation = { v: [0], expr: 'time * 90' };
    const t = createLayer('text', { x: 0, y: 0, w: 300, h: 50, name: 'Title', text: { content: 'Hello', fontFamily: 'Inter', fontSize: 40, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, align: 'center' } });
    for (const l of [grp, r, t]) p.layers[l.id] = l;
    comp.root.push(grp.id, t.id);
    const src = projectToAeScript(p);
    // es3: no arrow functions / let / const in the runtime part
    const runtime = src.slice(src.indexOf('var fr'));
    expect(runtime).not.toMatch(/=>|\blet\s|\bconst\s|`/);
    const { comps, errors } = run(src);
    expect(errors).toEqual([]);
    expect(comps).toHaveLength(1);
    const c = comps[0];
    expect(c.opened).toBe(true);
    expect(c.fps).toBe(comp.fps);
    const names = c.list.map(l => l.name);
    expect(names).toContain('Box');
    expect(names).toContain('Title');
    const box = c.list.find(l => l.name === 'Box')!;
    const g = c.list.find(l => l.name === 'G')!;
    expect(box.parent).toBe(g);
    const pos = box.property('ADBE Transform Group').property('ADBE Position') as Prop;
    expect(pos.keys.map(k => k.t)).toEqual([0, 1, 2]);
    expect(pos.keys[0].v).toEqual([10, 20]);
    // out ease of key 1: influence 33, speed 0 (handle y = 0)
    expect(pos.keys[0].outE[0].influence).toBeCloseTo(33, 0);
    expect(pos.keys[0].outE[0].speed).toBeCloseTo(0, 5);
    // key 2 holds
    expect(pos.keys[1].tout).toBe(6614);
    const rot = box.property('ADBE Transform Group').property('ADBE Rotate Z') as Prop;
    expect(rot.expression).toBe('time * 90');
    const scale = box.property('ADBE Transform Group').property('ADBE Scale') as Prop;
    expect(scale.value).toEqual([100, 100, 100]);
    // shape contents: a group with a rect, fill
    const root = box.property('ADBE Root Vectors Group') as Group;
    const gr = root.children[0] as Group;
    const vecs = gr.property('ADBE Vectors Group') as Group;
    expect(vecs.children.map(x => (x as any).matchName ?? (x as any).name)).toEqual(['ADBE Vector Shape - Rect', 'ADBE Vector Graphic - Fill']);
    // background solid is added
    expect(c.list.some(l => l.kind === 'solid')).toBe(true);
  });
});

// optional: AE_SCRIPT_FILE=/path/to/script.jsx npx vitest run tests/aejsx.test.ts
const extra = typeof process !== 'undefined' ? process.env.AE_SCRIPT_FILE : undefined;
if (extra) {
  it('runs an exported script file without errors', async () => {
    const fs = await import('node:fs');
    const { comps, errors } = run(fs.readFileSync(extra, 'utf8'));
    expect(errors).toEqual([]);
    console.log(comps.map(c => `${c.name}: ${c.list.length} layers`).join('\n'));
  });
}
