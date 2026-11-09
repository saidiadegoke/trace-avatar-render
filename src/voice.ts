/**
 * Voices for narration (--voice). Always configurable; without --voice nothing speaks.
 *
 *   --voice gateway[:gemini[/<model>][:<voice>]]   our AI gateway (AI_GATEWAY_URL, AI_GATEWAY_KEY). DeepSeek goes
 *                                                   first wherever it offers a feature, but has no speech API, so
 *                                                   this is Gemini (default gemini-2.5-flash-preview-tts, Kore)
 *   --voice openai:<model>[:<voice>]                /audio/speech at OPENAI_BASE_URL (OpenAI, or any compatible
 *                                                   local server); OPENAI_API_KEY
 *   --voice say[:<voice>]                           macOS `say`, offline
 *   --voice ./voice.js                              a module whose default export is a Voice
 *
 * Only the spoken text is sent. Lines are cached by (voice, text), so a re-render pays only for changed lines.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromS16le, fromWav, toWav } from './audio';
import type { Pcm } from './audio';

/** Speak one line. */
export type Voice = (text: string) => Promise<Pcm>;

export const GEMINI_TTS = { model: 'gemini-2.5-flash-preview-tts', voice: 'Kore' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST with two retries on a 429, a 5xx or no answer; never on the gateway's own refusal. */
async function post(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  for (let n = 1; ; n += 1) {
    let res: Response | null = null;
    try { res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); } catch (e) {
      if (n >= 3) throw new Error(`could not reach the voice (${(e as Error).message})`);
    }
    if (res?.ok) return res;
    if (res) {
      const text = await res.text();
      let gw: { message?: string } | null = null;
      try { const j = JSON.parse(text); if (j?.error?.source === 'ai-interface') gw = j.error; } catch { /* not JSON */ }
      if (gw) throw new Error(`the AI gateway refused the voice call: ${gw.message}`);
      if (!(res.status === 429 || res.status >= 500) || n >= 3) throw new Error(`the voice call failed (${res.status}): ${text.slice(0, 300)}`);
    }
    await sleep(Math.min(400 * 2 ** (n - 1) * (0.5 + Math.random() / 2), 4000));
  }
}

/** Gemini speech (generateContent with audio out): 24 kHz 16-bit PCM, base64. */
export function geminiVoice(o: { url: string; key: string; model?: string; voice?: string; bearer?: boolean; headers?: Record<string, string>; fetch?: typeof fetch }): Voice {
  const model = o.model ?? GEMINI_TTS.model;
  return async (text) => {
    const res = await post(o.fetch ?? fetch, `${o.url.replace(/\/+$/, '')}/models/${model}:generateContent`,
      { ...(o.bearer ? { authorization: `Bearer ${o.key}` } : { 'x-goog-api-key': o.key }), ...o.headers },
      {
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice ?? GEMINI_TTS.voice } } } },
      });
    const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } }> } }> };
    const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data || p.inline_data?.data);
    const data = part?.inlineData?.data ?? part?.inline_data?.data;
    if (!data) throw new Error(`${model} answered without audio`);
    const mime = part?.inlineData?.mimeType ?? part?.inline_data?.mime_type ?? '';
    const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000);
    return { pcm: fromS16le(new Uint8Array(Buffer.from(data, 'base64'))), sampleRate: rate };
  };
}

/** OpenAI-compatible /audio/speech, as raw 24 kHz 16-bit PCM. */
export function openAiVoice(o: { baseUrl: string; key?: string; model: string; voice?: string; fetch?: typeof fetch }): Voice {
  return async (text) => {
    const res = await post(o.fetch ?? fetch, `${o.baseUrl.replace(/\/+$/, '')}/audio/speech`, o.key ? { authorization: `Bearer ${o.key}` } : {},
      { model: o.model, voice: o.voice ?? 'alloy', input: text, response_format: 'pcm' });
    return { pcm: fromS16le(new Uint8Array(await res.arrayBuffer())), sampleRate: 24000 };
  };
}

/** macOS `say`, offline. */
export function sayVoice(o: { voice?: string } = {}): Voice {
  return async (text) => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-say-'));
    try {
      const file = join(dir, 'line.wav');
      const r = spawnSync('say', [...(o.voice ? ['-v', o.voice] : []), '-o', file, '--file-format=WAVE', '--data-format=LEI16@24000', text], { encoding: 'utf8' });
      if (r.error || r.status !== 0) throw new Error(`say failed${r.error ? ` (${r.error.message})` : `: ${r.stderr}`}; --voice say needs macOS`);
      return fromWav(new Uint8Array(readFileSync(file)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

/** A voice that keeps every line it speaks in `dir`, by hash(id, text). */
export function cached(voice: Voice, id: string, dir: string): Voice & { hits: number; misses: number } {
  const v = (async (text: string) => {
    const file = join(dir, `${createHash('sha256').update(`${id}\n${text}`).digest('hex').slice(0, 32)}.wav`);
    if (existsSync(file)) { v.hits += 1; return fromWav(new Uint8Array(readFileSync(file))); }
    const p = await voice(text);
    v.misses += 1;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, toWav(p.pcm, p.sampleRate));
    return p;
  }) as Voice & { hits: number; misses: number };
  v.hits = 0;
  v.misses = 0;
  return v;
}

/** The --voice spec to a Voice (cached in `cacheDir` unless it is null). */
export async function voiceOf(spec: string, env: NodeJS.ProcessEnv = process.env, o: { cacheDir?: string | null; fetch?: typeof fetch } = {}): Promise<Voice> {
  const cacheDir = o.cacheDir === undefined ? resolve('.trace-avatar-cache', 'voice') : o.cacheDir;
  const wrap = (v: Voice) => (cacheDir ? cached(v, spec, cacheDir) : v);
  const g = /^gateway(?::gemini(?:\/([^:]+))?(?::(.+))?)?$/.exec(spec);
  if (g) {
    if (!env.AI_GATEWAY_URL || !env.AI_GATEWAY_KEY) throw new Error('--voice gateway needs AI_GATEWAY_URL and AI_GATEWAY_KEY');
    return wrap(geminiVoice({
      url: `${env.AI_GATEWAY_URL.replace(/\/+$/, '')}/v1/gemini`, key: env.AI_GATEWAY_KEY, bearer: true,
      ...(g[1] ? { model: g[1] } : {}), ...(g[2] ? { voice: g[2] } : {}),
      headers: { 'x-ai-feature': 'trace-avatar-voice' }, ...(o.fetch ? { fetch: o.fetch } : {}),
    }));
  }
  const m = /^openai:([^:]+)(?::(.+))?$/.exec(spec);
  if (m) {
    if (!env.OPENAI_API_KEY && !env.OPENAI_BASE_URL) throw new Error('--voice openai:… needs OPENAI_API_KEY (and OPENAI_BASE_URL for another OpenAI-compatible server)');
    return wrap(openAiVoice({ baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', ...(env.OPENAI_API_KEY ? { key: env.OPENAI_API_KEY } : {}), model: m[1], ...(m[2] ? { voice: m[2] } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) }));
  }
  const s = /^say(?::(.+))?$/.exec(spec);
  if (s) return wrap(sayVoice(s[1] ? { voice: s[1] } : {}));
  if (/\.(m?js|cjs)$/.test(spec)) {
    const mod = await import(pathToFileURL(resolve(spec)).href);
    const fn = mod.default ?? mod.voice;
    if (typeof fn !== 'function') throw new Error(`${spec} must export a default function (text) → { pcm: Int16Array, sampleRate }`);
    return wrap(fn as Voice);
  }
  throw new Error(`--voice is gateway[:gemini[/<model>][:<voice>]], openai:<model>[:<voice>], say[:<voice>], or a .js file (got "${spec}")`);
}
