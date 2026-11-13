/**
 * render(): play a trace on the real app, cut its waits, and write GIF / MP4 files.
 *
 *   capture (headless Chromium) ──► timeline + frames ──► edit list ──► frames at the target fps
 *     ──► compose (window frame, camera, burned-in captions, title / end cards) ──► encode (+ poster, VTT)
 *
 * With none of the E2 options set, a frame is the capture scaled to the output width, as in E1.
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
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
import { canvasOf, watermarkOf } from './brand';
import type { CanvasSpec, Corner, Watermark } from './brand';
import type { FrameStyle, Layout } from './layout';
import { encodeMp4, FFMPEG_MISSING, findFfmpeg } from './mp4';
import { actionsOf, cueAt, pageAt, stepCues } from './plan';
import { cardFrames, durationOf, editList, frameTimes, outputAt, pickFrames, withCards, withHolds, DEFAULT_MAX_WAIT_MS } from './timeline';
import { mix, msOf, toWav, trimSilence, TRACK_RATE } from './audio';
import type { Pcm } from './audio';
import { linesOf, narrationText, parseScript, planNarration } from './narration';
import type { PlannedLine, Script } from './narration';
import type { Voice } from './voice';
import { repairGuide, repairScriptOf, stallInspector } from './repair';
import type { RepairOutcome } from './repair';
import type { Segment, TimelineEvent } from './timeline';
import { chapterCues, toVtt } from './vtt';
import { describe as describeGuide } from 'trace-avatar/assist';
import { runQa } from './ai';
import type { Ai, QaFlag, QaFrame } from './ai';
import { resize } from './image';
import type { Cue } from './vtt';

export type OutFormat = 'gif' | 'mp4';

export interface OutSpec {
  file: string;
  /** Output width in pixels (height keeps the aspect). Default: GIF 800, MP4 the capture's width. */
  width?: number;
  /** Default: GIF 12, MP4 30. */
  fps?: number;
  /** This output's own canvas (over the render's `canvas`): several shapes from one capture. */
  canvas?: CanvasSpec;
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
  /**
   * When a step is on another page, load it, as the app's router would (`navigate` in the player). Without it, a
   * Show me guide that crosses pages waits on "Open … to continue" until the render times out.
   */
  navigate?: boolean;
  /** Perform mode: what the guide leaves to the viewer, as trace-avatar's `security` (true, or 'secrets', 'money', 'files'). Default none. */
  security?: boolean | string[];
  /** Perform mode: values to type, by name or field label, e.g. { password: 'demo-pass' } (trace-avatar's `values`). */
  values?: Record<string, string>;
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
  /** Where burned-in captions sit: 'bottom' (the default) or 'top', for an app whose own UI is at the
   *  bottom of the page (a toolbar, a card, a cookie bar) where the caption would cover it. */
  captionsAt?: 'top' | 'bottom';
  /** A still at the first click: true writes <out>.png beside the first output, or give a path. */
  poster?: boolean | string;
  /** A 1.5 s card before the guide: true (the trace's title and avatar), a title, or { title, sub }. */
  titleCard?: boolean | string | CardOptions;
  /** A 2 s card after it: true ("Done"), a title, or { title, sub, url, logo }. */
  endCard?: boolean | string | CardOptions;
  /** Compose onto a picture of this shape: '9:16' (1080×1920), '4:5', '1:1', '16:9', 'WxH' or { width, height }.
   *  The app is placed between safe margins on the background; an output's width scales the whole canvas. */
  canvas?: CanvasSpec;
  /** A small badge on every frame, cards included: its text, or { text, at, opacity, logo }. */
  watermark?: string | Watermark;
  /** The AI for qa and alt (see trace-avatar/assist). Without it nothing calls a model. */
  ai?: Ai;
  /** Send a frame per step (640 px) to the AI to look for errors, empty states, a stall, personal data. */
  qa?: boolean;
  /** Write <out>.alt.txt (alt text for the GIF) and, with VTT captions, AI chapter names. */
  alt?: boolean;
  /** Narrate MP4 outputs with this voice (see voiceOf). GIFs keep their timing and have no sound. */
  voice?: Voice;
  /** What each step says: a script ({ lines: [{ n, text }] }) or its path. Default: each step's caption. */
  script?: string | Script;
  /** Fail when a line needs a hold longer than 8 s (otherwise a warning). */
  voiceStrict?: boolean;
  /** Also write the narration track here (WAV). */
  voiceOut?: string;
  /** When a step can't find its element, or a wait's text never shows: propose a fix (<out>.repair.json, for
   *  `apply`), verified by playing the guide again with it. The render still fails: a person accepts the fix.
   *  With `ai`, unsure cases are asked; a wait with no clear text is offered as a guess (`by: 'guess'`). */
  repair?: boolean;
  /** With repair and ai: send a screenshot of the stalled page too. */
  repairVision?: boolean;
}

/** What finish() takes besides the capture: the composing options, with the cards resolved. */
export type FinishOptions = Pick<RenderOptions, 'cuts' | 'timeline' | 'frame' | 'background' | 'camera' | 'captions' | 'captionsAt' | 'poster' | 'canvas' | 'watermark'> & {
  cards?: { title?: CardOptions; end?: CardOptions };
  /** Check frames with this AI (the steps give it context). */
  qa?: { ai: Ai; title?: string; steps: Array<{ n: number; type: string; say?: string }> };
  /** Chapter names by step index (from the AI), instead of each caption's first sentence. */
  chapterNames?: Array<{ index: number; name: string }>;
  /** Spoken lines by step index, for MP4 outputs. */
  narration?: { lines: Map<number, { text: string; audio: Pcm }>; strict?: boolean; out?: string };
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
  /** <out>.alt.txt, with alt. */
  alt?: string;
  /** What the AI flagged in the frames, with qa (times in the video). */
  qa?: QaFlag[];
  /** With a voice: the lines as placed (ms in the video), the time added by holds, the script file, the track. */
  narration?: { lines: PlannedLine[]; holdMs: number; text: string; wav?: string };
  /** Things worth knowing that didn't stop the render. */
  warnings?: string[];
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
/** A narrated card stays this much longer than its line. */
const CARD_PAD_MS = 700;
/** A card this close to the end of the capture is the video's last moment. */
const CLOSING_CARD_MS = 1500;

/** A card option to a card, or nothing. Exported for tests. */
export function cardOf(v: boolean | string | CardOptions | undefined, fallback: CardOptions): CardOptions | undefined {
  if (!v) return undefined;
  if (v === true) return fallback;
  if (typeof v === 'string') return { ...fallback, title: v };
  return { ...fallback, ...v };
}

export async function render(o: RenderOptions): Promise<RenderResult> {
  let trace = typeof o.trace === 'string' ? JSON.parse(readFileSync(o.trace, 'utf8')) : o.trace;
  if (!trace || typeof trace !== 'object') throw new RenderError('the trace must be an object or a .trace.json path');
  const mode = o.mode ?? 'overlay';
  if (mode === 'perform' && !o.allowPerform) {
    throw new RenderError('Do it for me clicks and types in the app for real: pass allowPerform (--allow-perform), and render against a sandbox account.');
  }
  const outs = o.out.map((x) => (typeof x === 'string' ? { file: x } : x)).map((x) => ({ ...x, format: formatOf(x.file) }));
  if (!outs.length) throw new RenderError('nothing to write: give at least one output (.gif or .mp4)');
  // Fail before the capture, not after it.
  const ffmpeg = outs.some((x) => x.format === 'mp4') ? findFfmpeg() : null;
  if (outs.some((x) => x.format === 'mp4') && !ffmpeg) throw new RenderError(FFMPEG_MISSING);
  const t = trace as { meta?: { title?: string; viewport?: { w: number; h: number } }; avatar?: { name?: string; color?: string } };
  const viewport = o.viewport ?? t.meta?.viewport ?? { w: 1280, h: 800 };
  const burn = o.captions === 'burn' || o.captions === 'both';
  if ((o.qa || o.alt) && !o.ai) throw new RenderError('qa and alt need an AI: pass ai (--ai)');
  if (o.voice && !outs.some((x) => x.format === 'mp4')) throw new RenderError('narration is for video: add an .mp4 output (a GIF has no sound)');
  const spoken = o.voice
    ? linesOf((trace as { steps?: Array<{ say?: string }> }).steps ?? [], o.script === undefined ? undefined : parseScript(typeof o.script === 'string' ? JSON.parse(readFileSync(o.script, 'utf8')) : o.script))
    : null;
  if (spoken && !spoken.size) throw new RenderError('nothing to say: no step has a caption (say), and no script was given');
  // Narrated from a script, each step says its spoken line: the captions (and the player's bubble) show what is heard.
  // Found 2026-11-12: captions kept the steps' own words while the voice read the script's.
  if (spoken && o.script !== undefined) {
    const steps = (trace as { steps?: Array<{ say?: string }> }).steps ?? [];
    trace = { ...(trace as object), steps: steps.map((st, i) => (spoken.has(i) && spoken.get(i) !== st.say ? { ...st, say: spoken.get(i) } : st)) };
  }

  if (o.repairVision && !(o.repair && o.ai)) throw new RenderError('repairVision needs repair and an AI');
  const capOpts = {
    url: o.url, mode, viewport, scale: o.scale, storageState: o.storageState,
    playerFile: await findPlayer(o.player), hide: o.hide, blur: o.blur, rate: o.rate,
    timeoutMs: o.timeoutMs, headless: o.headless, leadMs: LEAD_MS, ...(o.navigate ? { navigate: true } : {}),
    ...(o.security !== undefined ? { security: o.security } : {}), ...(o.values ? { values: o.values } : {}),
    ...(burn ? { captions: 'none' as const } : {}),
  };
  if (o.repair) repairScriptOf(capOpts.playerFile); // fail before the capture when the player is too old
  let cap: Capture;
  try {
    cap = await capture({
      ...capOpts, trace, allowStall: o.allowStall,
      ...(o.repair && !o.allowStall ? { onStall: stallInspector({ script: repairScriptOf(capOpts.playerFile), trace: () => trace as never, ...(o.ai ? { ai: o.ai } : {}), ...(o.repairVision ? { vision: true } : {}), skip: [...(o.hide ?? []), ...(o.blur ?? [])] }) } : {}),
    });
  } catch (e) {
    if (!(o.repair && e instanceof RenderError && e.stall)) throw e;
    const outcome = await repairGuide({ trace: trace as never, capture: capOpts, ...(o.ai ? { ai: o.ai } : {}), ...(o.repairVision ? { vision: true } : {}), first: e });
    const file = `${base(outs[0].file)}.repair.json`;
    mkdirSync(dirname(file) || '.', { recursive: true });
    writeFileSync(file, `${JSON.stringify({ task: 'repair', suggestions: outcome.suggestions, unresolved: outcome.unresolved, passed: outcome.passed }, null, 2)}\n`);
    const n = outcome.suggestions.length;
    const ok = outcome.suggestions.filter((x) => x.verified).length;
    const err = new RenderError(`${e.message}\nrepair: ${n ? `${n} fix${n > 1 ? 'es' : ''} (${ok} verified${outcome.passed ? ', the guide now plays to the end' : ''})` : 'no fix found'}${outcome.unresolved.length ? `; unresolved: step ${outcome.unresolved.map((u) => u.index + 1).join(', ')}` : ''}. See ${file}${n ? `, then: trace-avatar-render apply <trace> ${file} --accept ${outcome.suggestions.map((x) => x.id).join(',')} --out <new.trace.json>` : ''}`, e.screenshot);
    err.stall = e.stall;
    (err as RenderError & { repair?: { file: string; outcome: RepairOutcome } }).repair = { file, outcome };
    throw err;
  }
  const sub = t.avatar?.name ? { sub: t.avatar.name, color: t.avatar.color } : {};
  const title = cardOf(o.titleCard, { title: t.meta?.title || 'How to', ...sub });
  const end = cardOf(o.endCard, { title: 'Done', ...sub });
  const steps = ((trace as { steps?: Array<{ type: string; say?: string }> }).steps ?? []).map((st, i) => ({ n: i + 1, type: st.type, ...(st.say ? { say: st.say } : {}) }));
  // Alt text and chapter names come from the trace alone (asked only after the capture worked).
  const described = o.alt ? await describeGuide(trace as Parameters<typeof describeGuide>[0], { ai: o.ai! }) : null;
  // The voice speaks only after the capture worked (one line at a time; cached lines cost nothing).
  let narration: FinishOptions['narration'];
  if (spoken) {
    const lines = new Map<number, { text: string; audio: Pcm }>();
    for (const [i, text] of spoken) {
      let audio: Pcm;
      try { audio = trimSilence(await o.voice!(text)); } catch (e) { throw new RenderError(`the voice failed on step ${i + 1} ("${text}"): ${(e as Error).message}`); }
      if (audio.pcm.length) lines.set(i, { text, audio });
    }
    narration = { lines, ...(o.voiceStrict ? { strict: true } : {}), ...(o.voiceOut ? { out: o.voiceOut } : {}) };
  }
  const { qa: _qa, voice: _v, script: _s, ...rest } = o;
  const r = await finish(cap, outs, {
    ...rest,
    cards: { ...(title ? { title } : {}), ...(end ? { end } : {}) },
    ...(o.qa ? { qa: { ai: o.ai!, title: t.meta?.title, steps } } : {}),
    ...(described?.chapters.length ? { chapterNames: described.chapters } : {}),
    ...(narration ? { narration } : {}),
  });
  if (described?.alt) {
    const file = `${base(outs[0].file)}.alt.txt`;
    writeFileSync(file, `${described.alt}\n`);
    r.alt = file;
  }
  return r;
}

const base = (file: string) => file.replace(/\.[^./]+$/, '');

/** From a capture to files. Exported for tests (a capture can be made up). */
export async function finish(cap: Capture, outs: Array<OutSpec & { format: OutFormat }>, o: FinishOptions = {}): Promise<RenderResult> {
  const frames = cap.frames.slice().sort((a, b) => a.t - b.t);
  const capCards = cap.cards ?? [];
  // A card is a moment of the video even when the page sent no frame then (a still page sends none): the video
  // starts no later than its first card, and a card in its last moments closes it (no flash of the app after).
  const firstCard = capCards.length ? Math.min(...capCards.map((c) => c.t)) : Infinity;
  const lastCard = capCards.length ? Math.max(...capCards.map((c) => c.t)) : -Infinity;
  const start = Math.min(Math.max(frames[0].t, cap.playAt - LEAD_MS), firstCard);
  const end = lastCard >= cap.stopAt - CLOSING_CARD_MS ? Math.min(cap.stopAt, lastCard + 1) : cap.stopAt;
  const warnings: string[] = [];
  const narr = o.narration?.lines.size ? o.narration : null;
  // Cards between scenes: each as long as asked, or as its line when it is narrated (and a little more).
  const cards = capCards.map((c) => {
    const line = c.step !== undefined ? narr?.lines.get(c.step) : undefined;
    return { ...c, ms: Math.max(c.ms, line ? msOf(line.audio) + CARD_PAD_MS : 0) };
  });
  const cut = withCards(editList(cap.events, { start, end, maxWaitMs: o.cuts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS }), cards);
  const stamps = frames.map((f) => f.t);

  // Narration: place each line, and hold the video where a line would run over its step.
  let said: ReturnType<typeof planNarration> | null = null;
  let held = cut;
  if (narr) {
    const seen = new Set<number>();
    const acts = cap.events
      .filter((e) => e.type === 'step' && e.index !== undefined)
      .sort((a, b) => a.t - b.t)
      .flatMap((e) => { const t = outputAt(cut, e.t); if (t === null || seen.has(e.index!)) return []; seen.add(e.index!); return [{ index: e.index!, t }]; });
    const lines = new Map([...narr.lines].map(([i, l]) => [i, { text: l.text, ms: msOf(l.audio) }]));
    said = planNarration(acts, lines, durationOf(cut));
    for (const l of said.long) {
      const msg = `step ${l.index + 1}'s line needs the video to hold ${(l.ms / 1000).toFixed(1)} s: shorten it (--script)`;
      if (narr.strict) throw new RenderError(msg);
      warnings.push(msg);
    }
    const missed = [...narr.lines.keys()].filter((i) => !said!.lines.some((l) => l.index === i));
    if (missed.length) warnings.push(`no narration for step${missed.length > 1 ? 's' : ''} ${missed.map((i) => i + 1).join(', ')}: ${missed.length > 1 ? 'they' : 'it'} never played`);
    held = withHolds(cut, said.holds);
  }
  // The timeline of everything except GIFs (VTT, poster, QA follow the narrated video).
  const segs = held;
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
  const canvas = o.canvas !== undefined ? canvasOf(o.canvas) : undefined;
  // Each output may name its own canvas: checked before anything is drawn.
  const canvases = outs.map((x) => (x.canvas !== undefined ? canvasOf(x.canvas) : canvas));
  const mark = o.watermark !== undefined ? watermarkOf(o.watermark) : undefined;
  const background = o.background ?? DEFAULT_BACKGROUND;
  const burn = o.captions === 'burn' || o.captions === 'both';
  const variant = (sg: Segment[]) => {
    const ms = durationOf(sg);
    return {
      segs: sg, contentMs: ms,
      cam: o.camera ? cameraPath(actionsOf(cap.events, sg, scale), { width: srcW, height: srcH, ...(typeof o.camera === 'object' && o.camera.zoom ? { zoom: o.camera.zoom } : {}) }) : null,
      // A card says its own words: no caption over it or after it.
      cues: o.captions ? stepCues(cap.events.map((e) => (e.stepType === 'card' ? { ...e, say: undefined } : e)), sg, ms) : [],
    };
  };
  const main = variant(segs);
  const plain = narr ? variant(cut) : main;
  const cues = main.cues;
  const page = pageAt(cap.events);
  const titleMs = o.cards?.title ? TITLE_MS : 0;
  const endMs = o.cards?.end ? END_MS : 0;
  const full: Rect = { x: 0, y: 0, w: srcW, h: srcH };
  const needLayers = frameStyle !== 'none' || canvases.some(Boolean) || !!mark || (burn && (cues.length > 0 || plain.cues.length > 0)) || !!o.cards?.title || !!o.cards?.end || cards.length > 0;

  const browser = needLayers ? await chromium.launch() : null;
  let layers: Layers | null = null;
  const outputs: RenderOutput[] = [];
  const qaFrames: QaFrame[] = [];
  let poster: string | undefined;
  let wav: string | undefined;
  const tmp = narr ? mkdtempSync(join(tmpdir(), 'tar-voice-')) : null;
  try {
    layers = browser ? await createLayers(browser) : null;
    for (const [n, out] of outs.entries()) {
      mkdirSync(dirname(out.file) || '.', { recursive: true });
      const fps = out.fps ?? (out.format === 'gif' ? 12 : 30);
      const layout = layoutOf(srcW, srcH, out.width ?? (out.format === 'gif' ? 800 : undefined), frameStyle, canvases[n]);
      // A GIF has no sound, so it keeps the timing without holds.
      const v = out.format === 'gif' ? plain : main;
      const { cam, segs, contentMs } = v;
      const cues = v.cues;
      const times = frameTimes(segs, fps);
      const picks = pickFrames(stamps, times);
      const art = await artFor(layers, layout, { frameStyle, background, cues: burn ? cues : [], urls: [...new Set(cap.events.map((e) => e.url).filter(Boolean) as string[])], titles: cap.titles ?? {}, cards: o.cards, mid: cards.map((c) => c.card), mark });
      // Which card each content frame shows (at this output's fps).
      const cardAt = cards.length ? cardFrames(segs, fps) : [];

      const nTitle = Math.round((titleMs * fps) / 1000);
      const nEnd = Math.round((endMs * fps) / 1000);
      const nFade = Math.max(1, Math.round((FADE_MS * fps) / 1000));
      const total = nTitle + picks.length + nEnd;

      let last: { key: string; img: Image } | null = null;
      /** Content frame k: the app, or a card (fading in from the app before it and out to the app after). */
      const content = (k: number): Image => {
        const c = cardAt[k];
        if (c === undefined) return app(k);
        const img = art.mid[c];
        let s = k; while (s > 0 && cardAt[s - 1] === c) s -= 1;
        let e = k; while (e + 1 < cardAt.length && cardAt[e + 1] === c) e += 1;
        if (k - s < nFade && s > 0 && cardAt[s - 1] === undefined) return crossfade(app(s - 1), img, (k - s + 1) / nFade);
        if (e - k < nFade && e + 1 < picks.length && cardAt[e + 1] === undefined) return crossfade(img, app(e + 1), 1 - (e - k) / nFade);
        return img;
      };
      const app = (k: number): Image => {
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
          const gap = Math.round(layout.content.h * 0.05);
          let y = img && (o.captionsAt === 'top' ? layout.content.y + gap : layout.content.y + layout.content.h - img.height - gap);
          // On a canvas the caption goes in the room beside the app (below it, or above with captionsAt top), when it fits.
          if (img && layout.canvas) {
            const g2 = Math.round(layout.height * 0.02);
            const below = layout.window.y + layout.window.h + g2;
            const above = layout.window.y - g2 - img.height;
            if (o.captionsAt === 'top' ? above >= g2 : below + img.height <= layout.height - g2) y = o.captionsAt === 'top' ? above : below;
          }
          const x = img ? (layout.canvas ? (layout.width - img.width) / 2 : layout.content.x + (layout.content.w - img.width) / 2) : 0;
          // Clear of the watermark: a caption that would touch it moves away from it (up, or down at the top).
          if (img && y !== undefined && art.badge) {
            const b = art.badge;
            const touches = x < b.x + b.img.width && x + img.width > b.x && y < b.y + b.img.height && y + img.height > b.y;
            if (touches) y = b.y < layout.height / 2 ? b.y + b.img.height + Math.round(gap / 2) : b.y - img.height - Math.round(gap / 2);
          }
          if (img && y !== undefined) overlay(dst, img, x, y, alpha);
        }
        if (art.badge) overlay(dst, art.badge.img, art.badge.x, art.badge.y, art.badge.alpha);
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
        let audio: string | undefined;
        if (narr && said && tmp) {
          // One track as long as this video, each line at its place (after the title card).
          const track = mix(said.lines.map((l) => ({ start: l.start + titleMs, audio: narr.lines.get(l.index)!.audio })), (total * 1000) / fps);
          audio = join(tmp, `${n}.wav`);
          writeFileSync(audio, toWav(track, TRACK_RATE));
          if (narr.out && !wav) { mkdirSync(dirname(narr.out) || '.', { recursive: true }); writeFileSync(narr.out, toWav(track, TRACK_RATE)); wav = narr.out; }
        }
        await encodeMp4(all(), { file: out.file, fps, width: layout.width, height: layout.height, ...(audio ? { audio } : {}) });
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

      if (n === 0 && o.qa) {
        // A frame just after each step acts (at most 16, spread out) and the last one, 640 px wide.
        const steps = cap.events.filter((e) => e.type === 'step' && e.index !== undefined);
        const pick = steps.length > 15 ? Array.from({ length: 15 }, (_, j) => steps[Math.floor((j * steps.length) / 15)]) : steps;
        const at = [...pick.map((e) => ({ t: outputAt(segs, e.t), label: `after step ${e.index! + 1} (${e.stepType})` })).filter((x): x is { t: number; label: string } => x.t !== null),
          { t: contentMs - 1, label: 'the end' }];
        for (const x of at) {
          const k = Math.min(picks.length - 1, Math.max(0, Math.round(((x.t + 300) * fps) / 1000)));
          last = null;
          const img = content(k);
          const small = img.width > 640 ? resize(img, 640, Math.max(2, Math.round((img.height * 640) / img.width))) : img;
          const png = new PNG({ width: small.width, height: small.height });
          png.data.set(small.data);
          qaFrames.push({ at: Math.round(x.t + titleMs), label: x.label, png: new Uint8Array(PNG.sync.write(png)) });
        }
      }
    }
  } finally {
    await layers?.close().catch(() => {});
    await browser?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }

  let vtt: string | undefined;
  let chapters: string | undefined;
  if ((o.captions === 'vtt' || o.captions === 'both') && cues.length) {
    const shift = (c: Cue): Cue => ({ ...c, start: c.start + titleMs, end: c.end + titleMs });
    vtt = `${base(outs[0].file)}.vtt`;
    chapters = `${base(outs[0].file)}.chapters.vtt`;
    writeFileSync(vtt, toVtt(cues.map(shift)));
    writeFileSync(chapters, toVtt(o.chapterNames?.length ? namedChapters(o.chapterNames, cap.events, segs, contentMs).map(shift) : chapterCues(cues.map((c) => ({ t: c.start, text: c.text })), contentMs).map(shift)));
  }
  const qa = o.qa ? await runQa(o.qa.ai, qaFrames, { title: o.qa.title, steps: o.qa.steps }) : undefined;

  let narration: RenderResult['narration'];
  if (said) {
    const mp4 = outs.find((x) => x.format === 'mp4')!;
    const text = `${base(mp4.file)}.narration.txt`;
    writeFileSync(text, narrationText(said.lines, titleMs));
    narration = { lines: said.lines.map((l) => ({ ...l, start: l.start + titleMs })), holdMs: said.holds.reduce((a, h) => a + h.ms, 0), text, ...(wav ? { wav } : {}) };
  }
  const rel = (t: number) => Math.round(t - start);
  const result: RenderResult = {
    durationMs: Math.round(contentMs + titleMs + endMs),
    offsetMs: titleMs,
    rawMs: Math.round(end - start),
    segments: segs.map((s) => ({ from: rel(s.from), to: rel(s.to), ...(s.hold ? { hold: s.hold } : {}), ...(s.card !== undefined ? { card: s.card } : {}) })),
    events: cap.events.map((e) => ({ ...e, t: rel(e.t) })),
    outputs,
    ...(poster ? { poster } : {}),
    ...(vtt ? { vtt, chapters } : {}),
    ...(qa ? { qa } : {}),
    ...(narration ? { narration } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
  if (o.timeline) {
    mkdirSync(dirname(o.timeline) || '.', { recursive: true });
    writeFileSync(o.timeline, JSON.stringify(result, null, 2));
  }
  return result;
}

/** Chapters named by the AI: each starts when its step acts (steps that were cut or never played are skipped). */
export function namedChapters(names: ReadonlyArray<{ index: number; name: string }>, events: readonly TimelineEvent[], segs: readonly Segment[], endMs: number): Cue[] {
  const starts = names.flatMap((c) => {
    const e = events.find((x) => x.type === 'step' && x.index === c.index);
    const t = e ? outputAt(segs, e.t) : null;
    return t === null ? [] : [{ t: c.index === names[0].index ? 0 : t, text: c.name }];
  }).sort((a, b) => a.t - b.t);
  return starts.map((c, k) => ({ start: c.t, end: starts[k + 1]?.t ?? endMs, text: c.text }));
}

interface Art { base: Map<string, Image> | null; captions: Map<string, Image>; title?: Image; end?: Image; mid: Image[]; badge?: { img: Image; x: number; y: number; alpha: number } }

/** Where a badge w×h sits in a picture W×H: in its corner, a margin of 2.5% of the shorter side from the edges. */
export function badgeAt(W: number, H: number, w: number, h: number, at: Corner = 'bottom-right'): { x: number; y: number } {
  const m = Math.round(Math.min(W, H) * 0.025);
  return { x: at.endsWith('left') ? m : W - w - m, y: at.startsWith('top') ? m : H - h - m };
}

/** Everything Chromium draws for one output size, made before the frames. */
async function artFor(layers: Layers | null, layout: Layout, o: { frameStyle: FrameStyle; background: string; cues: readonly Cue[]; urls: string[]; titles: Record<string, string>; cards?: FinishOptions['cards']; mid?: CardOptions[]; mark?: Watermark }): Promise<Art> {
  const art: Art = { base: null, captions: new Map(), mid: [] };
  if (!layers) return art;
  if (o.frameStyle !== 'none' || layout.canvas) {
    art.base = new Map();
    for (const url of o.urls.length ? o.urls : ['/']) art.base.set(url, await layers.base(layout, { background: o.background, path: url, title: o.titles[url] }));
  }
  // On a canvas, captions are sized to the canvas (they sit beside the app, read on a phone), not to the app.
  const fontPx = layout.canvas ? Math.max(12, Math.round(layout.width * 0.034)) : Math.max(12, Math.round(layout.content.w * 0.026));
  const maxWidth = Math.round(layout.canvas ? layout.width * 0.9 : layout.content.w * 0.8);
  for (const c of o.cues) {
    if (!art.captions.has(c.text)) art.captions.set(c.text, await layers.caption(c.text, { maxWidth, fontPx }));
  }
  if (o.cards?.title) art.title = await layers.card(layout, { ...o.cards.title, background: o.background });
  if (o.cards?.end) art.end = await layers.card(layout, { ...o.cards.end, background: o.background });
  for (const c of o.mid ?? []) art.mid.push(await layers.card(layout, { ...c, background: o.background }));
  if (o.mark) {
    const img = await layers.badge(o.mark.text, { fontPx: Math.max(11, Math.round(Math.min(layout.width, layout.height) * 0.024)), ...(o.mark.logo ? { logo: o.mark.logo } : {}) });
    const { x, y } = badgeAt(layout.width, layout.height, img.width, img.height, o.mark.at);
    art.badge = { img, x, y, alpha: o.mark.opacity ?? 0.9 };
    // The cards carry it too (drawn once, on copies).
    for (const k of ['title', 'end'] as const) {
      const c = art[k];
      if (c) { const d = copy(c); overlay(d, img, x, y, art.badge.alpha); art[k] = d; }
    }
    art.mid = art.mid.map((c) => { const d = copy(c); overlay(d, img, x, y, art.badge!.alpha); return d; });
  }
  return art;
}
