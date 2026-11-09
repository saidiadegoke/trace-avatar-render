/**
 * --repair: when a step can't find its element, look at the page as it is now, choose what the step means
 * (code first, the AI only when unsure), re-record that element as the step's target, and play the guide
 * again with the fix (in memory) to see that it gets past the step. Up to `maxStalls` stalls in one run.
 *
 * Nothing is written to the trace: the fixes are suggestions in a file that `apply` takes once a person agrees.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright';
import { applyRaw, chooseRepair, repairSuggestion } from 'trace-avatar/assist';
import type { Ai, Candidate, Suggestion, RepairChoice } from 'trace-avatar/assist';
import { capture, RenderError } from './capture';
import type { CaptureOptions } from './capture';

type Trace = Parameters<typeof applyRaw>[0];

export interface RepairSuggestion extends Suggestion { id: number; by: 'score' | 'ai'; score?: number }

export interface Unresolved {
  index: number;
  reason: string;
  why: string;
  /** The best candidates by score, for a person to pick from. */
  top: Array<Omit<Candidate, 'key'> & { score: number }>;
}

export interface RepairOutcome {
  suggestions: RepairSuggestion[];
  unresolved: Unresolved[];
  /** The guide played to the end with every suggestion in. */
  passed: boolean;
}

interface Found {
  chosen?: { target: NonNullable<Suggestion['target']>; by: 'score' | 'ai'; score?: number; why?: string };
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
    if (stall.reason !== 'not-found') return { why: `the step ${stall.reason === 'until-timeout' ? 'waited for a text that never appeared' : 'timed out waiting'}; only a missing element can be repaired`, top: [] };
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
    if (!found?.chosen) {
      out.unresolved.push({ index: s.index, reason: s.reason, why: found?.why ?? 'the page could not be looked at', top: found?.top ?? [] });
      return out;
    }
    if (round === (o.maxStalls ?? 5)) {
      out.unresolved.push({ index: s.index, reason: s.reason, why: `stopped after ${o.maxStalls ?? 5} repairs`, top: found.top });
      return out;
    }
    const sg = repairSuggestion(current, s.index, found.chosen.target, found.chosen.why ? { why: found.chosen.why } : {});
    out.suggestions.push({ ...sg, id: out.suggestions.length + 1, by: found.chosen.by, ...(found.chosen.score !== undefined ? { score: found.chosen.score } : {}) });
    current = applyRaw(current, [sg]);
  }
  return out;
}
