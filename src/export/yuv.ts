// rgb -> yuv 4:2:0 for the video export, done here instead of by the browser so the encoded colours
// are exactly what the file is tagged with: BT.709 matrix, limited ("tv") range, sRGB-encoded
// values passed through (the BT.709 transfer tag is what players expect for sRGB content; it is
// how every desktop tool exports, and it displays identically in browsers / QuickTime / VLC).
// chroma: each 2x2 block averaged (centre siting). measured against ffmpeg and chromium's <video>,
// this is closer than left siting ([1 2 1] filter), see docs/export-parity.md.
//
// input is premultiplied rgba (FrameGrabber), i.e. the frame over black: exactly the opaque frame.

// BT.709 luma coefficients
const KR = 0.2126, KB = 0.0722, KG = 1 - KR - KB;

/** fixed-point (16 bit) conversion coefficients for 8-bit limited range */
const S = 65536;
const YR = Math.round(KR * 219 / 255 * S), YG = Math.round(KG * 219 / 255 * S), YB = Math.round(KB * 219 / 255 * S);
// cb = (b - y) / (2 (1 - kb)), cr = (r - y) / (2 (1 - kr)), scaled to 224/255
const CB_R = Math.round(-KR / (2 * (1 - KB)) * 224 / 255 * S), CB_G = Math.round(-KG / (2 * (1 - KB)) * 224 / 255 * S), CB_B = Math.round(0.5 * 224 / 255 * S);
const CR_R = Math.round(0.5 * 224 / 255 * S), CR_G = Math.round(-KG / (2 * (1 - KR)) * 224 / 255 * S), CR_B = Math.round(-KB / (2 * (1 - KR)) * 224 / 255 * S);

/** I420 buffer size for an even-sized frame */
export const i420Size = (w: number, h: number) => w * h + 2 * ((w + 1) >> 1) * ((h + 1) >> 1);

/** premultiplied rgba (w x h, top row first) -> I420 (Y plane, then U, then V). w and h even */
export function rgbaToI420(px: Uint8Array, w: number, h: number, out: Uint8Array = new Uint8Array(i420Size(w, h))): Uint8Array {
  const cw = w >> 1, ch = h >> 1, uo = w * h, vo = uo + cw * ch;
  const half = S >> 1, off16 = 16 * S + half;
  for (let i = 0, n = w * h; i < n; i++) {
    const o = i << 2;
    out[i] = (YR * px[o] + YG * px[o + 1] + YB * px[o + 2] + off16) >> 16;
  }
  const off128 = 128 * S + half;
  for (let y = 0; y < ch; y++) {
    const r0 = (2 * y) * w * 4, r1 = r0 + w * 4;
    for (let x = 0; x < cw; x++) {
      // the 2x2 block averaged (centre siting: what gpu players' bilinear chroma upsampling assumes)
      const a = x * 8, b = a + 4;
      const R = px[r0 + a] + px[r0 + b] + px[r1 + a] + px[r1 + b];
      const G = px[r0 + a + 1] + px[r0 + b + 1] + px[r1 + a + 1] + px[r1 + b + 1];
      const B = px[r0 + a + 2] + px[r0 + b + 2] + px[r1 + a + 2] + px[r1 + b + 2];
      const k = y * cw + x;
      out[uo + k] = (CB_R * R + CB_G * G + CB_B * B + off128 * 4) >> 18;
      out[vo + k] = (CR_R * R + CR_G * G + CR_B * B + off128 * 4) >> 18;
    }
  }
  return out;
}

/** the colour space every exported video is encoded and tagged with */
export const VIDEO_COLOR_SPACE: VideoColorSpaceInit = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false };
