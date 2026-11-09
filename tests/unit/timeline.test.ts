import { describe, expect, it } from 'vitest';
import { durationOf, editList, frameTimes, outputAt, pickFrames, sourceAt, spansOf } from '../../src/timeline';
import type { TimelineEvent } from '../../src/timeline';

const st = (t: number, phase: TimelineEvent['phase']): TimelineEvent => ({ t, type: 'state', phase });

describe('spansOf', () => {
  it('turns state events into phase spans over [start, end], merging repeats', () => {
    const ev = [st(100, 'playing'), st(400, 'waiting'), st(500, 'waiting'), st(2500, 'playing'), st(3000, 'ended')];
    expect(spansOf(ev, 0, 3500)).toEqual([
      { from: 0, to: 100, phase: 'idle' }, { from: 100, to: 400, phase: 'playing' },
      { from: 400, to: 2500, phase: 'waiting' }, { from: 2500, to: 3000, phase: 'playing' }, { from: 3000, to: 3500, phase: 'ended' },
    ]);
    expect(spansOf(ev, 450, 600)).toEqual([{ from: 450, to: 600, phase: 'waiting' }]);
  });

  it('a page unloading is waiting until the next page reports a phase', () => {
    const ev: TimelineEvent[] = [st(0, 'playing'), { t: 1000, type: 'unload' }, { t: 1900, type: 'ready' }, st(2000, 'playing')];
    expect(spansOf(ev, 0, 3000).map((s) => [s.phase, s.from, s.to])).toEqual([['playing', 0, 1000], ['waiting', 1000, 2000], ['playing', 2000, 3000]]);
  });
});

describe('editList and time maps', () => {
  const ev = [st(0, 'playing'), st(1000, 'waiting'), st(10_000, 'playing'), st(10_500, 'waiting'), st(11_000, 'playing')];

  it('keeps the first and last half of the wait limit of a long wait and cuts its middle; short waits stay', () => {
    const segs = editList(ev, { start: 0, end: 12_000, maxWaitMs: 800 });
    expect(segs).toEqual([{ from: 0, to: 1400 }, { from: 9600, to: 12_000 }]);
    expect(durationOf(segs)).toBe(3800);
    expect(editList(ev, { start: 0, end: 12_000, maxWaitMs: 0 })).toEqual([{ from: 0, to: 12_000 }]);
    expect(editList(ev, { start: 5, end: 5 })).toEqual([]);
    expect(durationOf(editList(ev, { start: 0, end: 12_000 }))).toBe(3800); // default 800
  });

  it('maps output time to source time and back', () => {
    const segs = [{ from: 0, to: 1400 }, { from: 9600, to: 12_000 }];
    expect(sourceAt(segs, 0)).toBe(0);
    expect(sourceAt(segs, 1399)).toBe(1399);
    expect(sourceAt(segs, 1400)).toBe(9600);
    expect(sourceAt(segs, 99_999)).toBe(12_000);
    expect(sourceAt(segs, -5)).toBe(0);
    expect(sourceAt([], 10)).toBe(0);
    expect(outputAt(segs, 9700)).toBe(1500);
    expect(outputAt(segs, 5000)).toBeNull();
    expect(frameTimes(segs, 10)).toHaveLength(38);
    expect(frameTimes(segs, 10).slice(13, 16)).toEqual([1300, 9600, 9700]);
    expect(frameTimes([], 10)).toHaveLength(1);
  });

  it('picks the last captured frame at or before each time', () => {
    expect(pickFrames([10, 20, 30], [0, 10, 15, 20, 29, 30, 99])).toEqual([0, 0, 0, 1, 1, 2, 2]);
  });
});
