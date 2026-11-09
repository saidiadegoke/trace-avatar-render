/**
 * render(): play a trace on the real app, cut its waits, and write GIF / MP4 files.
 *
 *   capture (headless Chromium) ──► timeline + frames ──► edit list ──► frames at the target fps ──► encode
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { PNG } from 'pngjs';
import { capture, findPlayer, RenderError } from './capture';
import type { Capture } from './capture';
import { encodeGif } from './gif';
import { crop, fitWidth, resize } from './image';
import type { Image } from './image';
import { encodeMp4, findFfmpeg } from './mp4';
import { durationOf, editList, frameTimes, pickFrames, DEFAULT_MAX_WAIT_MS } from './timeline';
import type { Segment, TimelineEvent } from './timeline';

export type OutFormat = 'gif' | 'mp4';

export interface OutSpec {
  file: string;
  /** Output width in pixels (height keeps the aspect). Default: GIF 800, MP4 the capture's width. */
  width?: number;
  /** Default: GIF 12, MP4 30. */
  fps?: number;
}

export interface RenderOptions {
  /** A trace object, or the path of a .trace.json. */
  trace: unknown;
  /** The page the guide starts on. */
  url: string;
  /** 'overlay' (Show me, default) or 'perform' (Do it for me: clicks and types for real). */
  mode?: 'overlay' | 'perform';
  /** Required for mode 'perform': render it only against a sandbox account. */
  allowPerform?: boolean;
  /** A signed-in session (Playwright storageState file). */
  storageState?: string;
  /** Default: the trace's meta.viewport, else 1280×800. */
  viewport?: { w: number; h: number };
  /** Device pixel ratio of the capture (2 for crisp video text). Default 1. */
  scale?: number;
  out: Array<string | OutSpec>;
  cuts?: { maxWaitMs?: number };
  /** Render a stalled guide anyway instead of failing. */
  allowStall?: boolean;
  hide?: string[];
  blur?: string[];
  rate?: number;
  /** The player build. Default: TRACE_AVATAR_PLAYER, else the installed trace-avatar's dist/trace-perform.min.js. */
  player?: string;
  /** Write the timeline and the edit list here (JSON). */
  timeline?: string;
  timeoutMs?: number;
  headless?: boolean;
}

export interface RenderOutput { file: string; format: OutFormat; width: number; height: number; fps: number; frames: number; bytes: number; durationMs: number }

export interface RenderResult {
  /** Length after cuts. */
  durationMs: number;
  /** Length as it played. */
  rawMs: number;
  /** Kept stretches, ms from the start of the capture. */
  segments: Segment[];
  /** Events, ms from the start of the capture. */
  events: TimelineEvent[];
  outputs: RenderOutput[];
}

export const formatOf = (file: string): OutFormat => {
  const ext = extname(file).toLowerCase();
  if (ext === '.gif') return 'gif';
  if (ext === '.mp4') return 'mp4';
  throw new RenderError(`unknown output "${file}": use .gif or .mp4`);
};

const LEAD_MS = 500;

export async function render(o: RenderOptions): Promise<RenderResult> {
  const trace = typeof o.trace === 'string' ? JSON.parse(readFileSync(o.trace, 'utf8')) : o.trace;
  if (!trace || typeof trace !== 'object') throw new RenderError('the trace must be an object or a .trace.json path');
  const mode = o.mode ?? 'overlay';
  if (mode === 'perform' && !o.allowPerform) {
    throw new RenderError('Do it for me clicks and types in the app for real: pass allowPerform (--allow-perform), and render against a sandbox account.');
  }
  const outs = o.out.map((x) => (typeof x === 'string' ? { file: x } : x)).map((x) => ({ ...x, format: formatOf(x.file) }));
  if (!outs.length) throw new RenderError('nothing to write: give at least one output (.gif or .mp4)');
  // Fail before the capture, not after it.
  const ffmpeg = outs.some((x) => x.format === 'mp4') ? findFfmpeg() : null;
  if (outs.some((x) => x.format === 'mp4') && !ffmpeg) throw new RenderError('MP4 needs ffmpeg: install it (brew install ffmpeg, apt install ffmpeg) or set FFMPEG to its path. GIF works without it.');
  const meta = (trace as { meta?: { viewport?: { w: number; h: number } } }).meta;
  const viewport = o.viewport ?? meta?.viewport ?? { w: 1280, h: 800 };

  const cap = await capture({
    trace, url: o.url, mode, viewport, scale: o.scale, storageState: o.storageState,
    playerFile: await findPlayer(o.player), hide: o.hide, blur: o.blur, rate: o.rate,
    allowStall: o.allowStall, timeoutMs: o.timeoutMs, headless: o.headless, leadMs: LEAD_MS,
  });
  return finish(cap, outs, o);
}

/** From a capture to files. Exported for tests (a capture can be made up). */
export async function finish(cap: Capture, outs: Array<OutSpec & { format: OutFormat }>, o: Pick<RenderOptions, 'cuts' | 'timeline'> = {}): Promise<RenderResult> {
  const frames = cap.frames.slice().sort((a, b) => a.t - b.t);
  const start = Math.max(frames[0].t, cap.playAt - LEAD_MS);
  const end = cap.stopAt;
  const segs = editList(cap.events, { start, end, maxWaitMs: o.cuts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS });
  const stamps = frames.map((f) => f.t);

  const decoded = new Map<number, Image>();
  const image = (i: number): Image => {
    let img = decoded.get(i);
    if (!img) {
      const p = PNG.sync.read(frames[i].png);
      img = { width: p.width, height: p.height, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.length) };
      decoded.set(i, img);
    }
    return img;
  };

  const outputs: RenderOutput[] = [];
  for (const out of outs) {
    mkdirSync(dirname(out.file) || '.', { recursive: true });
    const fps = out.fps ?? (out.format === 'gif' ? 12 : 30);
    const picks = pickFrames(stamps, frameTimes(segs, fps));
    const src = image(picks[0]);
    if (out.format === 'gif') {
      const size = fitWidth(src.width, src.height, out.width ?? 800);
      const scaled = new Map<number, Image>();
      const list = picks.map((i) => {
        let s = scaled.get(i);
        if (!s) {
          const im = image(i);
          const f = fitWidth(im.width, im.height, out.width ?? 800);
          s = f.width < im.width - 1 ? resize(im, f.width, f.height) : crop(im, f.width, f.height);
          scaled.set(i, s);
        }
        return s;
      });
      const gif = encodeGif(list, { fps });
      writeFileSync(out.file, gif.bytes);
      outputs.push({ file: out.file, format: 'gif', width: size.width, height: size.height, fps, frames: picks.length, bytes: gif.bytes.length, durationMs: gif.durationMs });
    } else {
      await encodeMp4(picks.map((i) => frames[i].png), { file: out.file, fps, width: out.width });
      const size = fitWidth(src.width, src.height, out.width);
      outputs.push({ file: out.file, format: 'mp4', width: size.width, height: size.height, fps, frames: picks.length, bytes: readFileSync(out.file).length, durationMs: Math.round((picks.length * 1000) / fps) });
    }
  }

  const rel = (t: number) => Math.round(t - start);
  const result: RenderResult = {
    durationMs: Math.round(durationOf(segs)),
    rawMs: Math.round(end - start),
    segments: segs.map((s) => ({ from: rel(s.from), to: rel(s.to) })),
    events: cap.events.map((e) => ({ ...e, t: rel(e.t) })),
    outputs,
  };
  if (o.timeline) {
    mkdirSync(dirname(o.timeline) || '.', { recursive: true });
    writeFileSync(o.timeline, JSON.stringify(result, null, 2));
  }
  return result;
}
