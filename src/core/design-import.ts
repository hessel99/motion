// what a figma paste brings besides layers: variables / styles (→ linked styles, and a library sync:
// newer values from figma update the project), and components (→ main components in a "Components"
// composition, pasted instances linked to them with their differences as overrides).
// runs inside the paste transaction: one undo step.

import type { Composition, Layer, PropKey } from './model';
import { createComp } from './model';
import type { Store, Tx } from './store';
import type { FigmaDesignData } from '../import/figma/convert';
import { applySyncTx, planSync, planIsEmpty, summarizePlan } from './token-sync';
import { refreshLinked, tokenValue, valueForProp } from './tokens';
import { linkAsInstance } from './components';
import { pasteAsMotionInstance } from './figma-components';

export const COMPONENTS_COMP = 'Components';

export interface DesignImportResult {
  /** e.g. "2 colors changed" when the paste carried newer library values */
  synced?: string;
  linked: number;
  components: number;
  instances: number;
}

export function importFigmaDesign(store: Store, tx: Tx, layers: Map<string, Layer>, design: FigmaDesignData): DesignImportResult {
  const P = store.project;
  const out: DesignImportResult = { linked: 0, components: 0, instances: 0 };
  // ---- styles / variables
  if (design.tokens.length) {
    const fresh = !P.tokens || !Object.keys(P.tokens.items).length;
    const plan = planSync(P, design.tokens, { from: 'figma' });
    const updated = plan.changed.length;
    const keyToId = applySyncTx(tx, P, plan, { from: 'figma' });
    const lib = P.tokens!;
    // a new library shows the mode the pasted design was in (e.g. Dark)
    if (fresh && design.mode && lib.modes.includes(design.mode) && lib.mode !== design.mode) { tx.set(lib, 'mode', design.mode); refreshLinked(tx, P, null); }
    if (updated && !planIsEmpty(plan)) out.synced = summarizePlan({ ...plan, added: [], removed: [] });
    for (const r of design.refs) {
      const id = keyToId.get(r.key);
      const l = layers.get(r.layer);
      const t = id ? lib.items[id] : undefined;
      const p = l?.props[r.prop as PropKey];
      if (!t || !p || p.kf?.length) continue;
      // fresh layer objects (inserted by this same transaction): plain writes are undone with them
      p.v = valueForProp(r.prop as PropKey, tokenValue(lib, t));
      p.bind = t.id;
      out.linked++;
    }
  }
  // ---- components
  if (design.instances.length) {
    const mainByKey = new Map<string, string>();
    for (const [id, c] of Object.entries(P.components ?? {})) if (c.figmaKey && P.layers[id]) mainByKey.set(c.figmaKey, id);
    // figma components already made animated components here: pasted instances become their instances
    const motionByKey = new Map<string, Composition>();
    for (const c of Object.values(P.comps)) if (c.component?.figmaKey) motionByKey.set(c.component.figmaKey, c);
    const defLayers = new Map(design.defLayers.map(l => [l.id, l]));
    let comp: Composition | undefined;
    let cursor = 40;
    for (const d of design.defs) {
      if (mainByKey.has(d.key) || motionByKey.has(d.key)) continue;
      const root = defLayers.get(d.root);
      if (!root) continue;
      if (!comp) {
        comp = Object.values(P.comps).find(c => c.name === COMPONENTS_COMP);
        if (comp) for (const id of comp.root) { const l = P.layers[id]; const sz = l?.props.size?.v; const pos = l?.props.position?.v; if (sz && pos) cursor = Math.max(cursor, pos[0] + sz[0] / 2 + 40); }
        else {
          comp = createComp({ name: COMPONENTS_COMP, width: 1920, height: 1080, fps: store.comp.fps, duration: store.comp.duration, background: [0.12, 0.12, 0.13, 1] });
          tx.set(P.comps, comp.id, comp);
          tx.comp();
        }
      }
      // lay the main components out in a row
      const sz = root.props.size?.v ?? [100, 100];
      root.props.position!.v = [cursor + sz[0] / 2, 40 + sz[1] / 2];
      root.props.anchor!.v = [sz[0] / 2, sz[1] / 2];
      cursor += sz[0] + 40;
      const walk = (l: Layer) => { tx.set(P.layers, l.id, l); for (const c of l.children) { const k = defLayers.get(c); if (k) walk(k); } };
      walk(root);
      root.parent = null;
      tx.set(comp, 'root', [...comp.root, root.id]);
      if (cursor > comp.width) tx.set(comp, 'width', Math.ceil(cursor));
      if (!P.components) tx.set(P, 'components', {});
      tx.set(P.components!, root.id, { name: d.name, figmaKey: d.key, ...(d.meta?.props.length ? { figmaProps: d.meta.props } : {}), ...(d.meta?.set ? { figmaSet: d.meta.set } : {}) });
      mainByKey.set(d.key, root.id);
      out.components++;
      tx.structure();
    }
    // nested components first (instances inside definitions), then the pasted ones
    for (const inst of design.instances) {
      const mc = motionByKey.get(inst.key);
      if (mc && P.layers[inst.layer]) { pasteAsMotionInstance(tx, P, mc, P.layers[inst.layer], inst.values); out.instances++; continue; }
      const mainId = mainByKey.get(inst.key);
      if (!mainId || !P.layers[inst.layer] || mainId === inst.layer) continue;
      linkAsInstance(tx, P, mainId, inst.layer);
      out.instances++;
    }
  }
  return out;
}
