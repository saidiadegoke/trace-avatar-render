/**
 * The clip catalogue, `trace-avatar-catalogue/1` (schemas/catalogue-1.json): a public JSON file listing a product's
 * published marketing videos, one entry per file and shape, so anything (a scheduler such as DutyCaptain, a site) can
 * pick a clip and write about it from the clip's own words (`says`).
 *
 *   const r = checkCatalogue(json);               // the rules a file can show by itself
 *   const r = await checkCatalogue(json, { fetch: true }); // …and its links: reachable, the right type, captions that
 *                                                  //    fit the video, an mp4 that starts playing before it has all loaded
 *
 * Problems break the spec; warnings are advice (a reader still works). Unknown fields are allowed.
 */

export const CATALOGUE_SPEC = 'trace-avatar-catalogue/1';
export const CATALOGUE_KINDS = ['intro', 'demo', 'guide', 'onboarding', 'pitch', 'whats-new', 'ad', 'docs-gif', 'qa', 'support'] as const;
export const CATALOGUE_SHAPES = ['16:9', '1:1', '4:5', '9:16'] as const;
export const CATALOGUE_FORMATS = ['mp4', 'gif'] as const;
/** The fields every entry has. */
export const CATALOGUE_REQUIRED = ['id', 'product', 'video', 'kind', 'preset', 'shape', 'format', 'url', 'captionsBurned', 'seconds', 'narrated', 'alt', 'site', 'made'] as const;

export interface CatalogueEntry {
  id: string;
  product: string;
  video: string;
  kind: (typeof CATALOGUE_KINDS)[number];
  preset: string;
  shape: (typeof CATALOGUE_SHAPES)[number] | null;
  format: (typeof CATALOGUE_FORMATS)[number];
  url: string;
  poster?: string;
  captions?: string;
  /** Two letters; `en` when absent. */
  language?: string;
  captionsBurned: boolean;
  seconds: number;
  narrated: boolean;
  title?: string | null;
  alt: string;
  /** The video's own words, in order: its captions (the spoken lines when narrated) and its cards' lines. */
  says?: string[];
  site: string;
  endsWith?: string;
  made: string;
  [more: string]: unknown;
}

export interface Catalogue {
  spec: typeof CATALOGUE_SPEC;
  updated: string;
  videos: CatalogueEntry[];
  [more: string]: unknown;
}

export interface CatalogueCheck {
  ok: boolean;
  problems: string[];
  warnings: string[];
  /** Entries checked. */
  videos: number;
  /** Links fetched (with `fetch`). */
  fetched: number;
}

/** An entry's id as the spec recommends: <product>/<video>/<preset>/<shape|gif>. Stable across re-renders. */
export function catalogueId(e: Pick<CatalogueEntry, 'product' | 'video' | 'preset' | 'shape' | 'format'>): string {
  return `${e.product}/${e.video}/${e.preset}/${e.format === 'gif' || !e.shape ? 'gif' : e.shape}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));
const isHttps = (v: unknown) => {
  if (typeof v !== 'string') return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
};

/** The rules a catalogue shows by itself. */
function checkShape(doc: unknown, problems: string[], warnings: string[], https: (v: unknown) => boolean): CatalogueEntry[] {
  if (!isObj(doc)) { problems.push('a catalogue is a JSON object { spec, updated, videos }'); return []; }
  if (doc.spec !== CATALOGUE_SPEC) problems.push(doc.spec === undefined ? `no spec: a catalogue says "spec": "${CATALOGUE_SPEC}"` : `spec is ${JSON.stringify(doc.spec)}; this checks ${CATALOGUE_SPEC}`);
  if (!isTime(doc.updated)) problems.push('updated is an ISO time');
  if (!Array.isArray(doc.videos)) { problems.push('videos is a list'); return []; }
  const ids = new Map<string, number>();
  const tuples = new Map<string, number>();
  const good: CatalogueEntry[] = [];
  doc.videos.forEach((v, i) => {
    const at = `videos[${i}]${isObj(v) && typeof v.id === 'string' ? ` (${v.id})` : ''}`;
    if (!isObj(v)) { problems.push(`${at}: an entry is an object`); return; }
    const before = problems.length;
    const p = (m: string) => problems.push(`${at}: ${m}`);
    for (const k of CATALOGUE_REQUIRED) if (v[k] === undefined) p(`no ${k}`);
    for (const k of ['id', 'product', 'video', 'preset'] as const) if (v[k] !== undefined && !(typeof v[k] === 'string' && /^\S+$/.test(v[k] as string))) p(`${k} is a word with no spaces`);
    if (v.kind !== undefined && !CATALOGUE_KINDS.includes(v.kind as never)) p(`kind is one of ${CATALOGUE_KINDS.join(', ')}`);
    if (v.format !== undefined && !CATALOGUE_FORMATS.includes(v.format as never)) p('format is mp4 or gif');
    if (v.format === 'gif' && v.shape !== null && v.shape !== undefined) p('a GIF has no shape (null)');
    if (v.format === 'mp4' && !CATALOGUE_SHAPES.includes(v.shape as never)) p(`an mp4's shape is one of ${CATALOGUE_SHAPES.join(', ')}`);
    for (const k of ['url', 'site'] as const) if (v[k] !== undefined && !https(v[k])) p(`${k} is an https link`);
    for (const k of ['poster', 'captions'] as const) if (v[k] !== undefined && !https(v[k])) p(`${k} is an https link`);
    if (v.captionsBurned !== undefined && typeof v.captionsBurned !== 'boolean') p('captionsBurned is true or false');
    if (v.narrated !== undefined && typeof v.narrated !== 'boolean') p('narrated is true or false');
    if (v.captions !== undefined && v.captionsBurned === true) p('captions are burned in, so it has no captions file');
    if (v.seconds !== undefined && !(typeof v.seconds === 'number' && Number.isFinite(v.seconds) && v.seconds > 0)) p('seconds is its length, a number above 0');
    if (v.language !== undefined && !(typeof v.language === 'string' && /^[a-z]{2}$/.test(v.language))) p('language is two lowercase letters, e.g. en');
    if (v.title !== undefined && v.title !== null && typeof v.title !== 'string') p('title is text or null');
    if (v.alt !== undefined && !(typeof v.alt === 'string' && v.alt.trim())) p('alt says what it shows');
    if (v.says !== undefined && !(Array.isArray(v.says) && v.says.length && v.says.every((s) => typeof s === 'string' && s.trim()))) p('says is a list of the lines the video shows or speaks');
    if (v.endsWith !== undefined && typeof v.endsWith !== 'string') p('endsWith is text');
    if (v.made !== undefined && !isTime(v.made)) p('made is an ISO time');
    if (problems.length > before) return;
    const e = v as CatalogueEntry;
    const seen = ids.get(e.id);
    if (seen !== undefined) p(`id used twice (videos[${seen}])`);
    else ids.set(e.id, i);
    const tuple = `${e.product}/${e.video}/${e.preset}/${e.shape}/${e.format}`;
    const twin = tuples.get(tuple);
    if (twin !== undefined) p(`the same product, video, preset, shape and format as videos[${twin}]`);
    else tuples.set(tuple, i);
    if (e.id !== catalogueId(e)) warnings.push(`${at}: the id ${catalogueId(e)} is recommended (stable across re-renders)`);
    if (e.format === 'mp4' && !e.captionsBurned && !e.captions && e.says?.length) warnings.push(`${at}: it has words but no captions file`);
    good.push(e);
  });
  return good;
}

/** WebVTT cue end times, in seconds. Throws when it is not WebVTT. */
export function vttEnds(text: string): number[] {
  if (!/^﻿?WEBVTT(?:[ \t].*)?(?:\r?\n|$)/.test(text)) throw new Error('not WebVTT (it does not start with WEBVTT)');
  const ends: number[] = [];
  const re = /(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/g;
  for (let m = re.exec(text); m; m = re.exec(text)) ends.push(Number(m[5] ?? 0) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000);
  return ends;
}

/**
 * An mp4's top-level boxes from its first bytes: whether `moov` (what a player needs first) comes before `mdat` (the
 * media), and, when moov is all there, which codecs it names.
 */
export function mp4Head(bytes: Uint8Array): { faststart: boolean | null; codecs: string[] | null } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const name = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  let at = 0;
  while (at + 8 <= bytes.length) {
    let size = dv.getUint32(at);
    const type = name(at + 4);
    if (size === 1 && at + 16 <= bytes.length) size = Number(dv.getBigUint64(at + 8));
    if (type === 'mdat') return { faststart: false, codecs: null };
    if (type === 'moov') {
      if (size < 8 || at + size > bytes.length) return { faststart: true, codecs: null };
      const body = new TextDecoder('latin1').decode(bytes.subarray(at, at + size));
      return { faststart: true, codecs: ['avc1', 'avc3', 'hvc1', 'hev1', 'mp4a', 'Opus'].filter((c) => body.includes(c)) };
    }
    if (size < 8) break;
    at += size;
  }
  return { faststart: null, codecs: null };
}

const TYPES: Record<string, RegExp> = { mp4: /^video\/mp4\b/, gif: /^image\/gif\b/, poster: /^image\/(png|jpeg|webp)\b/, captions: /^text\/vtt\b/ };

async function each<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

export interface CheckOptions {
  /** Fetch every link too (no cookies): reachable, its type, the captions' length, the mp4's head. */
  fetch?: boolean;
  /** The fetch to use (tests). */
  fetcher?: typeof fetch;
  /** Links fetched at once (default 6). */
  concurrency?: number;
  /** Allow http:// links (a local test server); the spec wants https. */
  allowHttp?: boolean;
}

/** Check a catalogue against trace-avatar-catalogue/1. With `fetch`, its links too. */
export async function checkCatalogue(doc: unknown, o: CheckOptions = {}): Promise<CatalogueCheck> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const https = o.allowHttp ? (v: unknown) => isHttps(v) || (typeof v === 'string' && /^http:\/\//.test(v)) : isHttps;
  const entries = checkShape(doc, problems, warnings, https);
  let fetched = 0;
  if (o.fetch) {
    const f = o.fetcher ?? fetch;
    const jobs: Array<{ e: CatalogueEntry; what: 'mp4' | 'gif' | 'poster' | 'captions'; url: string }> = [];
    for (const e of entries) {
      jobs.push({ e, what: e.format, url: e.url });
      if (e.poster) jobs.push({ e, what: 'poster', url: e.poster });
      if (e.captions) jobs.push({ e, what: 'captions', url: e.captions });
    }
    await each(jobs, o.concurrency ?? 6, async ({ e, what, url }) => {
      const at = `${e.id} ${what}`;
      try {
        // The head of the file is enough: a range for the media, the whole of a captions file.
        const res = await f(url, { headers: what === 'captions' ? {} : { range: 'bytes=0-262143' }, redirect: 'follow' });
        fetched += 1;
        if (!res.ok) { problems.push(`${at}: ${url} answered ${res.status}`); return; }
        const type = res.headers.get('content-type') ?? '';
        if (!TYPES[what].test(type)) problems.push(`${at}: served as ${type || 'no type'}, not ${what === 'captions' ? 'text/vtt' : what === 'poster' ? 'an image' : what === 'gif' ? 'image/gif' : 'video/mp4'}`);
        if (what === 'captions') {
          const ends = vttEnds(await res.text());
          if (!ends.length) warnings.push(`${at}: the captions have no cues`);
          else if (Math.max(...ends) > e.seconds + 0.5) problems.push(`${at}: the captions run to ${Math.max(...ends).toFixed(1)} s; the video is ${e.seconds} s`);
        } else if (what === 'mp4') {
          const head = mp4Head(new Uint8Array(await res.arrayBuffer()));
          if (head.faststart === false) problems.push(`${at}: its moov comes after its media, so it can't start before it has all loaded (encode with -movflags +faststart)`);
          else if (head.faststart === null) warnings.push(`${at}: could not read its first boxes`);
          if (head.codecs && !head.codecs.some((c) => c === 'avc1' || c === 'avc3')) problems.push(`${at}: not H.264 (${head.codecs.join(', ') || 'no known codec'}); platforms want H.264/AAC`);
          if (head.codecs && e.narrated && !head.codecs.includes('mp4a')) problems.push(`${at}: narrated, but no AAC sound`);
        } else await res.body?.cancel();
      } catch (err) {
        problems.push(`${at}: ${(err as Error).message}`);
      }
    });
  }
  return { ok: !problems.length, problems, warnings, videos: entries.length, fetched };
}
