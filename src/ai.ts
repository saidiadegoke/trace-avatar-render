/**
 * AI in the renderer: which provider (--ai), and the visual check of rendered frames (--qa).
 * Without --ai nothing calls a model. The renderer never changes a trace: suggestions go to a file
 * a person applies (the suggest / apply commands).
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gateway, openAiCompatible } from 'trace-avatar/assist';
import type { Ai } from 'trace-avatar/assist';

export type { Ai };

/**
 * --ai gateway                       DeepSeek, falling back to Gemini, then OpenAI (AI_GATEWAY_URL, AI_GATEWAY_KEY)
 * --ai gateway:<p>[/<model>][,<p>…]  those providers in that order (a model for the first)
 * --ai openai:<model>                (OPENAI_BASE_URL, default https://api.openai.com/v1; OPENAI_API_KEY)
 * --ai ./provider.js                 (its default export is the Ai function)
 * `vision` (--ai-vision) is the model for calls with images; the gateway's DeepSeek default is deepseek-flash.
 */
export async function providerOf(spec: string, env: NodeJS.ProcessEnv = process.env, o: { vision?: string } = {}): Promise<Ai> {
  const vision = o.vision ? { visionModel: o.vision } : {};
  const g = /^gateway(?::([\w.-]+)(?:\/([^,]+))?((?:,[\w.-]+)*))?$/.exec(spec);
  if (g) {
    return gateway({
      ...(g[1] ? { provider: [g[1], ...(g[3] ?? '').split(',').filter(Boolean)] } : {}),
      ...(g[2] ? { model: g[2] } : {}),
      ...vision,
      url: env.AI_GATEWAY_URL, key: env.AI_GATEWAY_KEY,
    });
  }
  const m = /^openai:(.+)$/.exec(spec);
  if (m) {
    if (!env.OPENAI_API_KEY && !env.OPENAI_BASE_URL) throw new Error('--ai openai:… needs OPENAI_API_KEY (and OPENAI_BASE_URL for another OpenAI-compatible server)');
    return openAiCompatible({ baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', ...(env.OPENAI_API_KEY ? { key: env.OPENAI_API_KEY } : {}), model: m[1], ...vision });
  }
  if (/\.(m?js|cjs)$/.test(spec)) {
    const mod = await import(pathToFileURL(resolve(spec)).href);
    const fn = mod.default ?? mod.ai;
    if (typeof fn !== 'function') throw new Error(`${spec} must export a default function (task, input, schema, { instructions, images }) → JSON`);
    return fn as Ai;
  }
  throw new Error(`--ai is gateway, gateway:<provider>[/<model>][,<provider>…], openai:<model>, or a .js file (got "${spec}")`);
}

export const QA_KINDS = ['error', 'empty', 'stalled', 'personal-data', 'wrong-page', 'other'] as const;
export type QaKind = (typeof QA_KINDS)[number];
export interface QaFrame { at: number; label: string; png: Uint8Array }
export interface QaFlag { at: number; kind: QaKind; note: string }

export const QA_SCHEMA = {
  type: 'object', required: ['flags'],
  properties: { flags: { type: 'array', items: { type: 'object', required: ['frame', 'kind', 'note'], properties: {
    frame: { type: 'integer' }, kind: { enum: [...QA_KINDS] }, note: { type: 'string', maxLength: 200 },
  } } } },
};

export const QA_INSTRUCTIONS = `You check frames of a GIF/video of an on-screen guide before it is published: a cursor with a name badge walks through a web app. For each numbered frame, flag only real problems a viewer would notice: an error message or toast ("error"), an empty state or blank page where content is expected ("empty"), a "Looking for …" caption meaning the guide got stuck ("stalled"), personal data such as real email addresses, phone numbers, card or account numbers ("personal-data"), or a page that does not fit the step ("wrong-page"). The cursor, the name badge, highlights and captions are part of the guide, not problems. Reply with JSON only: {"flags":[{"frame":1,"kind":"error","note":"…"}]}, an empty list when all is well.`;

/** Ask the model to look at the frames. The answer is checked: unknown frames or kinds are dropped. */
export async function runQa(ai: Ai, frames: readonly QaFrame[], context: { title?: string; steps: Array<{ n: number; type: string; say?: string }> }): Promise<QaFlag[]> {
  if (!frames.length) return [];
  const input = { title: context.title, steps: context.steps, frames: frames.map((f, k) => ({ frame: k + 1, at: Math.round(f.at / 100) / 10, shows: f.label })) };
  const answer = await ai('qa', input, QA_SCHEMA, { instructions: QA_INSTRUCTIONS, images: frames.map((f, k) => ({ png: f.png, label: `Frame ${k + 1}: ${f.label}` })) });
  const list = answer && typeof answer === 'object' && Array.isArray((answer as { flags?: unknown }).flags) ? (answer as { flags: unknown[] }).flags : null;
  if (!list) throw new Error('the QA answer has no "flags" list');
  const out: QaFlag[] = [];
  for (const item of list) {
    const r = item as { frame?: unknown; kind?: unknown; note?: unknown };
    if (!Number.isInteger(r?.frame) || (r.frame as number) < 1 || (r.frame as number) > frames.length) continue;
    const kind = (QA_KINDS as readonly string[]).includes(r.kind as string) ? (r.kind as QaKind) : 'other';
    const note = typeof r.note === 'string' ? r.note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    out.push({ at: frames[(r.frame as number) - 1].at, kind, note });
  }
  return out.sort((a, b) => a.at - b.at);
}
