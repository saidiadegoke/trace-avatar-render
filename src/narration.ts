/**
 * Narration: what each step says, when, and where the video holds so a line ends before its step acts.
 * The planning is PURE; suggestScript() asks an AI for spoken lines (a person edits the file it writes).
 */

import { preview } from 'trace-avatar/assist';
import type { Ai } from 'trace-avatar/assist';

/** A narration script: lines by step number (1-based). */
export interface Script { lines: Array<{ n: number; text: string }> }

export interface PlannedLine { index: number; text: string; /** ms on the held timeline */ start: number; ms: number }

export interface NarrationPlan {
  lines: PlannedLine[];
  /** Output times on the cut timeline (before any hold) and how long to hold there. */
  holds: Array<{ at: number; ms: number }>;
  /** Steps whose line needed a hold longer than maxHoldMs. */
  long: Array<{ index: number; ms: number }>;
}

export interface PlanOptions {
  /** The first line starts here. Default 300. */
  firstMs?: number;
  /** A line starts this long after the step before it acts (the cursor sets off). Default 200. */
  afterActMs?: number;
  /** A line ends at least this long before its step acts. Default 250. */
  beforeActMs?: number;
  /** Between two lines. Default 150. */
  gapMs?: number;
  /** After the last line, before the video ends. Default 400. */
  tailMs?: number;
  /** A hold longer than this is reported in `long`. Default 8000. */
  maxHoldMs?: number;
}

/** The spoken text of each step: the script's line, else its caption (say). Steps with neither are silent. */
export function linesOf(steps: ReadonlyArray<{ say?: string }>, script?: Script): Map<number, string> {
  const out = new Map<number, string>();
  steps.forEach((s, i) => { if (s.say?.trim()) out.set(i, s.say.trim()); });
  for (const l of script?.lines ?? []) {
    const i = l.n - 1;
    if (!Number.isInteger(i) || i < 0 || i >= steps.length) throw new Error(`the script has a line for step ${l.n}, but the trace has ${steps.length} steps`);
    if (l.text.trim()) out.set(i, l.text.trim()); else out.delete(i);
  }
  return out;
}

/** Reads a script: { lines: [{ n, text }] }. */
export function parseScript(json: unknown): Script {
  const lines = (json as Script | null)?.lines;
  if (!Array.isArray(lines) || lines.some((l) => !l || typeof l.n !== 'number' || typeof l.text !== 'string')) {
    throw new Error('a narration script is { "lines": [{ "n": 1, "text": "…" }] }');
  }
  return { lines: lines.map((l) => ({ n: l.n, text: l.text })) };
}

/**
 * When each line plays, and the holds that make it fit. `acts` are the steps as they act, on the cut timeline
 * (output ms, before holds); `ms` is how long each step's line is; `endMs` the cut timeline's length.
 */
export function planNarration(acts: ReadonlyArray<{ index: number; t: number }>, lines: ReadonlyMap<number, { text: string; ms: number }>, endMs: number, o: PlanOptions = {}): NarrationPlan & { endHoldMs: number } {
  const first = o.firstMs ?? 300;
  const after = o.afterActMs ?? 200;
  const before = o.beforeActMs ?? 250;
  const gap = o.gapMs ?? 150;
  const maxHold = o.maxHoldMs ?? 8000;
  const plan: NarrationPlan = { lines: [], holds: [], long: [] };
  let extra = 0;
  let prevCut: number | null = null;
  let prevEnd = -Infinity;
  for (const a of acts.slice().sort((x, y) => x.t - y.t)) {
    const line = lines.get(a.index);
    const prevHeld: number | null = prevCut === null ? null : prevCut + extra;
    if (line && line.ms > 0) {
      const start = Math.max(prevHeld === null ? first : prevHeld + after, prevEnd + gap);
      const end = start + line.ms;
      const need = Math.ceil(end - (a.t + extra - before));
      if (need > 0) {
        plan.holds.push({ at: Math.max(0, a.t - before, prevCut ?? 0), ms: need });
        extra += need;
        if (need > maxHold) plan.long.push({ index: a.index, ms: need });
      }
      plan.lines.push({ index: a.index, text: line.text, start: Math.round(start), ms: Math.round(line.ms) });
      prevEnd = end;
    }
    prevCut = a.t;
  }
  // The last line ends before the video does.
  const endHoldMs = Math.max(0, Math.ceil(prevEnd + (o.tailMs ?? 400) - (endMs + extra)));
  if (endHoldMs > 0) plan.holds.push({ at: endMs, ms: endHoldMs });
  return { ...plan, endHoldMs };
}

/** <out>.narration.txt: the spoken script with its times in the video. */
export function narrationText(lines: readonly PlannedLine[], offsetMs = 0): string {
  const at = (ms: number) => { const s = Math.round((ms + offsetMs) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  return lines.map((l) => `[${at(l.start)}] ${l.text}`).join('\n') + (lines.length ? '\n' : '');
}

const SCRIPT_SCHEMA = { type: 'object', properties: { lines: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, text: { type: 'string' } }, required: ['n', 'text'] } } }, required: ['lines'] };
const SCRIPT_INSTRUCTIONS = `You write the voice-over for a short screen guide. For each step, write one line to be spoken while the cursor moves to it: a full, natural sentence in plain English, second person ("Now click Save"), at most 25 words. Spell out symbols and numbers as spoken ("twenty percent", not "20%"). Keep the meaning of the step's caption when it has one. Skip steps that need no words (return no line for them). Never invent data values. Answer with JSON: { "lines": [{ "n": <step number>, "text": "…" }] }.`;

/** A script proposed by an AI from the steps (the same privacy-safe payload as captions: nothing typed is sent). */
export async function suggestScript(ai: Ai, trace: Parameters<typeof preview>[1]): Promise<{ script: Script; dropped: Array<{ n: unknown; why: string }> }> {
  const p = preview('captions', trace);
  const answer = await ai('narration' as Parameters<Ai>[0], p.input, SCRIPT_SCHEMA, { instructions: SCRIPT_INSTRUCTIONS });
  const steps = (trace as { steps?: unknown[] }).steps?.length ?? 0;
  const lines: Script['lines'] = [];
  const dropped: Array<{ n: unknown; why: string }> = [];
  const seen = new Set<number>();
  for (const l of (answer as Script | null)?.lines ?? []) {
    const n = (l as { n?: unknown })?.n;
    const text = typeof l?.text === 'string' ? l.text.trim() : '';
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > steps) dropped.push({ n, why: 'no such step' });
    else if (seen.has(n)) dropped.push({ n, why: 'a second line for the step' });
    else if (!text) dropped.push({ n, why: 'empty' });
    else if (text.length > 300) dropped.push({ n, why: 'longer than 300 characters' });
    else { seen.add(n); lines.push({ n, text }); }
  }
  return { script: { lines: lines.sort((a, b) => a.n - b.n) }, dropped };
}
