#!/usr/bin/env node
/**
 *   trace-avatar-render invoice.trace.json --url http://localhost:3000/app --out invoice.gif --out invoice.mp4
 *
 * Exit codes: 0 rendered, 1 the render failed (a stalled guide, an error in the app), 2 wrong usage.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { apply as applySuggestions, suggest } from 'trace-avatar/assist';
import type { Suggestion } from 'trace-avatar/assist';
import { providerOf } from './ai';
import { suggestScript } from './narration';
import { voiceOf } from './voice';
import { parseArgs } from 'node:util';
import { RenderError } from './capture';
import { render } from './render';

export const USAGE = `Usage: trace-avatar-render <trace.json> --url <page> --out <file.gif|file.mp4> [options]

  --url <url>             the page the guide starts on (required)
  --out <file>            .gif or .mp4; repeat for several (required)
  --mode <overlay|perform> Show me (default) or Do it for me
  --allow-perform         needed for perform: it clicks and types for real (use a sandbox account)
  --width <px>            output width (GIF default 800, MP4 the capture's)
  --fps <n>               frames per second (GIF default 12, MP4 30)
  --viewport <WxH>        default: the trace's meta.viewport, else 1280x800
  --scale <n>             device pixel ratio of the capture (2 for crisp video)
  --storage-state <file>  a signed-in Playwright session
  --max-wait <ms>         waits longer than this are cut to it (default 800, 0 keeps them)
  --hide <selector>       hidden before capture; repeatable
  --blur <selector>       blurred before capture (as well as [data-trace-blur]); repeatable
  --allow-stall           render a stalled guide anyway instead of failing
  --player <file>         the trace-perform.min.js to use (default: the installed trace-avatar)
  --timeline <file>       write the timeline and the cuts as JSON
  --timeout <ms>          give up after this long (default 120000)
  --report <file>         write what happened as JSON: { outcome: passed|stalled|failed, step, reason, message }
                          (for CI: one result per guide, whatever the exit code)
  --headed                show the browser

  Polish (all off by default):
  --frame <none|browser>  a browser window around the app, on a background
  --background <css>      the background behind the window and on the cards
  --camera                zoom in on each action and pan between close ones
  --zoom <n>              how far the camera goes in (default 1.6; implies --camera)
  --captions <burn|vtt|both>  burn the steps' words in, write <out>.vtt + <out>.chapters.vtt, or both
  --poster [file]         a PNG at the first click (default <out>.png)
  --title-card [title]    a 1.5 s card first (default: the trace's title)
  --end-card [title]      a 2 s card last (default: "Done")

  AI (nothing calls a model without --ai):
  --ai <provider>         gateway: our AI gateway (AI_GATEWAY_URL, AI_GATEWAY_KEY), DeepSeek first, then Gemini,
                          then OpenAI; or gateway:<provider>[/<model>][,<provider>…]; openai:<model> (OPENAI_API_KEY,
                          OPENAI_BASE_URL for any OpenAI-compatible server); or ./provider.js
  --ai-vision <model>     the model for --qa's frames (gateway's DeepSeek default: deepseek-flash)
  --qa [strict]           send a frame per step to the AI to look for errors, empty states, a stall, personal
                          data; strict exits 1 when anything is flagged (needs a vision model)
  --alt                   write <out>.alt.txt; with --captions vtt, AI names the chapters
  --repair                when a step can't find its element, or a wait's text never shows, propose a fix in
                          <out>.repair.json (verified by playing again); still exits 1. With --ai, unsure
                          cases are asked (DeepSeek first)
  --repair-vision         with --repair and --ai: send a screenshot of the stalled page too (elements only)

  Narration (MP4 only; nothing speaks without --voice):
  --voice <voice>         gateway (our AI gateway: Gemini speech, AI_GATEWAY_URL/KEY), gateway:gemini/<model>:<voice>,
                          openai:<model>[:<voice>] (OPENAI_API_KEY / OPENAI_BASE_URL), say[:<voice>] (macOS, offline),
                          or ./voice.js. Each step's caption is spoken; the video holds where a line runs long
  --script <file.json>    the spoken lines instead: { "lines": [{ "n": 1, "text": "…" }] }
  --voice-out <file.wav>  also write the narration track
  --voice-strict          fail when a line needs a hold longer than 8 s
  --no-voice-cache        don't keep spoken lines in .trace-avatar-cache/voice

Suggestions for a person to accept (the renderer never changes a trace):
  trace-avatar-render suggest <trace.json> --task captions|title|waits|narration --ai <provider> [--tone friendly|terse|formal]
                          [--hints hints.json] [--out suggestions.json]
  trace-avatar-render apply <trace.json> <suggestions.json> --accept 1,3|all --out <new.trace.json>
`;

export interface Parsed { /** --report */ report?: string; trace: string; options: Parameters<typeof render>[0]; /** --ai, made into a provider by main(). */ ai?: string; /** --ai-vision */ aiVision?: string; /** --voice, made into a Voice by main() */ voice?: string; /** --no-voice-cache */ noVoiceCache?: boolean; /** --qa strict */ strict?: boolean }

/** Parse the command line. Throws a usage message (exit 2) on mistakes. Exported for tests. */
export function parse(argv: string[]): Parsed {
  // --poster, --title-card and --end-card take an optional value: take it here when one follows (a
  // following *.json is the trace, not the value).
  const extra: { poster?: string | true; title?: string | true; end?: string | true; qa?: string | true } = {};
  const flags: Record<string, 'poster' | 'title' | 'end' | 'qa'> = { '--poster': 'poster', '--title-card': 'title', '--end-card': 'end', '--qa': 'qa' };
  const rest: string[] = [];
  for (let k = 0; k < argv.length; k += 1) {
    const a = argv[k];
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (flags[name]) {
      if (eq > 0) extra[flags[name]] = a.slice(eq + 1);
      else if (argv[k + 1] !== undefined && !argv[k + 1].startsWith('-') && !/\.json$/i.test(argv[k + 1]) && (flags[name] !== 'qa' || argv[k + 1] === 'strict')) { extra[flags[name]] = argv[k + 1]; k += 1; }
      else extra[flags[name]] = true;
      continue;
    }
    rest.push(a);
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      url: { type: 'string' }, out: { type: 'string', multiple: true }, mode: { type: 'string' },
      'allow-perform': { type: 'boolean' }, width: { type: 'string' }, fps: { type: 'string' },
      viewport: { type: 'string' }, scale: { type: 'string' }, 'storage-state': { type: 'string' },
      'max-wait': { type: 'string' }, hide: { type: 'string', multiple: true }, blur: { type: 'string', multiple: true },
      'allow-stall': { type: 'boolean' }, player: { type: 'string' }, timeline: { type: 'string' },
      timeout: { type: 'string' }, headed: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      frame: { type: 'string' }, background: { type: 'string' }, camera: { type: 'boolean' }, zoom: { type: 'string' },
      captions: { type: 'string' }, ai: { type: 'string' }, 'ai-vision': { type: 'string' }, alt: { type: 'boolean' },
      voice: { type: 'string' }, script: { type: 'string' }, 'voice-out': { type: 'string' }, 'voice-strict': { type: 'boolean' }, 'no-voice-cache': { type: 'boolean' },
      repair: { type: 'boolean' }, 'repair-vision': { type: 'boolean' }, report: { type: 'string' },
    },
  });
  if (values.help) throw new UsageError('');
  const trace = positionals[0];
  if (!trace) throw new UsageError('a trace file is needed');
  if (positionals.length > 1) throw new UsageError(`one trace at a time (got ${positionals.join(', ')})`);
  if (!values.url) throw new UsageError('--url is needed');
  if (!values.out?.length) throw new UsageError('--out is needed');
  const num = (name: string, v: string | undefined, min = 0) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) throw new UsageError(`--${name} must be a number ≥ ${min}`);
    return n;
  };
  const mode = values.mode ?? 'overlay';
  if (mode !== 'overlay' && mode !== 'perform') throw new UsageError('--mode is overlay or perform');
  let viewport: { w: number; h: number } | undefined;
  if (values.viewport) {
    const m = /^(\d+)x(\d+)$/i.exec(values.viewport);
    if (!m) throw new UsageError('--viewport is WIDTHxHEIGHT, e.g. 1280x800');
    viewport = { w: Number(m[1]), h: Number(m[2]) };
  }
  if (values.frame && values.frame !== 'none' && values.frame !== 'browser') throw new UsageError('--frame is none or browser');
  const captions = values.captions;
  if (captions !== undefined && captions !== 'burn' && captions !== 'vtt' && captions !== 'both') throw new UsageError('--captions is burn, vtt or both');
  const zoom = num('zoom', values.zoom, 1);
  if (extra.qa !== undefined && extra.qa !== true && extra.qa !== 'strict') throw new UsageError('--qa takes nothing or strict');
  if ((extra.qa !== undefined || values.alt || values['ai-vision']) && !values.ai) throw new UsageError('--qa, --alt and --ai-vision need --ai');
  if (values['repair-vision'] && !(values.repair && values.ai)) throw new UsageError('--repair-vision needs --repair and --ai');
  if ((values.script || values['voice-out'] || values['voice-strict'] || values['no-voice-cache']) && !values.voice) throw new UsageError('--script, --voice-out, --voice-strict and --no-voice-cache need --voice');
  if (values.voice && !values.out.some((f) => /\.mp4$/i.test(f))) throw new UsageError('--voice needs an .mp4 output (a GIF has no sound)');
  const width = num('width', values.width, 16);
  const fps = num('fps', values.fps, 1);
  const maxWait = num('max-wait', values['max-wait']);
  return {
    trace,
    options: {
      trace,
      url: values.url,
      mode,
      allowPerform: !!values['allow-perform'],
      out: values.out.map((file) => ({ file, ...(width ? { width } : {}), ...(fps ? { fps } : {}) })),
      ...(viewport ? { viewport } : {}),
      ...(values.scale ? { scale: num('scale', values.scale, 1) } : {}),
      ...(values['storage-state'] ? { storageState: values['storage-state'] } : {}),
      ...(maxWait !== undefined ? { cuts: { maxWaitMs: maxWait } } : {}),
      ...(values.hide ? { hide: values.hide } : {}),
      ...(values.blur ? { blur: values.blur } : {}),
      allowStall: !!values['allow-stall'],
      ...(values.player ? { player: values.player } : {}),
      ...(values.timeline ? { timeline: values.timeline } : {}),
      ...(values.timeout ? { timeoutMs: num('timeout', values.timeout, 1) } : {}),
      headless: !values.headed,
      ...(values.frame ? { frame: values.frame as 'none' | 'browser' } : {}),
      ...(values.background ? { background: values.background } : {}),
      ...(zoom ? { camera: { zoom } } : values.camera ? { camera: true } : {}),
      ...(captions ? { captions } : {}),
      ...(extra.poster !== undefined ? { poster: extra.poster } : {}),
      ...(extra.title !== undefined ? { titleCard: extra.title } : {}),
      ...(extra.end !== undefined ? { endCard: extra.end } : {}),
      ...(extra.qa !== undefined ? { qa: true } : {}),
      ...(values.alt ? { alt: true } : {}),
      ...(values.script ? { script: values.script } : {}),
      ...(values['voice-out'] ? { voiceOut: values['voice-out'] } : {}),
      ...(values['voice-strict'] ? { voiceStrict: true } : {}),
      ...(values.repair ? { repair: true } : {}),
      ...(values['repair-vision'] ? { repairVision: true } : {}),
    },
    ...(values.ai ? { ai: values.ai } : {}),
    ...(values['ai-vision'] ? { aiVision: values['ai-vision'] } : {}),
    ...(values.voice ? { voice: values.voice } : {}),
    ...(values['no-voice-cache'] ? { noVoiceCache: true } : {}),
    ...(extra.qa === 'strict' ? { strict: true } : {}),
    ...(values.report ? { report: values.report } : {}),
  };
}

/** What --report writes: one guide's outcome, for CI. */
export interface Report {
  outcome: 'passed' | 'stalled' | 'failed';
  /** The stalled step (from 0); null otherwise. */
  step: number | null;
  reason: 'not-found' | 'until-timeout' | null;
  /** The stalled step's caption, or the error. */
  message: string | null;
  /** The repair file, when --repair wrote one. */
  repair?: string;
}

/** The report for a render's outcome (exported for tests). */
export function reportOf(err: unknown, traceFile: string, repairFile?: string): Report {
  if (!err) return { outcome: 'passed', step: null, reason: null, message: null };
  const stall = err instanceof RenderError ? err.stall : undefined;
  if (stall && Number.isInteger(stall.index)) {
    let say: string | null = null;
    try { say = ((JSON.parse(readFileSync(traceFile, 'utf8')) as { steps?: Array<{ say?: string }> }).steps?.[stall.index]?.say) ?? null; } catch { /* the error is enough */ }
    return {
      outcome: 'stalled', step: stall.index, reason: stall.reason === 'until-timeout' ? 'until-timeout' : 'not-found',
      message: say ?? (err as Error).message, ...(repairFile && existsSync(repairFile) ? { repair: repairFile } : {}),
    };
  }
  return { outcome: 'failed', step: null, reason: null, message: (err as Error)?.message ?? String(err) };
}

export class UsageError extends Error {}

export async function main(argv: string[], io = { log: console.log, error: console.error }): Promise<number> {
  if (argv[0] === 'suggest' || argv[0] === 'apply') {
    try { return await (argv[0] === 'suggest' ? suggestCmd(argv.slice(1), io) : applyCmd(argv.slice(1), io)); } catch (e) {
      io.error(`trace-avatar-render ${argv[0]}: ${(e as Error).message}`);
      if (e instanceof UsageError) io.error(USAGE);
      return e instanceof UsageError ? 2 : 1;
    }
  }
  let p: Parsed;
  try { p = parse(argv); } catch (e) {
    const msg = (e as Error).message;
    if (msg) io.error(`trace-avatar-render: ${msg}\n`);
    io.error(USAGE);
    return e instanceof UsageError && !msg ? 0 : 2;
  }
  try {
    if (p.ai) p.options.ai = await providerOf(p.ai, process.env, p.aiVision ? { vision: p.aiVision } : {});
    if (p.voice) p.options.voice = await voiceOf(p.voice, process.env, p.noVoiceCache ? { cacheDir: null } : {});
    const r = await render(p.options);
    for (const o of r.outputs) io.log(`${o.file}  ${o.width}×${o.height}  ${o.fps} fps  ${(r.durationMs / 1000).toFixed(1)} s  ${(o.bytes / 1024).toFixed(0)} KB`);
    if (r.rawMs > r.durationMs + 50) io.log(`cut ${((r.rawMs - r.durationMs) / 1000).toFixed(1)} s of waiting`);
    for (const f of [r.poster, r.vtt, r.chapters, r.alt]) if (f) io.log(f);
    if (r.narration) {
      io.log(`narration: ${r.narration.lines.length} line${r.narration.lines.length === 1 ? '' : 's'}${r.narration.holdMs ? `, the video holds ${(r.narration.holdMs / 1000).toFixed(1)} s for them` : ''}  ${r.narration.text}`);
      if (r.narration.wav) io.log(r.narration.wav);
    }
    for (const w of r.warnings ?? []) io.error(`warning: ${w}`);
    if (p.report) writeFileSync(p.report, `${JSON.stringify(reportOf(null, p.trace), null, 2)}\n`);
    if (r.qa) {
      if (!r.qa.length) io.log('qa: nothing flagged');
      for (const f of r.qa) io.log(`qa: ${(f.at / 1000).toFixed(1)} s  ${f.kind}  ${f.note}`);
      if (p.strict && r.qa.length) { io.error(`trace-avatar-render: qa flagged ${r.qa.length} problem${r.qa.length > 1 ? 's' : ''} (--qa strict)`); return 1; }
    }
    return 0;
  } catch (e) {
    io.error(`trace-avatar-render: ${(e as Error).message}`);
    if (p.report) {
      const first = p.options.out[0];
      const base = (typeof first === 'string' ? first : first.file).replace(/\.[^./]+$/, '');
      writeFileSync(p.report, `${JSON.stringify(reportOf(e, p.trace, `${base}.repair.json`), null, 2)}\n`);
    }
    if (e instanceof RenderError && e.screenshot) {
      const first = p.options.out[0];
      const shot = `${(typeof first === 'string' ? first : first.file).replace(/\.[^./]+$/, '')}.failure.png`;
      writeFileSync(shot, e.screenshot);
      io.error(`the page at that moment: ${shot}`);
    }
    return 1;
  }
}

const readJson = (file: string): unknown => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`could not read ${file}: ${(e as Error).message}`); }
};

/** suggest <trace.json> --task … --ai …: suggestions, numbered, as JSON (stdout or --out). */
async function suggestCmd(argv: string[], io: { log: (m: string) => void }): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    task: { type: 'string' }, ai: { type: 'string' }, tone: { type: 'string' }, hints: { type: 'string' }, out: { type: 'string' }, 'send-typed': { type: 'boolean' },
  } });
  const [file] = positionals;
  if (!file) throw new UsageError('suggest needs a trace file');
  const task = values.task;
  if (task !== 'captions' && task !== 'title' && task !== 'waits' && task !== 'narration') throw new UsageError('--task is captions, title, waits or narration');
  if (!values.ai) throw new UsageError('suggest needs --ai');
  if (task === 'narration') {
    // A script file for --script: a person edits it before rendering.
    const r = await suggestScript(await providerOf(values.ai), readJson(file) as Parameters<typeof suggestScript>[1]);
    const out = JSON.stringify({ ...r.script, ...(r.dropped.length ? { dropped: r.dropped } : {}) }, null, 2);
    if (values.out) { writeFileSync(values.out, `${out}\n`); io.log(`${r.script.lines.length} line${r.script.lines.length === 1 ? '' : 's'} in ${values.out}: edit them, then --script ${values.out}`); } else io.log(out);
    return 0;
  }
  const tone = values.tone;
  if (tone !== undefined && tone !== 'friendly' && tone !== 'terse' && tone !== 'formal') throw new UsageError('--tone is friendly, terse or formal');
  const trace = readJson(file) as Parameters<typeof suggest>[1];
  const hints = values.hints ? (readJson(values.hints) as Parameters<typeof suggest>[2]['hints']) : undefined;
  const r = await suggest(task, trace, { ai: await providerOf(values.ai), ...(hints ? { hints } : {}), ...(tone ? { tone } : {}), ...(values['send-typed'] ? { sendTyped: true } : {}) });
  const out = JSON.stringify({ task, suggestions: r.suggestions.map((sg, k) => ({ id: k + 1, ...sg })), dropped: r.dropped }, null, 2);
  if (values.out) { writeFileSync(values.out, `${out}\n`); io.log(`${r.suggestions.length} suggestion${r.suggestions.length === 1 ? '' : 's'} in ${values.out}`); } else io.log(out);
  return 0;
}

/** apply <trace.json> <suggestions.json> --accept 1,3|all --out new.trace.json */
async function applyCmd(argv: string[], io: { log: (m: string) => void }): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { accept: { type: 'string' }, out: { type: 'string' } } });
  const [file, sugFile] = positionals;
  if (!file || !sugFile) throw new UsageError('apply needs a trace file and a suggestions file');
  if (!values.accept) throw new UsageError('apply needs --accept 1,3 (or all): a person picks what goes in');
  if (!values.out) throw new UsageError('apply needs --out for the new trace');
  const all = (readJson(sugFile) as { suggestions?: Array<Suggestion & { id: number }> }).suggestions ?? [];
  const ids = values.accept === 'all' ? all.map((x) => x.id) : values.accept.split(',').map((x) => Number(x.trim()));
  const missing = ids.filter((id) => !all.some((x) => x.id === id));
  if (missing.length) throw new UsageError(`no suggestion ${missing.join(', ')} in ${sugFile}`);
  const next = applySuggestions(readJson(file) as Parameters<typeof applySuggestions>[0], all.filter((x) => ids.includes(x.id)));
  writeFileSync(values.out, `${JSON.stringify(next, null, 2)}\n`);
  io.log(`applied ${ids.length} of ${all.length} to ${values.out}`);
  return 0;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/trace-avatar-render') || process.argv[1]?.endsWith('/cli.js');
if (isMain) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
