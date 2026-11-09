import { describe, expect, it } from 'vitest';
import { blank, crossfade, drawRegion, overlay } from '../../src/compose';
import { pixel } from '../../src/image';

/** Left half red, right half blue. */
const halves = (w: number, h: number) => {
  const img = blank(w, h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) img.data.set(x < w / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * w + x) * 4);
  return img;
};

describe('compose', () => {
  it('drawRegion shrinks by area-averaging and places the result', () => {
    const dst = blank(20, 10, [0, 0, 0]);
    drawRegion(dst, { x: 10, y: 0, w: 10, h: 10 }, halves(40, 40), { x: 0, y: 0, w: 40, h: 40 });
    expect(pixel(dst, 0, 0)).toEqual([0, 0, 0]); // left untouched
    expect(pixel(dst, 11, 5)).toEqual([255, 0, 0]);
    expect(pixel(dst, 18, 5)).toEqual([0, 0, 255]);
  });

  it('drawRegion zooms into a region (bilinear when growing)', () => {
    const dst = blank(20, 20);
    drawRegion(dst, { x: 0, y: 0, w: 20, h: 20 }, halves(40, 40), { x: 0, y: 0, w: 10, h: 10 }); // all red
    expect(pixel(dst, 19, 19)).toEqual([255, 0, 0]);
    drawRegion(dst, { x: 0, y: 0, w: 20, h: 20 }, halves(40, 40), { x: 15, y: 0, w: 10, h: 10 }); // the seam in the middle
    expect(pixel(dst, 0, 0)).toEqual([255, 0, 0]);
    expect(pixel(dst, 19, 0)).toEqual([0, 0, 255]);
    const [r, , b] = pixel(dst, 10, 0);
    expect(r > 0 && b > 0).toBe(true); // blended at the seam
  });

  it('overlay blends by alpha and clips at the edges', () => {
    const dst = blank(4, 4, [0, 0, 0]);
    const img = { width: 2, height: 2, data: new Uint8Array([255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 128, 255, 255, 255, 255]) };
    overlay(dst, img, 3, 3, 1);
    expect(pixel(dst, 3, 3)).toEqual([255, 255, 255]);
    overlay(dst, img, 0, 0, 0.5);
    expect(pixel(dst, 0, 0)).toEqual([128, 128, 128]);
    expect(pixel(dst, 1, 0)).toEqual([0, 0, 0]); // transparent pixel
  });

  it('crossfade mixes two frames', () => {
    const a = blank(2, 2, [0, 0, 0]);
    const b = blank(2, 2, [200, 100, 50]);
    expect(pixel(crossfade(a, b, 0.5), 1, 1)).toEqual([100, 50, 25]);
    expect(pixel(crossfade(a, b, 1), 0, 0)).toEqual([200, 100, 50]);
  });
});
