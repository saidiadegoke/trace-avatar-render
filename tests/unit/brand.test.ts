import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import omggif from 'omggif';
import { PNG } from 'pngjs';
import { brandFile, brandOf, canvasOf, watermarkOf } from '../../src/brand';
import { layoutOf } from '../../src/layout';
import { badgeAt, finish } from '../../src/render';
import { parse } from '../../src/cli';
import type { Capture } from '../../src/capture';

describe('canvas, watermark and brand', () => {
  it('a canvas by name, WxH or size; anything else is refused', () => {
    expect(canvasOf('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(canvasOf('4:5')).toEqual({ width: 1080, height: 1350 });
    expect(canvasOf('1:1')).toEqual({ width: 1080, height: 1080 });
    expect(canvasOf('16:9')).toEqual({ width: 1920, height: 1080 });
    expect(canvasOf('720x1280')).toEqual({ width: 720, height: 1280 });
    expect(canvasOf({ width: 600, height: 600 })).toEqual({ width: 600, height: 600 });
    expect(() => canvasOf('3:2')).toThrow(/9:16, 4:5, 1:1, 16:9 or WIDTHxHEIGHT/);
    expect(() => canvasOf({ width: 10.5, height: 20 })).toThrow(/whole pixels/);
  });

  it('a watermark: its text, a corner, an opacity', () => {
    expect(watermarkOf('  Created with TraceAvatar · traceavatar.com ')).toEqual({ text: 'Created with TraceAvatar · traceavatar.com' });
    expect(watermarkOf({ text: 'x', at: 'top-left', opacity: 0.5 })).toEqual({ text: 'x', at: 'top-left', opacity: 0.5 });
    expect(() => watermarkOf('')).toThrow(/needs its text/);
    expect(() => watermarkOf({ text: 'x', at: 'middle' as never })).toThrow(/sits at/);
    expect(() => watermarkOf({ text: 'x', opacity: 0 })).toThrow(/opacity/);
  });

  it('a brand: the polish options checked, every problem named, logos resolved beside the file', () => {
    expect(brandOf({ canvas: '9:16', watermark: 'W', frame: 'browser', camera: { zoom: 1.4 }, captions: 'burn', endCard: { title: 'For more info visit', url: 'naijaprices.com', logo: 'logo.png' } }, '/brands'))
      .toEqual({ canvas: '9:16', watermark: { text: 'W' }, frame: 'browser', camera: { zoom: 1.4 }, captions: 'burn', endCard: { title: 'For more info visit', url: 'naijaprices.com', logo: '/brands/logo.png' } });
    expect(() => brandOf({ canvas: 'tall', frame: 'phone', captions: 'yes', endCard: 3, speed: 2 })).toThrow(
      /unknown key speed.*a canvas is.*frame is none or browser.*captions is burn, vtt or both.*endCard is true/,
    );
    expect(() => brandOf([])).toThrow(/a JSON object/);
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ $comment: 'x', name: 'NaijaPrices', watermark: { text: 'W', logo: 'l.svg' } }));
    expect(brandFile(join(dir, 'b.json'))).toEqual({ watermark: { text: 'W', logo: join(dir, 'l.svg') } });
    writeFileSync(join(dir, 'bad.json'), '{');
    expect(() => brandFile(join(dir, 'bad.json'))).toThrow(/brand .*bad\.json/);
  });

  it('layout on a canvas: the canvas size (scaled by width), the app between the safe areas, even sizes', () => {
    const tall = layoutOf(1280, 800, undefined, 'browser', canvasOf('9:16'));
    expect([tall.width, tall.height, tall.canvas]).toEqual([1080, 1920, true]);
    expect(tall.window.x).toBe(54); // 5% margins
    expect(tall.window.w).toBe(972);
    expect(tall.bar!.h).toBe(Math.round(972 * 0.039));
    expect(tall.window.y).toBeGreaterThanOrEqual(192); // 10% at the top
    expect(tall.window.y + tall.window.h).toBeLessThanOrEqual(1920 - 307); // 16% at the bottom
    // A phone capture fills a tall canvas (scaled up; the height decides).
    const phone = layoutOf(390, 844, undefined, 'none', canvasOf('9:16'));
    expect(phone.bar).toBeNull();
    expect(phone.content.y).toBeGreaterThanOrEqual(192);
    expect(phone.content.y).toBeLessThanOrEqual(194);
    expect(phone.content.h).toBeLessThanOrEqual(1920 - 192 - 307);
    expect(phone.content.w / phone.content.h).toBeCloseTo(390 / 844, 2);
    expect(phone.content.w).toBeGreaterThan(390);
    // --width scales the whole canvas down, never up; sizes stay even.
    expect(layoutOf(1280, 800, 400, 'none', canvasOf('9:16'))).toMatchObject({ width: 400, height: 712 });
    expect(layoutOf(1280, 800, 4000, 'none', canvasOf('1:1'))).toMatchObject({ width: 1080, height: 1080 });
  });

  it('a badge sits in its corner, 2.5% of the shorter side from the edges', () => {
    expect(badgeAt(1000, 600, 200, 40)).toEqual({ x: 785, y: 545 });
    expect(badgeAt(1000, 600, 200, 40, 'top-left')).toEqual({ x: 15, y: 15 });
    expect(badgeAt(1000, 600, 200, 40, 'top-right')).toEqual({ x: 785, y: 15 });
    expect(badgeAt(1000, 600, 200, 40, 'bottom-left')).toEqual({ x: 15, y: 545 });
  });

  it('the CLI: --canvas, --watermark, --watermark-at, --brand (the flags win)', () => {
    const base = ['a.trace.json', '--url', 'u', '--out', 'o.mp4'];
    expect(parse([...base, '--canvas', '9:16', '--watermark', 'Created with TraceAvatar']).options).toMatchObject({ canvas: '9:16', watermark: { text: 'Created with TraceAvatar' } });
    expect(parse([...base, '--watermark', 'W', '--watermark-at', 'top-left']).options).toMatchObject({ watermark: { text: 'W', at: 'top-left' } });
    expect(() => parse([...base, '--watermark-at', 'top-left'])).toThrow(/needs a watermark/);
    expect(() => parse([...base, '--watermark-at', 'centre', '--watermark', 'W'])).toThrow(/--watermark-at is/);
    expect(() => parse([...base, '--canvas', 'tall'])).toThrow(/a canvas is/);
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    const file = join(dir, 'p.json');
    writeFileSync(file, JSON.stringify({ canvas: '4:5', frame: 'browser', watermark: 'From the brand', endCard: { title: 'For more info visit', url: 'naijaprices.com' } }));
    const p = parse([...base, '--brand', file, '--canvas', '1:1', '--watermark-at', 'top-right']).options;
    expect(p).toMatchObject({ canvas: '1:1', frame: 'browser', watermark: { text: 'From the brand', at: 'top-right' }, endCard: { title: 'For more info visit', url: 'naijaprices.com' } });
    expect(() => parse([...base, '--brand', join(dir, 'none.json')])).toThrow(/brand/);
  });
});

describe('finish with a canvas and a watermark', () => {
  const white = () => { const p = new PNG({ width: 320, height: 200 }); p.data.fill(255); return PNG.sync.write(p); };
  const t0 = 3_000_000;
  const cap = (): Capture => ({
    frames: Array.from({ length: 21 }, (_, k) => ({ t: t0 + k * 100, png: white() })),
    events: [{ t: t0, type: 'play' }, { t: t0 + 500, type: 'step', stepType: 'hover', say: 'A caption long enough to run across most of the picture' }, { t: t0 + 2000, type: 'end' }],
    playAt: t0, stopAt: t0 + 2000, endAt: t0 + 2000,
  });
  /** Every frame of a GIF, as RGBA. */
  const framesOf = (file: string) => {
    const g = new omggif.GifReader(new Uint8Array(readFileSync(file)));
    const px = new Uint8Array(g.width * g.height * 4);
    const out: Uint8Array[] = [];
    for (let i = 0; i < g.numFrames(); i += 1) { g.decodeAndBlitFrameRGBA(i, px); out.push(px.slice()); }
    return { g, out };
  };
  const dark = (px: Uint8Array, W: number, x0: number, y0: number, x1: number, y1: number) => {
    let n = 0;
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const k = (y * W + x) * 4; if (px[k] + px[k + 1] + px[k + 2] < 450) n += 1; /* the badge's backing over white is about 270 */ }
    return n;
  };

  it('the badge is on every frame, the cards too; the canvas is the output shape; the caption keeps clear of the badge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-'));
    const file = join(dir, 'w.gif');
    const r = await finish(cap(), [{ file, format: 'gif', fps: 10, width: 360 }], {
      canvas: '9:16', background: '#f0f0f0', watermark: 'Created with TraceAvatar', captions: 'burn', cuts: { maxWaitMs: 0 },
      cards: { title: { title: 'Hello' }, end: { title: 'For more info visit', url: 'example.com' } },
    });
    expect(r.outputs[0]).toMatchObject({ width: 360, height: 640 });
    const { g, out } = framesOf(file);
    // The badge's corner (bottom-right) is dark on every frame, title and end cards included.
    for (const px of out) expect(dark(px, g.width, g.width - 120, g.height - 40, g.width - 10, g.height - 10)).toBeGreaterThan(100);
    // On a canvas the caption sits below the app, not over it (the app is white; the caption is dark).
    const l = layoutOf(320, 200, 360, 'none', canvasOf('9:16'));
    const shown = out[Math.round(out.length / 2)];
    expect(dark(shown, g.width, 20, l.window.y + l.window.h + 2, g.width - 20, g.height - 50)).toBeGreaterThan(200);
    expect(dark(shown, g.width, l.content.x + 4, l.content.y + 4, l.content.x + l.content.w - 4, l.content.y + l.content.h - 4)).toBe(0);
    // Without a watermark, that corner stays light.
    const plain = join(dir, 'p.gif');
    await finish(cap(), [{ file: plain, format: 'gif', fps: 10, width: 360 }], { canvas: '9:16', background: '#f0f0f0', cuts: { maxWaitMs: 0 } });
    const p = framesOf(plain);
    expect(dark(p.out[p.out.length - 1], p.g.width, p.g.width - 120, p.g.height - 40, p.g.width - 10, p.g.height - 10)).toBe(0);
  }, 60_000);

  it('a watermark without a canvas sits on the app itself, in the corner it is given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-'));
    const file = join(dir, 'tl.gif');
    await finish(cap(), [{ file, format: 'gif', fps: 10 }], { watermark: { text: 'Made here', at: 'top-left' }, cuts: { maxWaitMs: 0 } });
    const { g, out } = framesOf(file);
    expect([g.width, g.height]).toEqual([320, 200]);
    const px = out[out.length - 1];
    expect(dark(px, g.width, 0, 0, 100, 30)).toBeGreaterThan(50);
    expect(dark(px, g.width, 200, 150, 320, 200)).toBe(0);
  }, 30_000);
});
