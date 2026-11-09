/** WebVTT captions and chapters on the edited timeline. PURE. */

export interface Cue { start: number; end: number; text: string }

const stamp = (ms: number) => {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}`;
};

/** "-->" can't appear in a cue; blank lines would end it. */
const clean = (s: string) => s.replace(/-->/g, '→').replace(/\r?\n\s*\r?\n/g, '\n').trim();

export function toVtt(cues: readonly Cue[]): string {
  return `WEBVTT\n\n${cues.filter((c) => c.end > c.start && c.text.trim()).map((c, k) => `${k + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${clean(c.text)}\n`).join('\n')}`;
}

/**
 * Captions from (time, text) starts: each lasts until the next starts, at most `maxMs`, and never past the end.
 */
export function captionCues(starts: ReadonlyArray<{ t: number; text: string }>, endMs: number, maxMs = 6000): Cue[] {
  const s = starts.slice().sort((a, b) => a.t - b.t);
  return s.map((c, k) => ({ start: c.t, end: Math.min(s[k + 1]?.t ?? endMs, c.t + maxMs, endMs), text: c.text }));
}

/** Chapters: each caption starts one, titled by its first sentence; each runs until the next. */
export function chapterCues(starts: ReadonlyArray<{ t: number; text: string }>, endMs: number): Cue[] {
  const s = starts.slice().sort((a, b) => a.t - b.t);
  return s.map((c, k) => {
    const first = c.text.split(/(?<=[.!?…])\s/)[0].trim();
    return { start: c.t, end: s[k + 1]?.t ?? endMs, text: first.length > 60 ? `${first.slice(0, 59)}…` : first };
  });
}
