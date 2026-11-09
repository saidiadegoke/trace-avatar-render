/**
 * From the captured events to what the composer needs, on the edited (output) timeline: the camera's
 * actions, the caption cues, and which page is showing. PURE.
 */

import type { Action } from './camera';
import { outputAt } from './timeline';
import type { Segment, TimelineEvent } from './timeline';
import type { Cue } from './vtt';

const stepsOf = (events: readonly TimelineEvent[]) => events.filter((e) => e.type === 'step').slice().sort((a, b) => a.t - b.t);

/**
 * Camera actions: each step with an element, at its centre (in capture pixels: CSS px × scale). A page
 * change is an action too (not a zoomable one), so a shot never spans two pages.
 */
export function actionsOf(events: readonly TimelineEvent[], segs: readonly Segment[], scale = 1): Action[] {
  const out: Action[] = [];
  for (const e of events) {
    const t = outputAt(segs, e.t);
    if (t === null) continue;
    if (e.type === 'unload') out.push({ t, x: 0, y: 0, kind: 'page' });
    else if (e.type === 'step' && e.rect && e.stepType) {
      out.push({ t, x: (e.rect.x + e.rect.w / 2) * scale, y: (e.rect.y + e.rect.h / 2) * scale, kind: e.stepType });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Caption cues as the player shows them: a step's words from the step before it (while the cursor
 * travels) until just after it acts. Cues never overlap; each lasts at least `minMs` where there's room.
 */
export function stepCues(events: readonly TimelineEvent[], segs: readonly Segment[], endMs: number, o: { afterMs?: number; minMs?: number } = {}): Cue[] {
  const after = o.afterMs ?? 600;
  const min = o.minMs ?? 1200;
  const cues: Cue[] = [];
  let prev = 0;
  for (const e of stepsOf(events)) {
    const t = outputAt(segs, e.t);
    if (t === null) continue;
    if (e.say) {
      const end = Math.min(t + after, endMs);
      cues.push({ start: Math.max(0, Math.min(prev, end - min)), end, text: e.say });
    }
    prev = t;
  }
  for (let k = 1; k < cues.length; k += 1) {
    if (cues[k].start < cues[k - 1].end) cues[k].start = cues[k - 1].end;
  }
  return cues.filter((c) => c.end > c.start);
}

/** The page path showing at a source time (the last event's page at or before it). */
export function pageAt(events: readonly TimelineEvent[]): (src: number) => string {
  const marks = events.filter((e) => e.url && e.type !== 'unload').slice().sort((a, b) => a.t - b.t);
  return (src) => {
    let url = marks[0]?.url ?? '/';
    for (const m of marks) { if (m.t <= src) url = m.url!; else break; }
    return url;
  };
}

/** The cue showing at output time t, and how opaque (fading in and out over `fadeMs`). */
export function cueAt(cues: readonly Cue[], t: number, fadeMs = 150): { cue: Cue; alpha: number } | null {
  for (const c of cues) {
    if (t >= c.start && t < c.end) {
      const alpha = Math.min(1, (t - c.start) / fadeMs, (c.end - t) / fadeMs);
      return { cue: c, alpha: Math.max(0, alpha) };
    }
  }
  return null;
}
