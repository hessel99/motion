// inspector + library pieces for motion components (core/motion-components.ts):
// - InstancePanel: a selected instance's properties (text, colors, image, numbers, toggles), its
//   variants (one picker per group: Format, Theme...) and its timing (start, part, speed or length,
//   loop, reverse, hold).
// - ComponentPanel: the component being edited (nothing selected): its properties, variants (show
//   one to edit its layout) and named ranges.
// - ExposeSection: the selected layer inside a component: make its text / color / ... a property.
// - MotionComponentRows + LibraryReview: the Assets panel list, publishing and updating a library.

import { useState } from 'preact/hooks';
import { editor } from '../app/editor';
import { download, toast } from '../app/actions';
import {
  addFormatVariants, addMotionInstance, addVariant, componentComps, componentOfLayer, defaultValue, editVariant,
  effectivePlay, exposableFields, exposeProperty, FORMATS, guessRanges, instanceComp, instanceSpan, motionInstancesOf, playRange,
  removeProperty, removeVariant, setInstanceProps, setInstanceVariant, setPlay, setRanges, swapComponent, updateProperty, markComponent,
} from '../core/motion-components';
import { applyLibrary, exportLibrary, parseLibrary, planLibrary, summarizeLibrary, type LibraryChange, type LibraryFile } from '../core/component-library';
import type { Composition, ExposedProp, ExposedValue, Layer, PlaySpec } from '../core/model';
import { toHex, parseColorValue } from '../core/token-sync';
import { showContextMenu, type MenuItem } from './menu';
import { useChannels } from './hooks';
import { Button, ColorSwatch, Dialog, FieldRow, NumField, Section, Segmented, Toggle } from './ui';
import { ArrowUpRight, Clock, Component, Diamond, Eye, Gauge, Plus, RotateCcw, X } from './chrome/icons';

const st = () => editor.store;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const sec = (t: number) => `${Math.round(t * 100) / 100}s`;

// ======================================================================================
// instance
// ======================================================================================

export function InstancePanel({ layer }: { layer: Layer }) {
  const s = st();
  const P = s.project;
  const comp = instanceComp(P, layer)!;
  const def = comp.component!;
  const ids = [layer.id];
  const swap = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = componentComps(P).filter(c => c.id !== comp.id).map(c => ({ label: c.name, action: () => { try { swapComponent(s, ids, c.id); } catch (err: any) { toast(err.message, 'error'); } } }));
    showContextMenu(r.left, r.bottom + 4, items.length ? items : [{ label: 'No other components yet', disabled: true }]);
  };
  return (
    <>
      <Section class="comp-box" title={<><span class="comp-icon" aria-hidden="true"><Diamond size={13} /></span> {comp.name}</>}
        right={<>
          <Button variant="ghost" size="sm" tip="Show another component here (values carry over by name)" onClick={swap}>Swap</Button>
          <Button variant="ghost" size="sm" tip="Edit the component (every instance follows)" onClick={() => s.openComp(comp.id)}>Edit <ArrowUpRight size={14} /></Button>
        </>}>
        {!(def.props ?? []).length && <p class="muted small">No properties yet. Edit the component and expose a text, a color or an image to change it per instance.</p>}
        {(def.props ?? []).map(p => <PropField key={p.id} layer={layer} prop={p} />)}
      </Section>
      {(def.variants ?? []).length > 0 && <VariantPickers layer={layer} comp={comp} />}
      <TimingSection layer={layer} comp={comp} />
    </>
  );
}

function PropField({ layer, prop }: { layer: Layer; prop: ExposedProp }) {
  const s = st();
  const own = layer.inst?.props?.[prop.id];
  const v: ExposedValue = own ?? defaultValue(s.project, prop);
  const set = (x: ExposedValue | null, mk?: string) => { try { setInstanceProps(s, [layer.id], { [prop.id]: x }, mk); } catch (e: any) { toast(e.message, 'error'); } };
  const reset = own !== undefined && (
    <button type="button" class="ghost icon prop-reset" aria-label={`Reset ${prop.name}`} data-tooltip="Back to the component's value" onClick={() => set(null)}><RotateCcw size={12} /></button>
  );
  let field;
  switch (prop.kind) {
    case 'text':
      field = <input class="grow name-input" aria-label={prop.name} value={String(v)} spellcheck={false}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        onInput={e => set((e.target as HTMLInputElement).value, 'prop:' + prop.id + layer.id)} />;
      break;
    case 'color': {
      const c = Array.isArray(v) ? v : [1, 1, 1, 1];
      field = <><ColorSwatch value={toHex(c).slice(0, 7)} alpha={c[3]} label={prop.name} onInput={hex => { const n = parseColorValue(hex); if (n) set([n[0], n[1], n[2], c[3] ?? 1], 'prop:' + prop.id + layer.id); }} /><span class="muted small mono">{toHex(c).slice(0, 7)}</span></>;
      break;
    }
    case 'number':
      field = <NumField label="#" title={prop.name} value={Number(v)} min={prop.min} max={prop.max} step={prop.step ?? (prop.targets[0]?.field === 'delay' ? 0.05 : 1)} suffix={prop.targets[0]?.field === 'delay' ? 's' : undefined} onChange={(n, mk) => set(n, mk)} />;
      break;
    case 'toggle':
      field = <Toggle checked={!!v} label={<span class="sr-only">{prop.name}</span>} onChange={on => set(on)} />;
      break;
    case 'image': {
      const imgs = Object.values(s.project.assets).filter(a => a.kind === 'image');
      field = (
        <select class="grow" aria-label={prop.name} value={String(v)} onChange={e => set((e.target as HTMLSelectElement).value)}>
          {imgs.map((a, i) => <option value={a.id}>Image {i + 1}{a.width ? ` · ${a.width}×${a.height}` : ''}</option>)}
        </select>
      );
      break;
    }
  }
  return <FieldRow label={prop.name} class={own !== undefined ? 'prop-own' : undefined} trail={reset || <span class="prop-reset-slot" />}>{field}</FieldRow>;
}

function VariantPickers({ layer, comp }: { layer: Layer; comp: Composition }) {
  const s = st();
  const def = comp.component!;
  const groups = [...new Set((def.variants ?? []).map(v => v.group))];
  return (
    <Section title="Variant">
      {groups.map(g => {
        const vs = def.variants!.filter(v => v.group === g);
        const cur = layer.inst?.variants?.[g] ?? '';
        const opts = [{ value: '', label: g === 'Format' ? `${comp.width}×${comp.height}` : 'Base' }, ...vs.map(v => ({ value: v.id, label: v.name }))];
        return (
          <FieldRow label={g}>
            {opts.length <= 4
              ? <Segmented size="sm" value={cur} options={opts} label={g} onChange={id => setInstanceVariant(s, [layer.id], g, id || null)} />
              : <select class="grow" aria-label={g} value={cur} onChange={e => setInstanceVariant(s, [layer.id], g, (e.target as HTMLSelectElement).value || null)}>{opts.map(o => <option value={o.value}>{o.label}</option>)}</select>}
          </FieldRow>
        );
      })}
    </Section>
  );
}

function TimingSection({ layer, comp }: { layer: Layer; comp: Composition }) {
  const s = st();
  const ids = [layer.id];
  const own = layer.play ?? {};
  const play = effectivePlay(s.project, layer) ?? {};
  const fps = s.comp.fps;
  const ranges = comp.component?.ranges ?? [];
  const [a, b] = playRange(comp, play);
  const span = instanceSpan(comp, play);
  const set = (patch: Partial<Record<keyof PlaySpec, unknown>>, mk?: string) => setPlay(s, ids, patch, mk);
  const part = own.range ?? (own.from !== undefined || own.to !== undefined ? 'custom' : '');
  return (
    <Section title="Timing" right={<span class="insp-type" title="How long this instance shows">{Number.isFinite(span) ? sec(span) : 'until out'}</span>}>
      <FieldRow label="Start">
        <NumField label="At" title="When the instance starts (seconds)" step={1 / fps} value={layer.startTime ?? 0} suffix="s"
          onChange={(n, mk) => s.transact('Instance start', tx => { tx.set(layer, 'startTime', n); tx.touch(layer.id); tx.recompile(); }, mk)} />
      </FieldRow>
      <FieldRow label="Plays">
        <select class="grow" aria-label="Part of the component" value={part} onChange={e => { const v = (e.target as HTMLSelectElement).value; if (v === 'custom') set({ from: a, to: b, range: null }); else set({ range: v || null, from: null, to: null }); }}>
          <option value="">Whole ({sec(comp.duration)})</option>
          {ranges.map(r => <option value={r.name}>{r.name} ({sec(r.from)}–{sec(r.to)})</option>)}
          <option value="custom">From … to …</option>
        </select>
      </FieldRow>
      {part === 'custom' && (
        <FieldRow label="">
          <NumField label="A" title="Starts at (seconds)" step={1 / fps} min={0} max={comp.duration} value={a} suffix="s" onChange={(n, mk) => set({ from: n }, mk)} />
          <NumField label="B" title="Ends at (seconds)" step={1 / fps} min={0} max={comp.duration} value={b} suffix="s" onChange={(n, mk) => set({ to: n }, mk)} />
        </FieldRow>
      )}
      <FieldRow label="Speed" title="Speed, or stretch the part to a length">
        <NumField label={<Gauge size={13} />} title="Speed (1 = as animated)" hint="×" step={0.05} min={0.05} value={own.duration ? (b - a) / own.duration : own.speed ?? 1} onChange={(n, mk) => set({ speed: Math.round(n * 1000) / 1000, duration: null }, mk)} />
        <NumField label={<Clock size={13} />} title="Stretch to this length (seconds)" step={1 / fps} min={0.05} value={own.duration ?? (b - a) / (own.speed ?? 1)} suffix="s" onChange={(n, mk) => set({ duration: n, speed: null }, mk)} />
      </FieldRow>
      <FieldRow label="Loop">
        <Segmented size="sm" value={own.loop ?? 'none'} label="Loop" options={[{ value: 'none', label: 'Once' }, { value: 'loop', label: 'Loop' }, { value: 'pingpong', label: 'Ping-pong' }]} onChange={v => set({ loop: v })} />
      </FieldRow>
      <FieldRow label="Hold" title="Show the first frame before it starts and / or the last frame after it ends">
        <Segmented size="sm" value={own.hold ?? 'none'} label="Hold" options={[{ value: 'none', label: 'No' }, { value: 'first', label: 'First' }, { value: 'last', label: 'Last' }, { value: 'both', label: 'Both' }]} onChange={v => set({ hold: v })} />
      </FieldRow>
      <FieldRow label="Reverse">
        <Toggle checked={!!own.reverse} label={<span class="sr-only">Play backwards</span>} onChange={on => set({ reverse: on || null })} />
      </FieldRow>
    </Section>
  );
}

// ======================================================================================
// component (editing it)
// ======================================================================================

/** nothing selected in a component's composition: its properties, variants and ranges */
export function ComponentPanel({ comp }: { comp: Composition }) {
  const s = st();
  const def = comp.component!;
  const n = motionInstancesOf(s.project, comp.id).length;
  return (
    <>
      <Section class="comp-box main" title={<><span class="comp-icon" aria-hidden="true"><Component size={14} /></span> Component</>} right={<span class="insp-type">{plural(n, 'instance')}</span>}>
        <p class="muted small">Animate it here once: every instance follows. Instances change it only through its properties{def.lib ? <> · from <b>{def.lib.name}</b></> : null}.</p>
        {!(def.props ?? []).length && <p class="muted small">Select a layer to expose its text, color, image or a number as a property.</p>}
        {(def.props ?? []).map(p => (
          <FieldRow label={<span class="prop-kind">{p.kind}</span>} trail={<button type="button" class="ghost icon" aria-label={`Remove ${p.name}`} data-tooltip="Remove property" onClick={() => removeProperty(s, comp.id, p.id)}><X size={12} /></button>}>
            <input class="grow name-input" aria-label="Property name" value={p.name} spellcheck={false}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              onChange={e => { const v = (e.target as HTMLInputElement).value.trim(); if (v && v !== p.name) updateProperty(s, comp.id, p.id, { name: v }); }} />
            <span class="muted small prop-targets">{p.targets.map(t => s.project.layers[t.layer]?.name ?? '?').join(', ')}</span>
          </FieldRow>
        ))}
      </Section>
      <VariantsSection comp={comp} />
      <RangesSection comp={comp} />
    </>
  );
}

function VariantsSection({ comp }: { comp: Composition }) {
  const s = st();
  const def = comp.component!;
  const editing = def.editing?.variant ?? null;
  const add = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const has = (n: string) => (def.variants ?? []).some(v => v.name === n);
    const ar = comp.width / comp.height;
    const items: MenuItem[] = [
      ...FORMATS.filter(f => Math.abs(f.w / f.h - ar) > 0.01).map(f => ({ label: `Format ${f.name}`, disabled: has(f.name), action: () => addVariant(s, comp.id, { name: f.name }) })),
      { label: 'All social formats', action: () => addFormatVariants(s, comp.id) },
      { separator: true },
      { label: 'Theme…', action: () => { const n = prompt('Theme name (e.g. Dark)', 'Dark'); if (n) addVariant(s, comp.id, { name: n, group: 'Theme' }); } },
      { label: 'Language…', action: () => { const n = prompt('Language (e.g. DE)', 'DE'); if (n) addVariant(s, comp.id, { name: n, group: 'Language' }); } },
      { label: 'Short cut (plays faster)', action: () => addVariant(s, comp.id, { name: 'Short', group: 'Cut', play: { speed: 1.5 } }) },
      { label: 'Other…', action: () => { const g = prompt('Group (e.g. Size)', 'Style'); const n = g && prompt('Variant name'); if (g && n) addVariant(s, comp.id, { name: n, group: g }); } },
    ];
    showContextMenu(r.left, r.bottom + 4, items);
  };
  const vs = def.variants ?? [];
  return (
    <Section title="Variants" onAdd={add as any} addLabel="Add a variant (format, theme, language, cut)">
      {vs.length > 0 && (
        <div class={'list-row variant-row' + (editing === null ? ' on' : '')} role="button" tabIndex={0} onClick={() => editVariant(s, comp.id, null)} title="Edit the base">
          <span class="variant-group">Base</span><span class="list-name">{editing ? def.editing!.size.join('×') : `${comp.width}×${comp.height}`}</span>
        </div>
      )}
      {vs.map(v => (
        <div class={'list-row variant-row' + (editing === v.id ? ' on' : '')} role="button" tabIndex={0} title={`Show ${v.name} here: layout, color and text edits belong to it; timing edits reach every variant`}
          onClick={() => editVariant(s, comp.id, editing === v.id ? null : v.id)}>
          <span class="variant-group">{v.group}</span>
          <span class="list-name">{v.name}{v.width ? <span class="muted"> · {v.width}×{v.height}</span> : null}{v.play ? <span class="muted"> · timing</span> : null}</span>
          {editing === v.id && <Eye size={13} class="muted" aria-label="shown" />}
          <span class="list-count">{Object.keys(v.ov).length || ''}</span>
          <button type="button" class="ghost icon" aria-label={`Remove ${v.name}`} data-tooltip="Remove variant" onClick={e => { e.stopPropagation(); removeVariant(s, comp.id, v.id); }}><X size={12} /></button>
        </div>
      ))}
      {!vs.length && <p class="muted small">Formats (9:16, 1:1, 4:5), themes or languages over the same animation.</p>}
      {editing && <p class="muted small variant-note">Showing <b>{vs.find(v => v.id === editing)?.name}</b>: moves, sizes, colors and text edits belong to it. Click Base when done.</p>}
    </Section>
  );
}

function RangesSection({ comp }: { comp: Composition }) {
  const s = st();
  const ranges = comp.component?.ranges ?? [];
  const fps = comp.fps;
  const put = (i: number, patch: Partial<{ name: string; from: number; to: number }>) => setRanges(s, comp.id, ranges.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRange = () => {
    if (!ranges.length) { const g = guessRanges(s.project, comp); if (g.length) { setRanges(s, comp.id, g); return; } }
    const t = s.time;
    setRanges(s, comp.id, [...ranges, { name: `part ${ranges.length + 1}`, from: Math.min(t, comp.duration - 0.1), to: comp.duration }]);
  };
  return (
    <Section title="Parts" onAdd={addRange} addLabel={ranges.length ? 'Add a part from the playhead' : 'Find in / hold / out'}>
      {ranges.map((r, i) => (
        <FieldRow label={<input class="range-name" aria-label="Part name" value={r.name} spellcheck={false} onKeyDown={e => e.stopPropagation()} onChange={e => put(i, { name: (e.target as HTMLInputElement).value })} />}
          trail={<button type="button" class="ghost icon" aria-label={`Remove ${r.name}`} onClick={() => setRanges(s, comp.id, ranges.filter((_, j) => j !== i))}><X size={12} /></button>}>
          <NumField label="A" title="Starts at (seconds)" step={1 / fps} min={0} max={comp.duration} value={r.from} suffix="s" onChange={n => put(i, { from: n })} />
          <NumField label="B" title="Ends at (seconds)" step={1 / fps} min={0} max={comp.duration} value={r.to} suffix="s" onChange={n => put(i, { to: n })} />
        </FieldRow>
      ))}
      {!ranges.length && <p class="muted small">Name parts of the timeline (in, hold, out) so instances can play just one of them.</p>}
    </Section>
  );
}

/** the selected layer is inside a component: offer its fields as properties */
export function ExposeSection({ layer }: { layer: Layer }) {
  const s = st();
  const comp = componentOfLayer(s.project, layer.id);
  if (!comp || comp.id !== s.comp.id) return null;
  const def = comp.component!;
  const used = (field: string) => (def.props ?? []).find(p => p.targets.some(t => t.layer === layer.id && t.field === field));
  const fields = exposableFields(s.project, layer);
  const expose = (f: (typeof fields)[number]) => {
    const name = prompt('Property name', f.field === 'text' ? (layer.name || 'Text') : f.field.startsWith('prop:') ? f.label.split(' · ')[1] : `${layer.name} ${f.label.toLowerCase()}`);
    if (!name) return;
    try { exposeProperty(s, comp.id, { name, kind: f.kind, targets: [{ layer: layer.id, field: f.field }] }); toast(`${name} is a property of ${comp.name}`); } catch (e: any) { toast(e.message, 'error'); }
  };
  return (
    <Section title="Expose as property">
      <div class="row expose-row">
        {fields.map(f => {
          const p = used(f.field);
          return p
            ? <span class="ov-chip on" title={`Property ${p.name}`}>{f.label}: {p.name}</span>
            : <button type="button" class="ov-chip" onClick={() => expose(f)} title={`Let each instance set ${f.label.toLowerCase()}`}><Plus size={11} aria-hidden="true" /> {f.label}</button>;
        })}
      </div>
    </Section>
  );
}

// ======================================================================================
// assets panel: component list + library
// ======================================================================================

export function MotionComponentRows() {
  const s = st();
  const P = s.project;
  const comps = componentComps(P);
  const instanceCount = (id: string) => motionInstancesOf(P, id).length;
  return (
    <>
      {comps.map(c => {
        const n = instanceCount(c.id), d = c.component!;
        return (
          <div class="lib-row comp" title={`${c.name}: ${c.width}×${c.height}, ${sec(c.duration)}\nDouble-click to edit`} onDblClick={() => s.openComp(c.id)}
            onContextMenu={e => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, [
              { label: `Add to ${s.comp.name}`, disabled: c.id === s.comp.id, action: () => add(c.id) },
              { label: 'Edit component', action: () => s.openComp(c.id) },
              { label: `Select instances (${n})`, disabled: !n, action: () => { const here = new Set(s.drawOrder()); s.select(motionInstancesOf(P, c.id).map(l => l.id).filter(x => here.has(x))); } },
              { separator: true },
              { label: 'Stop being a component', action: () => markComponent(s, c.id, false) },
            ]); }}>
            <span class="lib-comp-icon" aria-hidden="true"><Component size={14} /></span>
            <span class="lib-name">{c.name}<span class="muted small"> · {sec(c.duration)}{(d.props ?? []).length ? ` · ${plural(d.props!.length, 'property').replace('propertys', 'properties')}` : ''}{(d.variants ?? []).length ? ` · ${plural(d.variants!.length, 'variant')}` : ''}{d.lib ? ` · ${d.lib.name}` : ''}</span></span>
            <span class="lib-count" title={plural(n, 'instance')}>{n || ''}</span>
            <Button variant="ghost" size="sm" disabled={c.id === s.comp.id} tip={`Add an instance to ${s.comp.name}`} onClick={() => add(c.id)}>Add</Button>
          </div>
        );
      })}
      <div class="row lib-actions">
        <Button size="sm" variant="ghost" disabled={!comps.length} onClick={publishLibrary} tip="Save the components as a library file other projects can use and update from">Publish library…</Button>
        <Button size="sm" variant="ghost" onClick={pickLibrary} tip="Add components from a library file, or update the ones you have">Use library…</Button>
      </div>
    </>
  );
}

function add(id: string) {
  const s = st();
  try { addMotionInstance(s, id, { start: s.time }); } catch (e: any) { toast(e.message, 'error'); }
}

function publishLibrary() {
  const s = st();
  const name = prompt('Library name', s.project.name || 'Brand kit');
  if (!name) return;
  const lib = exportLibrary(s.project, { name });
  download(`${name}.motionlib.json`, JSON.stringify(lib), 'application/json');
  toast(`Published ${plural(lib.components.length, 'component')} as ${name}`);
}

/** the library waiting for review */
let pending: { lib: LibraryFile; plan: LibraryChange[] } | null = null;
function reviewLibrary(p: typeof pending) { pending = p; editor.emit('library'); }

/** pick a library file and show what it would add / update */
export function pickLibrary() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (f) openLibraryText(await f.text());
  };
  inp.click();
}

export function openLibraryText(text: string) {
  try {
    const lib = parseLibrary(text);
    const plan = planLibrary(st().project, lib);
    if (!plan.some(c => c.status === 'new' || c.status === 'changed')) { toast(`${lib.name}: ${summarizeLibrary(plan)}`); return; }
    reviewLibrary({ lib, plan });
  } catch (e: any) { toast(e.message, 'error'); }
}

/** "Title card: new property Accent · 6 instances": review before anything changes */
export function LibraryReview() {
  useChannels([], ['library']);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  if (!pending) return null;
  const { lib, plan } = pending;
  const list = plan.filter(c => c.status !== 'same');
  const apply = () => {
    const keys = list.filter(c => (c.status === 'new' || c.status === 'changed') && !skip.has(c.key)).map(c => c.key);
    const r = applyLibrary(st(), lib, plan, keys);
    reviewLibrary(null);
    toast(`${lib.name}: ${r.updated ? `${r.updated} updated` : ''}${r.updated && r.added ? ', ' : ''}${r.added ? `${r.added} added` : ''}`);
  };
  return (
    <Dialog title={`Components from ${lib.name}`} onClose={() => reviewLibrary(null)} width={480} class="sync-review lib-review"
      actions={<><Button onClick={() => reviewLibrary(null)}>Not now</Button><Button variant="primary" autofocus onClick={apply}>Update</Button></>}>
      <p class="sync-summary">{summarizeLibrary(plan)}</p>
      <ul class="sync-list">
        {list.map(c => (
          <li>
            <span class={'sync-tag ' + (c.status === 'new' ? 'added' : c.status)}>{c.status === 'new' ? 'new' : c.status}</span>
            <span class="lib-name">{c.name}<span class="muted small"> · {c.notes.join(', ') || 'new component'}{c.editedHere ? ' · edited here: updating replaces those edits' : ''}</span></span>
            <span class="muted small">{c.instances ? plural(c.instances, 'instance') : ''}</span>
            {(c.status === 'new' || c.status === 'changed') && <input type="checkbox" class="checkbox" aria-label={`Include ${c.name}`} checked={!skip.has(c.key)} onChange={e => { const n = new Set(skip); if ((e.target as HTMLInputElement).checked) n.delete(c.key); else n.add(c.key); setSkip(n); }} />}
          </li>
        ))}
      </ul>
      <p class="muted small">Instances keep their own text, colors and timing. You can undo this in one step.</p>
    </Dialog>
  );
}

