// texture atlas on a TEXTURE_2D_ARRAY: every raster layer (paths, text, images) lives in
// one texture so the whole scene still renders in a single instanced draw call.
// pages are packed with a simple shelf allocator. when full we grow (gpu-side copy)
// and when we hit the page limit we evict everything not used recently.

export interface AtlasEntry {
  key: string;
  page: number;
  x: number; y: number; w: number; h: number;
  lastUsed: number;
}

interface Shelf { y: number; h: number; x: number }

export const PAGE = 2048;
const MAX_PAGES = 12;

export class Atlas {
  tex: WebGLTexture;
  pages = 0;
  private shelves: Shelf[][] = [];
  private entries = new Map<string, AtlasEntry>();
  frame = 0;
  /** bumped when entries are invalidated (scene must re-resolve raster ids) */
  generation = 0;

  constructor(private gl: WebGL2RenderingContext) {
    this.tex = gl.createTexture()!;
    this.allocate(2);
  }

  private allocate(pages: number) {
    const gl = this.gl;
    const old = this.tex;
    const oldPages = this.pages;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, PAGE, PAGE, pages);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (oldPages > 0) {
      // gpu copy of existing pages
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
      for (let p = 0; p < oldPages; p++) {
        gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, old, 0, p);
        gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, p, 0, 0, PAGE, PAGE);
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(old);
    } else if (old) gl.deleteTexture(old);
    this.tex = tex;
    for (let p = oldPages; p < pages; p++) this.shelves[p] = [];
    this.pages = pages;
  }

  get(key: string): AtlasEntry | undefined {
    const e = this.entries.get(key);
    if (e) e.lastUsed = this.frame;
    return e;
  }

  has(key: string) { return this.entries.has(key); }

  get size() { return this.entries.size; }

  /** reserve space; returns null if it can't fit even after eviction */
  alloc(key: string, w: number, h: number): AtlasEntry | null {
    w = Math.ceil(w) + 2; // 1px gutter each side
    h = Math.ceil(h) + 2;
    if (w > PAGE || h > PAGE) return null;
    let slot = this.findSlot(w, h);
    if (!slot) {
      if (this.pages < MAX_PAGES) {
        this.allocate(Math.min(MAX_PAGES, this.pages * 2));
        slot = this.findSlot(w, h);
      }
      if (!slot) {
        this.evictAll();
        slot = this.findSlot(w, h);
        if (!slot) return null;
      }
    }
    const e: AtlasEntry = { key, page: slot.page, x: slot.x + 1, y: slot.y + 1, w: w - 2, h: h - 2, lastUsed: this.frame };
    this.entries.set(key, e);
    return e;
  }

  private findSlot(w: number, h: number) {
    for (let p = 0; p < this.pages; p++) {
      const shelves = this.shelves[p];
      // best fitting existing shelf
      let best: Shelf | null = null;
      for (const s of shelves) {
        if (s.h >= h && s.h <= h * 1.5 + 8 && PAGE - s.x >= w && (!best || s.h < best.h)) best = s;
      }
      if (best) {
        const x = best.x;
        best.x += w;
        return { page: p, x, y: best.y };
      }
      const top = shelves.length ? shelves[shelves.length - 1].y + shelves[shelves.length - 1].h : 0;
      if (top + h <= PAGE) {
        // round shelf height up a little so similar sized items share it
        const sh = Math.min(PAGE - top, Math.ceil(h / 8) * 8);
        shelves.push({ y: top, h: sh, x: w });
        return { page: p, x: 0, y: top };
      }
    }
    return null;
  }

  /** upload rgba pixels (non premultiplied raw bytes, or a canvas/bitmap) */
  upload(e: AtlasEntry, src: TexImageSource | Uint8Array, premultiply = false) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    if (src instanceof Uint8Array) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, e.x, e.y, e.page, e.w, e.h, 1, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } else {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, e.x, e.y, e.page, e.w, e.h, 1, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  evictAll() {
    this.entries.clear();
    for (let p = 0; p < this.pages; p++) this.shelves[p] = [];
    this.generation++;
  }

  /** drop entries not used for a while when the atlas is getting full (called from idle frames) */
  maybeCompact() {
    let used = 0;
    for (const p of this.shelves) { const top = p.length ? p[p.length - 1].y + p[p.length - 1].h : 0; used += top; }
    if (used < this.pages * PAGE * 0.85 || this.pages < MAX_PAGES) return false;
    this.evictAll();
    return true;
  }

  dispose() { this.gl.deleteTexture(this.tex); }
}
