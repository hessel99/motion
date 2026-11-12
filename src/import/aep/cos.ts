// minimal reader for the pdf-style "COS" object syntax after effects uses for text
// documents (LIST:btdk). syntax per py-aep docs/file_format.md "COS syntax"; verified on
// the text layer in boltframe/aftereffects-aep-parser data/Property-01.aep.
// never throws: malformed input yields a partial tree.

export type Cos = number | boolean | string | { name: string } | Cos[] | { [k: string]: Cos } | null;

const utf16 = /* @__PURE__ */ new TextDecoder('utf-16be');
const latin = /* @__PURE__ */ new TextDecoder('latin1');

function decodeStr(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    try { return utf16.decode(b.subarray(2)); } catch { /* fallthrough */ }
  }
  return latin.decode(b);
}

export function parseCos(b: Uint8Array): Cos {
  let i = 0;
  const n = b.length;
  const ws = () => { while (i < n && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x09 || b[i] === 0)) i++; };
  const isDelim = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x2f || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x28 || c === 0x29 || c === 0;
  let guard = 0;
  const value = (depth: number): Cos => {
    ws();
    if (i >= n || depth > 200 || ++guard > 5e6) return null;
    const c = b[i];
    if (c === 0x3c && b[i + 1] === 0x3c) { i += 2; return dict(depth + 1, true); }
    if (c === 0x5b) {
      i++;
      const a: Cos[] = [];
      for (;;) {
        ws();
        if (i >= n) break;
        if (b[i] === 0x5d) { i++; break; }
        const s = i;
        a.push(value(depth + 1));
        if (i === s) i++; // no progress: skip a byte
      }
      return a;
    }
    if (c === 0x28) {
      i++;
      const out: number[] = [];
      let lvl = 1;
      while (i < n) {
        const ch = b[i++];
        if (ch === 0x5c && i < n) { out.push(b[i++]); continue; }
        if (ch === 0x28) lvl++;
        else if (ch === 0x29 && --lvl === 0) break;
        out.push(ch);
      }
      return decodeStr(Uint8Array.from(out));
    }
    if (c === 0x2f) {
      i++;
      const s = i;
      while (i < n && !isDelim(b[i])) i++;
      return { name: latin.decode(b.subarray(s, i)) };
    }
    const s = i;
    while (i < n && !isDelim(b[i])) i++;
    const tok = latin.decode(b.subarray(s, i));
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    const v = Number(tok);
    return isFinite(v) ? v : null;
  };
  const dict = (depth: number, delimited: boolean): { [k: string]: Cos } => {
    const o: { [k: string]: Cos } = {};
    for (;;) {
      ws();
      if (i >= n) break;
      if (b[i] === 0x3e && b[i + 1] === 0x3e) { i += 2; if (delimited) break; continue; }
      if (b[i] !== 0x2f) { i++; continue; } // junk
      i++;
      const s = i;
      while (i < n && !isDelim(b[i])) i++;
      const key = latin.decode(b.subarray(s, i));
      o[key] = value(depth);
    }
    return o;
  };
  try { return dict(0, false); } catch { return null; }
}

/** safe path access: cosGet(doc, '1', '1', 0, '0') */
export function cosGet(c: Cos | undefined, ...path: (string | number)[]): Cos | undefined {
  let cur: any = c;
  for (const p of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p as any];
  }
  return cur;
}

export interface AepTextDoc {
  text: string;
  fontSize?: number;
  font?: string;
  /** rgba 0..1 */
  fill?: [number, number, number, number];
  /** 0 left, 1 right, 2 center (ExtendScript ParagraphJustification order), others = justified variants */
  justification?: number;
  leading?: number;
  autoLeading?: boolean;
  tracking?: number;
  /** box text size / position when the document is a paragraph box (not decoded yet) */
}

/** decode every document of a btdk body (one per Source Text keyframe) */
export function textDocs(body: Uint8Array): AepTextDoc[] {
  const root = parseCos(body);
  const fonts = cosGet(root, '0', '1', '0');
  const docs = cosGet(root, '1', '1');
  if (!Array.isArray(docs)) return [];
  return docs.map(d => {
    const raw = cosGet(d, '0', '0');
    const text = (typeof raw === 'string' ? raw : '').replace(/\r$/, '').replace(/\r\n?/g, '\n');
    const out: AepTextDoc = { text };
    const style = cosGet(d, '0', '6', '0', 0, '0', '0', '6');
    if (style && typeof style === 'object') {
      const fs = cosGet(style, '1'); if (typeof fs === 'number') out.fontSize = fs;
      const fi = cosGet(style, '0');
      if (typeof fi === 'number' && Array.isArray(fonts)) {
        const fn = cosGet(fonts[fi], '0', '0', '0');
        if (typeof fn === 'string') out.font = fn;
      }
      const col = cosGet(style, '53', '0', '1');
      if (Array.isArray(col) && col.length >= 4) out.fill = [Number(col[1]) || 0, Number(col[2]) || 0, Number(col[3]) || 0, Number(col[0]) || 1];
      const lead = cosGet(style, '5'); if (typeof lead === 'number') out.leading = lead;
      const al = cosGet(style, '4'); if (typeof al === 'boolean') out.autoLeading = al;
      const tr = cosGet(style, '8'); if (typeof tr === 'number') out.tracking = tr;
    }
    const j = cosGet(d, '0', '5', '0', 0, '0', '0', '5', '0');
    if (typeof j === 'number') out.justification = j;
    return out;
  });
}
