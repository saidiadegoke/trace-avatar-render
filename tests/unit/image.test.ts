import { describe, expect, it } from 'vitest';
import { crop, fitWidth, pixel, resize } from '../../src/image';

const solid = (w: number, h: number, f: (x: number, y: number) => [number, number, number]) => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const [r, g, b] = f(x, y); data.set([r, g, b, 255], (y * w + x) * 4); }
  return { width: w, height: h, data };
};

describe('image', () => {
  it('fits a width with even sizes, never upscaling', () => {
    expect(fitWidth(1280, 800, 800)).toEqual({ width: 800, height: 500 });
    expect(fitWidth(1281, 801)).toEqual({ width: 1280, height: 800 });
    expect(fitWidth(1280, 800, 4000)).toEqual({ width: 1280, height: 800 });
    expect(fitWidth(1000, 333, 501)).toEqual({ width: 502, height: 168 });
  });

  it('averages areas when shrinking', () => {
    const img = solid(4, 2, (x) => (x < 2 ? [0, 0, 0] : [200, 100, 50]));
    const r = resize(img, 2, 1);
    expect(pixel(r, 0, 0)).toEqual([0, 0, 0]);
    expect(pixel(r, 1, 0)).toEqual([200, 100, 50]);
    const half = resize(solid(3, 1, (x) => [x * 90, 0, 0]), 2, 1);
    expect(pixel(half, 0, 0)[0]).toBe(30); // (0 + 90*0.5) / 1.5
    expect(resize(img, 4, 2)).toBe(img);
  });

  it('crops to the top-left', () => {
    const img = solid(3, 3, (x, y) => [x, y, 0]);
    const c = crop(img, 2, 2);
    expect([c.width, c.height]).toEqual([2, 2]);
    expect(pixel(c, 1, 1)).toEqual([1, 1, 0]);
    expect(crop(img, 3, 3)).toBe(img);
  });
});
