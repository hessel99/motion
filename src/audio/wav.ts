// 16-bit PCM wav encoding (generated tracks, synthesized sound effects). no dependencies: runs in
// the page, workers and node tests.

export function encodeWav(channels: Float32Array[], sr: number): Uint8Array {
  const ch = channels.length, n = channels[0]?.length ?? 0;
  const bytes = new Uint8Array(44 + n * ch * 2);
  const v = new DataView(bytes.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const x = Math.max(-1, Math.min(1, channels[c][i])); v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true); o += 2; }
  return bytes;
}

export function bytesToBase64(b: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH) as unknown as number[]);
  return btoa(s);
}

export function wavDataUrl(channels: Float32Array[], sr: number): string {
  return 'data:audio/wav;base64,' + bytesToBase64(encodeWav(channels, sr));
}

/** decode a 16-bit PCM wav (what encodeWav writes) to mono float samples: lets tests and workers
 *  read generated audio without WebAudio */
export function decodeWav16(bytes: Uint8Array): { samples: Float32Array; sr: number } | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let o = 12, ch = 1, sr = 44100, bits = 16;
  while (o + 8 <= bytes.length) {
    const id = tag(o), size = v.getUint32(o + 4, true);
    if (id === 'fmt ') { ch = v.getUint16(o + 10, true); sr = v.getUint32(o + 12, true); bits = v.getUint16(o + 22, true); }
    if (id === 'data') {
      if (bits !== 16) return null;
      const n = Math.floor(Math.min(size, bytes.length - o - 8) / (2 * ch));
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += v.getInt16(o + 8 + (i * ch + c) * 2, true); out[i] = s / ch / 32768; }
      return { samples: out, sr };
    }
    o += 8 + size + (size & 1);
  }
  return null;
}
