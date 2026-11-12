// canvas parity for the design tokens (src/ui/tokens.css).
//
// the timeline, graph editor, viewport overlay and pen tool draw on 2d canvases and can't use
// css variables directly. this module resolves the tokens ONCE (at startup and whenever the
// theme changes) into a plain object of color strings + prebuilt font strings, so draw code
// just reads `T.tlBg` etc: a property read, no getComputedStyle, no allocation per frame.
//
// switching themes: setTheme('light' | 'dark') or set data-theme on <html> directly; a
// MutationObserver picks it up, re-resolves the tokens and notifies onThemeChange listeners
// (which mark their canvases dirty).

export type ThemeName = 'dark' | 'light';

/** canvas token name -> css custom property. add a token here + in tokens.css (both themes). */
const COLOR_TOKENS = {
  accent: '--accent',
  textOnAccent: '--text-on-accent',
  // timeline
  tlBg: '--tl-bg',
  tlBgOutside: '--tl-bg-outside',
  tlRulerBg: '--tl-ruler-bg',
  tlDivider: '--tl-divider',
  tlRowLine: '--tl-row-line',
  tlRowHover: '--tl-row-hover',
  tlRowSelected: '--tl-row-selected',
  tlTick: '--tl-tick',
  tlTickMinor: '--tl-tick-minor',
  tlGrid: '--tl-grid',
  tlRulerText: '--tl-ruler-text',
  tlLayerName: '--tl-layer-name',
  tlLayerNameSelected: '--tl-layer-name-selected',
  tlLayerNameHidden: '--tl-layer-name-hidden',
  tlPropName: '--tl-prop-name',
  tlIcon: '--tl-icon',
  tlIconOff: '--tl-icon-off',
  tlTwirl: '--tl-twirl',
  tlControl: '--tl-control',
  tlControlOff: '--tl-control-off',
  tlControlOn: '--tl-control-on',
  tlSolo: '--tl-solo',
  tlComponent: '--tl-component',
  tlBar: '--tl-bar',
  tlBarSelected: '--tl-bar-selected',
  tlKey: '--tl-key',
  tlKeyStroke: '--tl-key-stroke',
  tlKeySelected: '--tl-key-selected',
  tlKeySelectedStroke: '--tl-key-selected-stroke',
  tlKeyOff: '--tl-key-off',
  tlKeyOffStroke: '--tl-key-off-stroke',
  tlKeySummary: '--tl-key-summary',
  tlKeySummarySelected: '--tl-key-summary-selected',
  tlSegment: '--tl-segment',
  tlSegmentSpring: '--tl-segment-spring',
  tlSegmentSelected: '--tl-segment-selected',
  tlValue: '--tl-value',
  tlHint: '--tl-hint',
  tlPlayhead: '--tl-playhead',
  tlWorkArea: '--tl-work-area',
  tlWorkAreaDim: '--tl-work-area-dim',
  tlCompEnd: '--tl-comp-end',
  tlScrollbar: '--tl-scrollbar',
  tlMarqueeFill: '--tl-marquee-fill',
  tlMarqueeStroke: '--tl-marquee-stroke',
  tlDrop: '--tl-drop',
  tlAudio: '--tl-audio',
  tlAudioSelected: '--tl-audio-selected',
  tlTextAnim: '--tl-text-anim',
  tlTextAnimLabel: '--tl-text-anim-label',
  tlTab: '--tl-tab',
  tlTabText: '--tl-tab-text',
  tlTabOn: '--tl-tab-on',
  tlTabOnText: '--tl-tab-on-text',
  tlLabel1: '--tl-label-1', tlLabel2: '--tl-label-2', tlLabel3: '--tl-label-3', tlLabel4: '--tl-label-4',
  tlLabel5: '--tl-label-5', tlLabel6: '--tl-label-6', tlLabel7: '--tl-label-7', tlLabel8: '--tl-label-8',
  tlLabelKey: '--tl-label-key',
  tlHot: '--tl-hot',
  tlVelocity: '--tl-velocity',
  // graph editor
  graphBg: '--graph-bg',
  graphGrid: '--graph-grid',
  graphLabel: '--graph-label',
  graphKeyTick: '--graph-key-tick',
  graphKeySelected: '--graph-key-selected',
  graphHandle: '--graph-handle',
  graphHandleArm: '--graph-handle-arm',
  axisX: '--axis-x',
  axisY: '--axis-y',
  axisZ: '--axis-z',
  axisW: '--axis-w',
  axisScalar: '--axis-scalar',
  // viewport overlay
  vpBg: '--vp-bg',
  vpCompOutline: '--vp-comp-outline',
  vpLabel: '--vp-label',
  vpSelection: '--vp-selection',
  vpHandle: '--vp-handle',
  vpBadge: '--vp-badge',
  vpBadgeText: '--vp-badge-text',
  vpMotionPath: '--vp-motion-path',
  vpTangent: '--vp-tangent',
  vpTangentHandle: '--vp-tangent-handle',
  vpGuide: '--vp-guide',
  vpMarqueeFill: '--vp-marquee-fill',
  vpPixelGrid: '--vp-pixel-grid',
} as const;

export type ColorToken = keyof typeof COLOR_TOKENS;

export interface CanvasFonts {
  /** 12px ui (layer names, empty-state hints) */
  ui: string;
  /** 11px ui (tabs, overlay labels) */
  uiSm: string;
  /** 10px ui (ruler, small labels) */
  uiXs: string;
  /** bold 11px ui (type glyphs) */
  uiBoldSm: string;
  /** 11px mono (values, timecode) */
  monoSm: string;
}

export type CanvasTheme = Record<ColorToken, string> & {
  name: ThemeName;
  font: CanvasFonts;
  /** the pasteboard color as linear 0..1 rgb, for the webgl clear color */
  vpBgRgb: [number, number, number];
  /** graph curve colors per vector component (x, y, z, w) */
  axes: [string, string, string, string];
  /** timeline label colors (per top-level layer), in order */
  labels: string[];
};

// dark fallbacks so the module works before styles load (tests, ssr-ish contexts)
const FALLBACK_FONT_UI = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";
const FALLBACK_FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function fonts(ui: string, mono: string): CanvasFonts {
  return { ui: `12px ${ui}`, uiSm: `11px ${ui}`, uiXs: `10px ${ui}`, uiBoldSm: `bold 11px ${ui}`, monoSm: `11px ${mono}` };
}

/** the live canvas theme. read fields at draw time (never cache them across theme changes). */
export const T: CanvasTheme = Object.assign(
  Object.fromEntries(Object.keys(COLOR_TOKENS).map(k => [k, '#888'])) as Record<ColorToken, string>,
  { name: 'light' as ThemeName, font: fonts(FALLBACK_FONT_UI, FALLBACK_FONT_MONO), vpBgRgb: [0.1, 0.1, 0.11] as [number, number, number], axes: ['#f66', '#4c6', '#48f', '#fc0'] as [string, string, string, string], labels: ['#4a90e2', '#e8619d', '#3fa66a', '#e8833a'] },
);

const listeners = new Set<() => void>();
let observing = false;
/** data-theme value the tokens were last resolved for */
let resolvedFor: string | undefined = '\0';

/** resolves css colors (var(), color-mix(), rgba...) to computed rgb() inside a scope element */
function colorResolver(scope: Element) {
  const probe = document.createElement('i');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
  scope.appendChild(probe);
  return {
    resolve(value: string) {
      probe.style.color = '';
      probe.style.color = value;
      return getComputedStyle(probe).color || value;
    },
    done() { probe.remove(); },
  };
}

function parseRgb(c: string): [number, number, number] {
  const m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  return m ? [+m[1] / 255, +m[2] / 255, +m[3] / 255] : [0.1, 0.1, 0.11];
}

/**
 * resolve all canvas tokens as seen from `scope` (default: <html>). returns a new object;
 * the app uses the shared `T`, the style guide uses this to draw both themes side by side.
 */
export function readCanvasTheme(scope: Element = document.documentElement): CanvasTheme {
  const cs = getComputedStyle(scope);
  const r = colorResolver(scope);
  const out = { ...T } as CanvasTheme;
  try {
    for (const [k, prop] of Object.entries(COLOR_TOKENS) as [ColorToken, string][]) {
      const raw = cs.getPropertyValue(prop).trim();
      // plain hex needs no resolution; anything else (rgba, var, color-mix) goes through the probe
      if (raw) out[k] = /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : r.resolve(raw);
    }
    out.font = fonts(cs.getPropertyValue('--font-ui').trim() || FALLBACK_FONT_UI, cs.getPropertyValue('--font-mono').trim() || FALLBACK_FONT_MONO);
    out.name = scope.closest('[data-theme]')?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    out.vpBgRgb = parseRgb(r.resolve(out.vpBg));
    out.axes = [out.axisX, out.axisY, out.axisZ, out.axisW];
    out.labels = [out.tlLabel1, out.tlLabel2, out.tlLabel3, out.tlLabel4, out.tlLabel5, out.tlLabel6, out.tlLabel7, out.tlLabel8];
  } finally { r.done(); }
  return out;
}

/** re-read every token into `T` and notify listeners. runs once per theme change (~90 tokens, about a millisecond) */
export function refreshTheme() {
  if (typeof document === 'undefined') return;
  resolvedFor = document.documentElement.dataset.theme;
  Object.assign(T, readCanvasTheme());
  for (const fn of listeners) fn();
}

/** called after every theme change. returns an unsubscribe function. */
export function onThemeChange(fn: () => void) {
  initTheme();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getTheme(): ThemeName {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** the user's choice: a fixed theme or follow the OS (Settings > Appearance) */
export type ThemePref = ThemeName | 'system';

const STORAGE = 'motion.theme';
let pref: ThemePref = 'dark';
let mql: MediaQueryList | null = null;

export function getThemePref(): ThemePref { return pref; }

function apply(name: ThemeName) {
  const root = document.documentElement;
  // no transitions during the swap (every color transition would fire at once and smear): override,
  // switch, flush styles, remove the override after the next frame
  const off = document.createElement('style');
  off.textContent = '*,*::before,*::after{transition:none!important}';
  document.head.appendChild(off);
  root.dataset.theme = name;
  void document.body?.offsetHeight;
  requestAnimationFrame(() => requestAnimationFrame(() => off.remove()));
  // the mutation observer refreshes asynchronously; refresh now so callers can draw immediately
  refreshTheme();
}

function systemTheme(): ThemeName {
  try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { return 'light'; }
}

/** switch the whole app's theme (persisted). dark is the default; 'system' follows the OS. */
export function setTheme(name: ThemePref) {
  pref = name;
  try { localStorage.setItem(STORAGE, name); } catch { /* private mode */ }
  apply(name === 'system' ? systemTheme() : name);
}

/**
 * apply the saved / requested theme and start watching data-theme. idempotent.
 * `?theme=light` in the url overrides the saved choice (handy for tests and screenshots).
 */
export function initTheme() {
  if (observing || typeof document === 'undefined') return;
  observing = true;
  let wanted: string | null = null;
  try { wanted = new URLSearchParams(location.search).get('theme') ?? localStorage.getItem(STORAGE); } catch { /* */ }
  pref = wanted === 'light' || wanted === 'system' ? wanted : 'dark';
  const initial = pref === 'system' ? systemTheme() : pref;
  document.documentElement.dataset.theme = initial;
  refreshTheme();
  new MutationObserver(() => {
    if (document.documentElement.dataset.theme !== resolvedFor) refreshTheme();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  try {
    mql = matchMedia('(prefers-color-scheme: light)');
    mql.addEventListener('change', () => { if (pref === 'system') apply(systemTheme()); });
  } catch { /* no matchMedia (tests) */ }
}
