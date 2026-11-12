// RIFX (big-endian RIFF) chunk walker for after effects .aep files.
//
// layout (verified against forticheprod/py-aep docs/file_format.md "File structure"
// and against the real sample projects shipped with boltframe/aftereffects-aep-parser):
//   'RIFX' u4 bodyLen 'Egg!' chunks...           (followed by an XMP packet we ignore)
//   chunk = fourcc tag, u4 len (big endian), body[len], pad byte when len is odd
//   'LIST' body = fourcc listType + child chunks  (except LIST:btdk = raw COS text)
//
// the walker never copies data: chunks reference offsets into the original buffer.
// it never throws on malformed input; a truncated chunk is clamped to the buffer end
// and walking stops at the first header that does not fit.

export interface Chunk {
  /** four character tag ('LIST', 'ldta', 'Utf8', ...) */
  tag: string;
  /** list type for LIST chunks ('Fold', 'Item', 'Layr', 'tdgp', ...) */
  list?: string;
  /** absolute offset of the body (for LIST: after the list type) */
  off: number;
  /** body length in bytes (for LIST: excluding the list type) */
  len: number;
  /** children for LIST chunks */
  kids?: Chunk[];
}

/** lists whose body is raw bytes rather than a chunk sequence */
const RAW_LISTS = new Set(['btdk']);

const td = /* @__PURE__ */ new TextDecoder('utf-8');
const latin = /* @__PURE__ */ new TextDecoder('latin1');

export class Reader {
  readonly dv: DataView;
  readonly u8: Uint8Array;
  constructor(readonly buf: ArrayBuffer) {
    this.dv = new DataView(buf);
    this.u8 = new Uint8Array(buf);
  }
  get size() { return this.u8.length; }
  fourcc(off: number): string {
    const u = this.u8;
    if (off + 4 > u.length) return '';
    return String.fromCharCode(u[off], u[off + 1], u[off + 2], u[off + 3]);
  }
  u1(off: number) { return off < this.u8.length ? this.u8[off] : 0; }
  u2(off: number) { return off + 2 <= this.u8.length ? this.dv.getUint16(off) : 0; }
  s2(off: number) { return off + 2 <= this.u8.length ? this.dv.getInt16(off) : 0; }
  u4(off: number) { return off + 4 <= this.u8.length ? this.dv.getUint32(off) : 0; }
  s4(off: number) { return off + 4 <= this.u8.length ? this.dv.getInt32(off) : 0; }
  u4le(off: number) { return off + 4 <= this.u8.length ? this.dv.getUint32(off, true) : 0; }
  f4(off: number) { return off + 4 <= this.u8.length ? this.dv.getFloat32(off) : 0; }
  f8(off: number) { return off + 8 <= this.u8.length ? this.dv.getFloat64(off) : 0; }
  f8le(off: number) { return off + 8 <= this.u8.length ? this.dv.getFloat64(off, true) : 0; }
  bytes(off: number, len: number) { return this.u8.subarray(off, Math.min(this.u8.length, off + len)); }
  /** utf-8 string; stops at the first NUL when nul=true */
  str(off: number, len: number, nul = false): string {
    let b = this.bytes(off, len);
    if (nul) { const z = b.indexOf(0); if (z >= 0) b = b.subarray(0, z); }
    try { return td.decode(b); } catch { return latin.decode(b); }
  }
}

/** parse the chunk sequence in [off, end). iterative over siblings, recursive over lists (depth bounded). */
export function readChunks(r: Reader, off: number, end: number, depth = 0): Chunk[] {
  const out: Chunk[] = [];
  end = Math.min(end, r.size);
  while (off + 8 <= end) {
    const tag = r.fourcc(off);
    let len = r.u4(off + 4);
    const body = off + 8;
    if (body + len > end) len = Math.max(0, end - body); // truncated: clamp
    if (tag === 'LIST' && len >= 4) {
      const list = r.fourcc(body);
      const c: Chunk = { tag, list, off: body + 4, len: len - 4 };
      if (!RAW_LISTS.has(list) && depth < 64) c.kids = readChunks(r, body + 4, body + len, depth + 1);
      else c.kids = [];
      out.push(c);
    } else {
      out.push({ tag, off: body, len });
    }
    off = body + len + (len & 1);
  }
  return out;
}

/** parse a whole file. returns null when the header is not RIFX (or RIFF) */
export function readRifx(buf: ArrayBuffer): { reader: Reader; root: Chunk; form: string; littleEndian: boolean } | null {
  const r = new Reader(buf);
  if (r.size < 12) return null;
  const magic = r.fourcc(0);
  if (magic !== 'RIFX') return null; // aep is always big endian
  const len = r.u4(4);
  const form = r.fourcc(8);
  const end = Math.min(r.size, 8 + len);
  const kids = readChunks(r, 12, end);
  return { reader: r, root: { tag: 'RIFX', list: form, off: 12, len: end - 12, kids }, form, littleEndian: false };
}

// ---------------- small query helpers ----------------

export function find(c: Chunk | undefined, tag: string): Chunk | undefined {
  if (!c?.kids) return undefined;
  for (const k of c.kids) if (k.tag === tag) return k;
  return undefined;
}

export function findList(c: Chunk | undefined, list: string): Chunk | undefined {
  if (!c?.kids) return undefined;
  for (const k of c.kids) if (k.tag === 'LIST' && k.list === list) return k;
  return undefined;
}

export function lists(c: Chunk | undefined, list: string): Chunk[] {
  if (!c?.kids) return [];
  return c.kids.filter(k => k.tag === 'LIST' && k.list === list);
}

/** depth-first search for the first list of a type (bounded depth) */
export function deepFindList(c: Chunk | undefined, list: string, maxDepth = 8): Chunk | undefined {
  if (!c?.kids || maxDepth < 0) return undefined;
  for (const k of c.kids) if (k.tag === 'LIST' && k.list === list) return k;
  for (const k of c.kids) { const f = deepFindList(k, list, maxDepth - 1); if (f) return f; }
  return undefined;
}

/** string body of a Utf8 chunk (or a wrapper chunk like tdsn holding one) */
export function utf8(r: Reader, c: Chunk | undefined): string {
  if (!c) return '';
  if (c.tag === 'Utf8') return r.str(c.off, c.len);
  // wrapper chunks (tdsn, fnam, pdnm) contain a nested Utf8 chunk
  if (c.len >= 8 && r.fourcc(c.off) === 'Utf8') return r.str(c.off + 8, Math.min(r.u4(c.off + 4), c.len - 8));
  return r.str(c.off, c.len, true);
}

/**
 * group the children of a LIST:tdgp into (matchName, body chunks) pairs. a child's body
 * is every chunk between its tdmn and the next tdmn; 'ADBE Group End' terminates.
 */
export function tdgpEntries(r: Reader, group: Chunk): { mn: string; body: Chunk[] }[] {
  const out: { mn: string; body: Chunk[] }[] = [];
  let cur: { mn: string; body: Chunk[] } | null = null;
  for (const k of group.kids ?? []) {
    if (k.tag === 'tdmn') {
      const mn = r.str(k.off, k.len, true);
      if (mn === 'ADBE Group End') { cur = null; continue; }
      cur = { mn, body: [] };
      out.push(cur);
    } else if (cur) cur.body.push(k);
  }
  return out;
}
