// living style guide: every token and component primitive, rendered in both themes side by
// side, plus live WCAG contrast checks and the canvas (timeline / graph) tokens drawn through
// theme.ts exactly as the editor draws them. open with ?styleguide (dev server or built app).

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Button, Checkbox, ColorSwatch, Dialog, Kbd, NumField, Section, Segmented, Select, Slider, Toggle } from './ui';
import { showContextMenu } from './menu';
import { toast } from '../app/actions';
import { getTheme, onThemeChange, readCanvasTheme, setTheme, type CanvasTheme, type ThemeName } from './theme';
import { ChevronDown, MousePointer2, Play, Sparkles, Square, Type } from './chrome/icons';

const COLOR_GROUPS: [string, string[]][] = [
  ['Surfaces', ['--bg-app', '--surface-0', '--surface-1', '--surface-2', '--surface-3', '--surface-overlay', '--surface-code', '--surface-hover', '--surface-pressed', '--backdrop']],
  ['Borders', ['--border', '--border-strong', '--border-overlay']],
  ['Text', ['--text', '--text-secondary', '--text-muted', '--text-disabled', '--text-on-accent']],
  ['Accent + selection', ['--accent', '--accent-hover', '--accent-pressed', '--accent-solid', '--accent-solid-hover', '--accent-solid-pressed', '--accent-text', '--accent-soft', '--accent-soft-border', '--accent-soft-text', '--selection-bg', '--selection-strong', '--focus-ring-color']],
  ['Status', ['--danger', '--danger-soft', '--danger-border', '--danger-text', '--warning', '--warning-text', '--success', '--neutral-dot']],
  ['Animation', ['--keyframe', '--keyframe-selected', '--keyframe-animated', '--keyframe-idle', '--preset-in', '--preset-out', '--preset-loop', '--curve-handle', '--curve-preview', '--curve-arm', '--curve-guide', '--record']],
  ['Timeline (canvas)', ['--tl-bg', '--tl-bg-outside', '--tl-ruler-bg', '--tl-divider', '--tl-row-line', '--tl-row-hover', '--tl-row-selected', '--tl-tick', '--tl-tick-minor', '--tl-grid', '--tl-ruler-text', '--tl-layer-name', '--tl-layer-name-selected', '--tl-layer-name-hidden', '--tl-prop-name', '--tl-icon', '--tl-icon-off', '--tl-twirl', '--tl-control', '--tl-control-off', '--tl-control-on', '--tl-solo', '--tl-bar', '--tl-bar-selected', '--tl-key', '--tl-key-stroke', '--tl-key-selected', '--tl-key-selected-stroke', '--tl-key-off', '--tl-key-off-stroke', '--tl-key-summary', '--tl-key-summary-selected', '--tl-segment', '--tl-segment-spring', '--tl-segment-selected', '--tl-value', '--tl-hint', '--tl-playhead', '--tl-marker', '--tl-marker-line', '--tl-work-area', '--tl-work-area-dim', '--tl-comp-end', '--tl-scrollbar', '--tl-marquee-fill', '--tl-marquee-stroke', '--tl-drop', '--tl-audio', '--tl-audio-selected', '--tl-text-anim', '--tl-text-anim-label', '--tl-tab', '--tl-tab-text', '--tl-tab-on', '--tl-tab-on-text']],
  ['Graph editor (canvas)', ['--graph-bg', '--graph-grid', '--graph-label', '--graph-key-tick', '--graph-key-selected', '--graph-handle', '--graph-handle-arm', '--axis-x', '--axis-y', '--axis-z', '--axis-w', '--axis-scalar']],
  ['Viewport overlay (canvas)', ['--vp-bg', '--vp-comp-outline', '--vp-label', '--vp-selection', '--vp-handle', '--vp-badge', '--vp-badge-text', '--vp-motion-path', '--vp-tangent', '--vp-tangent-handle', '--vp-guide', '--vp-marquee-fill', '--vp-hud-bg', '--vp-hud-text']],
];

/** text token x surface token pairs that must reach WCAG AA (4.5:1 normal text; 3:1 for large / ui) */
const CONTRAST_TEXT = ['--text', '--text-secondary', '--text-muted', '--accent-text', '--danger-text', '--warning-text'];
const CONTRAST_BG = ['--surface-0', '--surface-1', '--surface-2', '--surface-overlay'];
const CONTRAST_EXTRA: [string, string, number][] = [
  ['--text-on-accent', '--accent-solid', 4.5],
  ['--text-on-accent', '--accent-solid-hover', 4.5],
  ['--accent-soft-text', '--surface-1', 4.5],
  ['--tl-layer-name', '--tl-bg', 4.5],
  ['--tl-ruler-text', '--tl-ruler-bg', 4.5],
  ['--tl-prop-name', '--tl-bg', 4.5],
  ['--tl-value', '--tl-bg', 4.5],
  ['--tl-tab-on-text', '--tl-ruler-bg', 4.5],
  ['--graph-label', '--graph-bg', 3],
  ['--vp-badge-text', '--vp-badge', 4.5],
  ['--text-disabled', '--surface-1', 0], // informational: disabled text is exempt
];

const SPACES = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7', '--space-8', '--space-9'];
const RADII = ['--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-pill'];
const TYPE = ['--text-2xs', '--text-xs', '--text-sm', '--text-md', '--text-lg'];
const SHADOWS = ['--shadow-1', '--shadow-2', '--shadow-3'];
const DURATIONS = ['--dur-fast', '--dur-base', '--dur-slow'];
const EASINGS = ['--ease-standard', '--ease-out', '--ease-in'];
const ZS = ['--z-canvas-ui', '--z-inline-edit', '--z-modal', '--z-popover', '--z-toast', '--z-tooltip'];

export function StyleGuide() {
  const [theme, setT] = useState<ThemeName>(getTheme());
  useEffect(() => {
    document.title = 'Motion style guide';
    // the editor shell locks scrolling; the guide is a normal scrolling page
    for (const el of [document.documentElement, document.body, document.getElementById('app')!]) { el.style.overflow = 'auto'; el.style.height = 'auto'; }
    return onThemeChange(() => setT(getTheme()));
  }, []);
  return (
    <div class="sg">
      <style>{SG_CSS}</style>
      <header class="sg-top">
        <div>
          <h1 class="sg-h1">Motion design system</h1>
          <div class="muted small">Tokens live in <code>src/ui/tokens.css</code>, components in <code>src/ui/ui.tsx</code> + <code>styles.css</code>, canvas parity in <code>src/ui/theme.ts</code>. Both themes are rendered below; the page chrome follows the app theme.</div>
        </div>
        <Segmented label="App theme" value={theme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} onChange={v => setTheme(v)} />
      </header>
      <div class="sg-cols">
        <ThemeColumn name="dark" />
        <ThemeColumn name="light" />
      </div>
    </div>
  );
}

function ThemeColumn({ name }: { name: ThemeName }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cs, setCs] = useState<CSSStyleDeclaration | null>(null);
  useEffect(() => setCs(getComputedStyle(ref.current!)), []);
  return (
    <div class="sg-col" data-theme={name} ref={ref}>
      <h2 class="sg-h2">{name === 'dark' ? 'Dark (default)' : 'Light'}</h2>
      {cs && <>
        <Block title="Color tokens">
          {COLOR_GROUPS.map(([g, toks]) => (
            <div class="sg-group">
              <div class="label-xs">{g}</div>
              <div class="sg-swatches">{toks.map(t => <Swatch token={t} value={cs.getPropertyValue(t).trim()} />)}</div>
            </div>
          ))}
        </Block>
        <Block title="Contrast (WCAG 2.x)"><ContrastTable scope={ref.current!} /></Block>
        <Block title="Canvas parity: timeline + graph drawn from theme.ts"><CanvasSample scope={ref.current!} /></Block>
      </>}
      <Block title="Type">
        <div class="sg-stack">
          {TYPE.map(t => <div style={{ fontSize: `var(${t})` }}>{t} · The quick brown fox · 0123456789</div>)}
          <div class="mono">--font-mono · 00:01:24 · 740, 740 · cubic-bezier(0.33, 0, 0.67, 1)</div>
          <div><span style={{ fontWeight: 'var(--weight-regular)' }}>Regular </span><span style={{ fontWeight: 'var(--weight-medium)' }}>Medium </span><span style={{ fontWeight: 'var(--weight-semibold)' }}>Semibold </span><span style={{ fontWeight: 'var(--weight-bold)' }}>Bold</span></div>
          <div class="muted">--text-muted secondary copy</div>
        </div>
      </Block>
      <Block title="Spacing (2px grid)">
        <div class="sg-stack">{SPACES.map(t => <div class="sg-row"><code class="sg-tok">{t}</code><span class="sg-space" style={{ width: `var(${t})` }} /></div>)}</div>
      </Block>
      <Block title="Radii">
        <div class="sg-wrap">{RADII.map(t => <div class="sg-radius" style={{ borderRadius: `var(${t})` }}><code>{t.replace('--radius-', '')}</code></div>)}</div>
      </Block>
      <Block title="Elevation">
        <div class="sg-wrap">{SHADOWS.map(t => <div class="sg-elev" style={{ boxShadow: `var(${t})` }}><code>{t}</code></div>)}</div>
      </Block>
      <Block title="Motion (hover a row)">
        <div class="sg-stack">
          {DURATIONS.map(d => EASINGS.map(e => (
            <div class="sg-motion" style={{ '--d': `var(${d})`, '--e': `var(${e})` } as any}><code class="sg-tok">{d} {e}</code><span class="sg-track"><span class="sg-ball" /></span></div>
          )))}
          <div class="muted small">prefers-reduced-motion sets every duration to 0.</div>
        </div>
      </Block>
      <Block title="Z layers">
        <div class="sg-stack small">{ZS.map(z => <div class="sg-row"><code class="sg-tok">{z}</code><span>{cs?.getPropertyValue(z)}</span></div>)}</div>
      </Block>
      <Block title="Buttons"><Buttons /></Block>
      <Block title="Fields"><Fields /></Block>
      <Block title="Section / panel header">
        <div class="sg-panel">
          <Section title="Transform" right={<span class="insp-type">rect</span>}>
            <div class="row"><NumField label="X" value={740} onChange={() => {}} /><NumField label="Y" value={540} onChange={() => {}} /></div>
          </Section>
          <Section title="Expressions" right={<Button variant="ghost" size="sm">+ add</Button>}><div class="muted small">e.g. wiggle(2, 20)</div></Section>
        </div>
      </Block>
      <Block title="Overlays: tooltip, menu, toast, dialog"><Overlays /></Block>
      <Block title="Focus ring (tab through this column)">
        <div class="sg-wrap"><Button>Focusable</Button><input placeholder="input" /><Checkbox checked onChange={() => {}}>check</Checkbox></div>
      </Block>
    </div>
  );
}

function Block(props: { title: string; children: ComponentChildren }) {
  return <section class="sg-block"><h3 class="sg-h3">{props.title}</h3>{props.children}</section>;
}

function Swatch({ token, value }: { token: string; value: string }) {
  return (
    <div class="sg-swatch" title={`${token}: ${value}`}>
      <span class="sg-chip" style={{ background: `var(${token})` }} />
      <code>{token.slice(2)}</code>
      <span class="sg-val">{value}</span>
    </div>
  );
}

function Buttons() {
  const [on, setOn] = useState(true);
  return (
    <div class="sg-stack">
      {(['primary', 'secondary', 'ghost', 'danger'] as const).map(v => (
        <div class="sg-wrap">
          <code class="sg-tok">{v}</code>
          <Button variant={v} size="sm">Small</Button>
          <Button variant={v}>Medium</Button>
          <Button variant={v} size="lg">Large</Button>
          <Button variant={v} disabled>Disabled</Button>
          <Button variant={v} icon tip="Icon button"><Sparkles /></Button>
        </div>
      ))}
      <div class="sg-wrap">
        <code class="sg-tok">toggle</code>
        <Button active={on} onClick={() => setOn(!on)}>Active: {on ? 'on' : 'off'}</Button>
        <Button variant="ghost" active={on} onClick={() => setOn(!on)}><Sparkles /> Agent</Button>
        <Button variant="ghost" icon tip="Play (Space)" aria-label="Play"><Play /></Button>
        <div class="toolbar sg-toolbar"><button type="button" class="tool on" aria-label="Move" data-tooltip="Move (V)" data-tooltip-side="top"><MousePointer2 size={18} /></button><button type="button" class="tool" aria-label="Rectangle" data-tooltip="Rectangle (R)" data-tooltip-side="top"><Square size={18} /><span class="tool-corner" /></button><button type="button" class="tool" aria-label="Text" data-tooltip="Text (T)" data-tooltip-side="top"><Type size={18} /></button></div>
      </div>
    </div>
  );
}

function Fields() {
  const [n, setN] = useState(42);
  const [sel, setSel] = useState('center');
  const [chk, setChk] = useState(true);
  const [tog, setTog] = useState(false);
  const [sl, setSl] = useState(0.4);
  const [seg, setSeg] = useState('medium');
  const [col, setCol] = useState('#4c8dff');
  return (
    <div class="sg-stack sg-fields">
      <div class="row"><NumField label="X" value={n} onChange={setN} /><NumField label="◐" title="Opacity" value={80} suffix="%" onChange={() => {}} /></div>
      <div class="row"><input placeholder="Text input" class="grow" /><Select value={sel} onChange={setSel} options={[{ value: 'inside', label: 'Inside' }, { value: 'center', label: 'Center' }, { value: 'outside', label: 'Outside' }]} /></div>
      <div class="row"><Checkbox checked={chk} onChange={setChk}>Checkbox</Checkbox><Toggle checked={tog} onChange={setTog} label="Toggle" /><Checkbox checked={false} disabled onChange={() => {}}>Disabled</Checkbox></div>
      <div class="row"><span class="field-label">Slider</span><Slider label="Slider" min={0} max={1} step={0.01} value={sl} onInput={setSl} style={{ flex: 1 }} /><span class="small">{Math.round(sl * 100)}%</span></div>
      <Segmented label="Quality" value={seg} options={['low', 'medium', 'high']} onChange={setSeg} />
      <div class="row color-field"><ColorSwatch value={col} onInput={setCol} /><ColorSwatch value={col} alpha={0.4} onInput={setCol} /><input class="hex" value={col.slice(1).toUpperCase()} readOnly /><Kbd>⌘Z</Kbd><Kbd>⇧⌘C</Kbd></div>
      <textarea rows={2} placeholder="Textarea" />
      <div class="progress"><div style={{ width: '62%' }} /></div>
      <div class="row"><span class="dot" /><span class="dot connecting" /><span class="dot connected" /><span class="small muted">status dots</span></div>
    </div>
  );
}

function Overlays() {
  const [open, setOpen] = useState(false);
  const menu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showContextMenu(r.left, r.bottom + 4, [
      { label: 'Copy', shortcut: '⌘C', action: () => toast('Copy') },
      { label: 'Paste', shortcut: '⌘V', action: () => toast('Paste') },
      { label: 'Disabled item', disabled: true },
      { separator: true },
      { label: 'Easing', submenu: [{ label: 'Linear', action: () => toast('Linear') }, { label: 'Easy Ease', action: () => toast('Easy Ease') }, { label: 'Spring', action: () => toast('Spring') }] },
      { label: 'Delete', shortcut: '⌫', action: () => toast('Delete', 'error') },
    ]);
  };
  return (
    <div class="sg-wrap">
      <span class="sg-tip-demo" data-tooltip="Tooltip via data-tooltip">Hover me</span>
      <Button onClick={menu as any} aria-haspopup="menu">Open menu <ChevronDown size={12} /></Button>
      <Button onClick={() => toast('Saved')}>Toast</Button>
      <Button variant="danger" onClick={() => toast('Something failed', 'error')}>Error toast</Button>
      <Button variant="primary" onClick={() => setOpen(true)}>Dialog</Button>
      {open && (
        <Dialog title="Export video" onClose={() => setOpen(false)} width={380}
          actions={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" autofocus onClick={() => setOpen(false)}>Export</Button></>}>
          <div class="muted">Dialogs trap focus, close on Escape and on a backdrop click, and return focus when closed.</div>
        </Dialog>
      )}
    </div>
  );
}

// ---------------- contrast ----------------
function luminance(rgb: number[]) {
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
function parse(c: string): number[] {
  const m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
  return m ? [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] === undefined ? 1 : +m[4]] : [0, 0, 0, 1];
}
export function contrastRatio(fg: number[], bg: number[]) {
  // composite a translucent foreground over the background first
  const a = fg[3] ?? 1;
  const f = [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a));
  const l1 = luminance(f), l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function ContrastTable({ scope }: { scope: HTMLElement }) {
  const probe = useRef<HTMLSpanElement>(null);
  const [rows, setRows] = useState<{ fg: string; bg: string; ratio: number; min: number }[]>([]);
  useEffect(() => {
    const p = probe.current!;
    const col = (t: string) => { p.style.color = `var(${t})`; return parse(getComputedStyle(p).color); };
    const out: typeof rows = [];
    for (const fg of CONTRAST_TEXT) for (const bg of CONTRAST_BG) out.push({ fg, bg, ratio: contrastRatio(col(fg), col(bg)), min: 4.5 });
    for (const [fg, bg, min] of CONTRAST_EXTRA) out.push({ fg, bg, ratio: contrastRatio(col(fg), col(bg)), min });
    setRows(out);
  }, [scope]);
  const fails = rows.filter(r => r.min && r.ratio < r.min).length;
  return (
    <div>
      <span ref={probe} style={{ display: 'none' }} />
      <div class={'small ' + (fails ? 'sg-fail' : 'sg-pass')} style={{ marginBottom: 'var(--space-3)' }}>{fails ? `${fails} pair(s) below target` : 'All pairs meet their target'}</div>
      <table class="bench sg-contrast">
        <thead><tr><th>text</th><th>on</th><th>sample</th><th>ratio</th><th>target</th></tr></thead>
        <tbody>{rows.map(r => (
          <tr>
            <td><code>{r.fg.slice(2)}</code></td><td><code>{r.bg.slice(2)}</code></td>
            <td><span class="sg-sample" style={{ color: `var(${r.fg})`, background: `var(${r.bg})` }}>Aa 12px</span></td>
            <td>{r.ratio.toFixed(2)}</td>
            <td class={!r.min ? 'muted' : r.ratio >= r.min ? 'sg-pass' : 'sg-fail'}>{r.min ? (r.ratio >= r.min ? `✓ ${r.min}` : `✕ ${r.min}`) : 'exempt'}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

// ---------------- canvas parity sample ----------------
function CanvasSample({ scope }: { scope: HTMLElement }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const draw = () => drawSample(ref.current!, readCanvasTheme(scope));
    draw();
    return onThemeChange(draw);
  }, [scope]);
  return <canvas ref={ref} class="sg-canvas" />;
}

function drawSample(c: HTMLCanvasElement, T: CanvasTheme) {
  const W = 520, H = 250, dpr = window.devicePixelRatio || 1;
  c.width = W * dpr; c.height = H * dpr; c.style.width = '100%'; c.style.maxWidth = W + 'px';
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const HEAD = 28, ROW = 24, LEFT = 150;
  const tx = (t: number) => LEFT + 10 + t * 80;
  g.fillStyle = T.tlBg; g.fillRect(0, 0, W, H);
  g.fillStyle = T.tlBgOutside; g.fillRect(tx(4), HEAD, W, 4 * ROW);
  g.textBaseline = 'middle';
  const rows = [
    { name: 'Title', sel: false, keys: [0.5, 1.6, 2.4] },
    { name: 'Square', sel: true, keys: [0.2, 1.1] },
    { name: 'Hidden layer', sel: false, keys: [], hidden: true },
  ];
  rows.forEach((r, i) => {
    const y = HEAD + i * ROW, cy = y + ROW / 2;
    if (r.sel) { g.fillStyle = T.tlRowSelected; g.fillRect(0, y, W, ROW); }
    if (i === 2) { g.fillStyle = T.tlRowHover; g.fillRect(0, y, W, ROW); }
    g.fillStyle = T.tlRowLine; g.fillRect(0, y + ROW - 1, W, 1);
    g.fillStyle = r.hidden ? T.tlLayerNameHidden : r.sel ? T.tlLayerNameSelected : T.tlLayerName;
    g.font = T.font.ui; g.fillText(r.name, 24, cy);
    g.fillStyle = T.tlTwirl; g.beginPath(); g.moveTo(10, cy - 4); g.lineTo(15, cy); g.lineTo(10, cy + 4); g.fill();
    g.fillStyle = i === 0 ? T.tlSolo : T.tlControlOff; g.beginPath(); g.arc(LEFT - 30, cy, 3, 0, 7); g.fill();
    g.fillStyle = r.sel ? T.tlBarSelected : T.tlBar; g.beginPath(); g.roundRect(tx(0), y + 4, tx(4) - tx(0), ROW - 8, 3); g.fill();
    g.fillStyle = r.sel ? T.tlKeySummarySelected : T.tlKeySummary;
    for (const k of r.keys) { g.beginPath(); g.moveTo(tx(k), cy - 3.5); g.lineTo(tx(k) + 3.5, cy); g.lineTo(tx(k), cy + 3.5); g.lineTo(tx(k) - 3.5, cy); g.fill(); }
  });
  // property row with keys + segments
  const py = HEAD + 3 * ROW, pcy = py + ROW / 2;
  g.fillStyle = T.tlPropName; g.font = T.font.ui; g.fillText('Position', 34, pcy);
  g.fillStyle = T.tlValue; g.font = T.font.monoSm; g.fillText('740, 540', LEFT - 60, pcy);
  g.fillStyle = T.tlSegmentSelected; g.fillRect(tx(0.2), pcy - 1, tx(1.1) - tx(0.2), 2);
  g.fillStyle = T.tlSegmentSpring; g.fillRect(tx(1.1), pcy - 0.5, tx(2.6) - tx(1.1), 1);
  for (const [k, sel] of [[0.2, true], [1.1, true], [2.6, false]] as [number, boolean][]) {
    g.fillStyle = sel ? T.tlKeySelected : T.tlKey; g.strokeStyle = sel ? T.tlKeySelectedStroke : T.tlKeyStroke;
    g.beginPath(); g.moveTo(tx(k), pcy - 5); g.lineTo(tx(k) + 5, pcy); g.lineTo(tx(k), pcy + 5); g.lineTo(tx(k) - 5, pcy); g.closePath(); g.fill(); g.stroke();
  }
  // graph strip
  const gy0 = HEAD + 4 * ROW, gy1 = H;
  g.fillStyle = T.graphBg; g.fillRect(LEFT, gy0, W - LEFT, gy1 - gy0);
  for (let i = 1; i < 4; i++) { g.fillStyle = T.graphGrid; g.fillRect(LEFT, gy0 + i * (gy1 - gy0) / 4, W - LEFT, 1); }
  g.fillStyle = T.graphLabel; g.font = T.font.uiXs; g.fillText('100', LEFT + 4, gy0 + (gy1 - gy0) / 4 - 6);
  T.axes.slice(0, 3).forEach((col, d) => {
    g.strokeStyle = col; g.lineWidth = 1.6; g.beginPath();
    for (let x = 0; x <= 300; x += 4) { const y = gy0 + 20 + d * 14 + Math.sin(x / 40 + d) * 12; x ? g.lineTo(tx(0) + x, y) : g.moveTo(tx(0) + x, y); }
    g.stroke();
  });
  g.strokeStyle = T.graphHandleArm; g.lineWidth = 1; g.beginPath(); g.moveTo(tx(1), gy0 + 30); g.lineTo(tx(1) + 30, gy0 + 15); g.stroke();
  g.fillStyle = T.graphHandle; g.beginPath(); g.arc(tx(1) + 30, gy0 + 15, 4, 0, 7); g.fill();
  // divider + ruler
  g.fillStyle = T.tlDivider; g.fillRect(LEFT - 1, 0, 1, H);
  g.fillStyle = T.tlRulerBg; g.fillRect(0, 0, W, HEAD);
  g.fillStyle = T.tlDivider; g.fillRect(0, HEAD - 1, W, 1);
  g.font = T.font.uiXs;
  for (let s = 0; s <= 4; s++) { g.fillStyle = T.tlTick; g.fillRect(tx(s), HEAD - 8, 1, 8); g.fillStyle = T.tlRulerText; g.fillText(`${s}s`, tx(s) + 3, HEAD / 2 - 1); }
  ['Keys', 'Graph'].forEach((l, i) => {
    g.fillStyle = i === 0 ? T.tlTabOn : T.tlTab; g.beginPath(); g.roundRect(10 + i * 48, 5, 44, HEAD - 10, 4); g.fill();
    g.fillStyle = i === 0 ? T.tlTabOnText : T.tlTabText; g.font = T.font.uiSm; g.fillText(l, 10 + i * 48 + 22 - g.measureText(l).width / 2, HEAD / 2);
  });
  g.fillStyle = T.tlWorkArea; g.fillRect(tx(0.2), HEAD - 5, tx(3) - tx(0.2), 4);
  g.fillStyle = T.tlWorkAreaDim; g.fillRect(tx(3), HEAD, W, H);
  g.fillStyle = T.tlMarker; const mx = tx(2) + 0.5;
  g.beginPath(); g.moveTo(mx - 4, HEAD - 13); g.lineTo(mx + 4, HEAD - 13); g.lineTo(mx + 4, HEAD - 6); g.lineTo(mx, HEAD - 2); g.lineTo(mx - 4, HEAD - 6); g.fill();
  g.fillStyle = T.tlMarkerLine; g.fillRect(mx - 0.5, HEAD, 1, H);
  g.fillStyle = T.tlCompEnd; g.fillRect(tx(4), 0, 1, HEAD);
  // playhead
  const px = tx(1.4);
  g.fillStyle = T.tlPlayhead; g.fillRect(px - 0.5, HEAD - 6, 1, H);
  g.beginPath(); g.moveTo(px - 6, 4); g.lineTo(px + 6, 4); g.lineTo(px + 6, HEAD - 10); g.lineTo(px, HEAD - 4); g.lineTo(px - 6, HEAD - 10); g.fill();
  // marquee
  g.fillStyle = T.tlMarqueeFill; g.strokeStyle = T.tlMarqueeStroke; g.fillRect(tx(2.9), HEAD + 6, 60, 50); g.strokeRect(tx(2.9) + 0.5, HEAD + 6.5, 60, 50);
}

const SG_CSS = `
.sg { min-height: 100vh; background: var(--bg-app); color: var(--text); }
.sg-top { position: sticky; top: 0; z-index: 10; display: flex; justify-content: space-between; align-items: center; gap: var(--space-7); padding: var(--space-6) var(--space-8); background: var(--surface-1); border-bottom: 1px solid var(--border); }
.sg-h1 { font-size: 18px; font-weight: var(--weight-semibold); margin-bottom: var(--space-1); }
.sg-h2 { font-size: var(--text-lg); font-weight: var(--weight-semibold); margin-bottom: var(--space-6); }
.sg-h3 { font-size: var(--text-md); font-weight: var(--weight-semibold); margin-bottom: var(--space-5); }
.sg-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(560px, 1fr)); }
.sg-col { background: var(--bg-app); color: var(--text); padding: var(--space-8); min-width: 0; }
.sg-col + .sg-col { border-left: 1px solid var(--border); }
.sg-block { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-7); margin-bottom: var(--space-7); }
.sg-group { margin-bottom: var(--space-5); }
.sg-swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--space-2) var(--space-4); }
.sg-swatch { display: grid; grid-template-columns: 22px 1fr; grid-template-rows: auto auto; column-gap: var(--space-3); align-items: center; min-width: 0; }
.sg-swatch code { background: none; padding: 0; font-size: var(--text-2xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-chip { grid-row: span 2; width: 22px; height: 22px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background-clip: padding-box; }
.sg-val { font-size: var(--text-2xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }
.sg-stack { display: flex; flex-direction: column; gap: var(--space-4); }
.sg-wrap { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4); }
.sg-row { display: flex; align-items: center; gap: var(--space-4); }
.sg-tok { background: none; padding: 0; font-size: var(--text-2xs); color: var(--text-muted); min-width: 120px; }
.sg-space { display: inline-block; height: 12px; background: var(--accent); border-radius: 1px; }
.sg-radius { width: 64px; height: 44px; display: grid; place-items: center; background: var(--surface-2); border: 1px solid var(--border-strong); }
.sg-radius code, .sg-elev code { background: none; font-size: var(--text-2xs); }
.sg-elev { width: 120px; height: 56px; display: grid; place-items: center; background: var(--surface-2); border-radius: var(--radius-lg); border: 1px solid var(--border-overlay); }
.sg-motion { display: flex; align-items: center; gap: var(--space-4); }
.sg-track { position: relative; flex: 1; height: 12px; border-radius: 6px; background: var(--surface-0); }
.sg-ball { position: absolute; left: 0; top: 0; width: 12px; height: 12px; border-radius: 6px; background: var(--accent); transition: transform var(--d) var(--e); }
.sg-motion:hover .sg-ball { transform: translateX(200px); }
.sg-panel { width: 272px; background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-md); }
.sg-fields { max-width: 420px; }
.sg-toolbar { position: static; transform: none; }
.sg-tip-demo { padding: var(--space-2) var(--space-4); border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); }
.sg-canvas { display: block; border-radius: var(--radius-md); border: 1px solid var(--border); }
.sg-contrast td, .sg-contrast th { padding: 3px var(--space-3); font-size: var(--text-xs); }
.sg-contrast code { background: none; padding: 0; }
.sg-sample { display: inline-block; padding: 1px var(--space-3); border-radius: var(--radius-xs); border: 1px solid var(--border); }
.sg-pass { color: var(--success); }
.sg-fail { color: var(--danger); font-weight: var(--weight-semibold); }
`;
