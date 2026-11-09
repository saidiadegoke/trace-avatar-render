declare module 'omggif' {
  export class GifReader {
    constructor(bytes: Uint8Array);
    width: number;
    height: number;
    numFrames(): number;
    loopCount(): number | null;
    frameInfo(i: number): { delay: number; x: number; y: number; width: number; height: number; disposal: number; transparent_index: number | null };
    decodeAndBlitFrameRGBA(i: number, pixels: Uint8Array): void;
  }
  const omggif: { GifReader: typeof GifReader };
  export default omggif;
}
