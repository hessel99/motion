// document model. plain json-serializable objects so the project can be saved,
// sent to agents and diffed. hot-path evaluation lives in evaluate.ts and works
// on compiled typed-array tracks, never on these objects directly.

export type Interp = 'bezier' | 'linear' | 'hold' | 'spring';

export interface Keyframe {
  /** time in seconds (composition time) */
  t: number;
  /** value; length = property dimension */
  v: number[];
  /** interpolation used when leaving this keyframe */
  interp: Interp;
  /** temporal ease handles, normalized 0..1 in time; y is relative progress (can overshoot).
   *  out = handle leaving this keyframe, in = handle arriving at this keyframe. */
  out: [number, number];
  in: [number, number];
  /** spring bounce 0..1 when interp = 'spring' (settles exactly at the next keyframe) */
  bounce?: number;
  /** optional spatial tangents (position only), relative to the keyframe value, like after effects / lottie */
  sOut?: number[];
  sIn?: number[];
  /** linked to a color/number style (token id, see core/tokens.ts): `v` is kept equal to the
   *  token's value, and a library sync rewrites it */
  tok?: string;
}

export interface Prop {
  /** static value (used when there are no keyframes) */
  v: number[];
  kf?: Keyframe[];
  /** expression (safe mini language, see core/expr.ts); `value` = keyframed/static value */
  expr?: string;
  /** static value linked to a style (token id). `v` always holds the resolved value, so the renderer
   *  and every exporter read plain numbers: bindings cost nothing per frame */
  bind?: string;
}

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'add' | 'darken' | 'lighten'
  // modes that need the backdrop (rendered with a compositing shader)
  | 'overlay' | 'softLight' | 'hardLight' | 'colorDodge' | 'colorBurn' | 'linearBurn'
  | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';
export const BLEND_MODES: BlendMode[] = [
  'normal', 'darken', 'multiply', 'linearBurn', 'colorBurn', 'lighten', 'screen', 'add', 'colorDodge',
  'overlay', 'softLight', 'hardLight', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];
/** modes the gpu blend unit does on its own (everything else composites through a shader) */
export const SIMPLE_BLENDS: ReadonlySet<BlendMode> = new Set<BlendMode>(['normal', 'multiply', 'screen', 'add', 'lighten']); // darken: MIN on a quad's transparent pixels draws a black box

export type LayerType = 'group' | 'rect' | 'ellipse' | 'path' | 'text' | 'image' | 'precomp' | 'audio';

/** ordered list of animatable properties shown in timeline / inspector */
export const PROP_DEFS = {
  anchor: { label: 'Anchor Point', dim: 2, default: [0, 0], unit: 'px' },
  position: { label: 'Position', dim: 2, default: [0, 0], unit: 'px' },
  scale: { label: 'Scale', dim: 2, default: [100, 100], unit: '%' },
  rotation: { label: 'Rotation', dim: 1, default: [0], unit: '°' },
  opacity: { label: 'Opacity', dim: 1, default: [100], unit: '%', min: 0, max: 100 },
  size: { label: 'Size', dim: 2, default: [100, 100], unit: 'px', min: 0 },
  radius: { label: 'Corner Radius', dim: 4, default: [0, 0, 0, 0], unit: 'px', min: 0 },
  fill: { label: 'Fill', dim: 4, default: [1, 1, 1, 1], unit: 'color' },
  stroke: { label: 'Stroke', dim: 4, default: [0, 0, 0, 0], unit: 'color' },
  strokeWidth: { label: 'Stroke Width', dim: 1, default: [0], unit: 'px', min: 0 },
  trimStart: { label: 'Trim Start', dim: 1, default: [0], unit: '%', min: 0, max: 100 },
  trimEnd: { label: 'Trim End', dim: 1, default: [100], unit: '%', min: 0, max: 100 },
  trimOffset: { label: 'Trim Offset', dim: 1, default: [0], unit: '°' },
  // effects (see Effect below): the first effect of each type reads these, so shadows, blurs and
  // noise are keyframable like any property (timeline, graph editor, agent tools)
  shadowColor: { label: 'Shadow Color', dim: 4, default: [0, 0, 0, 0.25], unit: 'color' },
  shadowOffset: { label: 'Shadow Offset', dim: 2, default: [0, 4], unit: 'px' },
  shadowBlur: { label: 'Shadow Blur', dim: 1, default: [4], unit: 'px', min: 0 },
  shadowSpread: { label: 'Shadow Spread', dim: 1, default: [0], unit: 'px' },
  innerShadowColor: { label: 'Inner Shadow Color', dim: 4, default: [0, 0, 0, 0.25], unit: 'color' },
  innerShadowOffset: { label: 'Inner Shadow Offset', dim: 2, default: [0, 4], unit: 'px' },
  innerShadowBlur: { label: 'Inner Shadow Blur', dim: 1, default: [4], unit: 'px', min: 0 },
  innerShadowSpread: { label: 'Inner Shadow Spread', dim: 1, default: [0], unit: 'px' },
  blur: { label: 'Layer Blur', dim: 1, default: [0], unit: 'px', min: 0 },
  backgroundBlur: { label: 'Background Blur', dim: 1, default: [0], unit: 'px', min: 0 },
  noiseColor: { label: 'Noise Color', dim: 4, default: [0, 0, 0, 0.25], unit: 'color' },
  noiseSize: { label: 'Noise Size', dim: 1, default: [1], unit: 'px', min: 0 },
  noiseDensity: { label: 'Noise Density', dim: 1, default: [50], unit: '%', min: 0, max: 100 },
} as const;

export type PropKey = keyof typeof PROP_DEFS;
export const PROP_KEYS = Object.keys(PROP_DEFS) as PropKey[];
export const TRANSFORM_KEYS: PropKey[] = ['anchor', 'position', 'scale', 'rotation', 'opacity'];

/** effect parameters (animatable). a layer only has the ones it uses */
export const EFFECT_KEYS: PropKey[] = [
  'shadowColor', 'shadowOffset', 'shadowBlur', 'shadowSpread',
  'innerShadowColor', 'innerShadowOffset', 'innerShadowBlur', 'innerShadowSpread',
  'blur', 'backgroundBlur', 'noiseColor', 'noiseSize', 'noiseDensity',
];

/** which props each layer type exposes (beyond transform) */
export const TYPE_PROPS: Record<LayerType, PropKey[]> = {
  group: ['size', 'radius', 'fill', 'stroke', 'strokeWidth', ...EFFECT_KEYS],
  rect: ['size', 'radius', 'fill', 'stroke', 'strokeWidth', ...EFFECT_KEYS],
  ellipse: ['size', 'fill', 'stroke', 'strokeWidth', ...EFFECT_KEYS],
  path: ['size', 'fill', 'stroke', 'strokeWidth', 'trimStart', 'trimEnd', 'trimOffset', ...EFFECT_KEYS],
  text: ['size', 'fill', ...EFFECT_KEYS],
  image: ['size', ...EFFECT_KEYS],
  audio: [],
  precomp: ['size', ...EFFECT_KEYS],
};

export type PathCmd =
  | ['M', number, number]
  | ['L', number, number]
  | ['C', number, number, number, number, number, number]
  | ['Q', number, number, number, number]
  | ['Z'];

export interface PathGeometry {
  cmds: PathCmd[];
  fillRule: 'nonzero' | 'evenodd';
  /** this region's own paints (figma vector networks with differently filled regions) */
  paints?: Paint[];
}

export interface GradientStop { pos: number; color: [number, number, number, number] }

/** image adjustments in figma's ranges (-1..1, 0 = unchanged) */
export interface ImageFilters {
  exposure?: number; contrast?: number; saturation?: number; temperature?: number; tint?: number; highlights?: number; shadows?: number;
}

export type PaintType = 'solid' | 'linear' | 'radial' | 'angular' | 'diamond' | 'image' | 'noise' | 'pattern';
export interface Paint {
  type: PaintType;
  color?: [number, number, number, number];
  stops?: GradientStop[];
  /** gradient transform: maps unit gradient space to layer box (a,b,c,d,e,f). gradient space:
   *  linear runs (0,.5) -> (1,.5); radial / diamond / angular are centered at (.5,.5) with radius .5
   *  (angular starts at +x and turns clockwise, y down). image 'stretch' (crop): unit image square -> box */
  transform?: number[];
  imageRef?: string;
  opacity?: number;
  /** blend mode of this paint over the paints below it (same layer) */
  blend?: BlendMode;
  /** image paints: how the image covers the box */
  scaleMode?: 'fill' | 'fit' | 'tile' | 'stretch';
  /** image rotation in degrees (figma rotates by 90° steps) */
  rotation?: number;
  /** tile scale (tile mode: 1 = native image pixels) */
  tileScale?: number;
  filters?: ImageFilters;
  /** noise paint (figma "noise" fill) */
  noise?: NoiseParams;
}

export interface NoiseParams {
  mode: 'mono' | 'duo' | 'multi';
  /** grain cell size (px) */
  size: number;
  /** share of the cells that get grain, 0..1 */
  density: number;
  /** mono: grain color; duo: first color */
  color?: number[];
  /** duo: second color */
  secondary?: number[];
  /** multi: grain opacity */
  opacity?: number;
  seed?: number;
}

export type EffectType = 'dropShadow' | 'innerShadow' | 'layerBlur' | 'backgroundBlur' | 'noise' | 'texture' | 'glass';
/** a layer effect, figma order. the FIRST effect of each type takes its animatable values from the
 *  layer props when the layer has them (shadowColor / shadowOffset / shadowBlur / shadowSpread,
 *  innerShadow*, blur, backgroundBlur, noiseColor / noiseSize / noiseDensity); the fields here are
 *  the static values (and the only values of further effects of that type). a layer with e.g. a
 *  shadowColor prop and no dropShadow effect gets one implicitly (agents can just set props). */
export interface Effect {
  type: EffectType;
  visible?: boolean;
  color?: number[];
  offset?: [number, number];
  /** blur radius (figma units: gaussian sigma = radius / 2) */
  radius?: number;
  spread?: number;
  blend?: BlendMode;
  /** drop shadow: also visible through transparent parts of the layer (figma "show behind") */
  showBehind?: boolean;
  /** progressive layer / background blur: radius goes from startRadius at `start` to radius at
   *  `end` (points in the layer box, 0..1) */
  progressive?: { start: [number, number]; end: [number, number]; startRadius: number };
  /** noise / texture effects */
  noise?: NoiseParams;
  /** texture / glass parameters (best effort, see docs/figma-fidelity.md) */
  params?: Record<string, number>;
}

export interface TextRun {
  /** [start, end) in content (utf-16 indices) */
  start: number;
  end: number;
  fontFamily?: string;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic';
  fontSize?: number;
  fill?: number[];
  decoration?: 'underline' | 'strike';
  letterSpacing?: number;
}

/** figma's own glyph outlines of a text layer (exact fonts, kerning, features, wrapping, lists).
 *  drawn while the text still matches `sig` (textSig); after an edit, live layout takes over */
export interface TextOutline {
  sig: string;
  /** glyph + decoration geometry per style, in the local box; fill null = the layer fill */
  groups: { geometry: PathGeometry[]; fill: number[] | null }[];
}

export interface TextData {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle?: 'normal' | 'italic';
  lineHeight: number; // multiplier
  letterSpacing: number; // px
  align: 'left' | 'center' | 'right' | 'justify';
  valign?: 'top' | 'center' | 'bottom';
  /** 'width': the box grows with the text (no wrapping); 'height': wraps at the box width */
  autoResize?: 'width' | 'height';
  decoration?: 'underline' | 'strike';
  /** extra space after each paragraph (px) */
  paragraphSpacing?: number;
  /** first-line indent of each paragraph (px) */
  paragraphIndent?: number;
  /** applied when drawn (content stays as typed) */
  textCase?: 'upper' | 'lower' | 'title' | 'smallCaps';
  /** truncate with an ellipsis after this many lines */
  maxLines?: number;
  truncate?: boolean;
  /** style runs (figma character style overrides) */
  runs?: TextRun[];
  /** opentype features switched on ('ss01') or off ('-liga') */
  features?: string[];
  /** variable font axes (tag -> value) */
  variations?: Record<string, number>;
  /** list marker per paragraph */
  lists?: ('ul' | 'ol' | null)[];
  outline?: TextOutline;
}

/** what a text layer's look depends on: TextOutline.sig must equal this for the outline to be used */
export function textSig(t: TextData, size: number[] | undefined): string {
  return [t.content, t.fontFamily, t.fontSize, t.fontWeight, t.fontStyle ?? 'normal', t.lineHeight, t.letterSpacing, t.align, t.textCase ?? '', t.paragraphSpacing ?? 0, Math.round(size?.[0] ?? 0), Math.round(size?.[1] ?? 0)].join('|');
}

/** keyframed path shape (morphing). commands are interpolated pairwise when the structure matches */
export interface PathKey {
  t: number;
  geometry: PathGeometry[];
  interp: Interp;
  out: [number, number];
  in: [number, number];
}

/** parametric per-unit text animation (text reveal), evaluated in the renderer */
export interface TextAnim {
  by: 'char' | 'word' | 'line';
  /** comp time the first unit starts (relative to the layer's own time) */
  start: number;
  /** seconds per unit */
  duration: number;
  /** delay between units */
  stagger: number;
  /** ease preset name or 'spring:<bounce>' */
  ease: string;
  /** 'in': animate from `from` to normal. 'out': from normal to `from` */
  mode: 'in' | 'out';
  /** unit order: forward, backward, center-out, random */
  order?: 'forward' | 'backward' | 'center' | 'random';
  from: { opacity: number; dx: number; dy: number; scale: number; rotation: number };
}

export interface Layer {
  id: string;
  name: string;
  type: LayerType;
  parent: string | null; // null = composition root
  children: string[]; // draw order: first = bottom
  visible: boolean;
  locked: boolean;
  /** clip children to this layer's box (figma frame "clip content") */
  clip?: boolean;
  /** figma-style mask: this layer's alpha masks the siblings above it (in the same parent) */
  mask?: boolean;
  /** what the mask uses: alpha (default), luminance, or the shape outline ("vector": geometry
   *  coverage, ignoring fill opacity) */
  maskType?: 'alpha' | 'luminance' | 'vector';
  /** blend mode with what is below (premultiplied colors) */
  blend?: BlendMode;
  /** effects (shadows, blurs, noise...), figma order */
  effects?: Effect[];
  /** group composites as one image (figma NORMAL group, vs pass-through): its children's blend
   *  modes only see the group's own content */
  isolate?: boolean;
  /** in/out points in seconds; layer is hidden outside */
  inPoint: number;
  outPoint: number;
  props: Partial<Record<PropKey, Prop>>;
  /** fills beyond a single solid color (gradients) make the layer render through the raster path */
  paints?: Paint[];
  strokeAlign?: 'inside' | 'center' | 'outside';
  /** stroke paints beyond one color (gradients, images); strokeWidth still sets the width */
  strokePaints?: Paint[];
  /** dash pattern (px, alternating dash / gap) */
  dash?: number[];
  strokeCap?: 'butt' | 'round' | 'square';
  strokeJoin?: 'miter' | 'round' | 'bevel';
  miterLimit?: number;
  /** per-side stroke weights of a box [top, right, bottom, left] (figma "individual strokes") */
  strokeSides?: [number, number, number, number];
  /** corner smoothing 0..1 (squircle corners; figma's "iOS" preset is 0.6) */
  smoothing?: number;
  geometry?: PathGeometry[]; // for 'path': coordinates in geometry space (0..geomSize)
  /** size the geometry was authored at; rendering scales geometry by size/geomSize */
  geomSize?: [number, number];
  /** animated path shape (overrides `geometry` over time) */
  pathKf?: PathKey[];
  /** parametric shape a path was generated from (star / polygon tool): its geometry is rebuilt from it */
  shape?: { kind: 'star' | 'polygon'; points: number; inner: number };
  /** trim paths on the stroke (values: props trimStart / trimEnd / trimOffset) */
  trimOn?: boolean;
  strokeGeometry?: PathGeometry[];
  text?: TextData;
  textAnim?: TextAnim;
  imageRef?: string; // asset id
  /** audio: volume 0..1 (startTime = when the clip starts, in comp time) */
  volume?: number;
  /** precomp: referenced composition id and when it starts (comp time) */
  compRef?: string;
  startTime?: number;
  /** component instance link (see core/components.ts): this layer mirrors main-component layer `main` */
  link?: InstanceLink;
  /** stable key the agent's build_scene gave this layer (re-building with the same key updates it) */
  sceneKey?: string;
  /** ui state */
  collapsed?: boolean;
}

/** an instance layer mirrors one layer of a main component. fields listed in `ov` were changed on the
 *  instance (overrides) and are not overwritten when the main changes. the instance ROOT also
 *  carries its offset from the main: position (dx, dy) and time (dt) */
export interface InstanceLink {
  main: string;
  ov?: string[];
  dx?: number;
  dy?: number;
  dt?: number;
}

/** a main component: the layer (with its subtree) whose id keys Project.components */
export interface ComponentInfo {
  name: string;
  /** figma component key (or symbol guid) it was pasted from: later pastes link to it */
  figmaKey?: string;
  description?: string;
}

/** a named color or number ("style"/"variable"/"design token") that layer properties can link to */
export interface Token {
  id: string;
  /** path with slashes, e.g. "Brand/Primary" (groups the palette) */
  name: string;
  type: 'color' | 'number';
  /** value per mode name. colors are [r,g,b,a] 0..1, numbers [n] */
  values: Record<string, number[]>;
  /** where it was synced from (re-sync matches on this key) */
  source?: { kind: 'figma-variable' | 'figma-style' | 'file' | 'figma-api'; key: string; from?: string };
  description?: string;
  /** removed from its library in the last sync but still used here */
  missing?: boolean;
}

export interface TokenSource {
  id: string;
  kind: 'file' | 'url' | 'figma-api';
  label: string;
  /** file path (desktop), url, or figma file key */
  location: string;
  lastSync?: number;
}

export interface TokenLibrary {
  items: Record<string, Token>;
  /** mode names (e.g. Light, Dark). always at least one */
  modes: string[];
  /** active mode */
  mode: string;
  sources?: TokenSource[];
}

export interface Composition {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  background: [number, number, number, number];
  root: string[]; // top-level layers, first = bottom
  /** timeline markers (comp time, sorted) */
  markers?: Marker[];
}

export interface Marker { id: string; t: number; label: string }

export interface Asset {
  id: string;
  kind: 'image' | 'audio';
  mime: string;
  /** data url (portable). large assets could move to a blob store later */
  data: string;
  width: number;
  height: number;
}

export interface Project {
  version: 1;
  name: string;
  comps: Record<string, Composition>;
  activeComp: string;
  layers: Record<string, Layer>;
  assets: Record<string, Asset>;
  /** colors / numbers layers can link to (optional: older files have none) */
  tokens?: TokenLibrary;
  /** main components by main layer id */
  components?: Record<string, ComponentInfo>;
}

let idCounter = 0;
const idPrefix = Math.random().toString(36).slice(2, 6);
export function uid(prefix = 'l'): string {
  return `${prefix}_${idPrefix}${(idCounter++).toString(36)}`;
}

export function prop(v: number[]): Prop {
  return { v: v.slice() };
}

export function defaultEase(): Pick<Keyframe, 'interp' | 'out' | 'in'> {
  // "ease in out" (after effects easy ease = 33.33% influence, 0 speed)
  return { interp: 'bezier', out: [0.333, 0], in: [0.667, 1] };
}

export function createLayer(type: LayerType, init: Partial<Layer> & { x?: number; y?: number; w?: number; h?: number; color?: number[] } = {}): Layer {
  const w = init.w ?? 200, h = init.h ?? 200;
  const x = init.x ?? 0, y = init.y ?? 0;
  const props: Layer['props'] = {
    anchor: prop([w / 2, h / 2]),
    position: prop([x + w / 2, y + h / 2]),
    scale: prop([100, 100]),
    rotation: prop([0]),
    opacity: prop([100]),
    size: prop([w, h]),
  };
  if (type === 'rect' || type === 'group') props.radius = prop([0, 0, 0, 0]);
  if (type !== 'image') props.fill = prop(init.color ?? (type === 'group' ? [1, 1, 1, 0] : [0.42, 0.55, 1, 1]));
  if (type !== 'text' && type !== 'image') {
    props.stroke = prop([0, 0, 0, 1]);
    props.strokeWidth = prop([0]);
  }
  const { x: _x, y: _y, w: _w, h: _h, color: _c, ...rest } = init;
  return {
    id: uid(),
    name: type[0].toUpperCase() + type.slice(1),
    type,
    parent: null,
    children: [],
    visible: true,
    locked: false,
    inPoint: 0,
    outPoint: 1e9,
    props,
    ...rest,
  };
}

export function createComp(init: Partial<Composition> = {}): Composition {
  return {
    id: uid('c'),
    name: 'Main',
    width: 1920,
    height: 1080,
    fps: 60,
    duration: 5,
    background: [0.07, 0.07, 0.08, 1],
    root: [],
    ...init,
  };
}

export function createProject(name = 'Untitled'): Project {
  const comp = createComp();
  return { version: 1, name, comps: { [comp.id]: comp }, activeComp: comp.id, layers: {}, assets: {} };
}

export function getPropValue(layer: Layer, key: PropKey): number[] {
  return layer.props[key]?.v ?? (PROP_DEFS[key].default as unknown as number[]);
}
