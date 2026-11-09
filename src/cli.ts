#!/usr/bin/env node
/**
 *   trace-avatar-render invoice.trace.json --url http://localhost:3000/app --out invoice.gif --out invoice.mp4
 *
 * Exit codes: 0 rendered, 1 the render failed (a stalled guide, an error in the app), 2 wrong usage.
 */

import { writeFileSync } from 'node:fs';
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
  --headed                show the browser
`;

export interface Parsed { trace: string; options: Parameters<typeof render>[0] }

/** Parse the command line. Throws a usage message (exit 2) on mistakes. Exported for tests. */
export function parse(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: 'string' }, out: { type: 'string', multiple: true }, mode: { type: 'string' },
      'allow-perform': { type: 'boolean' }, width: { type: 'string' }, fps: { type: 'string' },
      viewport: { type: 'string' }, scale: { type: 'string' }, 'storage-state': { type: 'string' },
      'max-wait': { type: 'string' }, hide: { type: 'string', multiple: true }, blur: { type: 'string', multiple: true },
      'allow-stall': { type: 'boolean' }, player: { type: 'string' }, timeline: { type: 'string' },
      timeout: { type: 'string' }, headed: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
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
    },
  };
}

export class UsageError extends Error {}

export async function main(argv: string[], io = { log: console.log, error: console.error }): Promise<number> {
  let p: Parsed;
  try { p = parse(argv); } catch (e) {
    const msg = (e as Error).message;
    if (msg) io.error(`trace-avatar-render: ${msg}\n`);
    io.error(USAGE);
    return e instanceof UsageError && !msg ? 0 : 2;
  }
  try {
    const r = await render(p.options);
    for (const o of r.outputs) io.log(`${o.file}  ${o.width}×${o.height}  ${o.fps} fps  ${(r.durationMs / 1000).toFixed(1)} s  ${(o.bytes / 1024).toFixed(0)} KB`);
    if (r.rawMs > r.durationMs + 50) io.log(`cut ${((r.rawMs - r.durationMs) / 1000).toFixed(1)} s of waiting`);
    return 0;
  } catch (e) {
    io.error(`trace-avatar-render: ${(e as Error).message}`);
    if (e instanceof RenderError && e.screenshot) {
      const first = p.options.out[0];
      const shot = `${(typeof first === 'string' ? first : first.file).replace(/\.[^./]+$/, '')}.failure.png`;
      writeFileSync(shot, e.screenshot);
      io.error(`the page at that moment: ${shot}`);
    }
    return 1;
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/trace-avatar-render') || process.argv[1]?.endsWith('/cli.js');
if (isMain) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
