/** RGBA pixel helpers. PURE. */

export interface Image { width: number; height: number; data: Uint8Array }

/** The size to scale to for a target width (even numbers, for video encoders), keeping the aspect. */
export function fitWidth(w: number, h: number, width?: number): { width: number; height: number } {
  if (!width || width >= w) return { width: w - (w % 2), height: h - (h % 2) };
  const W = Math.max(2, Math.round(width / 2) * 2);
  const H = Math.max(2, Math.round((h * W) / w / 2) * 2);
  return { width: W, height: H };
}

/** Area-average (box) downscale: every source pixel contributes by its overlap. Upscaling isn't needed here. */
export function resize(src: Image, W: number, H: number): Image {
  const { width: w, height: h, data } = src;
  if (W === w && H === h) return src;
  const out = new Uint8Array(W * H * 4);
  const sx = w / W;
  const sy = h / H;
  for (let Y = 0; Y < H; Y += 1) {
    const y0 = Y * sy;
    const y1 = y0 + sy;
    for (let X = 0; X < W; X += 1) {
      const x0 = X * sx;
      const x1 = x0 + sx;
      let r = 0; let g = 0; let b = 0; let a = 0; let wsum = 0;
      for (let y = Math.floor(y0); y < Math.min(h, Math.ceil(y1)); y += 1) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.min(w, Math.ceil(x1)); x += 1) {
          const wt = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const i = (y * w + x) * 4;
          r += data[i] * wt; g += data[i + 1] * wt; b += data[i + 2] * wt; a += data[i + 3] * wt;
          wsum += wt;
        }
      }
      const o = (Y * W + X) * 4;
      out[o] = Math.round(r / wsum); out[o + 1] = Math.round(g / wsum); out[o + 2] = Math.round(b / wsum); out[o + 3] = Math.round(a / wsum);
    }
  }
  return { width: W, height: H, data: out };
}

/** Crop to the top-left W×H (to make sizes even). */
export function crop(src: Image, W: number, H: number): Image {
  if (W === src.width && H === src.height) return src;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) out.set(src.data.subarray(y * src.width * 4, y * src.width * 4 + W * 4), y * W * 4);
  return { width: W, height: H, data: out };
}

export function pixel(img: Image, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}
