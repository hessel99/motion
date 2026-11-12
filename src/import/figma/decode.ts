// figma clipboard decoding: text/html payload -> fig-kiwi buffer -> kiwi message.
//
// on cmd+c figma writes text/html roughly like:
//   <meta charset='utf-8'><span data-metadata="<!--(figmeta)BASE64JSON(/figmeta)-->"></span>
//   <span data-buffer="<!--(figma)BASE64(/figma)-->"></span>
// the buffer is the "fig-kiwi" container:
//   8 bytes ascii prelude ("fig-kiwi"; .fig files use other "fig-*" preludes), uint32 LE version,
//   then chunks of [uint32 LE length][bytes]. chunk 0 = compressed kiwi binary schema,
//   chunk 1 = compressed message. compression is raw deflate or zstd (magic 28 b5 2f fd).

import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { inflateSync, unzlibSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';

// ---------------- html extraction ----------------

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', lpar: '(', rpar: ')', sol: '/', excl: '!', equals: '=', plus: '+', hyphen: '-', dash: '-' };

/** minimal, linear-time html entity decoder (enough for the figma markers / base64 payload) */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);?/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const r = NAMED_ENTITIES[body.toLowerCase()];
    return r ?? m;
  });
}

const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62; // url-safe variants
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

/** tolerant base64 decoder: skips whitespace and any non-alphabet chars, stops at '=' padding */
export function base64ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4) + 3);
  let acc = 0, bits = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) break; // '='
    const v = c < 256 ? B64_LOOKUP[c] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  const parts: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += chars[v >> 18] + chars[(v >> 12) & 63] + chars[(v >> 6) & 63] + chars[v & 63];
    if (out.length > 65536) { parts.push(out); out = ''; }
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const v = bytes[i] << 16;
    out += chars[v >> 18] + chars[(v >> 12) & 63] + '==';
  } else if (rem === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += chars[v >> 18] + chars[(v >> 12) & 63] + chars[(v >> 6) & 63] + '=';
  }
  parts.push(out);
  return parts.join('');
}

function between(s: string, open: string, close: string): string | null {
  const a = s.indexOf(open);
  if (a < 0) return null;
  const start = a + open.length;
  const b = s.indexOf(close, start);
  return b < 0 ? s.slice(start) : s.slice(start, b);
}

/** quick check without decoding anything */
export function looksLikeFigmaHtml(html: string): boolean {
  return /\(\s*figma\s*\)|&#40;figma&#41;|&lpar;figma&rpar;|data-buffer/i.test(html);
}

/**
 * find the figma payload in clipboard html. markers may be wrapped in html comments,
 * entity-escaped, or have stray whitespace/comment syntax between them; we decode entities
 * once and then take everything between "(figma)" and "(/figma)", keeping base64 chars only.
 */
export function extractFigmaBuffer(html: string): { meta: any; buffer: Uint8Array } | null {
  if (!html) return null;
  let s = html;
  if (s.indexOf('(figma)') < 0 || s.indexOf('(/figma)') < 0) {
    s = decodeEntities(s);
    // tolerate whitespace inside the markers, e.g. "( figma )"
    s = s.replace(/\(\s*(\/?)\s*(figma|figmeta)\s*\)/gi, (_m, sl: string, w: string) => `(${sl}${w.toLowerCase()})`);
  }
  let raw = between(s, '(figma)', '(/figma)');
  if (raw == null) {
    // fallback: a data-buffer attribute without markers
    const m = /data-buffer\s*=\s*["']([^"']*)["']/i.exec(s);
    if (!m) return null;
    raw = decodeEntities(m[1]);
  }
  // remove html comment syntax that may have leaked in (e.g. "<!--" / "-->"): '-' is a
  // url-safe base64 char, so strip comment tokens explicitly before decoding.
  raw = raw.replace(/<!--|-->|&lt;!--|--&gt;/g, '');
  const buffer = base64ToBytes(raw);
  if (buffer.length < 12) return null;

  let meta: any = null;
  const metaRaw = between(s, '(figmeta)', '(/figmeta)');
  if (metaRaw != null) {
    try {
      const bytes = base64ToBytes(metaRaw.replace(/<!--|-->/g, ''));
      meta = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      meta = null;
    }
  }
  return { meta, buffer };
}

// ---------------- fig-kiwi container ----------------

function isZstd(b: Uint8Array) {
  return b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;
}

export function decompressChunk(b: Uint8Array): Uint8Array {
  if (isZstd(b)) return zstdDecompress(b);
  try {
    return inflateSync(b);
  } catch (e) {
    // zlib-wrapped deflate (0x78 header) as a fallback
    if (b.length > 2 && b[0] === 0x78) return unzlibSync(b);
    throw e;
  }
}

export function splitFigKiwi(buf: Uint8Array): { prelude: string; version: number; chunks: Uint8Array[] } {
  if (buf.length < 12) throw new Error('fig-kiwi: buffer too small');
  let prelude = '';
  for (let i = 0; i < 8; i++) prelude += String.fromCharCode(buf[i]);
  if (!prelude.startsWith('fig-')) throw new Error(`fig-kiwi: unknown prelude "${prelude}"`);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = view.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  let off = 12;
  while (off + 4 <= buf.length) {
    const len = view.getUint32(off, true);
    off += 4;
    if (off + len > buf.length) throw new Error(`fig-kiwi: truncated chunk ${chunks.length}`);
    chunks.push(buf.subarray(off, off + len));
    off += len;
  }
  if (chunks.length < 2) throw new Error('fig-kiwi: expected schema + message chunks');
  return { prelude, version, chunks };
}

// compiled schemas are cached by a hash of the (decompressed) schema bytes: compileSchema
// generates code via new Function and is far more expensive than decoding a message.
const compiledCache = new Map<string, { schema: any; compiled: any }>();

function hashBytes(b: Uint8Array): string {
  let h1 = 0x811c9dc5 | 0, h2 = 0x01000193 | 0;
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i], 16777619);
    h2 = Math.imul(h2 + b[i], 0x5bd1e995) ^ (h2 >>> 15);
  }
  return `${b.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

export function decodeFigKiwi(buf: Uint8Array): { message: any; schema: any } {
  const { chunks, version, prelude } = splitFigKiwi(buf);
  const schemaBytes = decompressChunk(chunks[0]);
  const key = hashBytes(schemaBytes);
  let entry = compiledCache.get(key);
  if (!entry) {
    const schema = decodeBinarySchema(schemaBytes);
    entry = { schema, compiled: compileSchema(schema) };
    if (compiledCache.size > 8) compiledCache.clear();
    compiledCache.set(key, entry);
  }
  const msgBytes = decompressChunk(chunks[1]);
  const message = entry.compiled.decodeMessage(msgBytes);
  if (message && typeof message === 'object') {
    // keep container info around for debugging; non-enumerable so it never leaks into json
    Object.defineProperty(message, '__figKiwi', { value: { version, prelude, extraChunks: chunks.slice(2) }, enumerable: false });
  }
  return { message, schema: entry.schema };
}
