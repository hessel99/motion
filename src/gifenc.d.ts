declare module 'gifenc' {
  export function GIFEncoder(): { writeFrame(index: Uint8Array, w: number, h: number, opts?: { palette?: number[][]; delay?: number; transparent?: boolean; transparentIndex?: number; dispose?: number }): void; finish(): void; bytes(): Uint8Array };
  export function quantize(rgba: Uint8Array, maxColors: number, opts?: { format?: string; oneBitAlpha?: boolean | number; clearAlpha?: boolean }): number[][];
  export function applyPalette(rgba: Uint8Array, palette: number[][], format?: string): Uint8Array;
}
