// one frame source for every raster export (PNG, PNG sequence, GIF, video, share preview, Lottie
// bakes) and for the export parity harness: the editor's own renderer, at output size, with every
// raster finished synchronously and every figma shader settled for the exact frame. what an
// export writes is therefore the editor's frame, not a re-implementation of it.
//
// frames are rendered into an offscreen RGBA8 target (the editor canvas has no alpha channel), so
// transparent comp backgrounds stay transparent. pixels come back premultiplied, top row first.

import type { Renderer } from '../render/renderer';
import type { Composition } from '../core/model';

export interface FrameGrabOptions {
  /** output size in px (default: the comp size) */
  width?: number;
  height?: number;
}

/** the output covers the comp exactly: scale to cover (even-rounded sizes change the aspect < 1 px), centered */
export function coverView(compW: number, compH: number, w: number, h: number) {
  const zoom = Math.max(w / compW, h / compH);
  return { zoom, panX: (w - compW * zoom) / 2, panY: (h - compH * zoom) / 2 };
}

/** frame time of output frame i at fps, clamped into the comp ([0, duration]) */
export function frameTime(i: number, fps: number, t0 = 0, duration = Infinity): number {
  return Math.min(t0 + i / fps, duration);
}

export class FrameGrabber {
  readonly width: number;
  readonly height: number;
  private fb: WebGLFramebuffer | null = null;
  private tex: WebGLTexture | null = null;
  private prev: { zoom: number; panX: number; panY: number; w: number; h: number; dpr: number; sync: boolean; transparent: boolean; cull: boolean } | null = null;
  private buf: Uint8Array;
  private row: Uint8Array;

  constructor(private r: Renderer, private comp: Composition, opts: FrameGrabOptions = {}) {
    this.width = Math.max(1, Math.round(opts.width ?? comp.width));
    this.height = Math.max(1, Math.round(opts.height ?? comp.height));
    this.buf = new Uint8Array(this.width * this.height * 4);
    this.row = new Uint8Array(this.width * 4);
  }

  /** take over the renderer (callers stop the editor's frame loop first) */
  begin() {
    const r = this.r, gl = r.gl;
    this.prev = { zoom: r.zoom, panX: r.panX, panY: r.panY, w: r.cssW, h: r.cssH, dpr: r.dpr, sync: r.syncRaster, transparent: r.transparentBg, cull: r.cullOffscreen };
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    r.syncRaster = true; // every frame complete and sharp (no async rasters)
    r.transparentBg = true;
    // the canvas keeps its size (only the target is export-sized): no visible flash, no relayout
    r.setTarget({ fb: this.fb!, w: this.width, h: this.height });
    const v = coverView(this.comp.width, this.comp.height, this.width, this.height);
    r.setView(v.zoom, v.panX, v.panY);
    r.dirty = true;
  }

  /** render comp time t; settles async rasters and shaders. leaves the frame in the target */
  async render(t: number) {
    const r = this.r;
    const v = coverView(this.comp.width, this.comp.height, this.width, this.height);
    // (re)apply each frame: ui code (resize observers, theme) may touch the view between tasks
    r.setTarget({ fb: this.fb!, w: this.width, h: this.height });
    r.dpr = 1;
    r.setView(v.zoom, v.panX, v.panY);
    r.syncRaster = true;
    r.transparentBg = true;
    r.render(t);
    // first-time rasters / tiles / atlas repacks: render until nothing is pending
    for (let k = 0; k < 50 && r.dirty; k++) r.render(t);
    await r.settleShaders(t); // figma shaders: wait for this exact frame
    if (r.dirty) r.render(t);
  }

  /** read the last rendered frame: premultiplied RGBA, top row first. the array is reused */
  read(): Uint8Array {
    const gl = this.r.gl, w = this.width, h = this.height, px = this.buf, row = this.row;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // webgl rows are bottom-up
    const stride = w * 4;
    for (let y = 0; y < h >> 1; y++) {
      const a = y * stride, b = (h - 1 - y) * stride;
      row.set(px.subarray(a, a + stride));
      px.copyWithin(a, b, b + stride);
      px.set(row, b);
    }
    return px;
  }

  /** render + read */
  async grab(t: number): Promise<Uint8Array> { await this.render(t); return this.read(); }

  end() {
    const r = this.r, gl = r.gl, p = this.prev;
    r.setTarget(null);
    if (p) {
      r.syncRaster = p.sync;
      r.transparentBg = p.transparent;
      r.cullOffscreen = p.cull;
      r.resize(p.w, p.h, p.dpr);
      r.setView(p.zoom, p.panX, p.panY);
    }
    if (this.fb) gl.deleteFramebuffer(this.fb);
    if (this.tex) gl.deleteTexture(this.tex);
    this.fb = this.tex = null;
    r.dirty = true;
  }
}

// ---------------- pixel helpers (pure, unit tested) ----------------

/** premultiplied -> straight alpha (in place) */
export function unpremultiply<T extends Uint8Array | Uint8ClampedArray>(px: T): T {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 255 || a === 0) { if (a === 0) px[i] = px[i + 1] = px[i + 2] = 0; continue; }
    const k = 255 / a;
    px[i] = Math.min(255, Math.round(px[i] * k));
    px[i + 1] = Math.min(255, Math.round(px[i + 1] * k));
    px[i + 2] = Math.min(255, Math.round(px[i + 2] * k));
  }
  return px;
}

/** premultiplied RGBA over an opaque colour (0..255): the opaque frame a video / GIF shows */
export function flatten(px: Uint8Array, out: Uint8Array, bg: [number, number, number] = [0, 0, 0]): Uint8Array {
  for (let i = 0; i < px.length; i += 4) {
    const k = 255 - px[i + 3];
    out[i] = px[i] + Math.round((bg[0] * k) / 255);
    out[i + 1] = px[i + 1] + Math.round((bg[1] * k) / 255);
    out[i + 2] = px[i + 2] + Math.round((bg[2] * k) / 255);
    out[i + 3] = 255;
  }
  return out;
}
