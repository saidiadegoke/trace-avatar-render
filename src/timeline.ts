/**
 * The guide's own timeline, and the edit list made from it. PURE: plain numbers in, plain numbers out.
 *
 * Times are wall-clock milliseconds (the page logs Date.now(), the screencast stamps frames in epoch
 * seconds), so events and frames from every page load share one clock.
 */

export type Phase = 'idle' | 'playing' | 'paused' | 'waiting' | 'ended';

export interface TimelineEvent {
  t: number;
  type: 'ready' | 'play' | 'state' | 'step' | 'stalled' | 'handoff' | 'page' | 'end' | 'error' | 'blocked' | 'unload';
  phase?: Phase;
  index?: number;
  stepType?: string;
  reason?: string;
  message?: string;
  url?: string;
}

export interface Span { from: number; to: number; phase: Phase }

/** A kept stretch of the capture, in source time. */
export interface Segment { from: number; to: number }

export interface EditOptions {
  /** Where the output starts and ends (source time). */
  start: number;
  end: number;
  /** A wait longer than this keeps its first and last half of it; the middle is cut. Default 800. 0 keeps every wait. */
  maxWaitMs?: number;
}

export const DEFAULT_MAX_WAIT_MS = 800;

/**
 * The player's phase over [start, end]. A page unloading counts as waiting until the next page's player
 * reports a phase again.
 */
export function spansOf(events: readonly TimelineEvent[], start: number, end: number): Span[] {
  const marks = events
    .filter((e) => (e.type === 'state' && e.phase) || e.type === 'unload')
    .map((e) => ({ t: e.t, phase: (e.type === 'unload' ? 'waiting' : e.phase) as Phase }))
    .sort((a, b) => a.t - b.t);
  const spans: Span[] = [];
  let phase: Phase = 'idle';
  let at = start;
  for (const m of marks) {
    if (m.t <= start) { phase = m.phase; continue; }
    if (m.t >= end) break;
    if (m.t > at) spans.push({ from: at, to: m.t, phase });
    phase = m.phase;
    at = m.t;
  }
  if (end > at) spans.push({ from: at, to: end, phase });
  // Merge neighbours in the same phase.
  const out: Span[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && last.phase === s.phase && last.to === s.from) last.to = s.to;
    else out.push({ ...s });
  }
  return out;
}

/** The stretches of the capture to keep: everything, except the middle of each long wait. */
export function editList(events: readonly TimelineEvent[], o: EditOptions): Segment[] {
  if (!(o.end > o.start)) return [];
  const max = o.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const cuts: Segment[] = [];
  if (max > 0) {
    for (const s of spansOf(events, o.start, o.end)) {
      if (s.phase === 'waiting' && s.to - s.from > max) cuts.push({ from: s.from + max / 2, to: s.to - max / 2 });
    }
  }
  const keep: Segment[] = [];
  let at = o.start;
  for (const c of cuts) {
    if (c.from > at) keep.push({ from: at, to: c.from });
    at = Math.max(at, c.to);
  }
  if (o.end > at) keep.push({ from: at, to: o.end });
  return keep;
}

export const durationOf = (segs: readonly Segment[]): number => segs.reduce((n, s) => n + (s.to - s.from), 0);

/** The source time shown at output time `t` (clamped to the ends). */
export function sourceAt(segs: readonly Segment[], t: number): number {
  if (!segs.length) return 0;
  let left = Math.max(0, t);
  for (const s of segs) {
    const len = s.to - s.from;
    if (left < len) return s.from + left;
    left -= len;
  }
  return segs[segs.length - 1].to;
}

/** The output time where source time `src` lands, or null when it was cut. */
export function outputAt(segs: readonly Segment[], src: number): number | null {
  let out = 0;
  for (const s of segs) {
    if (src >= s.from && src <= s.to) return out + (src - s.from);
    out += s.to - s.from;
  }
  return null;
}

/** The source time of every output frame at `fps`. */
export function frameTimes(segs: readonly Segment[], fps: number): number[] {
  const n = Math.max(1, Math.round((durationOf(segs) / 1000) * fps));
  return Array.from({ length: n }, (_, k) => sourceAt(segs, (k * 1000) / fps));
}

/** For each wanted time, the last captured frame at or before it (the first frame before any). */
export function pickFrames(captured: readonly number[], want: readonly number[]): number[] {
  return want.map((t) => {
    let lo = 0;
    let hi = captured.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (captured[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  });
}
