/**
 * GIF encoding with gifenc (pure JS, no binaries).
 *
 * UI frames change little from one to the next, so: one palette for the whole GIF (from a sample of
 * frames), identical frames merged into one longer frame, and every later frame writes only what
 * changed (unchanged pixels are transparent and the frame below shows through).
 */

import * as gifencNs from 'gifenc';
import type { Image } from './image';

// The ESM build has named exports; Node loading the CommonJS build puts them on the default export.
type Lib = typeof import('gifenc').default;
const lib: Lib = (gifencNs as unknown as Partial<Lib>).quantize ? (gifencNs as unknown as Lib) : (gifencNs as unknown as { default: Lib }).default;
const { GIFEncoder, quantize, applyPalette } = lib;

export interface GifOptions {
  fps: number;
  /** 0 = loop forever (default), -1 = play once. */
  repeat?: number;
  /** Frames sampled for the palette. Default 12. */
  paletteSamples?: number;
}

/** The index the GIF uses for "unchanged" pixels; the palette has 255 real colours before it. */
const CLEAR = 255;

/** Build one palette from evenly spaced frames (every 3rd pixel of each). Exported for tests. */
export function paletteOf(frames: readonly Image[], samples = 12): number[][] {
  const pick = Math.min(samples, frames.length);
  const chosen = Array.from({ length: pick }, (_, k) => frames[Math.floor((k * frames.length) / pick)]);
  const per = chosen.map((f) => Math.ceil(f.width * f.height / 3));
  const all = new Uint8Array(per.reduce((a, b) => a + b, 0) * 4);
  let o = 0;
  for (const f of chosen) {
    for (let p = 0; p < f.width * f.height; p += 3) {
      all[o] = f.data[p * 4]; all[o + 1] = f.data[p * 4 + 1]; all[o + 2] = f.data[p * 4 + 2]; all[o + 3] = 255;
      o += 4;
    }
  }
  return quantize(all.subarray(0, o), CLEAR);
}

export interface GifResult { bytes: Uint8Array; frames: number; durationMs: number }

/** Encode frames shown at a steady fps. */
export function encodeGif(frames: readonly Image[], o: GifOptions): GifResult {
  if (!frames.length) throw new Error('no frames to encode');
  const w = createGifWriter({ width: frames[0].width, height: frames[0].height, fps: o.fps, repeat: o.repeat, palette: paletteOf(frames, o.paletteSamples) });
  for (const f of frames) w.add(f);
  return w.finish();
}

export interface GifWriter {
  /** The next frame (same size as the first); it can be reused by the caller once this returns. */
  add(frame: Image): void;
  finish(): GifResult;
}

/**
 * A GIF written one frame at a time, so a long video never holds all its frames: the palette comes first
 * (from sample frames, paletteOf), identical frames in a row are merged, later frames hold only changes.
 */
export function createGifWriter(o: { width: number; height: number; fps: number; palette: number[][]; repeat?: number }): GifWriter {
  const { width, height, palette } = o;
  const step = 1000 / o.fps;
  const full = [...palette, ...Array.from({ length: CLEAR + 1 - palette.length }, () => [0, 0, 0])];
  const gif = GIFEncoder();
  let prev: Uint8Array | null = null;
  let pending: { index: Uint8Array; ms: number } | null = null;
  let shown = 0;
  let count = 0;
  const flush = () => {
    if (!pending) return;
    const { index, ms } = pending;
    // GIF delays are in hundredths: carry the rounding so the total stays right.
    const delay = Math.max(20, Math.round((shown + ms) / 10) * 10 - Math.round(shown / 10) * 10);
    shown += ms;
    if (!prev) {
      gif.writeFrame(index, width, height, { palette: full, delay, repeat: o.repeat ?? 0 });
    } else {
      const diff = new Uint8Array(index.length);
      for (let i = 0; i < index.length; i += 1) diff[i] = index[i] === prev[i] ? CLEAR : index[i];
      gif.writeFrame(diff, width, height, { delay, transparent: true, transparentIndex: CLEAR, dispose: 1 });
    }
    prev = index;
    count += 1;
    pending = null;
  };
  return {
    add(f) {
      if (f.width !== width || f.height !== height) throw new Error('every frame must be the same size');
      const index = applyPalette(f.data, palette);
      if (pending && same(pending.index, index)) { pending.ms += step; return; }
      flush();
      pending = { index, ms: step };
    },
    finish() {
      flush();
      if (!count) throw new Error('no frames to encode');
      gif.finish();
      return { bytes: gif.bytes(), frames: count, durationMs: Math.round(shown) };
    },
  };
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
