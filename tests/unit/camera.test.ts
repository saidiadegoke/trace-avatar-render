import { describe, expect, it } from 'vitest';
import { cameraKeys, cameraPath } from '../../src/camera';

const O = { width: 1000, height: 600 };

describe('camera', () => {
  it('no actions: always the whole frame', () => {
    const at = cameraPath([], O);
    expect(at(0)).toEqual({ x: 0, y: 0, w: 1000, h: 600 });
    expect(at(5000)).toEqual({ x: 0, y: 0, w: 1000, h: 600 });
  });

  it('arrives zoomed in 400 ms before a click, centred on it, then goes back out', () => {
    const at = cameraPath([{ t: 3000, x: 500, y: 300, kind: 'click' }], O);
    expect(at(2000)).toEqual({ x: 0, y: 0, w: 1000, h: 600 }); // before the move
    const there = at(2600);
    expect(there.w).toBeCloseTo(1000 / 1.6);
    expect(there.x + there.w / 2).toBeCloseTo(500);
    expect(there.y + there.h / 2).toBeCloseTo(300);
    expect(at(3000)).toEqual(there); // holds through the action
    const mid = at(2400); // halfway into the move
    expect(mid.w).toBeLessThan(1000);
    expect(mid.w).toBeGreaterThan(1000 / 1.6);
    expect(at(3000 + 900 + 400 + 1)).toEqual({ x: 0, y: 0, w: 1000, h: 600 }); // hold 900, ease 400
  });

  it('keeps the view inside the frame near an edge', () => {
    const r = cameraPath([{ t: 2000, x: 5, y: 590, kind: 'click' }], O)(1900);
    expect(r.x).toBe(0);
    expect(r.y + r.h).toBeCloseTo(600);
  });

  it('pans between actions close in time; a scroll ends the shot; far-apart shots zoom out between', () => {
    const near = cameraKeys([{ t: 2000, x: 300, y: 200, kind: 'click' }, { t: 3500, x: 600, y: 350, kind: 'type' }], O);
    expect(near.filter((k) => k.z === 1)).toHaveLength(2); // one in, one out
    const scrolled = cameraKeys([{ t: 2000, x: 100, y: 100, kind: 'click' }, { t: 2600, x: 0, y: 0, kind: 'scroll' }, { t: 6000, x: 800, y: 400, kind: 'click' }], O);
    expect(scrolled.filter((k) => k.z === 1)).toHaveLength(4);
    const far = cameraKeys([{ t: 2000, x: 100, y: 100, kind: 'click' }, { t: 9000, x: 800, y: 400, kind: 'click' }], O);
    expect(far.filter((k) => k.z === 1)).toHaveLength(4);
  });

  it('joins shots that would change zoom too often', () => {
    // 2.8 s apart: past joinMs (2.5 s), but out-then-in would be under 1.5 s apart.
    const keys = cameraKeys([{ t: 2000, x: 300, y: 200, kind: 'click' }, { t: 4800, x: 600, y: 350, kind: 'click' }], O);
    expect(keys.filter((k) => k.z === 1)).toHaveLength(2);
  });

  it('is deterministic, and times are monotone', () => {
    const acts = [{ t: 1000, x: 10, y: 10, kind: 'click' }, { t: 1100, x: 900, y: 500, kind: 'click' }, { t: 1200, x: 400, y: 200, kind: 'key' }];
    const a = cameraKeys(acts, O);
    expect(cameraKeys(acts, O)).toEqual(a);
    for (let k = 1; k < a.length; k += 1) expect(a[k].t).toBeGreaterThanOrEqual(a[k - 1].t);
  });
});

describe('camera: long trips', () => {
  it('zooms out and back in for a far action, instead of panning across the page', () => {
    // 800 px apart on a 1000 px page (over 45%), 2 s apart: two shots, not one pan.
    const acts = [{ t: 2000, x: 100, y: 300, kind: 'click' }, { t: 4000, x: 900, y: 300, kind: 'click' }];
    const keys = cameraKeys(acts, O);
    expect(keys.filter((k) => k.z === 1).length).toBe(4); // in, out, in, out
    const at = cameraPath(acts, O);
    // Zoomed in on each when it acts.
    expect(at(2000).w).toBeCloseTo(1000 / 1.6);
    expect(at(4000).w).toBeCloseTo(1000 / 1.6);
    expect(at(4000).x).toBeCloseTo(1000 - 1000 / 1.6); // on the right edge, where x = 900 is
    // Out somewhere between them.
    const between = [2800, 3000, 3200].map((t) => at(t).w);
    expect(Math.max(...between)).toBe(1000);
  });

  it('a near action in the same burst still pans', () => {
    const acts = [{ t: 2000, x: 400, y: 300, kind: 'click' }, { t: 3000, x: 600, y: 300, kind: 'click' }];
    expect(cameraKeys(acts, O).filter((k) => k.z === 1).length).toBe(2); // one shot
  });

  it('a far action close behind still arrives before it acts', () => {
    const acts = [{ t: 2000, x: 100, y: 300, kind: 'click' }, { t: 3500, x: 900, y: 300, kind: 'click' }];
    const at = cameraPath(acts, O);
    const r = at(3500 - 50);
    expect(r.w).toBeCloseTo(1000 / 1.6);
    expect(r.x).toBeCloseTo(1000 - 1000 / 1.6);
  });

  it('travel sets how far is far', () => {
    const acts = [{ t: 2000, x: 100, y: 300, kind: 'click' }, { t: 4000, x: 900, y: 300, kind: 'click' }];
    expect(cameraKeys(acts, { ...O, travel: 0.9 }).filter((k) => k.z === 1).length).toBe(2);
  });
});
