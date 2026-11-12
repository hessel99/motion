// texture atlas on a TEXTURE_2D_ARRAY: every raster layer (paths, text, images) lives in
// one texture so the whole scene still renders in a single instanced draw call.
//
// performance design (learned the hard way, see NOTES.md):
//  - every page has a CPU shadow copy. rasters are written into the shadow, and at most ONE
//    texSubImage3D per dirty page per frame uploads the changed rows (flush()).
//    many small uploads into a texture that the gpu is still reading forced drivers to stall
//    or copy the whole array per call (llvmpipe: ~170ms frames and finally an oom crash).
//  - compaction (dropping stale entries) and growth happen on the shadows, no gpu read-back.
//  - pages are packed with a shelf allocator.

export interface AtlasEntry {
  key: string;
  page: number;
  x: number; y: number; w: number; h: number;
  lastUsed: number;
  /** evicted: holders must re-resolve */
  dead?: boolean;
}

interface Shelf { y: number; h: number; x: number }
interface Dirty { x0: number; y0: number; x1: number; y1: number; rects: number[]; area: number }

export const PAGE = 2048;
const MAX_PAGES = 12;

export class Atlas {
  tex: WebGLTexture;
  pages = 0;
  private shelves: Shelf[][] = [];
  private shadow: Uint8Array[] = [];
  private dirty: (Dirty | null)[] = [];
  private entries = new Map<string, AtlasEntry>();
  frame = 0;
  /** bumped when everything was evicted */
  generation = 0;
  compactions = 0;
  uploadsLastFlush = 0;

  constructor(private gl: WebGL2RenderingContext) {
    this.tex = gl.createTexture()!;
    this.allocate(2);
  }

  /** (re)create the gpu texture with `pages` layers; shadows are the source of truth */
  private allocate(pages: number) {
    const gl = this.gl;
    gl.deleteTexture(this.tex);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, PAGE, PAGE, pages);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex = tex;
    for (let p = 0; p < pages; p++) {
      if (!this.shelves[p]) this.shelves[p] = [];
      // existing shadow pages must be re-uploaded into the new texture
      this.dirty[p] = this.shadow[p] ? fullDirty(this.usedHeight(p)) : null;
    }
    this.pages = pages;
  }

  private usedHeight(p: number) {
    const sh = this.shelves[p];
    return sh && sh.length ? sh[sh.length - 1].y + sh[sh.length - 1].h : 0;
  }

  private page(p: number) {
    let s = this.shadow[p];
    if (!s) this.shadow[p] = s = new Uint8Array(PAGE * PAGE * 4);
    return s;
  }

  get(key: string): AtlasEntry | undefined {
    const e = this.entries.get(key);
    if (e) e.lastUsed = this.frame;
    return e;
  }

  has(key: string) { return this.entries.has(key); }
  get size() { return this.entries.size; }

  /** reserve space; returns null if it can't fit even after compaction/eviction */
  alloc(key: string, w: number, h: number): AtlasEntry | null {
    w = Math.ceil(w) + 2; // 1px gutter each side
    h = Math.ceil(h) + 2;
    if (w > PAGE || h > PAGE) return null;
    let slot = this.findSlot(w, h);
    if (!slot) {
      if (this.compact(120)) slot = this.findSlot(w, h);
      if (!slot && this.pages < MAX_PAGES) {
        this.allocate(Math.min(MAX_PAGES, this.pages * 2));
        slot = this.findSlot(w, h);
      }
      if (!slot && this.compact(1)) slot = this.findSlot(w, h);
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
      let best: Shelf | null = null;
      for (const s of shelves) {
        if (s.h >= h && s.h <= h * 1.5 + 8 && PAGE - s.x >= w && (!best || s.h < best.h)) best = s;
      }
      if (best) {
        const x = best.x;
        best.x += w;
        return { page: p, x, y: best.y };
      }
      const top = this.usedHeight(p);
      if (top + h <= PAGE) {
        const sh = Math.min(PAGE - top, Math.ceil(h / 8) * 8);
        shelves.push({ y: top, h: sh, x: w });
        return { page: p, x: 0, y: top };
      }
    }
    return null;
  }

  /** write rgba bytes (w*h*4, final format) into the shadow; uploaded on flush() */
  upload(e: AtlasEntry, src: Uint8Array) {
    const s = this.page(e.page);
    const rowBytes = e.w * 4;
    // clear the 1px gutter so neighbours never bleed under linear filtering
    this.clearRect(s, e.x - 1, e.y - 1, e.w + 2, e.h + 2);
    for (let r = 0; r < e.h; r++) s.set(src.subarray(r * rowBytes, r * rowBytes + rowBytes), ((e.y + r) * PAGE + e.x) * 4);
    this.markDirty(e.page, e.x - 1, e.y - 1, e.x + e.w + 1, e.y + e.h + 1);
  }

  private clearRect(s: Uint8Array, x: number, y: number, w: number, h: number) {
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    w = Math.min(PAGE - x, w); h = Math.min(PAGE - y, h);
    for (let r = 0; r < h; r++) s.fill(0, ((y + r) * PAGE + x) * 4, ((y + r) * PAGE + x + w) * 4);
  }

  private markDirty(p: number, x0: number, y0: number, x1: number, y1: number) {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(PAGE, x1); y1 = Math.min(PAGE, y1);
    let d = this.dirty[p];
    if (!d) this.dirty[p] = d = { x0, y0, x1, y1, rects: [], area: 0 };
    else { d.x0 = Math.min(d.x0, x0); d.y0 = Math.min(d.y0, y0); d.x1 = Math.max(d.x1, x1); d.y1 = Math.max(d.y1, y1); }
    d.rects.push(x0, y0, x1, y1);
    d.area += (x1 - x0) * (y1 - y0);
  }

  /** upload this frame's changes. per page: the union rect if it is compact, otherwise the
   *  individual rects (capped). WebGL2 unpack params let us upload a sub-rectangle of the
   *  shadow without copying it, so uploads are only as big as what changed. */
  flush() {
    const gl = this.gl;
    let n = 0;
    for (let p = 0; p < this.pages; p++) {
      const d = this.dirty[p];
      if (!d) continue;
      this.dirty[p] = null;
      const s = this.shadow[p];
      if (!s || d.x1 <= d.x0 || d.y1 <= d.y0) continue;
      if (n === 0) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, PAGE);
        // 3d uploads: skip rows are only valid when the source image height is declared
        gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, PAGE);
      }
      const unionArea = (d.x1 - d.x0) * (d.y1 - d.y0);
      const rects = d.rects.length / 4 <= 24 && unionArea > d.area * 3 ? d.rects : [d.x0, d.y0, d.x1, d.y1];
      for (let i = 0; i < rects.length; i += 4) {
        const x0 = rects[i], y0 = rects[i + 1], w = rects[i + 2] - x0, h = rects[i + 3] - y0;
        if (w <= 0 || h <= 0) continue;
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x0, y0, p, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, s);
        n++;
      }
    }
    if (n) {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    }
    this.uploadsLastFlush = n;
  }

  /** repack entries used within `maxAge` frames on the cpu shadows; entries keep their identity
   *  (x/y/page updated in place) and stale ones are marked dead. returns true if it freed anything. */
  compact(maxAge: number): boolean {
    const live: AtlasEntry[] = [];
    for (const e of this.entries.values()) if (this.frame - e.lastUsed <= maxAge) live.push(e);
    if (live.length === this.entries.size) return false;
    const oldShadow = this.shadow;
    this.shadow = [];
    for (let p = 0; p < this.pages; p++) this.shelves[p] = [];
    live.sort((a, b) => b.h - a.h);
    const keep = new Map<string, AtlasEntry>();
    for (const e of live) {
      const slot = this.findSlot(e.w + 2, e.h + 2);
      if (!slot) continue;
      const src = oldShadow[e.page];
      const dst = this.page(slot.page);
      const nx = slot.x + 1, ny = slot.y + 1;
      if (src) for (let r = 0; r < e.h; r++) {
        const so = ((e.y + r) * PAGE + e.x) * 4;
        dst.set(src.subarray(so, so + e.w * 4), ((ny + r) * PAGE + nx) * 4);
      }
      e.page = slot.page; e.x = nx; e.y = ny;
      keep.set(e.key, e);
    }
    for (const e of this.entries.values()) if (!keep.has(e.key)) e.dead = true;
    this.entries = keep;
    for (let p = 0; p < this.pages; p++) this.dirty[p] = this.shadow[p] ? fullDirty(this.usedHeight(p)) : null;
    this.compactions++;
    return true;
  }

  evictAll() {
    for (const e of this.entries.values()) e.dead = true;
    this.entries.clear();
    for (let p = 0; p < this.pages; p++) { this.shelves[p] = []; this.dirty[p] = null; }
    this.shadow = [];
    this.generation++;
  }

  /** bytes held by cpu shadows (for the hud) */
  get shadowBytes() { return this.shadow.reduce((s, p) => s + (p ? p.byteLength : 0), 0); }

  dispose() { this.gl.deleteTexture(this.tex); }
}

function fullDirty(h: number): Dirty { return { x0: 0, y0: 0, x1: PAGE, y1: h, rects: [0, 0, PAGE, h], area: PAGE * h }; }
