import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import omggif from 'omggif';
import { PNG } from 'pngjs';
import { finish } from '../../src/render';
import type { Capture } from '../../src/capture';

/** A made-up capture: a dot moving right, 25 frames a second, with a 6 s wait in the middle. */
function capture(): Capture {
  const png = (x: number) => {
    const p = new PNG({ width: 100, height: 60 });
    for (let i = 0; i < 100 * 60; i += 1) p.data.set([255, 255, 255, 255], i * 4);
    for (let y = 20; y < 30; y += 1) for (let dx = 0; dx < 10; dx += 1) p.data.set([255, 0, 170, 255], (y * 100 + x + dx) * 4);
    return PNG.sync.write(p);
  };
  const t0 = 1_000_000;
  const frames = [];
  for (let k = 0; k <= 250; k += 1) frames.push({ t: t0 + k * 40, png: png(Math.min(85, Math.floor(k / 3))) });
  return {
    frames,
    events: [
      { t: t0 + 500, type: 'state', phase: 'playing' }, { t: t0 + 2000, type: 'state', phase: 'waiting' },
      { t: t0 + 8000, type: 'state', phase: 'playing' }, { t: t0 + 9000, type: 'end' }, { t: t0 + 9000, type: 'state', phase: 'ended' },
    ],
    playAt: t0 + 500, stopAt: t0 + 10_000, endAt: t0 + 9000,
  };
}

describe('finish: from a capture to a GIF', () => {
  it('cuts the long wait, scales, writes the frames at the fps, and the timeline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-'));
    const r = await finish(capture(), [{ file: join(dir, 'a.gif'), format: 'gif', width: 50, fps: 10 }], { timeline: join(dir, 't.json') });
    // 0.5 s lead (from the first frame) … 10 s, minus the 6 s wait cut to 0.8 s.
    expect(r.rawMs).toBe(10_000);
    expect(r.durationMs).toBe(10_000 - 6000 + 800);
    expect(r.segments).toEqual([{ from: 0, to: 2400 }, { from: 7600, to: 10_000 }]);
    expect(r.outputs[0]).toMatchObject({ format: 'gif', width: 50, height: 30, fps: 10, frames: 48 });
    const g = new omggif.GifReader(new Uint8Array(readFileSync(join(dir, 'a.gif'))));
    expect([g.width, g.height]).toEqual([50, 30]);
    let total = 0;
    for (let i = 0; i < g.numFrames(); i += 1) total += g.frameInfo(i).delay * 10;
    expect(total).toBe(4800);
    expect(JSON.parse(readFileSync(join(dir, 't.json'), 'utf8')).events[0]).toEqual({ t: 500, type: 'state', phase: 'playing' });
    // Keeping every wait: the whole capture.
    const all = await finish(capture(), [{ file: join(dir, 'b.gif'), format: 'gif', fps: 5 }], { cuts: { maxWaitMs: 0 } });
    expect(all.durationMs).toBe(10_000);
    expect(all.outputs[0]).toMatchObject({ width: 100, height: 60, frames: 50 });
  });

  it('camera: zoomed in at a click (the dot fills more of the frame), whole frame before; VTT files and a poster', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-'));
    const cap = capture();
    // The click lands on the dot (x 33..43 at k≈100 → 4 s), with words.
    cap.events.push({ t: 1_000_000 + 4000, type: 'step', stepType: 'click', rect: { x: 33, y: 20, w: 10, h: 10 }, say: 'Click the dot' });
    cap.events.push({ t: 1_000_000 + 1000, type: 'step', stepType: 'wait', say: 'Wait for it. Really.' });
    const r = await finish(cap, [{ file: join(dir, 'c.gif'), format: 'gif', fps: 10 }], { camera: true, captions: 'vtt', poster: true, cuts: { maxWaitMs: 0 } });
    const g = new omggif.GifReader(new Uint8Array(readFileSync(join(dir, 'c.gif'))));
    const canvas = new Uint8Array(g.width * g.height * 4);
    const pink = (at: number) => {
      let shown = 0;
      for (let i = 0; i < g.numFrames(); i += 1) {
        g.decodeAndBlitFrameRGBA(i, canvas);
        shown += g.frameInfo(i).delay * 10;
        if (shown > at) break;
      }
      let n = 0;
      for (let p = 0; p < g.width * g.height; p += 1) if (canvas[p * 4] > 200 && canvas[p * 4 + 1] < 80) n += 1;
      return n;
    };
    expect(pink(500)).toBeLessThan(130); // 10×10 dot, whole frame
    expect(pink(3500)).toBeGreaterThan(160); // ×1.6 → about 16×16 (edges blend)
    expect(pink(9500)).toBeLessThan(130); // back out
    // The poster is that zoomed moment.
    const p = PNG.sync.read(readFileSync(r.poster!));
    expect(r.poster).toBe(join(dir, 'c.png'));
    expect([p.width, p.height]).toEqual([100, 60]);
    let n = 0;
    for (let i = 0; i < 100 * 60; i += 1) if (p.data[i * 4] > 200 && p.data[i * 4 + 1] < 80) n += 1;
    expect(n).toBeGreaterThan(160);
    expect(readFileSync(r.vtt!, 'utf8')).toBe('WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.600\nWait for it. Really.\n\n2\n00:00:01.600 --> 00:00:04.600\nClick the dot\n');
    expect(r.chapters).toBe(join(dir, 'c.chapters.vtt'));
    expect(readFileSync(r.chapters!, 'utf8')).toContain('Wait for it.\n');
    expect(r.offsetMs).toBe(0);
  });

  it('burned-in captions sit low by default, high with captionsAt: top (for an app whose own UI is low)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-'));
    const white = () => { const p = new PNG({ width: 480, height: 300 }); p.data.fill(255); return PNG.sync.write(p); };
    const t0 = 2_000_000;
    const cap = (): Capture => ({
      frames: Array.from({ length: 31 }, (_, k) => ({ t: t0 + k * 100, png: white() })),
      events: [{ t: t0, type: 'play' }, { t: t0 + 2000, type: 'step', stepType: 'hover', say: 'A caption to place' }, { t: t0 + 3000, type: 'end' }],
      playAt: t0, stopAt: t0 + 3000, endAt: t0 + 3000,
    });
    const darkRows = async (at?: 'top' | 'bottom') => {
      const file = join(dir, `${at ?? 'default'}.gif`);
      await finish(cap(), [{ file, format: 'gif', fps: 10 }], { captions: 'burn', cuts: { maxWaitMs: 0 }, ...(at ? { captionsAt: at } : {}) });
      const g = new omggif.GifReader(new Uint8Array(readFileSync(file)));
      const px = new Uint8Array(g.width * g.height * 4);
      // The frame showing at 1.8 s (the caption shows); repeated frames are merged, so walk the delays.
      for (let i = 0, t = 0; i < g.numFrames() && t <= 1800; t += g.frameInfo(i).delay * 10, i += 1) g.decodeAndBlitFrameRGBA(i, px);
      const rows = { top: 0, bottom: 0 };
      for (let y = 0; y < g.height; y += 1) for (let x = 0; x < g.width; x += 1) {
        const k = (y * g.width + x) * 4;
        if (px[k] + px[k + 1] + px[k + 2] < 200) rows[y < g.height / 2 ? 'top' : 'bottom'] += 1;
      }
      return rows;
    };
    const low = await darkRows();
    expect(low.bottom).toBeGreaterThan(500);
    expect(low.top).toBe(0);
    const high = await darkRows('top');
    expect(high.top).toBeGreaterThan(500);
    expect(high.bottom).toBe(0);
  }, 30_000);
});
