// Minimal types for gifenc 1.0.3 (MIT, Matt DesLauriers): only what the GIF export uses.
declare module 'gifenc' {
  export type Palette = number[][];
  export interface GifEncoder {
    writeHeader(): void;
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: Palette; delay?: number; repeat?: number; first?: boolean; dispose?: number; colorDepth?: number; transparent?: boolean; transparentIndex?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    reset(): void;
  }
  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GifEncoder;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' }): Palette;
}
