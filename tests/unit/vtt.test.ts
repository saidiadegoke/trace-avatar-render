import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captionCues, chapterCues, toVtt } from '../../src/vtt';
import { actionsOf, cueAt, pageAt, stepCues } from '../../src/plan';
import type { TimelineEvent } from '../../src/timeline';

const golden = (name: string) => readFileSync(join(import.meta.dirname, 'golden', name), 'utf8');

describe('vtt', () => {
  it('writes WebVTT (golden), dropping empty cues and cleaning arrows and blank lines', () => {
    const cues = captionCues([{ t: 0, text: 'Open the invoice. It is new.' }, { t: 2500, text: 'Type the amount --> here' }, { t: 9000, text: 'Save\n\nit' }, { t: 9500, text: '  ' }, { t: 3_720_000, text: 'An hour in' }], 3_725_000);
    expect(toVtt(cues)).toBe(golden('captions.vtt'));
    expect(toVtt(chapterCues([{ t: 0, text: 'Open the invoice. It is new.' }, { t: 2500, text: 'Type the amount' }], 4000))).toBe(golden('chapters.vtt'));
  });

  it('captions last until the next, at most maxMs, never past the end', () => {
    expect(captionCues([{ t: 5000, text: 'b' }, { t: 0, text: 'a' }], 7000, 3000)).toEqual([{ start: 0, end: 3000, text: 'a' }, { start: 5000, end: 7000, text: 'b' }]);
  });
});

describe('plan', () => {
  const segs = [{ from: 1000, to: 3000 }, { from: 5000, to: 9000 }]; // 2 s cut out
  const ev: TimelineEvent[] = [
    { t: 1000, type: 'ready', url: '/a' },
    { t: 1500, type: 'step', stepType: 'wait', say: 'It loads' },
    { t: 2800, type: 'step', stepType: 'click', rect: { x: 100, y: 50, w: 20, h: 10 }, say: 'Save', url: '/a' },
    { t: 5500, type: 'unload', url: '/b' },
    { t: 6000, type: 'ready', url: '/b' },
    { t: 7000, type: 'step', stepType: 'scroll', rect: { x: 0, y: 0, w: 640, h: 400 } },
    { t: 8000, type: 'step', stepType: 'type', rect: { x: 10, y: 10, w: 100, h: 30 }, say: 'Type it' },
  ];

  it('actions: steps with an element at their centre (× scale), page changes, on the output timeline', () => {
    expect(actionsOf(ev, segs, 2)).toEqual([
      { t: 1800, x: 220, y: 110, kind: 'click' },
      { t: 2500, x: 0, y: 0, kind: 'page' },
      { t: 4000, x: 640, y: 400, kind: 'scroll' },
      { t: 5000, x: 120, y: 50, kind: 'type' },
    ]);
  });

  it('cues: from the step before to just after the step, never overlapping, at least minMs where there is room', () => {
    expect(stepCues(ev, segs, 6000)).toEqual([
      { start: 0, end: 1100, text: 'It loads' },
      { start: 1100, end: 2400, text: 'Save' },
      { start: 4000, end: 5600, text: 'Type it' },
    ]);
  });

  it('cueAt fades in and out; pageAt follows the events', () => {
    const cues = [{ start: 1000, end: 2000, text: 'x' }];
    expect(cueAt(cues, 999)).toBeNull();
    expect(cueAt(cues, 1075)!.alpha).toBeCloseTo(0.5);
    expect(cueAt(cues, 1500)!.alpha).toBe(1);
    expect(cueAt(cues, 2000)).toBeNull();
    const page = pageAt(ev);
    expect([page(0), page(2900), page(5600), page(6500)]).toEqual(['/a', '/a', '/a', '/b']);
  });
});
