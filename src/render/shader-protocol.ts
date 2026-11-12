// messages between the renderer (main thread) and the shader worker (render/shader-worker.ts).
// only plain data and transferables cross: the shader modules never see the main window.

export interface ShaderModuleSrc {
  /** cache key of the module (asset key) */
  key: string;
  /** main.ts source (typescript allowed) */
  code: string;
}

/** one shader pass of a job: a fill (no input) or one effect of a chain */
export interface ShaderPass {
  /** persistent instance (frame.state lives as long as it does): `${item}:${slot}` */
  inst: string;
  mod: ShaderModuleSrc;
  params: Record<string, unknown>;
}

export interface ShaderJob {
  type: 'render';
  job: number;
  /** output size in device pixels */
  w: number;
  h: number;
  /** device px per design unit (frame.renderScale) */
  renderScale: number;
  /** ms (frame.time) */
  time: number;
  deltaTime: number;
  mouse: { x: number; y: number } | null;
  passes: ShaderPass[];
  /** effects: the rendered layer, premultiplied rgba8, rows top-down, w*h*4 bytes */
  input?: { w: number; h: number; data: ArrayBuffer } | null;
  /** 'bitmap' (default): result as ImageBitmap; 'pixels': rgba8 bytes (tests, fallback) */
  out?: 'bitmap' | 'pixels';
}

export type ToWorker =
  | ShaderJob
  | { type: 'dispose'; inst: string }
  | { type: 'describe'; job: number; mod: ShaderModuleSrc };

export type FromWorker =
  | { type: 'ready'; ok: boolean; error?: string; adapter?: string }
  | { type: 'done'; job: number; bitmap?: ImageBitmap; pixels?: ArrayBuffer; w: number; h: number; ms: number; input?: ArrayBuffer; errors?: { inst: string; error: string }[] }
  | { type: 'failed'; job: number; error: string; inst?: string; input?: ArrayBuffer }
  | { type: 'schema'; job: number; schema: Record<string, unknown> | null; error?: string };
