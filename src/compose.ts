/**
 * Putting an output frame together: the background (and window) first, then the camera's view of the
 * capture into the content area, then overlays such as a burned-in caption. PURE.
 */

import type { Rect } from './camera';
import type { Image } from './image';

/** Draw `src`'s region `from` into `dst`'s region `to`: area-averaged when shrinking, bilinear when growing. */
export function drawRegion(dst: Image, to: Rect, src: Image, from: Rect): void {
  const W = Math.round(to.w);
  const H = Math.round(to.h);
  const X0 = Math.round(to.x);
  const Y0 = Math.round(to.y);
  const sx = from.w / W;
  const sy = from.h / H;
  const s = src.data;
  const d = dst.data;
  const maxX = src.width - 1;
  const maxY = src.height - 1;
  for (let Y = 0; Y < H; Y += 1) {
    const dy = Y0 + Y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let X = 0; X < W; X += 1) {
      const dx = X0 + X;
      if (dx < 0 || dx >= dst.width) continue;
      let r = 0; let g = 0; let b = 0;
      if (sx > 1 || sy > 1) {
        const x0 = from.x + X * sx; const x1 = x0 + sx;
        const y0 = from.y + Y * sy; const y1 = y0 + sy;
        let wsum = 0;
        for (let y = Math.floor(y0); y < Math.min(src.height, Math.ceil(y1)); y += 1) {
          const wy = Math.min(y + 1, y1) - Math.max(y, y0);
          for (let x = Math.floor(x0); x < Math.min(src.width, Math.ceil(x1)); x += 1) {
            const wt = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
            const i = (y * src.width + x) * 4;
            r += s[i] * wt; g += s[i + 1] * wt; b += s[i + 2] * wt; wsum += wt;
          }
        }
        r /= wsum; g /= wsum; b /= wsum;
      } else {
        const fx = Math.min(maxX, Math.max(0, from.x + (X + 0.5) * sx - 0.5));
        const fy = Math.min(maxY, Math.max(0, from.y + (Y + 0.5) * sy - 0.5));
        const x0 = Math.floor(fx); const y0 = Math.floor(fy);
        const x1 = Math.min(maxX, x0 + 1); const y1 = Math.min(maxY, y0 + 1);
        const ax = fx - x0; const ay = fy - y0;
        const i00 = (y0 * src.width + x0) * 4; const i10 = (y0 * src.width + x1) * 4;
        const i01 = (y1 * src.width + x0) * 4; const i11 = (y1 * src.width + x1) * 4;
        for (let c = 0; c < 3; c += 1) {
          const v = (s[i00 + c] * (1 - ax) + s[i10 + c] * ax) * (1 - ay) + (s[i01 + c] * (1 - ax) + s[i11 + c] * ax) * ay;
          if (c === 0) r = v; else if (c === 1) g = v; else b = v;
        }
      }
      const o = (dy * dst.width + dx) * 4;
      d[o] = Math.round(r); d[o + 1] = Math.round(g); d[o + 2] = Math.round(b); d[o + 3] = 255;
    }
  }
}

/** Alpha-blend `img` onto `dst` at (x, y), its own alpha times `alpha`. */
export function overlay(dst: Image, img: Image, x: number, y: number, alpha = 1): void {
  if (alpha <= 0) return;
  const X0 = Math.round(x);
  const Y0 = Math.round(y);
  for (let Y = 0; Y < img.height; Y += 1) {
    const dy = Y0 + Y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let X = 0; X < img.width; X += 1) {
      const dx = X0 + X;
      if (dx < 0 || dx >= dst.width) continue;
      const i = (Y * img.width + X) * 4;
      const a = (img.data[i + 3] / 255) * alpha;
      if (a <= 0) continue;
      const o = (dy * dst.width + dx) * 4;
      for (let c = 0; c < 3; c += 1) dst.data[o + c] = Math.round(dst.data[o + c] * (1 - a) + img.data[i + c] * a);
      dst.data[o + 3] = 255;
    }
  }
}

/** A mix of two same-size frames (u = 0: a, 1: b). */
export function crossfade(a: Image, b: Image, u: number): Image {
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.round(a.data[i] * (1 - u) + b.data[i] * u);
  return { width: a.width, height: a.height, data: out };
}

export const blank = (width: number, height: number, rgb: [number, number, number] = [255, 255, 255]): Image => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return { width, height, data };
};

export const copy = (img: Image): Image => ({ width: img.width, height: img.height, data: img.data.slice() });
