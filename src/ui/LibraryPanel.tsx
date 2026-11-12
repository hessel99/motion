// "Library" tab: the project's colors / numbers (linked styles) and components, in plain words.
// colors are grouped like a palette by their name path ("Brand / Primary"), each shows how many
// layers use it; click a row to select those layers, drag a swatch onto a layer to link it.

import { useState } from 'preact/hooks';
import { editor } from '../app/editor';
import { toast } from '../app/actions';
import { confirmSync, exportTokens, importTokensFile, pendingSync, reviewSync, syncFromFigmaApi, syncFromUrl, syncSource } from '../app/library';
import { addToken, deleteToken, layersUsing, linkProp, prettyName, renameToken, setTokenMode, setTokenValue, splitName, tokenUsage, tokenValue, canBind } from '../core/tokens';
import { summarizePlan, toHex, parseColorValue } from '../core/token-sync';
import { createComponent, createInstance, instancesOf, removeComponent, renameComponent } from '../core/components';
import { valueAt } from '../core/commands';
import type { PropKey, Token } from '../core/model';
import { useChannels } from './hooks';
import { showContextMenu, type MenuItem } from './menu';
import { Button, ColorSwatch, Dialog, Section, Segmented } from './ui';

const st = () => editor.store;
export const STYLE_MIME = 'application/x-motion-style';

const css = (c: number[]) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3] ?? 1})`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** link a style to the layers: colors go to fill (or stroke with `asStroke`), numbers to the first property that takes them */
export function applyStyle(tokenId: string, ids: string[], asStroke = false) {
  const s = st();
  const t = s.project.tokens?.items[tokenId];
  if (!t || !ids.length) return;
  let key: PropKey | undefined;
  if (t.type === 'color') key = asStroke ? 'stroke' : 'fill';
  else key = (['radius', 'strokeWidth', 'opacity'] as PropKey[]).find(k => ids.every(id => { const l = s.layer(id); return l && (k === 'opacity' || l.props[k]); }));
  if (!key) { toast(`Nothing on this layer takes a number like ${prettyName(t.name)}`, 'error'); return; }
  const ok = ids.filter(id => { const l = s.layer(id); return l && (key === 'opacity' || l.props[key!]) && canBind(key!, t); });
  if (!ok.length) { toast(`${prettyName(t.name)} can't be used on this layer`, 'error'); return; }
  try { linkProp(s, ok, key, t.id); } catch (e: any) { toast(e.message, 'error'); return; }
  toast(`${ok.length === 1 ? s.layer(ok[0])!.name : plural(ok.length, 'layer')}: ${key === 'fill' ? 'fill' : key === 'stroke' ? 'stroke' : key} linked to ${prettyName(t.name)}`);
}

export function LibraryPanel() {
  useChannels(['doc', 'tokens', 'components', 'selection', 'comps']);
  return (
    <div class="library">
      <StylesSection />
      <ComponentsSection />
    </div>
  );
}

// ---------------- colors + numbers ----------------
function StylesSection() {
  const s = st();
  const lib = s.project.tokens;
  const items = Object.values(lib?.items ?? {});
  const usage = tokenUsage(s.project);
  const colors = items.filter(t => t.type === 'color');
  const numbers = items.filter(t => t.type === 'number');
  const syncMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sources = lib?.sources ?? [];
    const menu: MenuItem[] = [
      ...sources.map(src => ({ label: `Update from ${src.label}`, action: () => { syncSource(src); } })),
      ...(sources.length ? [{ separator: true } as MenuItem] : []),
      { label: 'Import tokens file (.json)…', action: () => { importTokensFile(); } },
      { label: 'Sync from a URL…', action: () => { syncFromUrl(); } },
      { label: 'Sync Figma variables (API)…', action: () => { syncFromFigmaApi(); } },
      { separator: true },
      { label: 'Export as tokens file', action: exportTokens, disabled: !items.length },
    ];
    showContextMenu(r.left, r.bottom + 4, menu);
  };
  const addColor = () => {
    const sel = s.selection.map(id => s.layer(id)).find(l => l?.props.fill);
    const v = sel ? valueAt(sel, 'fill', s.time) : [0.3, 0.55, 1, 1];
    const name = prompt('Name the color (use / to group, e.g. "Brand / Primary")', sel ? `Colors / ${sel.name}` : 'Colors / New color');
    if (!name) return;
    const t = addToken(s, { name: name.replace(/\s*\/\s*/g, '/'), type: 'color', value: v });
    if (sel && !sel.props.fill?.kf?.length) linkProp(s, [sel.id], 'fill', t.id);
  };
  const addNumber = () => {
    const name = prompt('Name the number (e.g. "Radius / Medium")', 'Radius / Medium');
    if (!name) return;
    const v = parseFloat(prompt('Value', '8') ?? '');
    if (!isFinite(v)) return;
    addToken(s, { name: name.replace(/\s*\/\s*/g, '/'), type: 'number', value: [v] });
  };
  const src = lib?.sources?.[lib.sources.length - 1];
  return (
    <>
      <Section title="Colors" right={
        <span class="lib-actions">
          <Button variant="ghost" size="sm" tip="Save a new color (from the selected layer's fill)" aria-label="Add color" onClick={addColor}>＋</Button>
          <Button variant="ghost" size="sm" tip="Import or update colors from a design library" onClick={syncMenu as any} aria-haspopup="menu">Sync ▾</Button>
        </span>}>
        {lib && lib.modes.length > 1 && (
          <div class="lib-modes" title="Light / dark (or other) versions of the same colors">
            <span class="muted small">Showing</span>
            <Segmented value={lib.mode} options={lib.modes.map(m => ({ value: m, label: m }))} onChange={m => setTokenMode(s, m as string)} size="sm" />
          </div>
        )}
        {!colors.length && (
          <div class="lib-empty">
            <p>No colors yet.</p>
            <p class="muted small">Paste a design from Figma (its color styles and variables come along), import a tokens file, or select a layer and press ＋ to save its fill.</p>
            <div class="row"><Button size="sm" onClick={() => importTokensFile()}>Import tokens file</Button><Button size="sm" variant="ghost" onClick={addColor}>Save a color</Button></div>
          </div>
        )}
        {groups(colors).map(([group, list]) => (
          <div class="lib-group">
            {group && <div class="lib-group-name">{group}</div>}
            {list.map(t => <StyleRow t={t} used={usage.get(t.id)?.layers.size ?? 0} />)}
          </div>
        ))}
        {src && <div class="lib-source muted small">From {src.label}{src.lastSync ? ` · ${ago(src.lastSync)}` : ''} · <button class="link" onClick={() => syncSource(src)}>Check for updates</button></div>}
      </Section>
      <Section title="Numbers" right={<Button variant="ghost" size="sm" tip="Save a named number (corner radius, stroke width, opacity)" aria-label="Add number" onClick={addNumber}>＋</Button>}>
        {!numbers.length && <p class="muted small lib-hint">Named numbers for corner radius, stroke width or opacity. Change one, every linked layer follows.</p>}
        {groups(numbers).map(([group, list]) => (
          <div class="lib-group">
            {group && <div class="lib-group-name">{group}</div>}
            {list.map(t => <StyleRow t={t} used={usage.get(t.id)?.layers.size ?? 0} />)}
          </div>
        ))}
      </Section>
    </>
  );
}

function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

function groups(list: Token[]): [string, Token[]][] {
  const m = new Map<string, Token[]>();
  for (const t of [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const g = splitName(t.name).group;
    let a = m.get(g);
    if (!a) m.set(g, (a = []));
    a.push(t);
  }
  return [...m.entries()];
}

function StyleRow({ t, used }: { t: Token; used: number }) {
  const s = st();
  const lib = s.project.tokens!;
  const v = tokenValue(lib, t);
  const { leaf } = splitName(t.name);
  const [mk] = useState(() => 'tok' + Math.random());
  const select = () => {
    const ids = layersUsing(s.project, t.id);
    const here = new Set(s.drawOrder());
    const vis = ids.filter(id => here.has(id));
    if (!ids.length) { toast(`No layer uses ${prettyName(t.name)} yet: drag it onto a layer`); return; }
    if (!vis.length) { toast(`${prettyName(t.name)} is used in another composition`); return; }
    s.select(vis);
  };
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    const sel = s.selection;
    showContextMenu(e.clientX, e.clientY, [
      ...(t.type === 'color'
        ? [{ label: 'Use as fill of selection', disabled: !sel.length, action: () => applyStyle(t.id, sel) }, { label: 'Use as stroke of selection', disabled: !sel.length, action: () => applyStyle(t.id, sel, true) }]
        : [{ label: 'Use on selection', disabled: !sel.length, action: () => applyStyle(t.id, sel) }]),
      { label: `Select layers using it (${used})`, disabled: !used, action: select },
      { separator: true },
      ...(t.type === 'number' ? [{ label: 'Change value…', action: () => { const n = parseFloat(prompt(prettyName(t.name), String(v[0])) ?? ''); if (isFinite(n)) setTokenValue(s, t.id, [n]); } }] : []),
      ...(t.type === 'color' ? [{ label: 'Change color (hex)…', action: () => { const c = parseColorValue((prompt(prettyName(t.name), toHex(v)) ?? '').trim()); if (c) setTokenValue(s, t.id, c); } }] : []),
      { label: 'Rename…', action: () => { const n = prompt('Name (use / to group)', prettyName(t.name)); if (n) renameToken(s, t.id, n.replace(/\s*\/\s*/g, '/')); } },
      { label: used ? `Delete (${plural(used, 'layer')} keep their look)` : 'Delete', action: () => deleteToken(s, t.id) },
    ]);
  };
  return (
    <div class={'lib-row' + (t.missing ? ' missing' : '')} draggable
      title={`${prettyName(t.name)}${t.description ? `\n${t.description}` : ''}\nClick: select layers using it · Drag onto a layer to link it · Right-click: more`}
      onDragStart={e => { e.dataTransfer!.setData(STYLE_MIME, t.id); e.dataTransfer!.setData('text/plain', prettyName(t.name)); e.dataTransfer!.effectAllowed = 'link'; }}
      onClick={e => { if (!(e.target as HTMLElement).closest('.swatch')) select(); }}
      onContextMenu={menu}>
      {t.type === 'color'
        ? <ColorSwatch size="sm" value={toHex(v).slice(0, 7)} alpha={v[3]} label={`Edit ${prettyName(t.name)}`}
            onInput={h => setTokenValue(s, t.id, [...parseColorValue(h)!.slice(0, 3), v[3]], { mergeKey: mk })} />
        : <span class="lib-num">{Math.round(v[0] * 100) / 100}</span>}
      <span class="lib-name">{leaf}</span>
      {t.missing && <span class="lib-badge warn" title="Removed from its library. Layers keep using it until you replace it.">removed</span>}
      <span class={'lib-count' + (used ? '' : ' zero')} title={used ? `Used by ${plural(used, 'layer')}` : 'Not used yet'}>{used || ''}</span>
    </div>
  );
}

// ---------------- components ----------------
function ComponentsSection() {
  const s = st();
  const P = s.project;
  const comps = Object.entries(P.components ?? {}).filter(([id]) => P.layers[id]);
  const sel = s.selection.length === 1 ? s.layer(s.selection[0]) : undefined;
  const canMake = !!sel && !P.components?.[sel.id] && !sel.link;
  const make = () => {
    if (!sel) { toast('Select a layer or group first'); return; }
    try { createComponent(s, sel.id); toast(`${sel.name} is now a component: add instances from here, edit or animate it and they follow`); } catch (e: any) { toast(e.message, 'error'); }
  };
  const compOf = (id: string) => Object.values(P.comps).find(c => { let cur: string | null = id; while (cur) { const l: import("../core/model").Layer | undefined = P.layers[cur]; if (!l?.parent) return c.root.includes(cur); cur = l.parent; } return false; });
  const goMain = (id: string) => { const c = compOf(id); if (c) s.openComp(c.id); s.select([id]); };
  return (
    <Section title="Components" right={<Button variant="ghost" size="sm" disabled={!canMake} tip="Make the selected layer a reusable component (⌥⌘K)" onClick={make}>＋ Make</Button>}>
      {!comps.length && <p class="muted small lib-hint">A component is a layer you can reuse: animate it once, add instances anywhere, and changes to the main show up in every instance. Select a layer and press ＋ Make, or paste components from Figma.</p>}
      {comps.map(([id, c]) => {
        const n = instancesOf(P, id).length;
        return (
          <div class="lib-row comp" title={`${c.name}\nDouble-click: edit the main component`} onDblClick={() => goMain(id)}
            onContextMenu={e => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, [
              { label: 'Add instance', action: () => createInstance(s, id) },
              { label: 'Edit main component', action: () => goMain(id) },
              { label: `Select instances (${n})`, disabled: !n, action: () => { const here = new Set(s.drawOrder()); s.select(instancesOf(P, id).filter(x => here.has(x))); } },
              { label: 'Rename…', action: () => { const v = prompt('Component name', c.name); if (v) renameComponent(s, id, v); } },
              { separator: true },
              { label: 'Stop being a component', action: () => removeComponent(s, id) },
            ]); }}>
            <span class="lib-comp-icon" aria-hidden="true">◆</span>
            <span class="lib-name">{c.name}{c.figmaKey ? <span class="muted small"> · Figma</span> : null}</span>
            <span class="lib-count" title={`${plural(n, 'instance')}`}>{n || ''}</span>
            <Button variant="ghost" size="sm" tip="Add an instance to this composition" onClick={() => { createInstance(s, id); }}>Add</Button>
          </div>
        );
      })}
    </Section>
  );
}

// ---------------- sync review ----------------
/** "3 colors changed": before → after per style, new and removed ones; Update applies (one undo step) */
export function SyncReview() {
  useChannels([], ['sync']);
  const p = pendingSync;
  if (!p) return null;
  const s = st();
  const lib = s.project.tokens;
  const mode = lib?.mode;
  const show = (v: number[] | undefined, type: Token['type']) => !v ? <span class="muted">–</span> : type === 'color'
    ? <span class="chip" style={{ background: css(v) }} title={toHex(v)} />
    : <span class="lib-num">{Math.round(v[0] * 100) / 100}</span>;
  return (
    <Dialog title={`Update styles from ${p.source.label}`} onClose={() => reviewSync(null)} width={460} class="sync-review"
      actions={<><Button onClick={() => reviewSync(null)}>Not now</Button><Button variant="primary" autofocus onClick={confirmSync}>Update</Button></>}>
      <p class="sync-summary">{summarizePlan(p.plan)}</p>
      <ul class="sync-list">
        {p.plan.changed.map(c => {
          const modes = Object.keys(c.values);
          const m = modes.includes(mode ?? '') ? mode! : modes[0];
          const used = lib ? layersUsing(s.project, c.id).length : 0;
          return (
            <li>
              <span class="sync-tag changed">changed</span>
              <span class="lib-name">{prettyName(c.name)}{c.rename && <span class="muted"> → {prettyName(c.rename)}</span>}</span>
              {m && <span class="sync-vals">{show(c.values[m][0], c.type)}<span class="muted">→</span>{show(c.values[m][1], c.type)}</span>}
              <span class="muted small">{used ? plural(used, 'layer') : ''}{modes.length > 1 ? ` · ${modes.length} modes` : ''}</span>
            </li>
          );
        })}
        {p.plan.added.map(t => (
          <li><span class="sync-tag added">new</span><span class="lib-name">{prettyName(t.name)}</span><span class="sync-vals">{show(Object.values(t.values)[0], t.type)}</span><span /></li>
        ))}
        {p.plan.removed.map(r => (
          <li><span class="sync-tag removed">removed</span><span class="lib-name">{prettyName(r.name)}</span><span /><span class="muted small">{r.used ? `kept: ${plural(r.used, 'layer')} use it` : 'deleted'}</span></li>
        ))}
      </ul>
      <p class="muted small">Linked layers and keyframes update everywhere. You can undo this in one step.</p>
    </Dialog>
  );
}
