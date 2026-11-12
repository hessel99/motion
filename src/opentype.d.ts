declare module 'opentype.js' {
  export interface PathCommand { type: 'M' | 'L' | 'C' | 'Q' | 'Z'; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }
  export interface Glyph { index: number; advanceWidth: number; getPath(x: number, y: number, fontSize: number): { commands: PathCommand[] } }
  export interface Font { unitsPerEm: number; charToGlyph(ch: string): Glyph }
  export function parse(buf: ArrayBuffer): Font;
}
