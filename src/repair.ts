/**
 * --repair: when a step can't find its element, look at the page as it is now, choose what the step means
 * (code first, the AI only when unsure), re-record that element as the step's target, and play the guide
 * again with the fix (in memory) to see that it gets past the step. A wait whose text never showed is fixed
 * the same way: the texts on the page (and those that showed while it waited) are scored, and the chosen one
 * becomes what the step waits for. Up to `maxStalls` stalls in one run.
 *
 * Nothing is written to the trace: the fixes are suggestions in a file that `apply` takes once a person agrees.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright';
import { applyRaw, chooseRepair, chooseWait, guessWait, repairSuggestion, typedOf, waitSuggestion } from 'trace-avatar/assist';
import type { Ai, Candidate, Suggestion, RepairChoice, TextCandidate } from 'trace-avatar/assist';
import { capture, RenderError } from './capture';
import type { CaptureOptions } from './capture';

type Trace = Parameters<typeof applyRaw>[0];

/** `by: 'guess'`: a wait's text that was not a clear winner (the best that scored well, or what showed after the action), kept only when the replay passes. */
export interface RepairSuggestion extends Suggestion { id: number; by: 'score' | 'ai' | 'guess'; score?: number }

export interface Unresolved {
  index: number;
  reason: string;
  why: string;
  /** The best candidates by score, for a person to pick from: elements, or (for a wait) texts. */
  top: Array<(Omit<Candidate, 'key'> | Omit<TextCandidate, 'id'>) & { score: number }>;
}

export interface RepairOutcome {
  suggestions: RepairSuggestion[];
  unresolved: Unresolved[];
  /** The guide played to the end with every suggestion in. */
  passed: boolean;
}

interface Found {
  chosen?: { target: NonNullable<Suggestion['target']>; by: 'score' | 'ai'; score?: number; why?: string };
  /** For a wait: the text to wait for now. */
  text?: { value: string; by: 'score' | 'ai' | 'guess'; score?: number; why?: string };
  why?: string;
  top: Unresolved['top'];
}

/** The repair script that ships next to the player (trace-avatar ≥ 0.1.7). */
export function repairScriptOf(playerFile: string): string {
  const file = join(dirname(playerFile), 'trace-repair.min.js');
  if (!existsSync(file)) throw new RenderError(`--repair needs trace-avatar 0.1.7 or later (no ${file})`);
  return file;
}

/** What onStall does: candidates on the live page, a choice, the chosen element re-recorded and checked. */
export function stallInspector(o: { script: string; trace: () => Trace; ai?: Ai; vision?: boolean; skip?: string[] }): (page: Page, stall: { index: number; reason: string }) => Promise<Found> {
  const code = `${readFileSync(o.script, 'utf8')}\n;window.__taRepair = TraceAvatarRepair;`;
  return async (page, stall) => {
    if (stall.reason === 'until-timeout') return waitInspect(page, stall.index);
    if (stall.reason !== 'not-found') return { why: 'the step timed out waiting; only a missing element or a changed text can be repaired', top: [] };
    await page.evaluate(code);
    const skip = o.skip?.length ? o.skip.join(', ') : undefined;
    const list = await page.evaluate((sk) => (window as unknown as { __taRepair: { candidatesOf(r: ParentNode, x: { skip?: string }): Candidate[] } }).__taRepair.candidatesOf(document, sk ? { skip: sk } : {}), skip);
    const image = o.ai && o.vision ? { png: new Uint8Array(await page.screenshot()), label: 'the page now' } : undefined;
    const choice: RepairChoice = await chooseRepair(o.trace(), stall.index, list, { ...(o.ai ? { ai: o.ai } : {}), ...(image ? { image } : {}) });
    const byId = new Map(list.map((c) => [c.id, c]));
    const top = choice.top.map((t) => { const { key: _k, ...c } = byId.get(t.id)!; return { ...c, score: t.score }; });
    if (choice.id === null || choice.by === 'none') return { why: choice.why ?? (o.ai ? 'no element on the page fits the step' : 'no clear match; pass --ai to ask, or pick one'), top };
    const r = await page.evaluate((id) => {
      const x = (window as unknown as { __taRepair: { targetFor(i: number): unknown; resolvesTo(t: unknown, el: Element | null): boolean; elementOf(i: number): Element | null } }).__taRepair;
      const target = x.targetFor(id);
      return { target, ok: !!target && x.resolvesTo(target, x.elementOf(id)) };
    }, choice.id);
    if (!r.ok) return { why: 'the chosen element could not be told apart from others on the page', top };
    return { chosen: { target: r.target as NonNullable<Suggestion['target']>, by: choice.by, ...(choice.score !== undefined ? { score: choice.score } : {}), ...(choice.why ? { why: choice.why } : {}) }, top };
  };

  /** A wait whose text never showed: the texts where it looks, plus what showed while it waited. */
  async function waitInspect(page: Page, index: number): Promise<Found> {
    await page.evaluate(code);
    if (!(await page.evaluate(() => typeof (window as unknown as { __taRepair: { textsOf?: unknown } }).__taRepair.textsOf === 'function'))) {
      return { why: 'repairing a wait needs trace-avatar 0.1.9 or later', top: [] };
    }
    const trace = o.trace();
    const list = await page.evaluate(({ target, typed, skip }) => {
      const w = window as unknown as { __taSeen?: Array<{ element: Element }>; __taRepair: { textsOf(s: ParentNode, x: object): TextCandidate[]; scopeFor(t: unknown, r: ParentNode): ParentNode; elementOf(i: number): Element | null } };
      const r = w.__taRepair;
      // Hidden and blurred areas (--hide, --blur) are never offered, on the page or seen while it waited.
      const out = (el: Element | null) => !!skip && !!el?.closest(skip);
      const seen = (w.__taSeen ?? []).filter((x) => !out(x.element));
      return r.textsOf(r.scopeFor(target ?? undefined, document), { seen, typed })
        .filter((c) => !out(r.elementOf(c.id)))
        .map((c, id) => ({ ...c, id }));
    }, { target: (trace.steps[index]?.target ?? null) as never, typed: typedOf(trace), skip: o.skip?.length ? o.skip.join(', ') : '' });
    // No screenshot for a wait: a text that came and went is not on the page any more.
    const choice = await chooseWait(trace, index, list, o.ai ? { ai: o.ai } : {});
    const top = choice.top.map((t) => { const { id: _i, ...c } = list[t.id]; return { ...c, score: t.score }; });
    // As the app's card does: a guess is offered too; here the replay checks it, and a person still accepts it.
    const best = guessWait(choice, list);
    if (!best) return { why: choice.why ?? (o.ai ? 'no text on the page fits the wait' : 'no clear match; pass --ai to ask, or pick one'), top };
    const score = choice.top.find((t) => t.id === best.id)?.score;
    return { text: { value: best.text, by: best.guess ? 'guess' : (choice.by as 'score' | 'ai'), ...(score !== undefined ? { score } : {}), ...(choice.why && !best.guess ? { why: choice.why } : {}) }, top };
  }
}

/**
 * Repair a guide: each stall is fixed in memory and the guide played again, until it ends, a stall can't be
 * fixed, or `maxStalls` is reached. `first` is a stall already met (with onStall data) to start from.
 */
export async function repairGuide(o: {
  trace: Trace;
  capture: Omit<CaptureOptions, 'trace' | 'onStall' | 'allowStall'>;
  ai?: Ai;
  vision?: boolean;
  maxStalls?: number;
  first?: RenderError;
}): Promise<RepairOutcome> {
  let current = o.trace;
  const out: RepairOutcome = { suggestions: [], unresolved: [], passed: false };
  const inspect = stallInspector({ script: repairScriptOf(o.capture.playerFile), trace: () => current, ...(o.ai ? { ai: o.ai } : {}), ...(o.vision ? { vision: true } : {}), ...(o.capture.hide || o.capture.blur ? { skip: [...(o.capture.hide ?? []), ...(o.capture.blur ?? [])] } : {}) });
  let pending: RenderError | undefined = o.first;
  for (let round = 0; round <= (o.maxStalls ?? 5); round += 1) {
    let stall: RenderError | undefined = pending;
    pending = undefined;
    if (!stall) {
      try {
        await capture({ ...o.capture, trace: current, onStall: inspect });
        const last = out.suggestions[out.suggestions.length - 1];
        if (last) last.verified = true;
        out.passed = true;
        return out;
      } catch (e) {
        if (!(e instanceof RenderError) || !e.stall) throw e;
        stall = e;
      }
    }
    const s = stall.stall!;
    // The fix before this one worked if the guide got further than its step.
    const last = out.suggestions[out.suggestions.length - 1];
    if (last && last.verified === undefined) {
      last.verified = s.index > last.index;
      if (!last.verified) { out.unresolved.push({ index: s.index, reason: s.reason, why: 'the repaired step still stalls', top: [] }); return out; }
    }
    const found = s.data as Found | undefined;
    if (!found?.chosen && !found?.text) {
      out.unresolved.push({ index: s.index, reason: s.reason, why: found?.why ?? 'the page could not be looked at', top: found?.top ?? [] });
      return out;
    }
    if (round === (o.maxStalls ?? 5)) {
      out.unresolved.push({ index: s.index, reason: s.reason, why: `stopped after ${o.maxStalls ?? 5} repairs`, top: found.top });
      return out;
    }
    const pick = (found.chosen ?? found.text)!;
    const sg = found.chosen
      ? repairSuggestion(current, s.index, found.chosen.target, pick.why ? { why: pick.why } : {})
      : waitSuggestion(current, s.index, found.text!.value, pick.why ? { why: pick.why } : {});
    out.suggestions.push({ ...sg, id: out.suggestions.length + 1, by: pick.by, ...(pick.score !== undefined ? { score: pick.score } : {}) });
    current = applyRaw(current, [sg]);
  }
  return out;
}
