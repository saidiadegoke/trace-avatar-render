import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCampaign, endsWithOf, filesOf, loadCampaign, progressOf, readCampaign, rendersOf, saysOf, statusOf } from '../../src/campaign';
import { cardsOf, cursorAt, lookOptions, pathOf, sayFrom, travelMs, withCursor, arrowSprite, aliasOf } from '../../src/director';
import { main } from '../../src/cli';
import { PNG } from 'pngjs';

/** A campaign folder: campaign.json, a brand, a script, a director script, a guides file. */
function folder(over: Record<string, unknown> = {}, videos?: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'campaign-'));
  mkdirSync(join(dir, 'brands'));
  mkdirSync(join(dir, 'app'));
  writeFileSync(join(dir, 'brands', 'acme.json'), JSON.stringify({ name: 'Acme', frame: 'browser', endCard: { title: 'For more info visit', url: 'acme.com' } }));
  writeFileSync(join(dir, 'brands', 'show.json'), JSON.stringify({ watermark: 'Made with X · x.com' }));
  writeFileSync(join(dir, 'intro.json'), JSON.stringify({ lines: [{ n: 1, text: 'One.' }, { n: 2, text: 'Two.' }] }));
  writeFileSync(join(dir, 'ad.mjs'), 'export default async () => {};');
  writeFileSync(join(dir, 'app', 'guides.json'), JSON.stringify({ guides: [{ id: 'send', trace: { steps: [{ type: 'click' }, { type: 'note' }] }, pages: ['/app/*', '/app/send'] }] }));
  const c = {
    product: 'acme', site: 'https://acme.com',
    app: { name: 'Acme', url: 'http://127.0.0.1:3000', dir: 'app', guides: 'guides.json', reset: { post: 'http://127.0.0.1:3001/reset' } },
    looks: { product: { brand: 'brands/acme.json' }, showcase: { brand: 'brands/show.json' } },
    videos: videos ?? [
      { id: 'intro', kind: 'intro', guide: 'send', looks: ['product', 'showcase'], shapes: ['16:9', '1:1', '9:16'], voice: { product: 'intro.json', showcase: 'intro.json' }, alt: 'Acme sends one.' },
      { id: 'ad-paid', kind: 'ad', director: 'ad.mjs', shapes: ['9:16', '1:1'], polish: ['--title-card'], alt: 'An ad.' },
      { id: 'gif-send', kind: 'docs-gif', guide: 'send', alt: 'Send, as a GIF.' },
    ],
    ...over,
  };
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(c));
  return { dir, file: join(dir, 'campaign.json') };
}

describe('campaign file', () => {
  it('loads with its paths made absolute (the app\'s own files from its dir), and checks clean', () => {
    const { dir, file } = folder();
    const c = loadCampaign(file);
    expect(c.app.dir).toBe(join(dir, 'app'));
    expect(c.app.guides).toBe(join(dir, 'app', 'guides.json'));
    expect(c.looks.product.brand).toBe(join(dir, 'brands', 'acme.json'));
    expect(c.videos[1].director).toBe(join(dir, 'ad.mjs'));
    expect(c.videos[0].voice!.product).toBe(join(dir, 'intro.json'));
    expect(c.out).toBe(join(dir, 'out', 'acme'));
    expect(checkCampaign(c)).toEqual([]);
  });

  it('names every problem at once', () => {
    const { file } = folder({ site: 'acme.com', language: 'English', app: { url: 'localhost', guides: 'nope.json', reset: { get: 'x' } } }, [
      { id: 'Intro', kind: 'teaser', guide: 'missing', director: 'ad.mjs', looks: ['dark'], shapes: ['3:2'], alt: '' },
      { id: 'gif', kind: 'docs-gif', guide: 'missing', shapes: ['1:1'], voice: { product: 'gone.json' }, alt: 'x' },
      { id: 'gif', kind: 'ad', director: 'missing.mjs', mode: 'perform', shapes: ['1:1'], alt: 'x' },
    ]);
    const text = checkCampaign(loadCampaign(file)).join('\n');
    for (const m of [
      'site is the product\'s https address', 'language is two letters', 'app.url is where the app serves', 'app.reset is { "post": url }',
      'no guides file', 'bad video id Intro', 'Intro: kind is one of', 'Intro: a guide or a director script (one of them)', 'Intro: no alt text',
      'Intro: looks are some of product, showcase', 'Intro: shapes are some of', 'gif: a docs-gif has no shapes', 'gif: a GIF has no sound', 'gif: no script',
      'gif: id used twice', 'gif: no director script', 'gif: a director video has no mode',
    ]) expect(text).toContain(m);
    expect(() => readCampaign(file)).toThrow(/^campaign acme: /);
  });

  it('a narration script for lines the guide doesn\'t have is caught before filming', () => {
    const { dir, file } = folder();
    writeFileSync(join(dir, 'intro.json'), JSON.stringify({ lines: [{ n: 1, text: 'One.' }, { n: 5, text: 'Five.' }] }));
    expect(checkCampaign(loadCampaign(file))).toContain('intro: the product script has line 5, but the guide has 2 step(s)');
  });

  it('TRACE_AVATAR_APP_DIR says where the app is checked out', () => {
    const { dir, file } = folder();
    process.env.TRACE_AVATAR_APP_DIR = join(dir, 'elsewhere');
    try { expect(loadCampaign(file).app.guides).toBe(join(dir, 'elsewhere', 'guides.json')); } finally { delete process.env.TRACE_AVATAR_APP_DIR; }
  });

  it('renders: per look, a desktop capture for 16:9/1:1/4:5 (captions as a file) and a phone one for 9:16 (burned in)', () => {
    const c = loadCampaign(folder().file);
    const rs = rendersOf(c);
    expect(rs.map((r) => r.id)).toEqual(['intro--product', 'intro--product--phone', 'intro--showcase', 'intro--showcase--phone', 'ad-paid--product', 'ad-paid--product--phone', 'gif-send--product']);
    expect(rs[0]).toMatchObject({ shapes: ['16:9', '1:1'], phone: false, format: 'mp4', polish: ['--scale', '2', '--captions', 'vtt', '--poster'] });
    expect(rs[1]).toMatchObject({ shapes: ['9:16'], phone: true, polish: ['--scale', '2', '--frame', 'none', '--captions', 'burn', '--poster'] });
    expect(rs[4].polish.at(-1)).toBe('--title-card');
    expect(filesOf(rs[0])).toEqual([
      { key: 'mp4@16:9', name: 'intro--product-16x9.mp4', format: 'mp4', canvas: '16:9' },
      { key: 'mp4@1:1', name: 'intro--product-1x1.mp4', format: 'mp4', canvas: '1:1' },
    ]);
    expect(filesOf(rs[6])).toEqual([{ key: 'gif', name: 'gif-send--product.gif', format: 'gif' }]);
  });

  it('what a look ends with: its own words, else the brand\'s end card, else its watermark', () => {
    const c = loadCampaign(folder().file);
    expect(endsWithOf(c.looks.product)).toBe('For more info visit acme.com');
    expect(endsWithOf(c.looks.product, 'Start free at')).toBe('Start free at acme.com');
    expect(endsWithOf(c.looks.showcase)).toBe('Made with X · x.com');
    expect(endsWithOf({ ...c.looks.showcase, endsWith: 'Own words' })).toBe('Own words');
  });
});

describe('campaign progress', () => {
  it('kept while it runs; a stopped run carries on, keeping what it made; --fresh starts over; status says it all', () => {
    const out = mkdtempSync(join(tmpdir(), 'progress-'));
    const p = progressOf(out, ['a', 'b', 'c']);
    p.start('a', 1, 3); p.done('a'); p.start('b', 2, 3); p.fail('b', 'stalled at step 2: Save'); p.start('c', 3, 3);
    const now = Date.parse(p.state.current!.since) + 120_000;
    expect(statusOf({ product: 'acme', out }, now)).toMatch(/^acme: 1 of 3 made \(started \d+ min ago\)\n {2}now: \[3\/3\] c, for 2 min\n {2}✓ a\n {2}✗ b — stalled at step 2: Save\n {2}… c$/);
    const again = progressOf(out, ['c', 'b', 'a']);
    expect(again.resumed).toBe(true);
    expect([again.isDone('a'), again.isDone('b')]).toEqual([true, false]);
    expect(progressOf(out, ['a', 'b', 'c'], { fresh: true }).isDone('a')).toBe(false);
    // Another set of renders is a new run.
    expect(progressOf(out, ['a']).resumed).toBe(false);
    const done = progressOf(out, ['a']); done.done('a'); done.finish();
    expect(progressOf(out, ['a']).resumed).toBe(false);
    expect(statusOf({ product: 'none', out: join(out, 'nothing') })).toBe('none: no make run yet');
  });

  it('says: the captions and cards in order, from <id>.scenes.json', () => {
    const out = mkdtempSync(join(tmpdir(), 'says-'));
    writeFileSync(join(out, 'ad--product.scenes.json'), JSON.stringify([{ n: 1, caption: 'Get paid.' }, { n: 2, caption: ' ' }, { n: 3, caption: 'Marked paid.' }]));
    expect(saysOf({ out }, 'ad--product')).toEqual(['Get paid.', 'Marked paid.']);
    expect(saysOf({ out }, 'none')).toBeNull();
  });
});

describe('director helpers', () => {
  it('the look: brand first, the video\'s flags over it; its title on the brand\'s card', () => {
    const dir = mkdtempSync(join(tmpdir(), 'look-'));
    const brand = join(dir, 'b.json');
    writeFileSync(brand, JSON.stringify({ frame: 'browser', captions: 'vtt', endCard: { title: 'For more info visit', url: 'acme.com', color: '#123456' } }));
    const o = lookOptions({ title: 'Send one', endTitle: 'Start free at', polish: ['--captions', 'burn', '--title-card', '--poster', '--canvas', '1:1'] }, brand, 'Acme');
    expect(o).toMatchObject({ frame: 'browser', captions: 'burn', poster: true, canvas: '1:1' });
    expect(o.cards!.title).toEqual({ title: 'Send one', sub: 'Acme' });
    expect(o.cards!.end).toMatchObject({ title: 'Start free at', url: 'acme.com', color: '#123456', sub: 'Acme' });
    expect(lookOptions({ polish: [] })).toEqual({});
  });

  it('cards between scenes take the end card\'s look; the address only where asked', () => {
    const end = { title: 'x', url: 'acme.com', color: '#123456', sub: 'Acme' };
    expect(cardsOf([{ t: 10, ms: 2200, title: 'The problem.', step: 0 }, { t: 90, ms: 2200, title: 'Start free at', url: true, step: 7 }], { end })).toEqual([
      { t: 10, ms: 2200, step: 0, card: { color: '#123456', sub: 'Acme', title: 'The problem.' } },
      { t: 90, ms: 2200, step: 7, card: { color: '#123456', sub: 'Acme', title: 'Start free at', url: 'acme.com' } },
    ]);
    expect(cardsOf([{ t: 1, ms: 1, title: 'A', step: 0 }], {}, 'Acme')[0].card).toEqual({ sub: 'Acme', title: 'A' });
  });

  it('a narration script can\'t name a scene the video doesn\'t have', () => {
    expect([...sayFrom({ lines: [{ n: 1, text: ' Hi. ' }, { n: 2, text: '' }] }, 2)]).toEqual([[1, 'Hi.']]);
    expect(() => sayFrom({ lines: [{ n: 3, text: 'x' }] }, 2, 'ad')).toThrow('ad: the narration script has a line 3, but the video has 2 scene(s)');
  });

  it('the cursor: a human path, where it is at a time, drawn on the frames with a ring on a click', () => {
    const pts = pathOf({ x: 0, y: 0 }, { x: 400, y: 0 }, 400);
    expect(pts).toHaveLength(25);
    expect(pts.at(-1)!.x).toBe(400);
    expect(pts.at(-1)!.y).toBeCloseTo(0, 9);
    expect(travelMs(0)).toBe(380);
    expect(travelMs(5000)).toBe(1100);
    const moves = [{ t: 100, x: 0, y: 0 }, { t: 200, x: 100, y: 50 }];
    expect(cursorAt(moves, 150)).toEqual({ x: 50, y: 25 });
    expect(cursorAt([], 5)).toBeNull();
    const png = new PNG({ width: 80, height: 60 });
    png.data.fill(200);
    const shots = [{ t: 0, png: PNG.sync.write(png) }, { t: 1000, png: PNG.sync.write(png) }];
    expect(withCursor(shots, [{ t: 0, x: 10, y: 10 }], [])).toHaveLength(2);
    const moving = withCursor(shots, [{ t: 0, x: 10, y: 10 }, { t: 500, x: 60, y: 40 }], [{ t: 1000, x: 60, y: 40 }]);
    expect(moving.length).toBeGreaterThan(20);
    const sprite = arrowSprite(1.5);
    expect(sprite.width).toBeGreaterThan(20);
  });

  it('an alias: the public host answered by the local server, its API at api.<host>', () => {
    expect(aliasOf('http://127.0.0.1:3000')).toEqual({ url: 'http://127.0.0.1:3000', local: null, rewrite: [] });
    expect(aliasOf('http://127.0.0.1:3000/', { host: 'acme.com', api: 'http://127.0.0.1:3001', rewrite: ['/config.js'] })).toEqual({
      url: 'https://acme.com', local: 'http://127.0.0.1:3000', api: 'https://api.acme.com', localApi: 'http://127.0.0.1:3001', rewrite: ['/config.js'],
    });
  });
});

describe('cli: campaign', () => {
  const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) } }; };
  it('check says it is ready, or names the problems; status before any run; usage', async () => {
    const { file } = folder();
    const ok = io();
    expect(await main(['campaign', 'check', file], ok.io)).toBe(0);
    expect(ok.out[0]).toMatch(/acme, 3 videos in 2 looks — ready to make$/);
    const st = io();
    expect(await main(['campaign', 'status', file], st.io)).toBe(0);
    expect(st.out[0]).toBe('acme: no make run yet');
    const bad = folder({ site: 'acme.com' });
    const b = io();
    expect(await main(['campaign', 'check', bad.file], b.io)).toBe(1);
    expect(b.err[0]).toMatch(/site is the product's https address/);
    const u = io();
    expect(await main(['campaign', 'publish'], u.io)).toBe(2);
    expect(await main(['campaign', 'check', '/no/such/campaign.json'], u.io)).toBe(2);
    expect(JSON.parse(readFileSync(file, 'utf8')).product).toBe('acme');
  });
});
