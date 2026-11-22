/**
 * A product's marketing videos from one file (campaign.json): made on the real app, in each shape and look, with
 * progress you can read while it runs and a run that carries on where it stopped.
 *
 *   trace-avatar-render campaign check  [campaign.json]
 *   trace-avatar-render campaign make   [campaign.json] [video ids…] [--start] [--fresh] [--voice <voice>]
 *   trace-avatar-render campaign status [campaign.json]
 *
 * Each video is made once per look it lists. The desktop shapes (16:9, 1:1, 4:5) come from one capture, each written
 * on its own canvas; 9:16 is captured again at a phone's size (a desktop page in a tall canvas is too small to read),
 * with its captions as a file like the rest (off until the viewer turns them on). A look whose brand fills 16:9
 * (`"fill": ["16:9"]`) captures the desktop at 1280×720, so the wide file is the app edge to edge and the other
 * shapes keep the window; one that fills 9:16 captures the phone at 414×736 (exactly 9:16), edge to edge too. A video is a guide (played by the player) or
 * a director script (a person using the app, src/director.ts).
 *
 * Paths in the file are relative to it; the app's own files (guides, storageState, session) to the app's `dir`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, reportOf } from './cli';
import { RenderError } from './capture';
import { CATALOGUE_KINDS, CATALOGUE_SHAPES } from './catalogue';
import { brandFile } from './brand';
import { direct, lookOptions } from './director';
import type { Alias } from './director';
import { FFMPEG_MISSING, findFfmpeg } from './mp4';
import { render } from './render';
import type { OutFormat } from './render';
import { voiceOf } from './voice';
import { checkVideo, cuesOf } from './check';
import type { CheckResult } from './check';
import type { BlurSpec } from './blur';
import type { RefuseSpec } from './refuse';
import type { Ai } from 'trace-avatar/assist';
import type { Voice } from './voice';

export const CAMPAIGN_KINDS = CATALOGUE_KINDS;
export const CAMPAIGN_SHAPES = CATALOGUE_SHAPES;
const DESKTOP = ['16:9', '1:1', '4:5'];
const PHONE = '390x844';
/** The phone capture when 9:16 fills the picture: a phone at exactly 9:16 (414×736), so it fills it edge to edge. */
const TALL = { width: 414, height: 736 };
/** The desktop capture when 16:9 fills the picture (the look's "fill"): the same shape, so nothing is cropped or padded. */
const WIDE = { width: 1280, height: 720 };

export interface CampaignApp {
  /** Its name, on the cards. */
  name?: string;
  /** Where it serves while videos are made, e.g. http://127.0.0.1:3000. */
  url: string;
  /** Its checkout (for start, guides, storageState, session). Default: the campaign's folder. */
  dir?: string;
  /** How to start it (with --start), run in `dir`. */
  start?: string[];
  /** A path that answers once it's ready (default /). */
  ready?: string;
  /** Or: a line its start prints once it's ready. */
  readyText?: string;
  /** Its guides: { guides: [{ id, trace, pages? }] }. A video's `guide` can be a .trace.json path instead. */
  guides?: string;
  /** A signed-in session (Playwright storageState): guides play with it. */
  storageState?: string;
  /** A module whose `storageStateFor(url, options)` gives one: director windows use it (a video's `session` is the
   *  first window's options; `d.window(path, options)` passes others), and guides when there is no storageState. */
  session?: string;
  /** Put the app back to a known state before each video: POST this (body: the video's `reset`), or run this. */
  reset?: { post: string; body?: Record<string, unknown> } | { run: string[] };
  /** Show it under its public name (https://<host>, answered locally). */
  alias?: string | Alias;
  /** Folders served at a path of the app's own address, for director videos: { "/__props": "props" }. */
  routes?: Record<string, string>;
  /** Addresses answered by others while filming (director videos): { "https://api.x.com": "https://demo-api.x.com" }. */
  reroute?: Record<string, string>;
}

export interface CampaignLook {
  /** A brand file (--brand): frame, background, cards, watermark … */
  brand: string;
  /** What its last card says, for the catalogue. Default: the brand's end card (title and url), else its watermark. */
  endsWith?: string;
}

export interface CampaignVideo {
  id: string;
  /** Personal data blurred while filming: exact texts and/or contact details by pattern (STUDIO_V3 §3). */
  blur?: BlurSpec;
  /** Actions switched off for filming, refused in the page (STUDIO_V3 §5): { pay: true }. */
  refuse?: RefuseSpec;
  kind: (typeof CAMPAIGN_KINDS)[number];
  /** A guide id (from app.guides) or a .trace.json path … */
  guide?: string;
  /** … or a director script (.mjs). */
  director?: string;
  /**
   * A guide written on a phone-sized screen, for the phone shape (9:16): a phone layout often hides what the wide
   * one shows (a collapsed menu), so its steps differ. Its own narration per look, numbered by its own steps.
   */
  phone?: { guide: string; voice?: Record<string, string> };
  /** Guides: overlay (Show me) or perform (Do it for me: clicks and types for real). */
  mode?: 'overlay' | 'perform';
  /** Perform: values to type, by field name or label. */
  values?: Record<string, string>;
  /** The page it starts on (default: the guide's first page, else /). */
  page?: string;
  title?: string;
  endTitle?: string;
  /** The looks it's made in (default the first in `looks`). */
  looks?: string[];
  /** Its shapes; none for a docs-gif. */
  shapes?: string[];
  /** Narrated: a script per look ({ lines: [{ n, text }] }). */
  voice?: Record<string, string>;
  /** More renderer flags (--title-card, --camera, --captions-at top …). */
  polish?: string[];
  /** What it shows, plainly. */
  alt: string;
  /** The body of the app's reset for this video. */
  reset?: Record<string, unknown>;
  /** The session function's options for this video. */
  session?: Record<string, unknown>;
  /** Start signed out. */
  signedIn?: boolean;
  /** A docs-gif's width (default 800). */
  width?: number;
  /** Director: a real window (some captures can't run headless). */
  headed?: boolean;
  launchArgs?: string[];
  tailMs?: number;
}

export interface Campaign {
  product: string;
  site: string;
  language?: string;
  /** The voice for narrated videos (voiceOf: gateway, openai:…, say:…, a .js); --voice wins. */
  narrator?: string;
  /** Where files go (default out/<product> beside the file). */
  out?: string;
  app: CampaignApp;
  looks: Record<string, CampaignLook>;
  videos: CampaignVideo[];
  [more: string]: unknown;
}

/** A campaign as loaded: its paths absolute, its file and folder known. */
export interface LoadedCampaign extends Campaign { file: string; base: string; out: string }

/** One render: a video in one look, desktop or phone. */
export interface CampaignRender {
  id: string;
  video: CampaignVideo;
  look: string;
  phone: boolean;
  shapes: string[];
  format: OutFormat;
  polish: string[];
}

const abs = (base: string, p: string | undefined) => (p === undefined ? undefined : resolve(base, p));

/** Read a campaign file, its paths made absolute. Problems are found by checkCampaign. */
export function loadCampaign(file = 'campaign.json'): LoadedCampaign {
  const f = resolve(file);
  if (!existsSync(f)) throw new Error(`no campaign file ${file}`);
  let c: Campaign;
  try { c = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw new Error(`${file}: ${(e as Error).message}`); }
  const base = dirname(f);
  const app = { ...(c.app ?? {}) } as CampaignApp;
  // Where the app is checked out differs between machines: TRACE_AVATAR_APP_DIR wins.
  app.dir = process.env.TRACE_AVATAR_APP_DIR ? resolve(process.env.TRACE_AVATAR_APP_DIR) : resolve(base, app.dir ?? '.');
  for (const k of ['guides', 'storageState', 'session'] as const) app[k] = abs(app.dir, app[k]);
  if (app.routes) app.routes = Object.fromEntries(Object.entries(app.routes).map(([k, v]) => [k, resolve(base, v)]));
  const looks = Object.fromEntries(Object.entries(c.looks ?? {}).map(([k, l]) => [k, { ...l, brand: resolve(base, l?.brand ?? '') }]));
  const videos = (c.videos ?? []).map((v) => ({
    ...v,
    ...(v.director ? { director: resolve(base, v.director) } : {}),
    ...(v.guide && /\.json$/i.test(v.guide) ? { guide: resolve(base, v.guide) } : {}),
    ...(v.voice ? { voice: Object.fromEntries(Object.entries(v.voice).map(([k, s]) => [k, resolve(base, s)])) } : {}),
    ...(v.phone ? { phone: {
      guide: /\.json$/i.test(v.phone.guide) ? resolve(base, v.phone.guide) : v.phone.guide,
      ...(v.phone.voice ? { voice: Object.fromEntries(Object.entries(v.phone.voice).map(([k, s]) => [k, resolve(base, s)])) } : {}),
    } } : {}),
  }));
  return { ...c, app, looks, videos, file: f, base, out: resolve(base, c.out ?? join('out', c.product ?? 'product')) };
}

type GuideSet = { guides: Array<{ id: string; trace: { steps?: unknown[] }; pages?: string[] }> };
const guidesOf = (c: LoadedCampaign): GuideSet | null => (c.app.guides && existsSync(c.app.guides) ? JSON.parse(readFileSync(c.app.guides, 'utf8')) : null);

/** A guide video's trace and the page it starts on. */
function guideOf(c: LoadedCampaign, v: CampaignVideo, set = guidesOf(c)) {
  if (/\.json$/i.test(v.guide!)) {
    if (!existsSync(v.guide!)) return null;
    const trace = JSON.parse(readFileSync(v.guide!, 'utf8'));
    return { trace, page: v.page ?? '/' };
  }
  const g = set?.guides.find((x) => x.id === v.guide);
  if (!g) return null;
  return { trace: g.trace, page: v.page ?? (g.pages ?? []).find((p) => !p.includes('*')) ?? '/' };
}

/** Every problem in a campaign, at once. `files: false` skips what needs the app's checkout (guides, sessions). */
export function checkCampaign(c: LoadedCampaign, o: { files?: boolean } = {}): string[] {
  const files = o.files ?? true;
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(c.product ?? '')) problems.push('product is a word of a-z, 0-9 and -, e.g. acme');
  if (!/^https:\/\/[^\s/]+/.test(c.site ?? '')) problems.push('site is the product\'s https address, e.g. https://acme.com');
  if (c.language !== undefined && !/^[a-z]{2}$/.test(c.language)) problems.push('language is two letters, e.g. en');
  if (!/^https?:\/\//.test(c.app?.url ?? '')) problems.push('app.url is where the app serves, e.g. http://127.0.0.1:3000');
  if (c.app.reset && !('post' in c.app.reset && /^https?:\/\//.test(c.app.reset.post)) && !('run' in c.app.reset && Array.isArray(c.app.reset.run) && c.app.reset.run.length)) problems.push('app.reset is { "post": url } or { "run": [command…] }');
  if (c.app.start && !(Array.isArray(c.app.start) && c.app.start.length)) problems.push('app.start is a command, e.g. ["npm", "run", "demo"]');
  if (files) {
    if (c.app.guides && !existsSync(c.app.guides)) problems.push(`no guides file ${c.app.guides}`);
    if (c.app.storageState && !existsSync(c.app.storageState)) problems.push(`no storageState ${c.app.storageState}`);
    if (c.app.session && !existsSync(c.app.session)) problems.push(`no session module ${c.app.session}`);
  }
  for (const [d, dir] of Object.entries(c.app.routes ?? {})) if (!existsSync(dir)) problems.push(`app.routes ${d}: no folder ${dir}`);
  const lookNames = Object.keys(c.looks ?? {});
  if (!lookNames.length) problems.push('no looks: { "product": { "brand": "brands/acme.json" } }');
  for (const [k, l] of Object.entries(c.looks ?? {})) {
    if (!/^[a-z0-9-]+$/.test(k)) problems.push(`look ${k}: a name of a-z, 0-9 and -`);
    if (!existsSync(l.brand)) problems.push(`look ${k}: no brand file ${l.brand}`);
  }
  const set = files ? guidesOf(c) : null;
  const ids = new Set<string>();
  for (const v of c.videos ?? []) {
    const at = `${v.id}:`;
    if (!/^[a-z0-9-]+$/.test(v.id ?? '')) problems.push(`bad video id ${v.id} (a-z, 0-9 and -)`);
    if (ids.has(v.id)) problems.push(`${at} id used twice`);
    ids.add(v.id);
    if (!CAMPAIGN_KINDS.includes(v.kind)) problems.push(`${at} kind is one of ${CAMPAIGN_KINDS.join(', ')}`);
    if (!v.guide === !v.director) problems.push(`${at} a guide or a director script (one of them)`);
    if (v.director && !existsSync(v.director)) problems.push(`${at} no director script ${v.director}`);
    if (v.phone && (!v.guide || typeof v.phone.guide !== 'string')) problems.push(`${at} phone is { guide, voice? } on a guide video`);
    for (const w of v.guide && files ? [v, ...(v.phone?.guide ? [{ ...v, guide: v.phone.guide, voice: v.phone.voice ?? {} }] : [])] : []) {
      const g = guideOf(c, w, set);
      if (!g) problems.push(`${at} no guide ${w.guide}${/\.json$/i.test(w.guide!) ? '' : c.app.guides ? ` in ${c.app.guides}` : ' (no app.guides)'}`);
      else for (const [look, s] of Object.entries(w.voice ?? {})) {
        if (!existsSync(s)) continue;
        const steps = g.trace.steps?.length ?? 0;
        const over = (JSON.parse(readFileSync(s, 'utf8')).lines ?? []).filter((l: { n: number }) => !(l.n >= 1 && l.n <= steps));
        if (over.length) problems.push(`${at} the ${look} script has line ${over.map((l: { n: number }) => l.n).join(', ')}, but the guide has ${steps} step(s)`);
      }
    }
    if (v.mode !== undefined && v.mode !== 'overlay' && v.mode !== 'perform') problems.push(`${at} mode is overlay or perform`);
    if (v.director && v.mode) problems.push(`${at} a director video has no mode`);
    if (!v.alt?.trim()) problems.push(`${at} no alt text (what it shows)`);
    if (v.blur !== undefined && (typeof v.blur !== 'object' || v.blur === null
      || (v.blur.texts !== undefined && (!Array.isArray(v.blur.texts) || v.blur.texts.some((t) => typeof t !== 'string')))
      || (v.blur.patterns !== undefined && typeof v.blur.patterns !== 'boolean' && !(Array.isArray(v.blur.patterns) && v.blur.patterns.every((k) => ['email', 'phone', 'account'].includes(k))))
      || (v.blur.strength !== undefined && !(typeof v.blur.strength === 'number' && v.blur.strength >= 2 && v.blur.strength <= 24)))) {
      problems.push(`${at} blur is { texts?: [text…], patterns?: true | ["email", "phone", "account"], strength?: 2–24 }`);
    }
    const looks = v.looks ?? lookNames.slice(0, 1);
    if (!looks.length || looks.some((l) => !lookNames.includes(l))) problems.push(`${at} looks are some of ${lookNames.join(', ') || '(none defined)'}`);
    if (v.kind === 'docs-gif') { if (v.shapes) problems.push(`${at} a docs-gif has no shapes`); if (v.voice) problems.push(`${at} a GIF has no sound`); }
    else if (!v.shapes?.length || v.shapes.some((s) => !CAMPAIGN_SHAPES.includes(s as never))) problems.push(`${at} shapes are some of ${CAMPAIGN_SHAPES.join(', ')}`);
    for (const l of looks) {
      const s = v.voice?.[l];
      if (v.voice && !s) problems.push(`${at} a narrated video needs a script for each look (voice.${l})`);
      if (s && !existsSync(s)) problems.push(`${at} no script ${s}`);
    }
    if (v.polish && !Array.isArray(v.polish)) problems.push(`${at} polish is a list of renderer flags`);
  }
  if (!ids.size) problems.push('no videos');
  return problems;
}

/** A campaign, loaded and checked: every problem named at once. */
export function readCampaign(file?: string, o: { files?: boolean } = {}): LoadedCampaign {
  const c = loadCampaign(file);
  const problems = checkCampaign(c, o);
  if (problems.length) throw new Error(`campaign ${c.product ?? c.file}: ${problems.join('; ')}`);
  return c;
}

/**
 * The renders a campaign makes: per video and look, one for the desktop shapes (one capture, a file each) and one for
 * 9:16 (a phone-sized capture). Their ids are <video>--<look>[--phone].
 */
export function rendersOf(c: Campaign): CampaignRender[] {
  const out: CampaignRender[] = [];
  const first = Object.keys(c.looks)[0];
  for (const v of c.videos) {
    for (const look of v.looks ?? [first]) {
      if (v.kind === 'docs-gif') { out.push({ id: `${v.id}--${look}`, video: v, look, phone: false, shapes: [], format: 'gif', polish: [...(v.polish ?? [])] }); continue; }
      const desk = (v.shapes ?? []).filter((s) => DESKTOP.includes(s));
      // Desktop: captions as a file (uploaded beside the video where a platform takes one), never burned in.
      if (desk.length) out.push({ id: `${v.id}--${look}`, video: v, look, phone: false, shapes: desk, format: 'mp4', polish: ['--scale', '2', '--captions', 'vtt', '--poster', ...(v.polish ?? [])] });
      if (v.shapes?.includes('9:16')) out.push({ id: `${v.id}--${look}--phone`, video: v, look, phone: true, shapes: ['9:16'], format: 'mp4', polish: ['--scale', '2', '--frame', 'none', '--captions', 'vtt', '--poster', ...(v.polish ?? [])] });
    }
  }
  return out;
}

/** A shape's file tag: '16:9' → '16x9'. */
export const shapeTag = (shape: string): string => shape.replace(':', 'x');

/** What a render writes: [{ key, name, canvas? }]; key is what made.json calls it ('mp4@1:1', 'gif'). */
export function filesOf(r: CampaignRender): Array<{ key: string; name: string; format: OutFormat; canvas?: string }> {
  if (!r.shapes.length) return [{ key: r.format, name: `${r.id}.${r.format}`, format: r.format }];
  return r.shapes.map((s) => ({ key: `${r.format}@${s}`, name: `${r.id}-${shapeTag(s)}.${r.format}`, format: r.format, canvas: s }));
}

/** What a look's videos end with: its own words, else the brand's end card, else its watermark. */
export function endsWithOf(look: CampaignLook, endTitle?: string): string | null {
  if (look.endsWith) return look.endsWith;
  const b = existsSync(look.brand) ? JSON.parse(readFileSync(look.brand, 'utf8')) : {};
  const end = b.endCard;
  if (end && typeof end === 'object') return [endTitle ?? end.title, end.url].filter(Boolean).join(' ') || null;
  if (typeof end === 'string') return endTitle ?? end;
  const w = typeof b.watermark === 'string' ? b.watermark : b.watermark?.text;
  return w ?? null;
}

/* ── Progress ── */

export interface Progress {
  ids: string[]; started: string; done: Record<string, string>; failed: Record<string, string>;
  current: { id: string; n: number; of: number; since: string } | null; finished: string | null; resumed?: string;
}

/**
 * A run's progress, kept beside its files (<out>/progress.json) so it can be read while it runs, and a run stopped
 * part way carries on. A run of the same renders that did not finish keeps its done ones, unless `fresh`.
 */
export function progressOf(out: string, ids: string[], o: { fresh?: boolean } = {}) {
  const file = join(out, 'progress.json');
  const was: Progress | null = !o.fresh && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const same = !!was && !was.finished && JSON.stringify([...was.ids].sort()) === JSON.stringify([...ids].sort());
  const p: Progress = same ? { ...was!, failed: {}, current: null, resumed: new Date().toISOString() } : { ids, started: new Date().toISOString(), done: {}, failed: {}, current: null, finished: null };
  mkdirSync(out, { recursive: true });
  const save = () => writeFileSync(file, `${JSON.stringify(p, null, 2)}\n`);
  save();
  return {
    file,
    resumed: same,
    isDone: (id: string) => Boolean(p.done[id]),
    start(id: string, n: number, of: number) { p.current = { id, n, of, since: new Date().toISOString() }; save(); },
    done(id: string) { p.done[id] = new Date().toISOString(); delete p.failed[id]; p.current = null; save(); },
    fail(id: string, why: string) { p.failed[id] = why; p.current = null; save(); },
    finish() { p.finished = new Date().toISOString(); p.current = null; save(); },
    get state() { return p; },
  };
}

/** A make run's progress in words: what's done, what failed, what it's on now. */
export function statusOf(c: Pick<LoadedCampaign, 'product' | 'out'>, now = Date.now()): string {
  const file = join(c.out, 'progress.json');
  if (!existsSync(file)) return `${c.product}: no make run yet`;
  const p: Progress = JSON.parse(readFileSync(file, 'utf8'));
  const done = p.ids.filter((id) => p.done[id]);
  const mins = (t: string) => `${Math.round((now - Date.parse(t)) / 60000)} min`;
  return [
    `${c.product}: ${done.length} of ${p.ids.length} made${p.finished ? ` — finished ${mins(p.finished)} ago` : ''} (started ${mins(p.started)} ago${p.resumed ? `, carried on ${mins(p.resumed)} ago` : ''})`,
    ...(p.current ? [`  now: [${p.current.n}/${p.current.of}] ${p.current.id}, for ${mins(p.current.since)}`] : []),
    ...p.ids.map((id) => `  ${p.done[id] ? '✓' : p.failed[id] ? '✗' : p.current?.id === id ? '…' : '·'} ${id}${p.failed[id] ? ` — ${p.failed[id]}` : ''}`),
  ].join('\n');
}

/* ── Making ── */

export interface Made {
  files: Record<string, string>;
  width?: number; height?: number; seconds?: number;
  narrated: boolean; video: string; look: string; at: string;
  /** What the check found (STUDIO_V3 §4), when make was given an AI to check with. */
  check?: CheckResult;
}

export interface MakeOptions {
  /** Video ids, or render ids (intro--product--phone), to make; default all. */
  only?: string[];
  /** Start the app (app.start) if it isn't serving. */
  start?: boolean;
  /** Start over instead of carrying on a stopped run. */
  fresh?: boolean;
  /** The voice (over the campaign's narrator and TRACE_AVATAR_VOICE). '' makes narrated videos without a voice. */
  voice?: string | Voice;
  log?: (m: string) => void;
  /** Checks each made MP4 with this AI (check.ts): flags and blank frames go into the made manifest. */
  check?: Ai;
}

const reachable = async (url: string) => { try { return (await fetch(url)).ok; } catch { return false; } };
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/** The app serving: already, or started (app.start) and waited for. Returns how to stop what was started. */
export async function ensureApp(app: CampaignApp, start: boolean, log: (m: string) => void = () => {}): Promise<() => void> {
  const ready = `${app.url.replace(/\/$/, '')}${app.ready ?? '/'}`;
  if (await reachable(ready)) return () => {};
  if (!start || !app.start?.length) throw new Error(`the app is not serving at ${ready}${app.start?.length ? `: run \`${app.start.join(' ')}\` in ${app.dir}, or pass --start` : ''}`);
  log(`starting the app: ${app.start.join(' ')} (in ${app.dir}) …`);
  const child = spawn(app.start[0], app.start.slice(1), { cwd: app.dir, stdio: ['ignore', 'pipe', 'inherit'] });
  let exited: number | null = null;
  let said = false;
  child.on('exit', (code) => { exited = code ?? -1; });
  child.stdout!.on('data', (d) => { process.stdout.write(d); if (app.readyText && String(d).includes(app.readyText)) said = true; });
  const until = Date.now() + 600_000;
  for (;;) {
    if (exited !== null) throw new Error(`the app exited (${exited}) before it was ready`);
    if (app.readyText ? said : await reachable(ready)) break;
    if (Date.now() > until) { child.kill('SIGTERM'); throw new Error('the app did not start in 10 minutes'); }
    await sleep(500);
  }
  return () => { child.kill('SIGTERM'); };
}

/** Put the app back to a known state for a video (app.reset with the video's body). */
async function resetFor(app: CampaignApp, body: Record<string, unknown>): Promise<void> {
  if (!app.reset) return;
  if ('post' in app.reset) {
    const r = await fetch(app.reset.post, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(app.reset.body ?? {}), ...body }) }).catch((e: Error) => e);
    if (r instanceof Error || !r.ok) throw new Error(`the app did not reset (${app.reset.post}: ${r instanceof Error ? r.message : r.status})`);
    return;
  }
  const run = app.reset.run;
  const code = await new Promise<number>((done) => {
    const p = spawn(run[0], run.slice(1), { cwd: app.dir, stdio: 'inherit', env: { ...process.env, TRACE_AVATAR_RESET: JSON.stringify(body) } });
    p.on('exit', (c) => done(c ?? -1));
    p.on('error', () => done(-1));
  });
  if (code !== 0) throw new Error(`the app did not reset (${run.join(' ')} exited ${code})`);
}

/** The session function of app.session, when there is one. */
async function sessionFn(app: CampaignApp) {
  if (!app.session) return null;
  const m = await import(pathToFileURL(app.session).href);
  if (typeof m.storageStateFor !== 'function') throw new Error(`${app.session} has no storageStateFor(url, options)`);
  return m.storageStateFor as (url: string, o: Record<string, unknown>) => unknown;
}

/** The voice a run speaks with, checked once with a short line (a voice that can't be reached fails before filming). */
async function voiceFor(spec: string | Voice | undefined, log: (m: string) => void): Promise<Voice | null> {
  if (!spec) return null;
  const v = typeof spec === 'function' ? spec : await voiceOf(spec);
  try { await v('This is a short check that the voice can be reached.'); } catch (e) { throw new Error(`the voice is not reachable (${(e as Error).message}); nothing was filmed`); }
  log(`voice: ${typeof spec === 'string' ? spec : 'given'}`);
  return v;
}

/** Make a campaign's videos (all, or the ids given): files and <out>/made.json. */
export async function makeCampaign(c: LoadedCampaign, o: MakeOptions = {}): Promise<{ made: Record<string, Made>; failed: string[] }> {
  const log = o.log ?? console.log;
  const only = o.only ?? [];
  const all = rendersOf(c);
  const hit = (r: CampaignRender, id: string) => r.video.id === id || r.id === id;
  const unknown = only.filter((id) => !all.some((r) => hit(r, id)));
  if (unknown.length) throw new Error(`no such video: ${unknown.join(', ')}`);
  const renders = only.length ? all.filter((r) => only.some((id) => hit(r, id))) : all;
  mkdirSync(join(c.out, 'work'), { recursive: true });
  // Found making our own: with no ffmpeg, every video was captured and then failed at its encode, said only at the end.
  if (renders.some((r) => r.format === 'mp4')) {
    const ff = findFfmpeg();
    if (!ff) throw new Error(`${FFMPEG_MISSING} Nothing was captured.`);
    process.env.FFMPEG = ff;
  }
  const narrated = renders.some((r) => r.video.voice);
  const spec = o.voice ?? process.env.TRACE_AVATAR_VOICE ?? c.narrator;
  const voice = narrated ? await voiceFor(spec, log) : null;
  if (narrated && !voice) log('no voice (--voice, TRACE_AVATAR_VOICE or the campaign\'s narrator): narrated videos are made without narration');
  const manifest = join(c.out, 'made.json');
  const made: Record<string, Made> = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : {};
  const failed: string[] = [];
  const progress = progressOf(c.out, renders.map((r) => r.id), { fresh: o.fresh });
  if (progress.resumed) log(`carrying on a run that stopped: ${renders.filter((r) => progress.isDone(r.id)).length} of ${renders.length} already made (--fresh to start over) — progress in ${progress.file}`);
  else log(`${renders.length} render(s) — progress in ${progress.file}`);
  const fail = (id: string, why: string) => { failed.push(`${id}: ${why}`); progress.fail(id, why); log(`${id}: ✗ ${why}`); };
  let stop: (() => void) | null = null;
  const session = await sessionFn(c.app);
  try {
    for (const [i, r] of renders.entries()) {
      const tag = `[${i + 1}/${renders.length}]`;
      if (progress.isDone(r.id)) { log(`${tag} ${r.id}: made earlier in this run — kept`); continue; }
      log(`${tag} ${r.id} …`);
      progress.start(r.id, i + 1, renders.length);
      stop ??= await ensureApp(c.app, !!o.start, log);
      // The phone shape plays its own guide, written on a phone-sized screen, when it has one.
      const v = r.phone && r.video.phone ? { ...r.video, guide: r.video.phone.guide, voice: r.video.phone.voice ?? r.video.voice } : r.video;
      const outs = filesOf(r);
      const outBase = join(c.out, r.id);
      const firstBase = join(c.out, outs[0].name.replace(/\.[^.]+$/, ''));
      // What a render writes is found by looking for its files, so none may be left from an earlier one.
      for (const b of [outBase, firstBase]) for (const ext of ['vtt', 'chapters.vtt', 'png', 'scenes.json']) rmSync(`${b}.${ext}`, { force: true });
      rmSync(join(c.out, `${r.id}.failed.png`), { force: true });
      const look = c.looks[r.look];
      const script = v.voice?.[r.look];
      // A look that fills 16:9 is captured at 16:9 (1280×720), so the wide file is the app edge to edge.
      const fill = (existsSync(look.brand) ? brandFile(look.brand).fill : undefined) ?? [];
      const wide = !r.phone && r.shapes.includes('16:9') && fill.some((f) => String(f) === '16:9');
      const tall = r.phone && fill.some((f) => String(f) === '9:16');
      const speak = !!(v.voice && voice);
      let traceFile = '';
      try {
        await resetFor(c.app, v.reset ?? {});
        let width: number | undefined; let height: number | undefined; let seconds: number | undefined; let spoke = false;
        let said: string[] = [];
        if (v.director) {
          const res = await direct({
            id: r.id, script: v.director, url: c.app.url, page: v.page ?? '/', appName: c.app.name ?? '',
            failShot: join(c.out, `${r.id}.failed.png`),
            out: outs.map((x) => ({ file: join(c.out, x.name), format: x.format, ...(x.canvas ? { canvas: x.canvas } : {}), ...(x.format === 'gif' ? { width: v.width ?? 800 } : {}) })),
            look: lookOptions({ title: v.title, endTitle: v.endTitle, polish: r.polish }, look.brand, c.app.name ?? ''),
            ...(r.phone ? { viewport: tall ? TALL : { width: 390, height: 844 } } : wide ? { viewport: WIDE } : {}),
            ...(session ? { session } : c.app.storageState ? { session: c.app.storageState } : {}),
            ...(v.blur ? { autoBlur: v.blur } : {}), ...(v.refuse ? { refuse: v.refuse } : {}),
            ...(v.session ? { sessionOptions: v.session } : {}),
            ...(v.signedIn === false ? { signedOut: true } : {}),
            ...(c.app.alias ? { alias: c.app.alias } : {}),
            ...(c.app.routes ? { routes: c.app.routes } : {}),
            ...(c.app.reroute ? { reroute: c.app.reroute } : {}),
            // `d.app` in the script: the campaign's app, at the address the video shows (its alias, if it has one).
            props: { app: { ...c.app, url: c.app.alias ? `https://${typeof c.app.alias === 'string' ? c.app.alias : c.app.alias.host}` : c.app.url } },
            ...(speak ? { voice: voice!, ...(script ? { voiceScript: script } : {}) } : {}),
            scenesFile: `${outBase}.scenes.json`,
            headless: !v.headed, ...(v.launchArgs ? { launchArgs: v.launchArgs } : {}), ...(v.tailMs !== undefined ? { tailMs: v.tailMs } : {}),
            log,
          });
          ({ width, height } = res.outputs[0]);
          seconds = Math.round(res.durationMs / 100) / 10;
          spoke = res.narrated;
          for (const w of res.warnings ?? []) log(`${r.id}: ${w}`);
        } else {
          const g = guideOf(c, v);
          if (!g) throw new Error(`no guide ${v.guide}`);
          const trace = join(c.out, 'work', `${r.id}.trace.json`);
          writeFileSync(trace, JSON.stringify(g.trace, null, 2));
          traceFile = trace;
          // A guide is played signed in with storageState; without one, with the session module's.
          let storageState = c.app.storageState;
          if (!storageState && session) {
            storageState = join(c.out, 'work', `${r.id}.session.json`);
            writeFileSync(storageState, JSON.stringify(await session(c.app.url, v.session ?? {})));
          }
          const args = [trace, '--url', `${c.app.url.replace(/\/$/, '')}${g.page}`, '--navigate', '--brand', look.brand];
          if (storageState) args.push('--storage-state', storageState);
          if (r.phone) args.push('--viewport', tall ? `${TALL.width}x${TALL.height}` : PHONE);
          else if (wide) args.push('--viewport', `${WIDE.width}x${WIDE.height}`);
          if (r.format === 'gif') args.push('--width', String(v.width ?? 800));
          if (v.mode === 'perform') args.push('--mode', 'perform', '--allow-perform');
          for (const [name, text] of Object.entries(v.values ?? {})) args.push('--value', `${name}=${text}`);
          args.push(...r.polish);
          if (speak && script) args.push('--voice', 'given', '--script', script);
          for (const x of outs) args.push('--out', `${join(c.out, x.name)}${x.canvas ? `@${x.canvas}` : ''}`);
          const p = parse(args);
          const res = await render({ ...p.options, ...(speak ? { voice: voice! } : {}), ...(v.blur ? { autoBlur: v.blur } : {}), ...(v.refuse ? { refuse: v.refuse } : {}) });
          said = ((g.trace.steps ?? []) as Array<{ say?: string }>).map((st) => String(st.say ?? '').trim()).filter(Boolean);
          ({ width, height } = res.outputs[0]);
          seconds = Math.round(res.durationMs / 100) / 10;
          spoke = !!res.narration?.lines.length;
          for (const w of res.warnings ?? []) log(`${r.id}: ${w}`);
        }
        const files: Record<string, string> = {};
        for (const x of outs) files[x.key] = x.name;
        if (existsSync(`${firstBase}.png`)) files.poster = `${outs[0].name.replace(/\.[^.]+$/, '')}.png`;
        if (existsSync(`${firstBase}.vtt`)) files.vtt = `${outs[0].name.replace(/\.[^.]+$/, '')}.vtt`;
        // The check (STUDIO_V3 §4): frames of the first MP4, with what the video says.
        let check: CheckResult | undefined;
        const mp4 = outs.find((x) => x.format === 'mp4');
        if (o.check && mp4 && seconds) {
          if (v.director) said = saysOf(c, r.id) ?? [];
          const vtt = files.vtt ? join(c.out, files.vtt) : '';
          const cues = vtt && existsSync(vtt) ? cuesOf(readFileSync(vtt, 'utf8')) : [];
          check = await checkVideo({ ai: o.check, file: join(c.out, mp4.name), seconds, ffmpeg: findFfmpeg()!, ...(v.title ? { title: v.title } : {}), lines: said, cues });
          log(`${r.id}: checked ${check.frames} frame(s): ${check.flags.length || check.blank.length ? [...check.flags.map((f) => `${f.kind} at ${(f.at / 1000).toFixed(1)} s (${f.note})`), ...check.blank.map((t) => `blank at ${t} s`)].join('; ') : 'nothing found'}`);
        }
        made[r.id] = { files, width, height, seconds, narrated: spoke, video: v.id, look: r.look, at: new Date().toISOString(), ...(check ? { check } : {}) };
        writeFileSync(manifest, `${JSON.stringify(made, null, 2)}\n`);
        log(`${r.id}: ✓ ${Object.values(files).join(', ')}`);
        progress.done(r.id);
      } catch (e) {
        if (e instanceof RenderError) {
          const rep = reportOf(e, traceFile);
          fail(r.id, `${rep.outcome}${rep.step !== null ? ` at step ${rep.step + 1}` : ''}: ${String(rep.message).split('\n')[0]}`);
        } else fail(r.id, String((e as Error).message).split('\n')[0]);
      }
    }
    // Finished only when every render was made: a run with failures carries on next time (the failed ones again).
    if (!failed.length) progress.finish();
  } finally {
    stop?.();
  }
  return { made, failed };
}

/**
 * What a render's video says, in order: each scene's caption (narrated: the spoken line) and its cards' lines, from its
 * <id>.scenes.json (director videos). null when it has none.
 */
export function saysOf(c: Pick<LoadedCampaign, 'out'>, renderId: string): string[] | null {
  const file = join(c.out, `${renderId}.scenes.json`);
  if (!existsSync(file)) return null;
  const lines = (JSON.parse(readFileSync(file, 'utf8')) as Array<{ caption?: string }>).map((x) => String(x.caption ?? '').trim()).filter(Boolean);
  return lines.length ? lines : null;
}
