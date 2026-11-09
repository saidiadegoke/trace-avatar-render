import { describe, expect, it } from 'vitest';
import omggif from 'omggif';
import { encodeGif, paletteOf } from '../../src/gif';

const frame = (w: number, h: number, box?: { x: number; y: number; c: [number, number, number] }) => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) data.set([250, 250, 250, 255], i * 4);
  if (box) for (let y = box.y; y < box.y + 4; y += 1) for (let x = box.x; x < box.x + 4; x += 1) data.set([...box.c, 255], (y * w + x) * 4);
  return { width: w, height: h, data };
};

function decode(bytes: Uint8Array) {
  const r = new omggif.GifReader(bytes);
  const canvas = new Uint8Array(r.width * r.height * 4);
  const shots: Array<{ delay: number; rgba: Uint8Array }> = [];
  for (let i = 0; i < r.numFrames(); i += 1) {
    r.decodeAndBlitFrameRGBA(i, canvas);
    shots.push({ delay: r.frameInfo(i).delay * 10, rgba: canvas.slice() });
  }
  return { r, shots };
}
const at = (rgba: Uint8Array, w: number, x: number, y: number) => Array.from(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 3));

describe('encodeGif', () => {
  it('merges identical frames, keeps the total time, and draws only what changed (the rest shows through)', () => {
    const w = 40; const h = 20;
    const frames = [frame(w, h), frame(w, h), frame(w, h, { x: 10, y: 5, c: [36, 86, 216] }), frame(w, h, { x: 10, y: 5, c: [36, 86, 216] }), frame(w, h, { x: 20, y: 5, c: [36, 86, 216] })];
    const g = encodeGif(frames, { fps: 10 });
    expect(g.frames).toBe(3);
    expect(g.durationMs).toBe(500);
    const { r, shots } = decode(g.bytes);
    expect([r.width, r.height, r.loopCount()]).toEqual([w, h, 0]);
    expect(shots.map((s) => s.delay)).toEqual([200, 200, 100]);
    expect(at(shots[1].rgba, w, 11, 6)).toEqual([36, 86, 216]);
    expect(at(shots[1].rgba, w, 0, 0)).toEqual([250, 250, 250]);
    // The last frame moved the box: the old spot is background again, the new one is blue.
    expect(at(shots[2].rgba, w, 11, 6)).toEqual([250, 250, 250]);
    expect(at(shots[2].rgba, w, 21, 6)).toEqual([36, 86, 216]);
  });

  it('carries delay rounding so odd frame rates keep their length; once, or forever', () => {
    const w = 8; const h = 8;
    const frames = Array.from({ length: 12 }, (_, k) => frame(w, h, { x: k % 2 ? 0 : 4, y: 0, c: [200, 0, 0] }));
    const g = encodeGif(frames, { fps: 12, repeat: -1 });
    const { r, shots } = decode(g.bytes);
    expect(shots.reduce((n, s) => n + s.delay, 0)).toBe(1000);
    expect(r.loopCount()).toBeNull();
  });

  it('refuses empty or mixed-size input; the palette has at most 255 colours', () => {
    expect(() => encodeGif([], { fps: 10 })).toThrow('no frames');
    expect(() => encodeGif([frame(4, 4), frame(8, 4)], { fps: 10 })).toThrow('same size');
    const noisy = { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256)) };
    expect(paletteOf([noisy]).length).toBeLessThanOrEqual(255);
  });
});
