/**
 * Play a trace on the real app in headless Chromium and capture it.
 *
 * The player (trace-perform.min.js) and a small bootstrap are injected into every page of the context,
 * so a guide that crosses a full page load carries on (the player's resumeKey) and keeps logging its
 * events. Frames come from Chromium's screencast, stamped on the same wall clock as the events.
 */

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import type { TimelineEvent } from './timeline';

export interface CaptureOptions {
  /** The trace object. */
  trace: unknown;
  url: string;
  mode: 'overlay' | 'perform';
  viewport: { w: number; h: number };
  /** Device pixel ratio. Default 1. */
  scale?: number;
  /** A signed-in session (Playwright storageState file). */
  storageState?: string;
  /** The player build (trace-perform.min.js). */
  playerFile: string;
  /** Selectors hidden before capture (e.g. your own dev toolbars). */
  hide?: string[];
  /** Selectors blurred before capture, as well as [data-trace-blur]. */
  blur?: string[];
  rate?: number;
  /** When a step is on another page, load that page (as an app's router would) instead of waiting for it. */
  navigate?: boolean;
  /** Perform mode: what the guide leaves to the viewer (trace-avatar's `security`). */
  security?: boolean | string[];
  /** Perform mode: values to type, by name or field label (trace-avatar's `values`). */
  values?: Record<string, string>;
  /** The player's own captions: 'none' when the renderer burns them in itself. Default: the player's. */
  captions?: 'bubble' | 'bar' | 'none';
  /** A guide's own pause (or a hand-off) is held this long, then it plays on. Default 1200. */
  pauseHoldMs?: number;
  /** Keep capturing this long after the end. Default 1500. */
  holdEndMs?: number;
  /** Still frames before the guide starts. Default 500. */
  leadMs?: number;
  /** Render a stalled guide anyway (it shows "Looking for …") instead of failing. */
  allowStall?: boolean;
  /** Called on a stall with the live page, before anything else happens; what it returns rides on the RenderError. */
  onStall?: (page: Page, stall: { index: number; reason: string }) => Promise<unknown>;
  /** Give up after this long. Default 120 000. */
  timeoutMs?: number;
  headless?: boolean;
}

export interface CapturedFrame { t: number; png: Buffer }

export interface Capture {
  frames: CapturedFrame[];
  /** The viewport in CSS px and the device pixel ratio (frames are viewport × scale). */
  viewport?: { w: number; h: number; scale: number };
  /** Each page's title, by path. */
  titles?: Record<string, string>;
  events: TimelineEvent[];
  /** When the guide started and when capture stopped (wall ms). */
  playAt: number;
  stopAt: number;
  endAt: number | null;
}

export class RenderError extends Error {
  /** A stall: which step, why, and what onStall found on the page. */
  stall?: { index: number; reason: string; data?: unknown };
  constructor(message: string, public readonly screenshot?: Buffer) { super(message); this.name = 'RenderError'; }
}

interface BootConfig { trace: unknown; mode: string; key: string; hide: string[]; blur: string[]; rate?: number; pauseHoldMs: number; captions?: string; navigate?: boolean; security?: boolean | string[]; values?: Record<string, string> }

/** Runs in the page (serialised): start the player and report its events. */
function bootstrap(cfg: BootConfig) {
  if (window.top !== window || location.protocol === 'about:') return;
  const w = window as unknown as Record<string, any>;
  const send = (e: Record<string, unknown>) => { try { w.__taEvent({ ...e, t: Date.now(), url: location.pathname, title: document.title }); } catch { /* binding gone */ } };
  let c: any = null;
  let started = false;
  w.__taPlay = () => { started = true; send({ type: 'play' }); c?.play(); };
  addEventListener('pagehide', () => send({ type: 'unload' }));
  const go = () => {
    const style = document.createElement('style');
    style.setAttribute('data-trace-render', '');
    style.textContent = (cfg.hide.length ? `${cfg.hide.join(',')}{visibility:hidden!important}\n` : '')
      + `${['[data-trace-blur]', ...cfg.blur].join(',')}{filter:blur(8px)!important}`;
    (document.head || document.documentElement).append(style);
    c = w.__taPlayer.createTrace({
      trace: cfg.trace, mode: cfg.mode, autoplay: false, controls: false, resumeKey: cfg.key, ...(cfg.rate ? { rate: cfg.rate } : {}), ...(cfg.captions ? { captions: cfg.captions } : {}),
      // A step on another page: go there, as an app's router would (the player carries on after the load).
      ...(cfg.navigate ? { navigate: (path: string) => { location.assign(path); } } : {}),
      ...(cfg.security !== undefined ? { security: cfg.security } : {}),
      ...(cfg.values ? { values: cfg.values } : {}),
    });
    w.__taRender = c;
    c.on('state', ({ phase }: { phase: string }) => {
      send({ type: 'state', phase });
      // A pause step (or a hand-off) is a beat in a video, then it plays on.
      if (phase === 'paused' && started) setTimeout(() => { if (c.state === 'paused') c.play(); }, cfg.pauseHoldMs);
    });
    c.on('step', (e: any) => {
      // Where the step happens (CSS px of the viewport), for the camera; its words, for captions.
      const r = (e.element as Element | null)?.getBoundingClientRect?.();
      send({
        type: 'step', index: e.index, stepType: e.step.type,
        ...(r && r.width + r.height > 0 ? { rect: { x: r.x, y: r.y, w: r.width, h: r.height } } : {}),
        ...(typeof e.step.say === 'string' && e.step.say.trim() ? { say: e.step.say } : {}),
      });
    });
    c.on('stalled', (e: any) => {
      // What showed while a wait waited ({ text, element }), kept in the page for a repair to look at.
      (window as any).__taSeen = e.seen ?? [];
      send({ type: 'stalled', index: e.index, reason: e.reason });
    });
    c.on('page', (e: any) => send({ type: 'page', index: e.index }));
    c.on('blocked', (e: any) => send({ type: 'blocked', message: e.say }));
    c.on('handoff', (e: any) => {
      send({ type: 'handoff', index: e.index });
      // A masked field: type its bullets, so the video never holds the real text.
      const el = e.element as HTMLInputElement | null;
      if (e.step.type === 'type' && el && 'value' in el) {
        el.focus();
        el.value = e.step.text ?? '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    c.on('end', () => send({ type: 'end' }));
    c.on('error', (e: any) => send({ type: 'error', message: e.message }));
    c.ready.then(() => {
      send({ type: 'ready', phase: c.state });
      if (c.state === 'paused') { started = true; c.play(); } // carried on after a page load
    }, (e: any) => send({ type: 'error', message: String(e?.message ?? e) }));
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', go, { once: true }); else go();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function capture(o: CaptureOptions): Promise<Capture> {
  const timeout = o.timeoutMs ?? 120_000;
  const cfg: BootConfig = {
    trace: o.trace, mode: o.mode, key: 'trace-avatar-render', hide: o.hide ?? [], blur: o.blur ?? [],
    ...(o.rate ? { rate: o.rate } : {}), pauseHoldMs: o.pauseHoldMs ?? 1200, ...(o.captions ? { captions: o.captions } : {}),
    ...(o.navigate ? { navigate: true } : {}),
    ...(o.security !== undefined ? { security: o.security } : {}),
    ...(o.values ? { values: o.values } : {}),
  };
  // Init scripts run wrapped in a function, so the player's top-level `var TraceAvatar` stays local: keep our
  // own reference (a page may also load another build under the same global name).
  const content = `${readFileSync(o.playerFile, 'utf8')}\n;window.__taPlayer = TraceAvatar;\n(${bootstrap.toString()})(${JSON.stringify(cfg)});`;
  const browser = await chromium.launch({ headless: o.headless !== false });
  try {
    const context = await browser.newContext({
      viewport: { width: o.viewport.w, height: o.viewport.h },
      deviceScaleFactor: o.scale ?? 1,
      ...(o.storageState ? { storageState: o.storageState } : {}),
    });
    const events: TimelineEvent[] = [];
    let wake: () => void = () => {};
    await context.exposeBinding('__taEvent', (_src, e: TimelineEvent) => { events.push(e); wake(); });
    await context.addInitScript({ content });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const frames: CapturedFrame[] = [];
    let capturing = false;
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      frames.push({ t: (f.metadata.timestamp ?? Date.now() / 1000) * 1000, png: Buffer.from(f.data, 'base64') });
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    const startCast = () => cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }).catch(() => {});
    // A new document can end the screencast: start it again on every load while capturing.
    page.on('load', () => { if (capturing) void startCast(); });
    // Leaving the page: the time until the next page's player plays counts as waiting (pagehide can't report it reliably).
    page.on('request', (r) => {
      if (capturing && r.isNavigationRequest() && r.frame() === page.mainFrame()) { events.push({ t: Date.now(), type: 'unload', url: new URL(r.url()).pathname }); wake(); }
    });

    const until = async <T>(test: () => T | undefined | null | false, what: string, ms = timeout): Promise<T> => {
      const deadline = Date.now() + ms;
      for (;;) {
        const v = test();
        if (v) return v;
        const left = deadline - Date.now();
        if (left <= 0) throw new RenderError(`timed out after ${ms} ms waiting for ${what}`, await page.screenshot().catch(() => undefined));
        await new Promise<void>((r) => { wake = r; setTimeout(r, Math.min(left, 250)); });
      }
    };
    const failure = () => events.find((e) => e.type === 'error' || e.type === 'blocked');

    const opened = Date.now();
    await page.goto(o.url, { waitUntil: 'load', timeout });
    const first = await until(() => events.find((e) => e.type === 'ready' && e.t >= opened) ?? failure(), 'the player');
    if (first.type !== 'ready') throw new RenderError(`the guide could not start: ${first.message ?? first.type}`);

    capturing = true;
    await startCast();
    await sleep(o.leadMs ?? 500);
    const playAt = Date.now();
    await page.evaluate(() => (window as unknown as { __taPlay(): void }).__taPlay());

    const done = await until(() => events.find((e) => e.type === 'end' || e.type === 'stalled') ?? failure(), 'the guide to end');
    if (done.type === 'error' || done.type === 'blocked') throw new RenderError(`the guide stopped: ${done.message ?? done.type}`, await page.screenshot().catch(() => undefined));
    if (done.type === 'stalled') {
      const why = `step ${(done.index ?? 0) + 1} stalled (${done.reason}) on ${done.url ?? 'the page'}`;
      const stall = { index: done.index ?? 0, reason: done.reason ?? 'not-found' };
      const data = o.onStall ? await o.onStall(page, stall) : undefined;
      if (!o.allowStall) {
        const err = new RenderError(`${why}: the app no longer matches the guide. Pass allowStall (--allow-stall) to render it anyway.`, await page.screenshot().catch(() => undefined));
        err.stall = { ...stall, ...(data !== undefined ? { data } : {}) };
        throw err;
      }
      await sleep(3000); // show "Looking for …" for a moment
    } else await sleep(o.holdEndMs ?? 1500);
    const stopAt = Date.now();
    capturing = false;
    await cdp.send('Page.stopScreencast').catch(() => {});
    if (!frames.length) throw new RenderError('no frames were captured');
    const titles: Record<string, string> = {};
    for (const e of events as Array<TimelineEvent & { title?: string }>) if (e.url && e.title && !titles[e.url]) titles[e.url] = e.title;
    for (const e of events as Array<TimelineEvent & { title?: string }>) delete e.title;
    return { frames, events, playAt, stopAt, endAt: done.type === 'end' ? done.t : null, viewport: { ...o.viewport, scale: o.scale ?? 1 }, titles };
  } finally {
    await browser.close();
  }
}

/** Where the player build is: an explicit file, TRACE_AVATAR_PLAYER, or the installed trace-avatar. */
export async function findPlayer(explicit?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (explicit) return explicit;
  if (env.TRACE_AVATAR_PLAYER) return env.TRACE_AVATAR_PLAYER;
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const req = createRequire(import.meta.url);
  return join(dirname(req.resolve('trace-avatar/package.json')), 'dist', 'trace-perform.min.js');
}
