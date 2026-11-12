// texture atlas on a TEXTURE_2D_ARRAY: every raster layer (paths, text, images) lives in
// one texture so the whole scene still renders in a single instanced draw call.
//
// performance design (learned the hard way, see NOTES.md):
//  - every page has a CPU shadow copy. rasters are written into the shadow, and at most ONE
//    texSubImage3D per dirty page per frame uploads the changed rows (flush()).
//    many small uploads into a texture that the gpu is still reading forced drivers to stall
//    or copy the whole array per call (llvmpipe: ~170ms frames and finally an oom crash).
//  - compaction and growth happen on the shadows, no gpu read-back.
//  - pages are packed with a shelf allocator. freed slots become free spans on their shelf and are
//    reused. when space runs out the least recently used entries are evicted one by one, never
//    everything, and never an entry drawn this frame (callers fall back to a lower resolution).
//  - compaction repacks in place through one reusable scratch buffer and uploads only the entries
//    that moved (it used to allocate fresh pages and re-upload all of them: up to 200 MB).

export interface AtlasEntry {
  key: string;
  page: number;
  x: number; y: number; w: number; h: number;
  lastUsed: number;
  /** evicted: holders must re-resolve */
  dead?: boolean;
  /** shelf the slot lives on (internal) */
  shelf?: Shelf;
}

/** fixed-height row; `x` = end of the used prefix, `free` = released spans [x, w, ...], `live` = entries on it */
interface Shelf { y: number; h: number; x: number; free: number[]; live: number }
interface Dirty { x0: number; y0: number; x1: number; y1: number; rects: number[]; area: number }

export const PAGE = 2048;
const MAX_PAGES = 12;
/** byte budget for optional rasters (resolution upgrades, viewport tiles): they may grow the atlas
 *  only up to this many pages and only evict entries nobody drew for KEEP_FRAMES frames */
const BUDGET_PAGES = 8;
const KEEP_FRAMES = 30;
/** frames between two compactions (a compaction re-uploads everything that moved) */
const COMPACT_GAP = 60;

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
  evictions = 0;
  uploadsLastFlush = 0;
  /** bytes uploaded to the gpu so far (hud / zoom-check) */
  uploadedBytes = 0;
  private lastCompact = -1e9;
  /** called with the key of every evicted entry (holders drop their metadata) */
  onEvict: ((key: string) => void) | null = null;
  private scratch = new Uint8Array(0);

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

  /** reserve space; returns null if it can't fit without evicting entries drawn this frame
   *  (the caller then tries a lower resolution or keeps what it has).
   *  optional (upgrades, tiles: the caller has something to show meanwhile): stays within the byte
   *  budget, never evicts entries drawn in the last KEEP_FRAMES frames and never compacts, so zoomed-in
   *  playback can't turn into an evict / re-raster / compact cycle. */
  alloc(key: string, w: number, h: number, optional = false): AtlasEntry | null {
    w = Math.ceil(w) + 2; // 1px gutter each side
    h = Math.ceil(h) + 2;
    if (w > PAGE || h > PAGE) return null;
    const old = this.entries.get(key);
    if (old) this.evict(old);
    let slot = this.findSlot(w, h);
    if (!slot && optional) {
      slot = this.evictUntilFits(w, h, 120);
      if (!slot && this.pages < BUDGET_PAGES) {
        this.allocate(Math.min(BUDGET_PAGES, this.pages * 2));
        slot = this.findSlot(w, h);
      }
      if (!slot) slot = this.evictUntilFits(w, h, KEEP_FRAMES);
      if (!slot) return null;
    }
    if (!slot) {
      // 1. evict entries nobody drew for a while (oldest first), 2. grow, 3. evict anything not drawn
      // this frame, 4. defragment what is left. entries drawn this frame always stay.
      slot = this.evictUntilFits(w, h, 120);
      if (!slot && this.pages < MAX_PAGES) {
        this.allocate(Math.min(MAX_PAGES, this.pages * 2));
        slot = this.findSlot(w, h);
      }
      if (!slot) slot = this.evictUntilFits(w, h, 0);
      if (!slot && this.frame - this.lastCompact >= COMPACT_GAP && this.freeArea() >= w * h * 2) {
        this.lastCompact = this.frame;
        if (this.compact(0)) slot = this.findSlot(w, h);
      }
      if (!slot) return null;
    }
    const e: AtlasEntry = { key, page: slot.page, x: slot.x + 1, y: slot.y + 1, w: w - 2, h: h - 2, lastUsed: this.frame, shelf: slot.shelf };
    this.entries.set(key, e);
    return e;
  }

  /** evict entries unused for more than `maxAge` frames, oldest first, until a w x h slot exists */
  private evictUntilFits(w: number, h: number, maxAge: number) {
    const cands: AtlasEntry[] = [];
    for (const e of this.entries.values()) if (this.frame - e.lastUsed > maxAge) cands.push(e);
    if (!cands.length) return null;
    cands.sort((a, b) => a.lastUsed - b.lastUsed);
    let freed = 0;
    const need = w * h;
    for (let i = 0; i < cands.length; i++) {
      const e = cands[i];
      this.evict(e);
      freed += (e.w + 2) * (e.h + 2);
      if (freed >= need || i === cands.length - 1) {
        const slot = this.findSlot(w, h);
        if (slot) return slot;
        freed = 0;
      }
    }
    return null;
  }

  private evict(e: AtlasEntry) {
    this.release(e);
    e.dead = true;
    this.evictions++;
    this.onEvict?.(e.key);
  }

  /** drop an entry (its holder no longer needs it) */
  remove(key: string) {
    const e = this.entries.get(key);
    if (e) this.evict(e);
  }

  /** give an entry's slot back to its shelf */
  private release(e: AtlasEntry) {
    this.entries.delete(e.key);
    const sh = e.shelf;
    e.shelf = undefined;
    if (!sh) return;
    const x = e.x - 1, w = e.w + 2;
    if (--sh.live <= 0) { sh.live = 0; sh.x = 0; sh.free.length = 0; this.trimShelves(e.page); return; }
    if (x + w === sh.x) sh.x = x; // end of the used prefix: shrink it
    else sh.free.push(x, w);
    // free spans that now touch the prefix end fold into it
    for (let again = true; again && sh.free.length;) {
      again = false;
      for (let i = 0; i < sh.free.length; i += 2) {
        if (sh.free[i] + sh.free[i + 1] === sh.x) { sh.x = sh.free[i]; sh.free.splice(i, 2); again = true; break; }
      }
    }
  }

  /** empty shelves at the top of a page go away, so that space can take any height again */
  private trimShelves(p: number) {
    const shelves = this.shelves[p];
    while (shelves.length && shelves[shelves.length - 1].live === 0) shelves.pop();
  }

  private freeArea() {
    let used = 0;
    for (const e of this.entries.values()) used += (e.w + 2) * (e.h + 2);
    return this.pages * PAGE * PAGE - used;
  }

  private findSlot(w: number, h: number): { page: number; x: number; y: number; shelf: Shelf } | null {
    for (let p = 0; p < this.pages; p++) {
      const shelves = this.shelves[p];
      let best: Shelf | null = null, bestSpan = -1;
      for (const s of shelves) {
        // an empty shelf takes anything that fits under it; a used one only similar heights
        if (s.h < h || (s.live > 0 && s.h > h * 1.5 + 8)) continue;
        if (best && s.h >= best.h) continue;
        if (PAGE - s.x >= w) { best = s; bestSpan = -1; continue; }
        for (let i = 0; i < s.free.length; i += 2) if (s.free[i + 1] >= w) { best = s; bestSpan = i; break; }
      }
      if (best) {
        let x: number;
        if (bestSpan >= 0) {
          x = best.free[bestSpan];
          const rest = best.free[bestSpan + 1] - w;
          if (rest > 0) { best.free[bestSpan] = x + w; best.free[bestSpan + 1] = rest; }
          else best.free.splice(bestSpan, 2);
        } else { x = best.x; best.x += w; }
        best.live++;
        return { page: p, x, y: best.y, shelf: best };
      }
      const top = this.usedHeight(p);
      if (top + h <= PAGE) {
        const shelf: Shelf = { y: top, h: Math.min(PAGE - top, Math.ceil(h / 8) * 8), x: w, free: [], live: 1 };
        shelves.push(shelf);
        return { page: p, x: 0, y: top, shelf };
      }
    }
    return null;
  }

  /** write rgba bytes (w*h*4, final format) into the shadow; uploaded on flush() */
  upload(e: AtlasEntry, src: Uint8Array) {
    const s = this.page(e.page);
    const rowBytes = e.w * 4;
    // clear the 1px gutter ring so neighbours never bleed under linear filtering (the inside is overwritten)
    this.clearGutter(s, e);
    for (let r = 0; r < e.h; r++) s.set(src.subarray(r * rowBytes, r * rowBytes + rowBytes), ((e.y + r) * PAGE + e.x) * 4);
    this.markDirty(e.page, e.x - 1, e.y - 1, e.x + e.w + 1, e.y + e.h + 1);
  }

  private clearGutter(s: Uint8Array, e: AtlasEntry) {
    const x0 = Math.max(0, e.x - 1), x1 = Math.min(PAGE, e.x + e.w + 1);
    if (e.y - 1 >= 0) s.fill(0, ((e.y - 1) * PAGE + x0) * 4, ((e.y - 1) * PAGE + x1) * 4);
    if (e.y + e.h < PAGE) s.fill(0, ((e.y + e.h) * PAGE + x0) * 4, ((e.y + e.h) * PAGE + x1) * 4);
    const l = e.x - 1 >= 0, r = e.x + e.w < PAGE;
    for (let y = 0; y < e.h; y++) {
      const row = (e.y + y) * PAGE;
      if (l) s.fill(0, (row + e.x - 1) * 4, (row + e.x) * 4);
      if (r) s.fill(0, (row + e.x + e.w) * 4, (row + e.x + e.w + 1) * 4);
    }
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
      const rects = d.rects.length / 4 <= 32 && unionArea > d.area * 2 ? d.rects : [d.x0, d.y0, d.x1, d.y1];
      for (let i = 0; i < rects.length; i += 4) {
        const x0 = rects[i], y0 = rects[i + 1], w = rects[i + 2] - x0, h = rects[i + 3] - y0;
        if (w <= 0 || h <= 0) continue;
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x0, y0, p, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, s);
        this.uploadedBytes += w * h * 4;
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

  /** repack entries used within `maxAge` frames in place: live pixels go through one reusable
   *  scratch buffer (no new pages). entries keep their identity (x/y/page updated in place), stale
   *  ones are evicted, and only entries that moved are uploaded. returns true if anything changed. */
  compact(maxAge: number): boolean {
    const live: AtlasEntry[] = [], stale: AtlasEntry[] = [];
    for (const e of this.entries.values()) (this.frame - e.lastUsed <= maxAge ? live : stale).push(e);
    for (const e of stale) this.evict(e);
    let bytes = 0;
    for (const e of live) bytes += e.w * e.h * 4;
    if (this.scratch.length < bytes) this.scratch = new Uint8Array(Math.max(bytes, (this.scratch.length * 1.5) | 0));
    const tmp = this.scratch, old = new Float64Array(live.length * 4);
    let o = 0;
    for (let i = 0; i < live.length; i++) {
      const e = live[i], src = this.shadow[e.page];
      if (src) for (let r = 0; r < e.h; r++) { const so = ((e.y + r) * PAGE + e.x) * 4; tmp.set(src.subarray(so, so + e.w * 4), o + r * e.w * 4); }
      old[i * 4] = o; old[i * 4 + 1] = e.page; old[i * 4 + 2] = e.x; old[i * 4 + 3] = e.y;
      o += e.w * e.h * 4;
    }
    for (let p = 0; p < this.pages; p++) this.shelves[p] = [];
    const order = live.map((_, i) => i).sort((a, b) => live[b].h - live[a].h);
    let moved = 0;
    for (const i of order) {
      const e = live[i];
      e.shelf = undefined;
      const slot = this.findSlot(e.w + 2, e.h + 2);
      if (!slot) { this.evict(e); continue; }
      e.page = slot.page; e.x = slot.x + 1; e.y = slot.y + 1; e.shelf = slot.shelf;
      if (e.page === old[i * 4 + 1] && e.x === old[i * 4 + 2] && e.y === old[i * 4 + 3]) continue;
      const dst = this.page(e.page), so = old[i * 4];
      for (let r = 0; r < e.h; r++) dst.set(tmp.subarray(so + r * e.w * 4, so + (r + 1) * e.w * 4), ((e.y + r) * PAGE + e.x) * 4);
      this.clearGutter(dst, e);
      this.markDirty(e.page, e.x - 1, e.y - 1, e.x + e.w + 1, e.y + e.h + 1);
      moved++;
    }
    if (!moved && !stale.length) return false;
    this.compactions++;
    return true;
  }

  evictAll() {
    for (const e of [...this.entries.values()]) { e.dead = true; e.shelf = undefined; this.onEvict?.(e.key); }
    this.entries.clear();
    for (let p = 0; p < this.pages; p++) { this.shelves[p] = []; this.dirty[p] = null; }
    this.shadow = [];
    this.generation++;
  }

  /** after a webgl context loss: recreate the texture and re-upload every page from its shadow */
  restore() {
    this.tex = this.gl.createTexture()!;
    const pages = this.pages;
    this.pages = 0;
    this.allocate(pages);
    for (let p = 0; p < pages; p++) if (this.shadow[p]) this.dirty[p] = fullDirty(PAGE);
  }

  /** bytes held by cpu shadows (for the hud) */
  get shadowBytes() { return this.shadow.reduce((s, p) => s + (p ? p.byteLength : 0), 0); }

  dispose() { this.gl.deleteTexture(this.tex); }
}

function fullDirty(h: number): Dirty { return { x0: 0, y0: 0, x1: PAGE, y1: h, rects: [0, 0, PAGE, h], area: PAGE * h }; }
