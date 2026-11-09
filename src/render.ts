/**
 * render(): play a trace on the real app, cut its waits, and write GIF / MP4 files.
 *
 *   capture (headless Chromium) ──► timeline + frames ──► edit list ──► frames at the target fps
 *     ──► compose (window frame, camera, burned-in captions, title / end cards) ──► encode (+ poster, VTT)
 *
 * With none of the E2 options set, a frame is the capture scaled to the output width, as in E1.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { cameraPath } from './camera';
import type { Rect } from './camera';
import { capture, findPlayer, RenderError } from './capture';
import type { Capture } from './capture';
import { blank, copy, crossfade, drawRegion, overlay } from './compose';
import { createGifWriter, paletteOf } from './gif';
import type { Image } from './image';
import { createLayers, DEFAULT_BACKGROUND } from './layers';
import type { CardOptions, Layers } from './layers';
import { layoutOf } from './layout';
import type { FrameStyle, Layout } from './layout';
import { encodeMp4, findFfmpeg } from './mp4';
import { actionsOf, cueAt, pageAt, stepCues } from './plan';
import { durationOf, editList, frameTimes, outputAt, pickFrames, DEFAULT_MAX_WAIT_MS } from './timeline';
import type { Segment, TimelineEvent } from './timeline';
import { chapterCues, toVtt } from './vtt';
import type { Cue } from './vtt';

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
  /** 'browser' puts the capture in a window (title bar with the page path) on a background. Default 'none'. */
  frame?: FrameStyle;
  /** CSS background behind the window and on the cards. Default a soft gradient. */
  background?: string;
  /** Zoom in on each action and pan between close ones. true, or { zoom } (default 1.6). Default off. */
  camera?: boolean | { zoom?: number };
  /** 'burn' draws the steps' words into the video (the player's own bubble is then off), 'vtt' writes
   *  <out>.vtt and <out>.chapters.vtt beside the first output, 'both' does both. Default: neither. */
  captions?: 'burn' | 'vtt' | 'both';
  /** A still at the first click: true writes <out>.png beside the first output, or give a path. */
  poster?: boolean | string;
  /** A 1.5 s card before the guide: true (the trace's title and avatar), a title, or { title, sub }. */
  titleCard?: boolean | string | CardOptions;
  /** A 2 s card after it: true ("Done"), a title, or { title, sub }. */
  endCard?: boolean | string | CardOptions;
}

/** What finish() takes besides the capture: the composing options, with the cards resolved. */
export type FinishOptions = Pick<RenderOptions, 'cuts' | 'timeline' | 'frame' | 'background' | 'camera' | 'captions' | 'poster'> & {
  cards?: { title?: CardOptions; end?: CardOptions };
};

export interface RenderOutput { file: string; format: OutFormat; width: number; height: number; fps: number; frames: number; bytes: number; durationMs: number }

export interface RenderResult {
  /** Length of the video: after cuts, with any cards. */
  durationMs: number;
  /** Where the guide starts in the video (the title card's length; 0 without one). Add it to outputAt(). */
  offsetMs: number;
  /** Length as it played. */
  rawMs: number;
  /** Kept stretches, ms from the start of the capture. */
  segments: Segment[];
  /** Events, ms from the start of the capture. */
  events: TimelineEvent[];
  outputs: RenderOutput[];
  /** Files written besides the videos. */
  poster?: string;
  vtt?: string;
  chapters?: string;
}

export const formatOf = (file: string): OutFormat => {
  const ext = extname(file).toLowerCase();
  if (ext === '.gif') return 'gif';
  if (ext === '.mp4') return 'mp4';
  throw new RenderError(`unknown output "${file}": use .gif or .mp4`);
};

const LEAD_MS = 500;
const TITLE_MS = 1500;
const END_MS = 2000;
const FADE_MS = 300;

/** A card option to a card, or nothing. Exported for tests. */
export function cardOf(v: boolean | string | CardOptions | undefined, fallback: CardOptions): CardOptions | undefined {
  if (!v) return undefined;
  if (v === true) return fallback;
  if (typeof v === 'string') return { ...fallback, title: v };
  return { ...fallback, ...v };
}

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
  const t = trace as { meta?: { title?: string; viewport?: { w: number; h: number } }; avatar?: { name?: string; color?: string } };
  const viewport = o.viewport ?? t.meta?.viewport ?? { w: 1280, h: 800 };
  const burn = o.captions === 'burn' || o.captions === 'both';

  const cap = await capture({
    trace, url: o.url, mode, viewport, scale: o.scale, storageState: o.storageState,
    playerFile: await findPlayer(o.player), hide: o.hide, blur: o.blur, rate: o.rate,
    allowStall: o.allowStall, timeoutMs: o.timeoutMs, headless: o.headless, leadMs: LEAD_MS,
    ...(burn ? { captions: 'none' as const } : {}),
  });
  const sub = t.avatar?.name ? { sub: t.avatar.name, color: t.avatar.color } : {};
  const title = cardOf(o.titleCard, { title: t.meta?.title || 'How to', ...sub });
  const end = cardOf(o.endCard, { title: 'Done', ...sub });
  return finish(cap, outs, { ...o, cards: { ...(title ? { title } : {}), ...(end ? { end } : {}) } });
}

const base = (file: string) => file.replace(/\.[^./]+$/, '');

/** From a capture to files. Exported for tests (a capture can be made up). */
export async function finish(cap: Capture, outs: Array<OutSpec & { format: OutFormat }>, o: FinishOptions = {}): Promise<RenderResult> {
  const frames = cap.frames.slice().sort((a, b) => a.t - b.t);
  const start = Math.max(frames[0].t, cap.playAt - LEAD_MS);
  const end = cap.stopAt;
  const segs = editList(cap.events, { start, end, maxWaitMs: o.cuts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS });
  const stamps = frames.map((f) => f.t);
  const contentMs = durationOf(segs);

  // One decoded capture frame at a time: output frames ask for them in order.
  let slot: { i: number; img: Image } | null = null;
  const source = (i: number): Image => {
    if (slot?.i !== i) {
      const p = PNG.sync.read(frames[i].png);
      slot = { i, img: { width: p.width, height: p.height, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.length) } };
    }
    return slot.img;
  };
  const first = source(0);
  const srcW = first.width;
  const srcH = first.height;
  const scale = cap.viewport ? srcW / cap.viewport.w : 1;

  const frameStyle = o.frame ?? 'none';
  const background = o.background ?? DEFAULT_BACKGROUND;
  const burn = o.captions === 'burn' || o.captions === 'both';
  const cam = o.camera ? cameraPath(actionsOf(cap.events, segs, scale), { width: srcW, height: srcH, ...(typeof o.camera === 'object' && o.camera.zoom ? { zoom: o.camera.zoom } : {}) }) : null;
  const cues = o.captions ? stepCues(cap.events, segs, contentMs) : [];
  const page = pageAt(cap.events);
  const titleMs = o.cards?.title ? TITLE_MS : 0;
  const endMs = o.cards?.end ? END_MS : 0;
  const full: Rect = { x: 0, y: 0, w: srcW, h: srcH };
  const needLayers = frameStyle !== 'none' || (burn && cues.length > 0) || !!o.cards?.title || !!o.cards?.end;

  const browser = needLayers ? await chromium.launch() : null;
  let layers: Layers | null = null;
  const outputs: RenderOutput[] = [];
  let poster: string | undefined;
  try {
    layers = browser ? await createLayers(browser) : null;
    for (const [n, out] of outs.entries()) {
      mkdirSync(dirname(out.file) || '.', { recursive: true });
      const fps = out.fps ?? (out.format === 'gif' ? 12 : 30);
      const layout = layoutOf(srcW, srcH, out.width ?? (out.format === 'gif' ? 800 : undefined), frameStyle);
      const times = frameTimes(segs, fps);
      const picks = pickFrames(stamps, times);
      const art = await artFor(layers, layout, { frameStyle, background, cues: burn ? cues : [], urls: [...new Set(cap.events.map((e) => e.url).filter(Boolean) as string[])], titles: cap.titles ?? {}, cards: o.cards });

      const nTitle = Math.round((titleMs * fps) / 1000);
      const nEnd = Math.round((endMs * fps) / 1000);
      const nFade = Math.max(1, Math.round((FADE_MS * fps) / 1000));
      const total = nTitle + picks.length + nEnd;

      let last: { key: string; img: Image } | null = null;
      const content = (k: number): Image => {
        const t = (k * 1000) / fps;
        const i = picks[k];
        const rect = cam ? cam(t) : full;
        const url = page(times[k]);
        const c = burn ? cueAt(cues, t) : null;
        const alpha = c ? Math.round(c.alpha * 8) / 8 : 0;
        const key = `${i}|${rect.x.toFixed(1)},${rect.y.toFixed(1)},${rect.w.toFixed(1)}|${url}|${c && alpha > 0 ? `${c.cue.text}@${alpha}` : ''}`;
        if (last?.key === key) return last.img;
        const dst = art.base ? copy(art.base.get(url) ?? art.base.values().next().value!) : blank(layout.width, layout.height);
        drawRegion(dst, layout.content, source(i), rect);
        if (c && alpha > 0) {
          const img = art.captions.get(c.cue.text);
          if (img) overlay(dst, img, layout.content.x + (layout.content.w - img.width) / 2, layout.content.y + layout.content.h - img.height - Math.round(layout.content.h * 0.05), alpha);
        }
        last = { key, img: dst };
        return dst;
      };
      /** Output frame m of the whole video: title card, the guide, end card (each card fades in). */
      const frameAt = (m: number): Image => {
        if (m < nTitle) {
          const left = nTitle - m;
          return left <= nFade ? crossfade(art.title!, content(0), 1 - (left - 1) / nFade) : art.title!;
        }
        const k = m - nTitle;
        if (k < picks.length) return content(k);
        const e = k - picks.length;
        return e < nFade ? crossfade(content(picks.length - 1), art.end!, (e + 1) / nFade) : art.end!;
      };

      if (out.format === 'gif') {
        const samples = Array.from({ length: Math.min(12, total) }, (_, s) => copy(frameAt(Math.floor((s * total) / Math.min(12, total)))));
        last = null;
        const w = createGifWriter({ width: layout.width, height: layout.height, fps, palette: paletteOf(samples, samples.length) });
        for (let m = 0; m < total; m += 1) w.add(frameAt(m));
        const gif = w.finish();
        writeFileSync(out.file, gif.bytes);
        outputs.push({ file: out.file, format: 'gif', width: layout.width, height: layout.height, fps, frames: total, bytes: gif.bytes.length, durationMs: gif.durationMs });
      } else {
        const all = function* () { for (let m = 0; m < total; m += 1) yield frameAt(m).data; };
        await encodeMp4(all(), { file: out.file, fps, width: layout.width, height: layout.height });
        outputs.push({ file: out.file, format: 'mp4', width: layout.width, height: layout.height, fps, frames: total, bytes: readFileSync(out.file).length, durationMs: Math.round((total * 1000) / fps) });
      }

      if (n === 0 && o.poster) {
        // A still where the guide acts: just after the first click, else halfway.
        const click = cap.events.find((e) => e.type === 'step' && (e.stepType === 'click' || e.stepType === 'dblclick'));
        const ct = click ? outputAt(segs, click.t) : null;
        const k = Math.min(picks.length - 1, Math.max(0, Math.round((((ct ?? contentMs / 2) + (ct === null ? 0 : 300)) * fps) / 1000)));
        last = null;
        const img = content(k);
        const png = new PNG({ width: img.width, height: img.height });
        png.data.set(img.data);
        poster = typeof o.poster === 'string' ? o.poster : `${base(out.file)}.png`;
        mkdirSync(dirname(poster) || '.', { recursive: true });
        writeFileSync(poster, PNG.sync.write(png));
      }
    }
  } finally {
    await layers?.close().catch(() => {});
    await browser?.close();
  }

  let vtt: string | undefined;
  let chapters: string | undefined;
  if ((o.captions === 'vtt' || o.captions === 'both') && cues.length) {
    const shift = (c: Cue): Cue => ({ ...c, start: c.start + titleMs, end: c.end + titleMs });
    vtt = `${base(outs[0].file)}.vtt`;
    chapters = `${base(outs[0].file)}.chapters.vtt`;
    writeFileSync(vtt, toVtt(cues.map(shift)));
    writeFileSync(chapters, toVtt(chapterCues(cues.map((c) => ({ t: c.start, text: c.text })), contentMs).map(shift)));
  }

  const rel = (t: number) => Math.round(t - start);
  const result: RenderResult = {
    durationMs: Math.round(contentMs + titleMs + endMs),
    offsetMs: titleMs,
    rawMs: Math.round(end - start),
    segments: segs.map((s) => ({ from: rel(s.from), to: rel(s.to) })),
    events: cap.events.map((e) => ({ ...e, t: rel(e.t) })),
    outputs,
    ...(poster ? { poster } : {}),
    ...(vtt ? { vtt, chapters } : {}),
  };
  if (o.timeline) {
    mkdirSync(dirname(o.timeline) || '.', { recursive: true });
    writeFileSync(o.timeline, JSON.stringify(result, null, 2));
  }
  return result;
}

interface Art { base: Map<string, Image> | null; captions: Map<string, Image>; title?: Image; end?: Image }

/** Everything Chromium draws for one output size, made before the frames. */
async function artFor(layers: Layers | null, layout: Layout, o: { frameStyle: FrameStyle; background: string; cues: readonly Cue[]; urls: string[]; titles: Record<string, string>; cards?: FinishOptions['cards'] }): Promise<Art> {
  const art: Art = { base: null, captions: new Map() };
  if (!layers) return art;
  if (o.frameStyle !== 'none') {
    art.base = new Map();
    for (const url of o.urls.length ? o.urls : ['/']) art.base.set(url, await layers.base(layout, { background: o.background, path: url, title: o.titles[url] }));
  }
  const fontPx = Math.max(12, Math.round(layout.content.w * 0.026));
  for (const c of o.cues) {
    if (!art.captions.has(c.text)) art.captions.set(c.text, await layers.caption(c.text, { maxWidth: Math.round(layout.content.w * 0.8), fontPx }));
  }
  if (o.cards?.title) art.title = await layers.card(layout, { ...o.cards.title, background: o.background });
  if (o.cards?.end) art.end = await layers.card(layout, { ...o.cards.end, background: o.background });
  return art;
}
