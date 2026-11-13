/**
 * Director videos: a script plays a person using the app (Playwright), and the video is finished by finish(), so it
 * has the same frame, captions, cards, poster and narration as a guide's.
 *
 *   export default async function (d) {
 *     await d.card('Get paid the day you send it.');             // a card between scenes (spoken when narrated)
 *     await d.scene('Pick the customer, add two lines, send.', async () => {
 *       await d.click(d.page.getByRole('button', { name: 'New invoice' }));
 *       await d.type(d.page.getByLabel('Customer'), 'Ada Stores');
 *       await d.read(600);
 *     });
 *     await d.skip(async () => { … });                            // a long wait, cut to a jump
 *   }
 *
 * - The page is captured with Chrome's screencast, frames stamped with their own times.
 * - The cursor is drawn on the frames afterwards (an arrow, with a ring on a click): nothing is added to the app's
 *   page. Moves, clicks and typing are real mouse and keyboard events.
 * - A scene is one caption and, narrated, one spoken line (line n of the script is scene n; cards count as scenes).
 *   Narrated, the caption is the spoken line; a card's line is on screen, so it has no caption.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, CDPSession, Locator, Page } from 'playwright';
import { PNG } from 'pngjs';
import { trimSilence } from './audio';
import { brandFile } from './brand';
import type { Brand } from './brand';
import type { CardOptions } from './layers';
import { cardOf, finish } from './render';
import type { FinishOptions, OutFormat, OutSpec, RenderResult } from './render';
import type { Voice } from './voice';

export const DIRECTOR_VIEWPORT = { width: 1280, height: 800 };
const FPS = 30;
const RING_MS = 420;
/** How much of a skipped stretch a video keeps (ms). */
export const SKIP_KEEP_MS = 1600;
/** The arrow's size: 1.5× a system cursor, so it still reads when the video is shown at 800 px. */
const CURSOR_SIZE = 1.5;

/* ── The cursor, drawn on frames ── */

/** The arrow's outline (CSS px, tip at 0,0). */
const ARROW: Array<[number, number]> = [[0, 0], [0, 17], [4.2, 13.1], [7.1, 19.6], [9.8, 18.4], [7, 12.1], [12.6, 12.1]];

function inside(poly: Array<[number, number]>, x: number, y: number) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export interface Sprite { width: number; height: number; data: Uint8Array; ox: number; oy: number }
export interface Rgba { width: number; height: number; data: Uint8Array }
export interface Point { x: number; y: number }
export interface Move extends Point { t: number }

/** The arrow as an RGBA sprite (white with a dark edge), 4× supersampled; `ox, oy` is the tip. */
export function arrowSprite(scale = 1): Sprite {
  const pad = 2;
  const w = Math.ceil((13 + pad * 2) * scale);
  const h = Math.ceil((20 + pad * 2) * scale);
  const data = new Uint8Array(w * h * 4);
  const n = 4;
  const inner = ARROW.map(([x, y]) => [x * 0.8 + 1.3, y * 0.8 + 2.4] as [number, number]); // the white body inside a dark edge
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let edge = 0;
      let body = 0;
      for (let sy = 0; sy < n; sy += 1) {
        for (let sx = 0; sx < n; sx += 1) {
          const px = (x + (sx + 0.5) / n) / scale - pad;
          const py = (y + (sy + 0.5) / n) / scale - pad;
          if (inside(ARROW, px, py)) { edge += 1; if (inside(inner, px, py)) body += 1; }
        }
      }
      const k = (y * w + x) * 4;
      const a = edge / (n * n);
      const b = edge ? body / edge : 0;
      const v = Math.round(255 * b + 24 * (1 - b));
      data[k] = v; data[k + 1] = v; data[k + 2] = v; data[k + 3] = Math.round(a * 255);
    }
  }
  return { width: w, height: h, data, ox: Math.round(pad * scale), oy: Math.round(pad * scale) };
}

function blend(img: Rgba, x: number, y: number, r: number, g: number, b: number, a: number) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || a <= 0) return;
  const k = (y * img.width + x) * 4;
  img.data[k] = Math.round(img.data[k] * (1 - a) + r * a);
  img.data[k + 1] = Math.round(img.data[k + 1] * (1 - a) + g * a);
  img.data[k + 2] = Math.round(img.data[k + 2] * (1 - a) + b * a);
}

/** Draw the arrow with its tip at (x, y) and, while a click is fresh, a ring that grows and fades. */
export function drawCursor(img: Rgba, sprite: Sprite, x: number, y: number, ring: (Point & { p: number }) | null = null): void {
  if (ring) {
    const p = ring.p;
    const rad = 8 + 18 * p;
    const alpha = 0.55 * (1 - p);
    const x0 = Math.floor(ring.x - rad - 3);
    const y0 = Math.floor(ring.y - rad - 3);
    for (let py = y0; py <= ring.y + rad + 3; py += 1) {
      for (let px = x0; px <= ring.x + rad + 3; px += 1) {
        const d = Math.abs(Math.hypot(px - ring.x, py - ring.y) - rad);
        if (d < 2.5) blend(img, px, py, 37, 99, 235, alpha * Math.min(1, 2.5 - d));
      }
    }
  }
  const left = Math.round(x) - sprite.ox;
  const top = Math.round(y) - sprite.oy;
  for (let sy = 0; sy < sprite.height; sy += 1) {
    for (let sx = 0; sx < sprite.width; sx += 1) {
      const k = (sy * sprite.width + sx) * 4;
      const a = sprite.data[k + 3] / 255;
      if (a) blend(img, left + sx, top + sy, sprite.data[k], sprite.data[k + 1], sprite.data[k + 2], a);
    }
  }
}

/** Where the cursor is at time t, from the moves; before the first, at the first. */
export function cursorAt(moves: readonly Move[], t: number): Point | null {
  if (!moves.length) return null;
  if (t <= moves[0].t) return moves[0];
  for (let i = 1; i < moves.length; i += 1) {
    if (moves[i].t >= t) {
      const a = moves[i - 1];
      const b = moves[i];
      const f = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
  }
  return moves[moves.length - 1];
}

export interface Shot { t: number; png: Buffer }

/**
 * The frames finish() gets: each screencast frame, and one every 1/30 s while the cursor moves or a click ring shows,
 * all with the cursor drawn. A still page with a still cursor needs no more frames.
 */
export function withCursor(shots: readonly Shot[], moves: readonly Move[], clicks: readonly Move[], o: { scale?: number; sprite?: Sprite } = {}): Shot[] {
  if (!shots.length) return [];
  const sprite = o.sprite ?? arrowSprite((o.scale ?? 1) * CURSOR_SIZE);
  const times = new Set(shots.map((s) => s.t));
  const step = 1000 / FPS;
  for (let i = 1; i < moves.length; i += 1) {
    if (moves[i].x === moves[i - 1].x && moves[i].y === moves[i - 1].y) continue;
    for (let t = moves[i - 1].t; t < moves[i].t; t += step) times.add(Math.round(t));
    times.add(moves[i].t);
  }
  for (const c of clicks) for (let t = c.t; t <= c.t + RING_MS + step; t += step) times.add(Math.round(t));
  const end = shots[shots.length - 1].t;
  const last = Math.max(end, moves.at(-1)?.t ?? end, (clicks.at(-1)?.t ?? 0) + RING_MS);
  const sorted = [...times].filter((t) => t >= shots[0].t && t <= last).sort((a, b) => a - b);
  const out: Shot[] = [];
  let k = 0;
  let decoded = null as { k: number; width: number; height: number; data: Buffer } | null;
  const s = o.scale ?? 1;
  for (const t of sorted) {
    while (k + 1 < shots.length && shots[k + 1].t <= t) k += 1;
    if (!decoded || decoded.k !== k) {
      const p = PNG.sync.read(shots[k].png);
      decoded = { k, width: p.width, height: p.height, data: p.data };
    }
    const img = { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
    const at = cursorAt(moves, t);
    const c = [...clicks].reverse().find((x) => x.t <= t && t - x.t <= RING_MS);
    if (at) drawCursor(img, sprite, at.x * s, at.y * s, c ? { x: c.x * s, y: c.y * s, p: (t - c.t) / RING_MS } : null);
    const png = new PNG({ width: img.width, height: img.height });
    img.data.copy(png.data);
    out.push({ t, png: PNG.sync.write(png, { deflateLevel: 1 }) });
  }
  return out;
}

/* ── A person's pace ── */

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/** A human path from a to b: eased, with a slight arc, ~ 60 points a second. */
export function pathOf(a: Point, b: Point, ms: number): Point[] {
  const n = Math.max(2, Math.round(ms / 16));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const bend = Math.min(60, Math.hypot(dx, dy) * 0.12);
  const nx = -dy / (Math.hypot(dx, dy) || 1);
  const ny = dx / (Math.hypot(dx, dy) || 1);
  const pts: Point[] = [];
  for (let i = 1; i <= n; i += 1) {
    const f = i / n;
    const e = f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2;
    const arc = Math.sin(Math.PI * e) * bend;
    pts.push({ x: a.x + dx * e + nx * arc, y: a.y + dy * e + ny * arc });
  }
  return pts;
}

/** How long a person takes to reach something this far away (ms). */
export const travelMs = (d: number): number => Math.round(Math.min(1100, 380 + d * 0.9));

/**
 * A narration script's lines by scene number ({ lines: [{ n, text }] }, as --script). A line for a scene the video
 * doesn't have is refused, so a script can't drift from its director script unseen.
 */
export function sayFrom(script: { lines?: Array<{ n: number; text?: string }> } | null | undefined, count: number, id = 'video'): Map<number, string> {
  const out = new Map<number, string>();
  for (const l of script?.lines ?? []) {
    if (!(Number.isInteger(l.n) && l.n >= 1 && l.n <= count)) throw new Error(`${id}: the narration script has a line ${l.n}, but the video has ${count} scene(s)`);
    if (typeof l.text === 'string' && l.text.trim()) out.set(l.n, l.text.trim());
  }
  return out;
}

/* ── The look ── */

/** A video's own polish (renderer flags: --frame, --captions, --title-card …) and titles, over its look. */
export interface LookOf {
  title?: string;
  endTitle?: string;
  polish?: readonly string[];
}

/**
 * finish() options for a director video: the look (a brand file, or one already read) first, the video's flags over
 * it. A card the video asks for (--title-card / --end-card), else the brand's; the video's title wins over both, and
 * a brand's card object keeps its url, logo and colour. `appName` is the cards' small line.
 */
export function lookOptions(video: LookOf, brand?: string | Brand, appName = ''): FinishOptions {
  const p = video.polish ?? [];
  const at = (flag: string) => p.indexOf(flag);
  const b: Brand = typeof brand === 'string' ? brandFile(brand) : brand ?? {};
  const { titleCard: bTitle, endCard: bEnd, ...look } = b as Brand & { titleCard?: unknown; endCard?: unknown };
  const o: FinishOptions & Record<string, unknown> = { ...(look as FinishOptions) };
  if (at('--canvas') >= 0) o.canvas = p[at('--canvas') + 1];
  if (at('--watermark') >= 0) o.watermark = p[at('--watermark') + 1];
  if (at('--frame') >= 0) o.frame = p[at('--frame') + 1] as FinishOptions['frame'];
  if (at('--captions') >= 0) o.captions = p[at('--captions') + 1] as FinishOptions['captions'];
  if (at('--captions-at') >= 0) o.captionsAt = p[at('--captions-at') + 1] as FinishOptions['captionsAt'];
  if (at('--background') >= 0) o.background = p[at('--background') + 1];
  if (p.includes('--camera')) o.camera = true;
  if (p.includes('--poster')) o.poster = true;
  const sub = { sub: appName };
  const wantTitle = p.includes('--title-card') || bTitle !== undefined;
  const wantEnd = p.includes('--end-card') || bEnd !== undefined;
  const cardFrom = (brandCard: unknown, own: string | undefined, fallback: string) => {
    const base = brandCard && typeof brandCard === 'object' ? (brandCard as CardOptions) : typeof brandCard === 'string' ? { title: brandCard } : true;
    const v = own !== undefined ? (base === true ? own : { ...base, title: own }) : base;
    return cardOf(v, { title: own ?? fallback, ...sub });
  };
  const title = wantTitle ? cardFrom(bTitle, video.title, 'How to') : undefined;
  const end = wantEnd ? cardFrom(bEnd, video.endTitle, 'Done') : undefined;
  if (title || end) o.cards = { ...(title ? { title } : {}), ...(end ? { end } : {}) };
  return o;
}

export interface DirectorCard { t: number; ms: number; title: string; url?: boolean; step: number }

/**
 * A director's cards for finish(): each in the look of the video's end card (its logo and colour, else the title
 * card's), with its own title; the product's address only on those that ask for it.
 */
export function cardsOf(cards: readonly DirectorCard[], finishCards: FinishOptions['cards'] = {}, appName = '') {
  const { title: _t, url, ...look } = (finishCards?.end ?? finishCards?.title ?? { sub: appName }) as CardOptions & { url?: string };
  return cards.map((c) => ({ t: c.t, ms: c.ms, step: c.step, card: { ...look, title: c.title, ...(c.url && url ? { url } : {}) } }));
}

/* ── The run ── */

/** The app served under its public name: https://<host> answered by the local server (nothing leaves the machine). */
export interface Alias {
  /** The public host, e.g. acme.com. */
  host: string;
  /** The app's local API, served as https://api.<host>. */
  api?: string;
  /** App paths whose text has the local API's address replaced by the public one (a runtime config, /config.js). */
  rewrite?: string[];
}

/** What a session is: a storageState file, or a function of the app's address and the window's options. */
export type Session = string | ((url: string, o: Record<string, unknown>) => unknown | Promise<unknown>);

export interface Director {
  [prop: string]: unknown;
  page: Page;
  /** Playwright's expect (needs @playwright/test installed). */
  expect: (...a: unknown[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The app's address as the video shows it. */
  url: string;
  /** Where the app really runs. */
  local: string;
  open(path: string): Promise<void>;
  window(path: string, o?: Record<string, unknown>): Promise<void>;
  read(ms?: number): Promise<void>;
  hover(locator: Locator, o?: { ms?: number; rest?: number; timeout?: number }): Promise<void>;
  click(locator: Locator, o?: { ms?: number; aim?: number; rest?: number; timeout?: number }): Promise<void>;
  type(locator: Locator, text: string, o?: { delay?: number; rest?: number; clear?: boolean; ms?: number; timeout?: number }): Promise<void>;
  press(key: string, o?: { rest?: number }): Promise<void>;
  skip(fn: () => Promise<void>): Promise<void>;
  card(title: string, o?: { ms?: number; say?: string; url?: boolean }): Promise<void>;
  scene(caption: string, fn: () => Promise<void>, o?: { hold?: number; say?: string }): Promise<void>;
}

export interface Scene { index: number; caption: string; say: string; from: number; to: number; card?: boolean }

export interface DirectOptions {
  /** The script: a module path (its default export) or the function itself. */
  script: string | ((d: Director) => Promise<void>);
  /** Where the app runs, e.g. http://127.0.0.1:3000. */
  url: string;
  /** The first page (default /). */
  page?: string;
  /** The files to write. */
  out: Array<OutSpec & { format: OutFormat }>;
  /** finish() options (the look: lookOptions()). */
  look?: FinishOptions;
  /** The cards' small line (the app's name). */
  appName?: string;
  /** Page size (default 1280×800). Captured at 2× unless it's the desktop size. */
  viewport?: { width: number; height: number };
  scale?: number;
  /** Signed in with this session (default: not signed in). */
  session?: Session;
  /** Options for a session function, for the first window (a window of its own can pass others). */
  sessionOptions?: Record<string, unknown>;
  /** Open the first window signed out (default false). */
  signedOut?: boolean;
  alias?: Alias | string;
  /** Folders served at a path of the app's own address (props the app doesn't have): { '/__terminal': 'dir' }. */
  routes?: Record<string, string>;
  /** Narrate with this voice. */
  voice?: Voice;
  /** The spoken lines by scene (instead of each caption): a script or its path. */
  voiceScript?: string | { lines: Array<{ n: number; text: string }> };
  /** Write <scenes>: each scene's caption, spoken line and length (JSON). */
  scenesFile?: string;
  headless?: boolean;
  launchArgs?: string[];
  /** Kept after the script ends (ms, default 800). */
  tailMs?: number;
  /** More on `d` for the script's own use (e.g. { app: { dir } }). */
  props?: Record<string, unknown>;
  /** An id for messages. */
  id?: string;
  log?: (m: string) => void;
}

export interface DirectResult extends RenderResult { narrated: boolean; scenes: Scene[] }

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** The alias as its addresses: the public url, the local server, and the API's both. */
export function aliasOf(url: string, alias?: Alias | string): { url: string; local: string | null; api?: string; localApi?: string; rewrite: string[] } {
  const a = typeof alias === 'string' ? { host: alias } : alias;
  if (!a?.host) return { url, local: null, rewrite: [] };
  return { url: `https://${a.host}`, local: url.replace(/\/$/, ''), ...(a.api ? { api: `https://api.${a.host}`, localApi: a.api.replace(/\/$/, '') } : {}), rewrite: a.rewrite ?? [] };
}

async function routeAlias(context: BrowserContext, alias: ReturnType<typeof aliasOf>) {
  if (!alias.local) return;
  const forward = (to: string) => async (route: import('playwright').Route) => {
    const u = new URL(route.request().url());
    const response = await route.fetch({ url: `${to}${u.pathname}${u.search}` });
    if (to === alias.local && alias.localApi && alias.rewrite.includes(u.pathname)) {
      const body = (await response.text()).split(alias.localApi).join(alias.api!);
      await route.fulfill({ response, body });
      return;
    }
    await route.fulfill({ response });
  };
  await context.route(`${alias.url}/**`, forward(alias.local));
  if (alias.localApi) await context.route(`${alias.api}/**`, forward(alias.localApi));
}

async function routeFolders(context: BrowserContext, base: string, routes: Record<string, string>) {
  for (const [prefix, dir] of Object.entries(routes)) {
    const root = resolve(dir);
    const at = `/${prefix.replace(/^\/+|\/+$/g, '')}/`;
    await context.route(`${base}${at}**`, async (route) => {
      const rel = decodeURIComponent(new URL(route.request().url()).pathname.slice(at.length));
      const file = resolve(root, rel);
      if (!file.startsWith(`${root}/`) || !existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file), headers: { 'cache-control': 'no-store' } });
    });
  }
}

const pathOfUrl = (u: string) => { try { return new URL(u).pathname; } catch { return '/'; } };

/** Playwright's expect, when @playwright/test is installed. */
async function expectFn(): Promise<Director['expect']> {
  try {
    const m = await import('@playwright/test' as string);
    return m.expect;
  } catch {
    return () => { throw new Error('d.expect needs @playwright/test: npm install -D @playwright/test'); };
  }
}

/** Make one director video. A script that throws (a failed check) makes nothing. */
export async function direct(o: DirectOptions): Promise<DirectResult> {
  const id = o.id ?? 'video';
  const log = o.log ?? (() => {});
  const VP = o.viewport ?? DIRECTOR_VIEWPORT;
  const DSF = o.scale ?? (VP.width === DIRECTOR_VIEWPORT.width && VP.height === DIRECTOR_VIEWPORT.height ? 1 : 2);
  const alias = aliasOf(o.url, o.alias);
  const url = alias.url;
  const script = typeof o.script === 'function' ? o.script : (await import(pathToFileURL(resolve(o.script)).href)).default as (d: Director) => Promise<void>;
  if (typeof script !== 'function') throw new Error(`${id}: ${o.script} has no default export (the script)`);
  const expect = await expectFn();
  const stateOf = async (opts: Record<string, unknown>) => {
    if (!o.session) return undefined;
    if (typeof o.session === 'string') return o.session;
    return o.session(url, opts) as never;
  };

  const browser: Browser = await chromium.launch({ headless: o.headless ?? true, ...(o.launchArgs ? { args: o.launchArgs } : {}) });
  const shots: Shot[] = [];
  const moves: Move[] = [];
  const clicks: Move[] = [];
  const events: Array<Record<string, unknown> & { t: number; type: string }> = [];
  const titles: Record<string, string> = {};
  const scenes: Scene[] = [];
  const cards: DirectorCard[] = [];
  let playAt = 0;
  let skipped = false;
  try {
    const windowOf = async (opts: Record<string, unknown>) => {
      const signedIn = opts.signedIn !== false;
      const state = signedIn ? await stateOf(opts) : undefined;
      const context = await browser.newContext({
        viewport: VP, deviceScaleFactor: DSF, permissions: ['clipboard-read', 'clipboard-write'],
        ...(state ? { storageState: state as never } : {}),
      });
      await routeAlias(context, alias);
      if (o.routes) await routeFolders(context, url, o.routes);
      const page = await context.newPage();
      const cdp: CDPSession = await context.newCDPSession(page);
      cdp.on('Page.screencastFrame', (f) => {
        shots.push({ t: f.metadata?.timestamp ? Math.round(f.metadata.timestamp * 1000) : Date.now(), png: Buffer.from(f.data, 'base64') });
        cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      });
      page.on('framenavigated', (fr) => {
        if (fr !== page.mainFrame()) return;
        const p = pathOfUrl(page.url());
        events.push({ t: Date.now(), type: 'page', url: p });
        page.title().then((t) => { titles[p] = t; }).catch(() => {});
      });
      return { context, page, cdp };
    };
    let { context, page, cdp } = await windowOf({ ...(o.sessionOptions ?? {}), ...(o.signedOut ? { signedIn: false } : {}) });
    const path = () => pathOfUrl(page.url());
    const screencast = () => cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: VP.width * DSF, maxHeight: VP.height * DSF });

    let at: Point = { x: VP.width * 0.62, y: VP.height * 0.55 };
    const moveTo = async (to: Point, ms?: number) => {
      for (const p of pathOf(at, to, ms ?? travelMs(Math.hypot(to.x - at.x, to.y - at.y)))) {
        await page.mouse.move(p.x, p.y);
        moves.push({ t: Date.now(), x: p.x, y: p.y });
        await sleep(16);
      }
      at = to;
    };
    const pointOf = async (locator: Locator, opts: { timeout?: number } = {}) => {
      await locator.waitFor({ state: 'visible', timeout: opts.timeout ?? 15_000 });
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (!box) throw new Error(`director: ${locator} has no box`);
      // A person aims a little left of centre on wide things, at the middle of small ones.
      const fx = box.width > 160 ? 0.35 : 0.5;
      return { x: box.x + box.width * fx, y: box.y + box.height * 0.5 };
    };

    const d: Director = {
      ...(o.props ?? {}),
      page, expect, url, local: alias.local ?? url,
      async window(p, opts = {}) {
        await cdp.send('Page.stopScreencast').catch(() => {});
        await context.close();
        // A window's options over the video's (the session it was signed in with).
        ({ context, page, cdp } = await windowOf({ ...(o.sessionOptions ?? {}), ...opts }));
        d.page = page;
        await screencast();
        await page.goto(`${url}${p}`, { waitUntil: 'networkidle' });
        await sleep(400);
      },
      async open(p) {
        await page.goto(`${url}${p}`, { waitUntil: 'networkidle' });
        await sleep(300);
      },
      read: (ms = 900) => sleep(ms),
      async hover(locator, opts = {}) {
        const p = await pointOf(locator, opts);
        await moveTo(p, opts.ms);
        await sleep(opts.rest ?? 250);
      },
      async click(locator, opts = {}) {
        const p = await pointOf(locator, opts);
        await moveTo(p, opts.ms);
        await sleep(opts.aim ?? 180);
        await page.mouse.down();
        clicks.push({ t: Date.now(), x: p.x, y: p.y });
        await sleep(70);
        await page.mouse.up();
        await sleep(opts.rest ?? 350);
      },
      async type(locator, text, opts = {}) {
        await d.click(locator, { rest: 150, ...opts });
        if (opts.clear) { await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace'); }
        await page.keyboard.type(text, { delay: opts.delay ?? 55 });
        await sleep(opts.rest ?? 350);
      },
      async press(key, opts = {}) { await page.keyboard.press(key); await sleep(opts.rest ?? 350); },
      async skip(fn) {
        events.push({ t: Date.now(), type: 'state', phase: 'waiting' });
        await fn();
        events.push({ t: Date.now(), type: 'state', phase: 'playing' });
        skipped = true;
      },
      async card(title, opts = {}) {
        await sleep(5);
        const t = Date.now();
        const index = scenes.length;
        const ms = opts.ms ?? 2200;
        scenes.push({ index, caption: title, say: opts.say ?? title, from: t, to: t + ms, card: true });
        cards.push({ t, ms, title, url: !!opts.url, step: index });
        // Its step just after its moment: its line is spoken over the card.
        events.push({ t: t + 1, type: 'step', index, stepType: 'card', say: title, url: path() });
        await sleep(5);
      },
      async scene(caption, fn, opts = {}) {
        const from = Date.now();
        await fn();
        await sleep(opts.hold ?? 500);
        const index = scenes.length;
        scenes.push({ index, caption, say: opts.say ?? caption, from, to: Date.now() });
        events.push({ t: Date.now(), type: 'step', index, stepType: 'scene', say: caption, url: path() });
      },
    };

    await screencast();
    await page.goto(`${url}${o.page ?? '/'}`, { waitUntil: 'networkidle' });
    await sleep(600);
    moves.push({ t: Date.now(), ...at });
    playAt = Date.now();
    events.push({ t: playAt, type: 'play', url: path() });
    log(`${id}: playing …`);
    await script(d);
    await sleep(o.tailMs ?? 800);
    moves.push({ t: Date.now(), ...at });
    await cdp.send('Page.stopScreencast').catch(() => {});
    await sleep(100);
    // A page that never changed sends one frame: give the end a frame of its own.
    if (shots.length) shots.push({ t: Date.now(), png: shots[shots.length - 1].png });
    await context.close();
  } finally {
    await browser.close();
  }
  if (!shots.length) throw new Error('director: the screencast sent no frames');
  const stopAt = Date.now();
  events.push({ t: stopAt, type: 'end' });
  shots.sort((a, b) => a.t - b.t);

  log(`${id}: ${scenes.length} scenes, ${shots.length} screencast frames; drawing the cursor …`);
  const frames = withCursor(shots.filter((s) => s.t >= playAt - 400), moves, clicks, { scale: DSF });
  const cap = { frames, viewport: { w: VP.width, h: VP.height, scale: DSF }, titles, events, playAt, stopAt, endAt: stopAt } as unknown as Parameters<typeof finish>[0] & { cards?: unknown };

  const f: FinishOptions = { ...(o.look ?? {}), cuts: { maxWaitMs: skipped ? SKIP_KEEP_MS : 0 } };
  if (cards.length) cap.cards = cardsOf(cards, f.cards, o.appName);
  let narrated = false;
  if (o.voice) {
    const lines = new Map<number, { text: string; audio: ReturnType<typeof trimSilence> }>();
    if (o.voiceScript) {
      const s = sayFrom(typeof o.voiceScript === 'string' ? JSON.parse(readFileSync(o.voiceScript, 'utf8')) : o.voiceScript, scenes.length, id);
      for (const sc of scenes) sc.say = s.get(sc.index + 1) ?? sc.say;
    }
    // The captions say what is spoken. A card's line is on screen, so it keeps no caption.
    for (const sc of scenes) {
      if (sc.card || !sc.say || sc.say === sc.caption) continue;
      sc.caption = sc.say;
      for (const e of events) if (e.type === 'step' && e.index === sc.index) e.say = sc.say;
    }
    for (const sc of scenes) {
      if (!sc.say) continue;
      const audio = trimSilence(await o.voice(sc.say));
      if (audio.pcm.length) lines.set(sc.index, { text: sc.say, audio });
    }
    f.narration = { lines };
    narrated = lines.size > 0;
  }
  for (const x of o.out) mkdirSync(dirname(x.file), { recursive: true });
  // The poster sits beside the first output, as the VTT does.
  if (f.poster === true) f.poster = o.out[0].file.replace(/\.[^./]+$/, '.png');
  const r = await finish(cap, o.out, f);
  if (o.scenesFile) writeFileSync(o.scenesFile, `${JSON.stringify(scenes.map(({ index, caption, say, from, to }) => ({ n: index + 1, caption, say, ms: to - from })), null, 2)}\n`);
  return { ...r, narrated, scenes };
}
