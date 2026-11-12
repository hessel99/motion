// inspector section for figma shaders (fill + effects) of one layer: every shader param with the
// control its schema asks for (slider, select, toggle, color, point / angle / radius, gradient) and
// a keyframe button, like the built-in properties.

import { editor } from '../app/editor';
import { valueAt } from '../core/commands';
import type { Layer, PropKey } from '../core/model';
import { addShader, moveShaderEffect, removeShader, setShaderEnabled, setShaderParam } from '../core/shader-commands';
import { componentLabels, isDiscrete, shaderPropKey, shaderRefs, type ShaderAsset, type ShaderParamDef, type ShaderRef } from '../core/shaders';
import { ColorField, KeyNav } from './Inspector';
import { Checkbox, NumField, Section, Slider } from './ui';
import { ChevronLeft, ChevronRight, X } from './chrome/icons';
import { useEffect, useState } from 'preact/hooks';
import { shaderSources } from '../app/shader-sources';
import { SHADER_MAIN } from '../core/shaders';

/** pick shader files (main.ts, features.json) and hand them to the library */
export function importShaderFiles(target?: string) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.accept = '.ts,.js,.json,.md,.wgsl';
  inp.onchange = async () => {
    const files: Record<string, string> = {};
    for (const f of Array.from(inp.files ?? [])) files[/\.(ts|js)$/.test(f.name) && !files[SHADER_MAIN] ? SHADER_MAIN : f.name] = await f.text();
    try { shaderSources.importFiles(editor.store, files, target); } catch (e) { alert(String((e as Error).message ?? e)); }
  };
  inp.click();
}

/** "Fetching shader…" / why it is missing, with the ways to get it */
function SourceStatus({ ref_, asset }: { ref_: ShaderRef; asset: ShaderAsset }) {
  const [, force] = useState(0);
  useEffect(() => shaderSources.on(() => force(x => x + 1)), []);
  const st = shaderSources.states.get(ref_.shader);
  if (asset.files[SHADER_MAIN]) return st?.state === 'done' && st.warning ? <div class="small muted">{st.warning}</div> : null;
  return (
    <div class="small" role="status">
      {st?.state === 'fetching' ? <span class="muted">Fetching the shader from Figma…</span>
        : st?.state === 'error' ? <span style={{ color: 'var(--danger, #e5534b)' }}>{st.error}. Shown as a placeholder.</span>
        : <span class="muted">Figma doesn't copy a shader's code: it's shown as a placeholder until Motion fetches it (connect Figma) or you import its files.</span>}
      {st?.state !== 'fetching' && <div class="row" style={{ gap: 'var(--space-2)', marginTop: 4 }}>
        {shaderSources.status?.figma !== 'connected' && <button type="button" class="ghost btn-sm" onClick={() => { shaderSources.connect(); }}>Connect Figma</button>}
        <button type="button" class="ghost btn-sm" onClick={() => shaderSources.retry()}>Retry</button>
        <button type="button" class="ghost btn-sm" onClick={() => importShaderFiles(ref_.shader)}>Import shader…</button>
      </div>}
    </div>
  );
}

const st = () => editor.store;

export function ShaderPanel({ layer }: { layer: Layer }) {
  const store = st();
  const refs = shaderRefs(layer);
  const lib = store.project.shaders ?? {};
  const keys = Object.keys(lib);
  if (!refs.length && !keys.length) return null;
  const add = (e: Event) => {
    const v = (e.target as HTMLSelectElement).value;
    (e.target as HTMLSelectElement).value = '';
    if (!v) return;
    const [kind, key] = v.split('|');
    try { addShader(store, [layer.id], key, { kind: kind as 'fill' | 'effect' }); } catch (err) { console.warn(err); }
  };
  return (
    <Section title="Shaders" right={keys.length ? (
      <select class="expr-add" value="" onChange={add} aria-label="Add shader">
        <option value="">+ add</option>
        {keys.filter(k => lib[k].kind === 'fill').map(k => <option value={`fill|${k}`}>Fill: {lib[k].name}</option>)}
        {keys.filter(k => lib[k].kind === 'effect').map(k => <option value={`effect|${k}`}>Effect: {lib[k].name}</option>)}
      </select>
    ) : undefined}>
      {refs.length === 0 && <div class="muted small">Add a shader from this document's library (shaders arrive with pasted Figma layers).</div>}
      {refs.map(({ ref, kind }) => {
        const a = lib[ref.shader] ?? ref.asset;
        return a ? <ShaderBlock key={ref.slot} layer={layer} ref_={ref} kind={kind} asset={a} /> : <div class="muted small">Missing shader {ref.shader}</div>;
      })}
    </Section>
  );
}

function ShaderBlock({ layer, ref_, kind, asset }: { layer: Layer; ref_: ShaderRef; kind: 'fill' | 'effect'; asset: ShaderAsset }) {
  const store = st();
  const on = ref_.enabled !== false;
  const host = editor.renderer?.shaders;
  const err = host?.errors.get(`${layer.id}:${ref_.slot}`) ?? (host?.available === false ? `${host.error}: shown as a placeholder` : null);
  return (
    <div class="shader-block">
      <div class="row small" style={{ gap: 'var(--space-2)' }}>
        <Checkbox class="small" checked={on} title={on ? 'Bypass' : 'Enable'} onChange={v => setShaderEnabled(store, layer.id, ref_.slot, v)}>{''}</Checkbox>
        <strong style={{ flex: 1 }} title={asset.description}>{asset.name}</strong>
        <span class="insp-type">{kind}{asset.features.isAnimated ? ' · animated' : ''}</span>
        {kind === 'effect' && <>
          <button type="button" class="ghost icon btn-sm" title="Earlier in the chain" aria-label="Move effect up" onClick={() => moveShaderEffect(store, layer.id, ref_.slot, -1)}><ChevronLeft size={12} /></button>
          <button type="button" class="ghost icon btn-sm" title="Later in the chain" aria-label="Move effect down" onClick={() => moveShaderEffect(store, layer.id, ref_.slot, 1)}><ChevronRight size={12} /></button>
        </>}
        <button type="button" class="ghost icon btn-sm" title="Remove shader" aria-label={`Remove ${asset.name}`} onClick={() => removeShader(store, layer.id, ref_.slot)}><X size={14} /></button>
      </div>
      <SourceStatus ref_={ref_} asset={asset} />
      {err && asset.files[SHADER_MAIN] && <div class="small" style={{ color: 'var(--danger, #e5534b)' }}>{err}</div>}
      {on && asset.params.map(def => <ParamRow key={def.key} layer={layer} slot={ref_.slot} def={def} />)}
    </div>
  );
}

function ParamRow({ layer, slot, def }: { layer: Layer; slot: string; def: ShaderParamDef }) {
  const store = st();
  const key = shaderPropKey(slot, def.key) as unknown as PropKey;
  const v = valueAt(layer, key, store.time);
  const set = (nv: number[] | unknown, mk?: string) => { try { setShaderParam(store, layer.id, slot, def.key, nv, { mergeKey: mk }); } catch (e) { console.warn(e); } };
  const comp = (i: number, n: number, mk?: string) => { const c = v.slice(); c[i] = n; set(c, mk); };
  const unit = def.unit && def.unit !== '%' ? undefined : def.unit;
  let fields: any;
  switch (def.type) {
    case 'boolean':
      fields = <Checkbox checked={v[0] >= 0.5} onChange={b => set([b ? 1 : 0])}>{''}</Checkbox>;
      break;
    case 'color':
      fields = <ColorField value={v} onChange={(c, mk) => set(c, mk)} />;
      break;
    case 'point': case 'point-radius': case 'point-angle-radius': case 'point-point-line': {
      const labels = componentLabels(def);
      const short: Record<string, string> = { x: 'X', y: 'Y', radius: 'R', angle: '∠', x2: 'X2', y2: 'Y2' };
      fields = <>{labels.map((c, i) => <NumField label={short[c] ?? c} value={round(v[i])} suffix={c === 'angle' ? '°' : (c === 'radius' ? def.radiusUnit : def.positionUnit ?? def.unit) === '%' ? '%' : undefined} onChange={(n, mk) => comp(i, n, mk)} />)}</>;
      break;
    }
    case 'color-point':
      fields = <>
        <NumField label="X" value={round(v[0])} suffix="%" onChange={(n, mk) => comp(0, n, mk)} />
        <NumField label="Y" value={round(v[1])} suffix="%" onChange={(n, mk) => comp(1, n, mk)} />
        <ColorField value={v.slice(2, 6)} onChange={(c, mk) => set([v[0], v[1], ...c], mk)} />
      </>;
      break;
    case 'gradient': {
      const n = Math.max(0, Math.round(v[0]));
      fields = <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', flex: 1 }}>
        {Array.from({ length: n }, (_, i) => {
          const o = 1 + i * 5;
          return <div class="row" style={{ margin: 0 }}>
            <NumField label="@" min={0} max={100} value={Math.round(v[o] * 100)} suffix="%" onChange={(x, mk) => comp(o, x / 100, mk)} />
            <ColorField value={v.slice(o + 1, o + 5)} onChange={(c, mk) => { const nv = v.slice(); nv.splice(o + 1, 4, ...c); set(nv, mk); }} />
          </div>;
        })}
      </div>;
      break;
    }
    default: {
      if (def.options?.length && (def.control === 'select' || def.type === 'string')) {
        const idx = def.type === 'string' ? Math.round(v[0]) : def.options.findIndex(o => Number(o.value) === Math.round(v[0]));
        fields = <select value={String(Math.max(0, idx))} style={{ flex: 1 }} onChange={e => {
          const i = +(e.target as HTMLSelectElement).value;
          set([def.type === 'string' ? i : Number(def.options![i].value)]);
        }}>{def.options.map((o, i) => <option value={String(i)}>{o.label}</option>)}</select>;
      } else if (def.type === 'string') {
        fields = <span class="muted small">text</span>;
      } else {
        const ranged = def.min !== undefined && def.max !== undefined && def.control !== 'input';
        fields = <>
          {ranged && <Slider class="shader-slider" value={v[0]} min={def.min!} max={def.max!} step={def.step} label={def.label} onInput={n => set([n], `shd-${slot}-${def.key}`)} />}
          <NumField label="" value={round(v[0])} min={def.min} max={def.max} step={def.step} suffix={unit} onChange={(n, mk) => set([n], mk)} />
        </>;
      }
    }
  }
  const animated = !!layer.props[key]?.kf?.length;
  return (
    <div class={'row prop-row' + (animated ? ' animated' : '')} title={def.description}>
      <KeyNav layers={[layer]} prop={key} />
      <span class="prop-label">{def.label}{isDiscrete(def) ? '' : ''}</span>
      <span class="prop-fields">{fields}</span>
    </div>
  );
}

function round(x: number) { return Math.round(x * 1000) / 1000; }
