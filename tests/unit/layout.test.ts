import { describe, expect, it } from 'vitest';
import { canvasOf } from '../../src/brand';
import { layoutOf } from '../../src/layout';

describe('layoutOf', () => {
  it('none: the capture scaled, even sizes, never upscaled', () => {
    expect(layoutOf(1280, 800, 640, 'none')).toMatchObject({ width: 640, height: 400, bar: null, content: { x: 0, y: 0, w: 640, h: 400 } });
    expect(layoutOf(640, 400, 800, 'none')).toMatchObject({ width: 640, height: 400 });
    expect(layoutOf(101, 61, undefined)).toMatchObject({ width: 100, height: 60 }); // cropped, not stretched
  });

  it('browser: a window with a title bar, centred with padding, content keeping the aspect', () => {
    const l = layoutOf(1280, 800, 1000, 'browser');
    expect(l.width).toBe(1000);
    expect(l.bar).toEqual({ x: 40, y: l.window.y, w: 920, h: 36 });
    expect(l.content.w).toBe(920);
    expect(l.content.h).toBe(Math.round((800 * 920) / 1280));
    expect(l.content.y).toBe(l.bar!.y + 36);
    expect(l.height % 2).toBe(0);
    expect(l.window.y + l.window.h).toBeLessThanOrEqual(l.height);
    // Without a width: wide enough that the page keeps its own size.
    expect(layoutOf(640, 400, undefined, 'browser')).toMatchObject({ width: 696, height: 482, content: { w: 640, h: 400 } });
    // A small width keeps a usable bar.
    expect(layoutOf(320, 200, 320, 'browser').bar!.h).toBe(18);
  });

  it('fill: a capture of the canvas shape fills it edge to edge, with no window even when the frame is browser', () => {
    const wide = layoutOf(1280, 720, undefined, 'browser', canvasOf('16:9'), true);
    expect([wide.width, wide.height, wide.bar]).toEqual([1920, 1080, null]);
    expect(wide.content).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    // Another shape is fitted inside, centred, on the background.
    const tall = layoutOf(1280, 800, undefined, 'none', canvasOf('16:9'), true);
    expect(tall.content.h).toBe(1080);
    expect(tall.content.x).toBe(Math.round((1920 - tall.content.w) / 2));
    // Without fill the same output keeps its window and margins.
    expect(layoutOf(1280, 720, undefined, 'browser', canvasOf('16:9')).bar).not.toBeNull();
  });
});
