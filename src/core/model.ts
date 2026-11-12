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
}

export interface Prop {
  /** static value (used when there are no keyframes) */
  v: number[];
  kf?: Keyframe[];
  /** expression (safe mini language, see core/expr.ts); `value` = keyframed/static value */
  expr?: string;
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'add' | 'darken' | 'lighten';
export const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'add', 'darken', 'lighten'];

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
} as const;

export type PropKey = keyof typeof PROP_DEFS;
export const PROP_KEYS = Object.keys(PROP_DEFS) as PropKey[];
export const TRANSFORM_KEYS: PropKey[] = ['anchor', 'position', 'scale', 'rotation', 'opacity'];

/** which props each layer type exposes (beyond transform) */
export const TYPE_PROPS: Record<LayerType, PropKey[]> = {
  group: ['size', 'radius', 'fill', 'stroke', 'strokeWidth'],
  rect: ['size', 'radius', 'fill', 'stroke', 'strokeWidth'],
  ellipse: ['size', 'fill', 'stroke', 'strokeWidth'],
  path: ['size', 'fill', 'stroke', 'strokeWidth', 'trimStart', 'trimEnd', 'trimOffset'],
  text: ['size', 'fill'],
  image: ['size'],
  audio: [],
  precomp: ['size'],
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
}

export interface GradientStop { pos: number; color: [number, number, number, number] }
export interface Paint {
  type: 'solid' | 'linear' | 'radial' | 'image';
  color?: [number, number, number, number];
  stops?: GradientStop[];
  /** gradient transform: maps unit gradient space to layer box (a,b,c,d,e,f) */
  transform?: number[];
  imageRef?: string;
  opacity?: number;
}

export interface TextData {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle?: 'normal' | 'italic';
  lineHeight: number; // multiplier
  letterSpacing: number; // px
  align: 'left' | 'center' | 'right';
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
  /** blend mode with what is below (gpu blend functions; premultiplied colors) */
  blend?: BlendMode;
  /** in/out points in seconds; layer is hidden outside */
  inPoint: number;
  outPoint: number;
  props: Partial<Record<PropKey, Prop>>;
  /** fills beyond a single solid color (gradients) make the layer render through the raster path */
  paints?: Paint[];
  strokeAlign?: 'inside' | 'center' | 'outside';
  geometry?: PathGeometry[]; // for 'path': coordinates in geometry space (0..geomSize)
  /** size the geometry was authored at; rendering scales geometry by size/geomSize */
  geomSize?: [number, number];
  /** animated path shape (overrides `geometry` over time) */
  pathKf?: PathKey[];
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
  /** ui state */
  collapsed?: boolean;
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
}

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
