import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOGUE_KINDS, CATALOGUE_REQUIRED, CATALOGUE_SPEC, catalogueId, checkCatalogue, mp4Head, vttEnds } from '../../src/catalogue';
import { main } from '../../src/cli';

const SCHEMA = JSON.parse(readFileSync(new URL('../../schemas/catalogue-1.json', import.meta.url), 'utf8'));

const entry = (o: Record<string, unknown> = {}) => ({
  id: 'acme/ad-paid/product/1:1', product: 'acme', video: 'ad-paid', kind: 'ad', preset: 'product', shape: '1:1', format: 'mp4',
  url: 'https://cdn.acme.com/ad-paid-1x1-0123456789.mp4', poster: 'https://cdn.acme.com/ad-paid-1x1-aaaaaaaaaa.png',
  captions: 'https://cdn.acme.com/ad-paid-1x1-bbbbbbbbbb.vtt', language: 'en', captionsBurned: false, seconds: 12.5, narrated: true,
  title: null, alt: 'Acme ad: an invoice marked paid.', says: ['Get paid the day you send it.', 'Marked paid when the transfer lands.'],
  site: 'https://acme.com', endsWith: 'For more info visit acme.com', made: '2026-11-12T21:54:32.404Z', ...o,
});
const cat = (videos: unknown[], o: Record<string, unknown> = {}) => ({ spec: CATALOGUE_SPEC, updated: '2026-11-12T22:18:37.571Z', videos, ...o });

/** An ISO media box. */
function box(type: string, body: Uint8Array) {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  return out;
}
const join8 = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let a = 0; for (const x of p) { o.set(x, a); a += x.length; } return o; };
const ftyp = box('ftyp', new TextEncoder().encode('isom\0\0\0\0isomavc1'));
const moov = (codecs: string) => box('moov', box('trak', new TextEncoder().encode(codecs)));
const mdat = box('mdat', new Uint8Array(64));

/** A fetch that serves a map of url → { type, body }. */
function served(files: Record<string, { type: string; body: string | Uint8Array; status?: number }>) {
  const asked: string[] = [];
  const f = (async (url: string | URL) => {
    asked.push(String(url));
    const x = files[String(url)];
    if (!x) return new Response('no', { status: 404 });
    return new Response(x.body as BodyInit, { status: x.status ?? 200, headers: { 'content-type': x.type } });
  }) as typeof fetch;
  return { f, asked };
}
const VTT = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nGet paid the day you send it.\n\n2\n00:00:05.000 --> 00:00:12.000\nMarked paid.\n';
const all = (o: { mp4?: Uint8Array; vtt?: string } = {}) => ({
  'https://cdn.acme.com/ad-paid-1x1-0123456789.mp4': { type: 'video/mp4', body: o.mp4 ?? join8(ftyp, moov('avc1 mp4a'), mdat) },
  'https://cdn.acme.com/ad-paid-1x1-aaaaaaaaaa.png': { type: 'image/png', body: 'png' },
  'https://cdn.acme.com/ad-paid-1x1-bbbbbbbbbb.vtt': { type: 'text/vtt', body: o.vtt ?? VTT },
});

describe('catalogue: trace-avatar-catalogue/1', () => {
  it('a good catalogue keeps the spec; a GIF has no shape; unknown fields are allowed', async () => {
    const gif = entry({ id: 'acme/gif-send/product/gif', video: 'gif-send', kind: 'docs-gif', shape: null, format: 'gif', url: 'https://cdn.acme.com/x.gif', captions: undefined, narrated: false, says: undefined, extra: 1 });
    const r = await checkCatalogue(cat([entry(), gif], { generator: 'test' }));
    expect(r).toEqual({ ok: true, problems: [], warnings: [], videos: 2, fetched: 0 });
  });

  it('the recommended id: product/video/preset/shape, or gif', () => {
    expect(catalogueId({ product: 'acme', video: 'intro', preset: 'product', shape: '9:16', format: 'mp4' })).toBe('acme/intro/product/9:16');
    expect(catalogueId({ product: 'acme', video: 'gif-x', preset: 'showcase', shape: null, format: 'gif' })).toBe('acme/gif-x/showcase/gif');
  });

  it('names every problem at once', async () => {
    const r = await checkCatalogue({ updated: 'yesterday', videos: [
      entry({ kind: 'teaser', shape: '3:2', url: 'http://cdn.acme.com/x.mp4', seconds: 0, language: 'EN', says: [], alt: ' ' }),
      entry({ id: undefined }),
      entry({ captionsBurned: true }),
      'nope',
    ] });
    expect(r.ok).toBe(false);
    const text = r.problems.join('\n');
    for (const m of ['no spec', 'updated is an ISO time', 'kind is one of', "an mp4's shape", 'url is an https link', 'seconds is its length', 'language is two lowercase', 'says is a list', 'alt says what it shows', 'videos[1]: no id', 'captions are burned in, so it has no captions file', 'videos[3]: an entry is an object']) expect(text).toContain(m);
  });

  it('ids are unique, and so is product/video/preset/shape/format; another id form is a warning', async () => {
    const twice = await checkCatalogue(cat([entry(), entry()]));
    expect(twice.problems.join('\n')).toMatch(/id used twice \(videos\[0\]\)/);
    expect(twice.problems.join('\n')).toMatch(/the same product, video, preset, shape and format as videos\[0\]/);
    const own = await checkCatalogue(cat([entry({ id: 'clip-7' })]));
    expect(own.ok).toBe(true);
    expect(own.warnings).toEqual(['videos[0] (clip-7): the id acme/ad-paid/product/1:1 is recommended (stable across re-renders)']);
    const noCc = await checkCatalogue(cat([entry({ captions: undefined })]));
    expect(noCc.warnings[0]).toMatch(/has words but no captions file/);
  });

  it('a spec it does not know is a problem', async () => {
    expect((await checkCatalogue(cat([entry()], { spec: 'trace-avatar-catalogue/2' }))).problems).toEqual(['spec is "trace-avatar-catalogue/2"; this checks trace-avatar-catalogue/1']);
    expect((await checkCatalogue([])).problems).toEqual(['a catalogue is a JSON object { spec, updated, videos }']);
  });

  it('the schema file lists the same required fields, kinds and spec as the checker', () => {
    expect(SCHEMA.properties.spec.const).toBe(CATALOGUE_SPEC);
    expect(SCHEMA.$defs.entry.required).toEqual([...CATALOGUE_REQUIRED]);
    expect(SCHEMA.$defs.entry.properties.kind.enum).toEqual([...CATALOGUE_KINDS]);
  });
});

describe('catalogue: its links (--fetch)', () => {
  it('every link answers with its type; captions fit; the mp4 is H.264 + AAC, moov first', async () => {
    const { f, asked } = served(all());
    const r = await checkCatalogue(cat([entry()]), { fetch: true, fetcher: f });
    expect(r).toMatchObject({ ok: true, fetched: 3 });
    expect(asked).toHaveLength(3);
  });

  it('a link that does not answer, or answers with the wrong type', async () => {
    const files = all();
    delete (files as Record<string, unknown>)['https://cdn.acme.com/ad-paid-1x1-aaaaaaaaaa.png'];
    files['https://cdn.acme.com/ad-paid-1x1-bbbbbbbbbb.vtt'].type = 'binary/octet-stream';
    const r = await checkCatalogue(cat([entry()]), { fetch: true, fetcher: served(files).f });
    expect(r.problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/poster: .*answered 404/),
      expect.stringMatching(/captions: served as binary\/octet-stream, not text\/vtt/),
    ]));
  });

  it('captions longer than the video, or not WebVTT', async () => {
    const long = await checkCatalogue(cat([entry()]), { fetch: true, fetcher: served(all({ vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:20.000\nx\n' })).f });
    expect(long.problems).toEqual(['acme/ad-paid/product/1:1 captions: the captions run to 20.0 s; the video is 12.5 s']);
    const srt = await checkCatalogue(cat([entry()]), { fetch: true, fetcher: served(all({ vtt: '1\n00:00:00,000 --> 00:00:02,000\nx\n' })).f });
    expect(srt.problems[0]).toMatch(/not WebVTT/);
  });

  it('an mp4 with its media first, not H.264, or narrated with no sound', async () => {
    const late = await checkCatalogue(cat([entry()]), { fetch: true, fetcher: served(all({ mp4: join8(ftyp, mdat, moov('avc1 mp4a')) })).f });
    expect(late.problems[0]).toMatch(/moov comes after its media/);
    const hevc = await checkCatalogue(cat([entry()]), { fetch: true, fetcher: served(all({ mp4: join8(ftyp, moov('hvc1 mp4a'), mdat) })).f });
    expect(hevc.problems[0]).toMatch(/not H\.264 \(hvc1, mp4a\)/);
    const mute = await checkCatalogue(cat([entry()]), { fetch: true, fetcher: served(all({ mp4: join8(ftyp, moov('avc1'), mdat) })).f });
    expect(mute.problems[0]).toMatch(/narrated, but no AAC sound/);
  });

  it('vttEnds and mp4Head', () => {
    expect(vttEnds(VTT)).toEqual([5, 12]);
    expect(vttEnds('WEBVTT\n\n01:00:00.500 --> 01:00:01.250\nx')).toEqual([3601.25]);
    expect(mp4Head(join8(ftyp, moov('avc1 mp4a'), mdat))).toEqual({ faststart: true, codecs: ['avc1', 'mp4a'] });
    expect(mp4Head(join8(ftyp, mdat))).toEqual({ faststart: false, codecs: null });
    expect(mp4Head(ftyp)).toEqual({ faststart: null, codecs: null });
    // moov cut off by the range: first, but its codecs unknown.
    expect(mp4Head(join8(ftyp, moov('avc1 mp4a')).subarray(0, ftyp.length + 10))).toEqual({ faststart: true, codecs: null });
  });
});

describe('cli: catalogue check', () => {
  const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) } }; };
  const file = (doc: unknown) => { const f = join(mkdtempSync(join(tmpdir(), 'cat-')), 'catalogue.json'); writeFileSync(f, JSON.stringify(doc)); return f; };

  it('0 for a good file, 1 with its problems, 2 for usage', async () => {
    const good = io();
    expect(await main(['catalogue', 'check', file(cat([entry()]))], good.io)).toBe(0);
    expect(good.out.at(-1)).toMatch(/1 video — keeps trace-avatar-catalogue\/1$/);
    const bad = io();
    expect(await main(['catalogue', 'check', file(cat([entry({ seconds: -1 })]))], bad.io)).toBe(1);
    expect(bad.err[0]).toMatch(/^✗ videos\[0\] .*seconds is its length/);
    expect(bad.out.at(-1)).toMatch(/1 problem$/);
    const json = io();
    expect(await main(['catalogue', 'check', file(cat([entry()])), '--json'], json.io)).toBe(0);
    expect(JSON.parse(json.out[0])).toMatchObject({ ok: true, videos: 1 });
    const usage = io();
    expect(await main(['catalogue', 'lint', 'x.json'], usage.io)).toBe(2);
    expect(await main(['catalogue', 'check', '/no/such/file.json'], usage.io)).toBe(2);
  });
});
