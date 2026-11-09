import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { providerOf, runQa } from '../../src/ai';
import { main, parse } from '../../src/cli';
import { namedChapters } from '../../src/render';

const dir = mkdtempSync(join(tmpdir(), 'tar-ai-'));
/** A stand-in provider module: answers by task, and logs what it was sent. */
const providerFile = join(dir, 'provider.mjs');
writeFileSync(providerFile, `
import { appendFileSync } from 'node:fs';
export default async (task, input) => {
  appendFileSync(${JSON.stringify(join(dir, 'sent.log'))}, JSON.stringify({ task, input }) + '\\n');
  if (task === 'captions') return { steps: [{ n: 1, say: 'Open a new invoice' }, { n: 2, say: 'Save it' }] };
  if (task === 'title') return { title: 'Save an invoice' };
  return {};
};
`);
const traceFile = join(dir, 'a.trace.json');
writeFileSync(traceFile, JSON.stringify({ version: 1, meta: { title: 'x' }, steps: [
  { type: 'click', target: { role: 'button', name: 'New' } },
  { type: 'type', target: { role: 'textbox', name: 'Customer' }, text: 'Grace Hopper' },
] }));

describe('providerOf', () => {
  it('gateway:<provider>/<model> from the environment; openai:<model>; a .js file; anything else is a mistake', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }] })));
    vi.stubGlobal('fetch', f);
    const g = await providerOf('gateway:deepseek/deepseek-chat', { AI_GATEWAY_URL: 'https://gw', AI_GATEWAY_KEY: 'aik' });
    await g('title', {}, {}, { instructions: '' });
    expect(f.mock.calls[0][0]).toBe('https://gw/v1/deepseek/chat/completions');
    const o = await providerOf('openai:gpt-4o-mini', { OPENAI_API_KEY: 'sk' });
    await o('qa', {}, {}, { instructions: '' });
    expect(f.mock.calls[1][0]).toBe('https://api.openai.com/v1/chat/completions');
    const local = await providerOf('openai:llama3', { OPENAI_BASE_URL: 'http://localhost:11434/v1' });
    await local('qa', {}, {}, { instructions: '' });
    expect(f.mock.calls[2][0]).toBe('http://localhost:11434/v1/chat/completions');
    vi.unstubAllGlobals();
    await expect(providerOf('openai:gpt', {})).rejects.toThrow('OPENAI_API_KEY');
    await expect(providerOf('gateway:deepseek/x', {})).rejects.toThrow('AI_GATEWAY_URL');
    expect(await (await providerOf(providerFile))('title', {}, {}, { instructions: '' })).toEqual({ title: 'Save an invoice' });
    const bad = join(dir, 'bad.mjs');
    writeFileSync(bad, 'export const x = 1;');
    await expect(providerOf(bad)).rejects.toThrow('default function');
    await expect(providerOf('claude')).rejects.toThrow('--ai is');
  });

  it('gateway alone: DeepSeek, then Gemini, then OpenAI; a list; deepseek-flash for frames; --ai-vision overrides', async () => {
    const calls: Array<{ url: string; model?: string }> = [];
    let fail = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, model: JSON.parse(String(init?.body)).model });
      if (fail > 0) { fail -= 1; return new Response('no', { status: 400 }); }
      return new Response(JSON.stringify(url.includes(':generateContent')
        ? { candidates: [{ content: { parts: [{ text: '{"ok":1}' }] } }] }
        : { choices: [{ message: { content: '{"ok":1}' } }] }));
    }));
    const env = { AI_GATEWAY_URL: 'https://gw', AI_GATEWAY_KEY: 'aik' };
    const img = [{ png: new Uint8Array([1]), label: 'f' }];
    await (await providerOf('gateway', env))('qa', {}, {}, { instructions: '', images: img });
    expect(calls.pop()).toEqual({ url: 'https://gw/v1/deepseek/chat/completions', model: 'deepseek-flash' });
    fail = 1;
    await (await providerOf('gateway', env))('title', {}, {}, { instructions: '' });
    expect(calls.splice(0).map((c) => c.url)).toEqual(['https://gw/v1/deepseek/chat/completions', 'https://gw/v1/gemini/models/gemini-2.5-flash:generateContent']);
    fail = 1;
    await (await providerOf('gateway:gemini/gemini-2.5-pro,openai', env))('title', {}, {}, { instructions: '' });
    expect(calls.splice(0)).toEqual([{ url: 'https://gw/v1/gemini/models/gemini-2.5-pro:generateContent', model: undefined }, { url: 'https://gw/v1/openai/chat/completions', model: 'gpt-4o-mini' }]);
    await (await providerOf('gateway:deepseek', env, { vision: 'deepseek-vl' }))('qa', {}, {}, { instructions: '', images: img });
    expect(calls.pop()?.model).toBe('deepseek-vl');
    await (await providerOf('openai:gpt-4.1-nano', { OPENAI_API_KEY: 'sk' }, { vision: 'gpt-4o' }))('qa', {}, {}, { instructions: '', images: img });
    expect(calls.pop()?.model).toBe('gpt-4o');
    vi.unstubAllGlobals();
  });
});

describe('runQa', () => {
  const frames = [{ at: 1200, label: 'after step 1 (click)', png: new Uint8Array([1]) }, { at: 5000, label: 'the end', png: new Uint8Array([2]) }];
  it('sends the frames as images with labels; keeps flags on real frames, unknown kinds as other, notes trimmed', async () => {
    const ai = vi.fn(async () => ({ flags: [{ frame: 2, kind: 'error', note: '  "Something   went wrong" toast ' }, { frame: 7, kind: 'error', note: 'x' }, { frame: 1, kind: 'weird', note: 'hm' }] }));
    const flags = await runQa(ai, frames, { title: 't', steps: [{ n: 1, type: 'click' }] });
    expect(flags).toEqual([{ at: 1200, kind: 'other', note: 'hm' }, { at: 5000, kind: 'error', note: '"Something went wrong" toast' }]);
    const [task, input, , o] = ai.mock.calls[0] as unknown as [string, { frames: unknown[] }, unknown, { images: Array<{ label: string }> }];
    expect(task).toBe('qa');
    expect(input.frames).toEqual([{ frame: 1, at: 1.2, shows: 'after step 1 (click)' }, { frame: 2, at: 5, shows: 'the end' }]);
    expect(o.images.map((i) => i.label)).toEqual(['Frame 1: after step 1 (click)', 'Frame 2: the end']);
    await expect(runQa(vi.fn(async () => ({})), frames, { steps: [] })).rejects.toThrow('"flags"');
    expect(await runQa(vi.fn(), [], { steps: [] })).toEqual([]);
  });
});

describe('chapters named by the AI', () => {
  it('start when their step acts; the first at 0; cut or missing steps skipped', () => {
    const events = [{ t: 1000, type: 'step' as const, index: 0 }, { t: 3000, type: 'step' as const, index: 2 }, { t: 6000, type: 'step' as const, index: 4 }];
    const segs = [{ from: 0, to: 4000 }, { from: 7000, to: 9000 }];
    expect(namedChapters([{ index: 0, name: 'Start' }, { index: 2, name: 'Fill in' }, { index: 4, name: 'Cut' }, { index: 9, name: 'Never' }], events, segs, 6000))
      .toEqual([{ start: 0, end: 3000, text: 'Start' }, { start: 3000, end: 6000, text: 'Fill in' }]);
  });
});

describe('cli: AI', () => {
  it('parses --ai, --qa [strict], --alt; qa and alt need --ai', () => {
    const base = ['a.trace.json', '--url', 'u', '--out', 'o.gif'];
    expect(parse([...base, '--ai', 'openai:gpt-4o-mini', '--qa', 'strict', '--alt'])).toMatchObject({ ai: 'openai:gpt-4o-mini', strict: true, options: { qa: true, alt: true } });
    expect(parse([...base, '--ai', 'x.js', '--qa'])).toMatchObject({ options: { qa: true } });
    expect(parse([...base, '--ai', 'x.js', '--qa']).strict).toBeUndefined();
    expect(parse(['--qa', 'a.trace.json', '--url', 'u', '--out', 'o.gif', '--ai', 'x.js']).trace).toBe('a.trace.json');
    expect(() => parse([...base, '--qa'])).toThrow('need --ai');
    expect(() => parse([...base, '--alt'])).toThrow('need --ai');
    expect(() => parse([...base, '--ai-vision', 'm'])).toThrow('need --ai');
    expect(parse([...base, '--ai', 'gateway', '--ai-vision', 'deepseek-flash', '--qa'])).toMatchObject({ ai: 'gateway', aiVision: 'deepseek-flash' });
    expect(parse(base).options).not.toHaveProperty('qa');
  });

  it('suggest writes numbered suggestions (nothing typed sent); apply takes only the accepted ones', async () => {
    const logs: string[] = [];
    const io = { log: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    const sug = join(dir, 's.json');
    expect(await main(['suggest', traceFile, '--task', 'captions', '--ai', providerFile, '--tone', 'terse', '--out', sug], io)).toBe(0);
    const s = JSON.parse(readFileSync(sug, 'utf8'));
    expect(s.suggestions.map((x: { id: number; value: string }) => [x.id, x.value])).toEqual([[1, 'Open a new invoice'], [2, 'Save it']]);
    expect(readFileSync(join(dir, 'sent.log'), 'utf8')).not.toContain('Grace Hopper');
    const out = join(dir, 'b.trace.json');
    expect(await main(['apply', traceFile, sug, '--accept', '2', '--out', out], io)).toBe(0);
    const t = JSON.parse(readFileSync(out, 'utf8'));
    expect(t.steps.map((x: { say?: string }) => x.say)).toEqual([undefined, 'Save it']);
    expect(logs).toContain(`applied 1 of 2 to ${out}`);
    // Mistakes.
    expect(await main(['apply', traceFile, sug, '--out', out], io)).toBe(2);
    expect(await main(['apply', traceFile, sug, '--accept', '7', '--out', out], io)).toBe(2);
    expect(await main(['suggest', traceFile, '--task', 'everything', '--ai', providerFile], io)).toBe(2);
    expect(await main(['suggest', traceFile, '--task', 'title'], io)).toBe(2);
    expect(await main(['suggest', join(dir, 'none.json'), '--task', 'title', '--ai', providerFile], io)).toBe(1);
    // Printed to stdout without --out.
    logs.length = 0;
    expect(await main(['suggest', traceFile, '--task', 'title', '--ai', providerFile], io)).toBe(0);
    expect(JSON.parse(logs[0]).suggestions[0]).toMatchObject({ id: 1, kind: 'title', value: 'Save an invoice', before: 'x' });
  });
});
