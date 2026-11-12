// inspector pieces for linked styles and components, in plain words:
// "Linked to Brand / Primary" with one-click detach, a small link button that lists matching styles,
// and the component box ("Instance of Button": go to main, reset changes, detach, delay).

import { editor } from '../app/editor';
import { toast } from '../app/actions';
import { canBind, linkOf, linkProp, prettyName, tokenValue, addToken } from '../core/tokens';
import { toHex } from '../core/token-sync';
import { valueAt } from '../core/commands';
import { createInstance, detachInstance, FIELD_LABELS, instanceRootOf, instancesOf, isMain, overridesOf, removeComponent, resetOverrides, setInstanceDelay } from '../core/components';
import { PROP_DEFS, type Layer, type PropKey } from '../core/model';
import { promoteToMotionComponent } from '../core/figma-components';
import { showContextMenu, type MenuItem } from './menu';
import { NumField, Section, Button } from './ui';
import { Component, Diamond, RotateCcw, SwatchBook, Unlink } from './chrome/icons';

const st = () => editor.store;
const css = (c: number[]) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3] ?? 1})`;

/** the style all given layers share on `key` at the playhead (undefined if none or mixed) */
export function sharedLink(layers: Layer[], key: PropKey): string | undefined {
  const t = st().time;
  const first = linkOf(layers[0], key, t);
  return first && layers.every(l => linkOf(l, key, t) === first) ? first : undefined;
}

/** "Linked to Brand / Primary" + detach, shown instead of the raw value when a property is linked */
export function LinkedChip({ layers, prop }: { layers: Layer[]; prop: PropKey }) {
  const s = st();
  const id = sharedLink(layers, prop)!;
  const t = s.project.tokens?.items[id];
  if (!t) return null;
  const v = tokenValue(s.project.tokens!, t);
  const animated = layers.some(l => l.props[prop]?.kf?.length);
  return (
    <div class={'linked-chip' + (t.missing ? ' missing' : '')} title={`${PROP_DEFS[prop].label} is linked to ${prettyName(t.name)}${animated ? ' (this keyframe)' : ''}: when the style changes, this changes too.${t.missing ? '\nThis style was removed from its library.' : ''}`}>
      {t.type === 'color' ? <span class="chip" style={{ background: css(v) }} /> : <span class="lib-num">{Math.round(v[0] * 100) / 100}</span>}
      <button type="button" class="linked-name" onClick={e => pickStyle(e, layers, prop)} title="Change the linked style">
        <span class="muted">Linked to</span> {prettyName(t.name)}
      </button>
      <button type="button" class="linked-detach" aria-label={`Detach ${PROP_DEFS[prop].label} from ${prettyName(t.name)}`} data-tooltip="Detach (keep the current value)"
        onClick={() => linkProp(s, layers.map(l => l.id), prop, null)}>
        <Unlink size={14} />
      </button>
    </div>
  );
}

/** small "link to a style" button next to a value */
export function LinkButton({ layers, prop }: { layers: Layer[]; prop: PropKey }) {
  return (
    <button type="button" class="link-btn" tabIndex={-1} data-tooltip={PROP_DEFS[prop].unit === 'color' ? 'Use a color style' : 'Use a named number'} aria-label={`Link ${PROP_DEFS[prop].label} to a style`}
      onClick={e => pickStyle(e, layers, prop)}>
      <SwatchBook size={14} />
    </button>
  );
}

function pickStyle(e: MouseEvent, layers: Layer[], prop: PropKey) {
  const s = st();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const lib = s.project.tokens;
  const list = Object.values(lib?.items ?? {}).filter(t => canBind(prop, t)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const ids = layers.map(l => l.id);
  const items: MenuItem[] = [];
  // grouped like the palette: "Brand" ▸ Primary, Accent
  const groups = new Map<string, typeof list>();
  for (const t of list) { const g = t.name.includes('/') ? t.name.slice(0, t.name.lastIndexOf('/')) : ''; let a = groups.get(g); if (!a) groups.set(g, (a = [])); a.push(t); }
  const row = (t: (typeof list)[number], short: boolean) => {
    const v = tokenValue(lib!, t);
    const label = `${short ? t.name.slice(t.name.lastIndexOf('/') + 1) : prettyName(t.name)}   ${t.type === 'color' ? toHex(v) : Math.round(v[0] * 100) / 100}`;
    return { label, action: () => { try { linkProp(s, ids, prop, t.id); } catch (err: any) { toast(err.message, 'error'); } } };
  };
  if (groups.size > 1 && list.length > 8) for (const [g, ts] of groups) items.push(g ? { label: prettyName(g), submenu: ts.map(t => row(t, true)) } : row(ts[0], false));
  else for (const t of list) items.push(row(t, false));
  if (items.length) items.push({ separator: true });
  items.push({
    label: PROP_DEFS[prop].unit === 'color' ? 'Save this color as a style…' : 'Save this number…',
    action: () => {
      const v = valueAt(layers[0], prop, s.time);
      const name = prompt('Name (use / to group, e.g. "Brand / Primary")', PROP_DEFS[prop].unit === 'color' ? 'Colors / ' + layers[0].name : `${PROP_DEFS[prop].label} / ${Math.round(v[0])}`);
      if (!name) return;
      const t = addToken(s, { name: name.replace(/\s*\/\s*/g, '/'), type: PROP_DEFS[prop].unit === 'color' ? 'color' : 'number', value: PROP_DEFS[prop].unit === 'color' ? v : [v[0]] });
      linkProp(s, ids, prop, t.id);
    },
  });
  if (!list.length) items.unshift({ label: 'No matching styles yet', disabled: true }, { separator: true });
  showContextMenu(r.left, r.bottom + 4, items);
}

/** link controls for a value row: the chip when linked, else a link button */
export function LinkSlot({ layers, prop }: { layers: Layer[]; prop: PropKey }) {
  return sharedLink(layers, prop) ? <LinkedChip layers={layers} prop={prop} /> : <LinkButton layers={layers} prop={prop} />;
}

// ---------------- components ----------------
export function ComponentBox({ layer }: { layer: Layer }) {
  const s = st();
  const P = s.project;
  if (isMain(P, layer.id)) {
    const c = P.components![layer.id];
    const n = instancesOf(P, layer.id).length;
    return (
      <Section class="comp-box main" title={<><span class="comp-icon" aria-hidden="true"><Component size={14} /></span> Main component</>} right={<span class="insp-type">{n === 1 ? '1 instance' : `${n} instances`}</span>}>
        <p class="muted small">Changes and animation here show up in every instance of <b>{c.name}</b>.</p>
        <div class="row">
          <Button size="sm" onClick={() => createInstance(s, layer.id)}>Add instance</Button>
          <Button size="sm" variant="ghost" onClick={() => { const here = new Set(s.drawOrder()); const ids = instancesOf(P, layer.id).filter(x => here.has(x)); if (ids.length) s.select(ids); else toast('No instances in this composition'); }} disabled={!n}>Select instances</Button>
          <Button size="sm" variant="ghost" onClick={() => removeComponent(s, layer.id)} tip="Instances become plain layers">Unmake</Button>
          <Button size="sm" variant="ghost" onClick={() => { try { const c = promoteToMotionComponent(s, layer.id); toast(`${c.name} is an animated component${c.component?.props?.length ? ` with ${c.component.props.length} properties` : ''}${c.component?.variants?.length ? ` and ${c.component.variants.length} variants` : ''}`); } catch (e: any) { toast(e.message, 'error'); } }}
            tip="Own timeline, properties (from Figma's) and variants (from its component set); instances keep their values">Make animated</Button>
        </div>
      </Section>
    );
  }
  const rootId = instanceRootOf(P, layer.id);
  const mainRoot = rootId ? P.layers[rootId]?.link?.main : undefined;
  if (rootId && mainRoot && P.components?.[mainRoot]) {
    const root = P.layers[rootId];
    const c = P.components[mainRoot];
    const ov = overridesOf(layer);
    let total = 0;
    const walk = (id: string) => { const l = P.layers[id]; if (!l) return; total += overridesOf(l).length; l.children.forEach(walk); };
    walk(rootId);
    const goMain = () => {
      const target = layer.link?.main ?? mainRoot;
      const comp = Object.values(P.comps).find(cp => { let cur: string | null = target; while (cur) { const l: Layer | undefined = P.layers[cur]; if (!l?.parent) return cp.root.includes(cur); cur = l.parent; } return false; });
      if (comp) s.openComp(comp.id);
      s.select([target]);
    };
    const label = (f: string) => (PROP_DEFS as any)[f]?.label?.toLowerCase() ?? FIELD_LABELS[f] ?? f;
    return (
      <Section class="comp-box" title={<><span class="comp-icon" aria-hidden="true"><Diamond size={13} /></span> Instance of {c.name}</>} right={<button class="ghost" onClick={goMain} title="Select the main component (switches composition if needed)">Go to main</button>}>
        {rootId === layer.id && (
          <div class="row">
            <NumField label="Delay" title="Start this instance's animation later (seconds)" step={1 / s.comp.fps} value={root.link?.dt ?? 0} suffix="s" onChange={(n, mk) => setInstanceDelay(s, rootId, n, mk)} />
          </div>
        )}
        {ov.length > 0 && (
          <div class="ov-list">
            <span class="muted small">Changed here:</span>
            {ov.map(f => <button type="button" class="ov-chip" title={`Reset ${label(f)} to the main component's`} onClick={() => resetOverrides(s, layer.id, f)}>{label(f)} <RotateCcw size={11} aria-hidden="true" /></button>)}
          </div>
        )}
        <div class="row">
          <Button size="sm" variant="ghost" disabled={!total} onClick={() => resetOverrides(s, rootId)} tip="Undo every change made on this instance">Reset all changes{total ? ` (${total})` : ''}</Button>
          <Button size="sm" variant="ghost" onClick={() => detachInstance(s, rootId)} tip="Turn into plain layers (stops following the main)">Detach</Button>
        </div>
      </Section>
    );
  }
  return null;
}
