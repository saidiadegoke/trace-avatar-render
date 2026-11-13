/**
 * A campaign made end to end on the fixture app: a guide video (two shapes, narrated), a director video (a card and
 * scenes, a prop page served at the app's address, narrated from a script) and a docs GIF; the app reset before
 * each; a run stopped by a failure carries on where it stopped.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findFfmpeg, makeCampaign, readCampaign, statusOf } from '../../src/index';

const FIX = join(import.meta.dirname, 'fixtures');
let server: Server;
let base = '';
const resets: unknown[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/reset' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { resets.push(JSON.parse(body || '{}')); res.writeHead(204).end(); });
      return;
    }
    const file = join(FIX, decodeURIComponent(url.pathname));
    if (!file.startsWith(FIX) || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html; charset=utf-8' : 'application/json' }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe.runIf(!!findFfmpeg())('campaign make (Chromium)', () => {
  it('makes every look and shape, resets the app before each, writes scenes and made.json; a stopped run carries on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'campaign-e2e-'));
    mkdirSync(join(dir, 'props'));
    writeFileSync(join(dir, 'props', 'note.html'), '<!doctype html><h1 id="h">A prop page</h1>');
    writeFileSync(join(dir, 'brand.json'), JSON.stringify({ frame: 'browser', endCard: { title: 'For more info visit', url: 'fixture.test' } }));
    writeFileSync(join(dir, 'voice.mjs'), 'export default async (text) => ({ pcm: Int16Array.from({ length: 300 * 24 }, (_, i) => Math.round(6000 * Math.sin(i / 4))), sampleRate: 24000 });');
    writeFileSync(join(dir, 'show.product.json'), JSON.stringify({ lines: [{ n: 1, text: 'It loads.' }, { n: 2, text: 'Then save.' }] }));
    writeFileSync(join(dir, 'ad.product.json'), JSON.stringify({ lines: [{ n: 1, text: 'Save in one click.' }, { n: 2, text: 'Click Save.' }, { n: 3, text: 'And read the notes.' }] }));
    // The director script: fails while a marker file is there (a run stopped part way).
    writeFileSync(join(dir, 'ad.mjs'), `
      import { existsSync } from 'node:fs';
      export default async function (d) {
        if (existsSync(${JSON.stringify(join(dir, 'fail'))})) throw new Error('the check failed');
        await d.card('Save in one click.');
        await d.scene('Click Save.', async () => { await d.click(d.page.locator('#go')); await d.read(300); });
        await d.scene('Open the notes.', async () => {
          await d.open('/__props/note.html');
          if ((await d.page.locator('#h').textContent()) !== 'A prop page') throw new Error('no prop page');
        });
      }`);
    writeFileSync(join(dir, 'campaign.json'), JSON.stringify({
      product: 'fixture', site: 'https://fixture.test', narrator: join(dir, 'voice.mjs'),
      app: { name: 'Fixture', url: base, ready: '/app.html', reset: { post: `${base}/reset`, body: { seed: 1 } }, routes: { '/__props': 'props' } },
      looks: { product: { brand: 'brand.json' } },
      videos: [
        { id: 'intro', kind: 'intro', guide: join(FIX, 'show.trace.json'), page: '/app.html', shapes: ['16:9', '1:1'], voice: { product: 'show.product.json' }, polish: ['--title-card'], alt: 'It loads, then Save.' },
        { id: 'ad-save', kind: 'ad', director: 'ad.mjs', page: '/app.html', shapes: ['1:1'], voice: { product: 'ad.product.json' }, reset: { start: 'user' }, alt: 'An ad: Save.' },
        { id: 'gif-save', kind: 'docs-gif', guide: join(FIX, 'show.trace.json'), page: '/app.html', width: 320, alt: 'Save, as a GIF.' },
      ],
    }));
    const c = readCampaign(join(dir, 'campaign.json'));
    const log: string[] = [];

    writeFileSync(join(dir, 'fail'), '');
    const first = await makeCampaign(c, { log: (m) => log.push(m) });
    expect(first.failed).toEqual(['ad-save--product: the check failed']);
    expect(Object.keys(first.made).sort()).toEqual(['gif-save--product', 'intro--product']);
    expect(statusOf(c)).toMatch(/^fixture: 2 of 3 made .*\n {2}✓ intro--product\n {2}✗ ad-save--product — the check failed\n {2}✓ gif-save--product$/);
    expect(resets).toEqual([{ seed: 1 }, { seed: 1, start: 'user' }, { seed: 1 }]);

    rmSync(join(dir, 'fail'));
    log.length = 0;
    const second = await makeCampaign(c, { log: (m) => log.push(m) });
    expect(second.failed).toEqual([]);
    expect(log.join('\n')).toMatch(/carrying on a run that stopped: 2 of 3 already made/);
    expect(log.filter((l) => /made earlier in this run — kept/.test(l))).toHaveLength(2);
    expect(statusOf(c)).toMatch(/^fixture: 3 of 3 made — finished/);

    const made = JSON.parse(readFileSync(join(c.out, 'made.json'), 'utf8'));
    expect(made['intro--product']).toMatchObject({
      files: { 'mp4@16:9': 'intro--product-16x9.mp4', 'mp4@1:1': 'intro--product-1x1.mp4', poster: 'intro--product-16x9.png', vtt: 'intro--product-16x9.vtt' },
      narrated: true, video: 'intro', look: 'product',
    });
    expect(made['ad-save--product']).toMatchObject({ files: { 'mp4@1:1': 'ad-save--product-1x1.mp4', poster: 'ad-save--product-1x1.png', vtt: 'ad-save--product-1x1.vtt' }, narrated: true });
    expect(made['gif-save--product']).toMatchObject({ files: { gif: 'gif-save--product.gif' }, narrated: false, width: 320 });
    for (const m of Object.values(made) as Array<{ files: Record<string, string> }>) for (const f of Object.values(m.files)) expect(existsSync(join(c.out, f)), f).toBe(true);
    // Narrated, the captions say what is spoken; the card says its own line.
    const scenes = JSON.parse(readFileSync(join(c.out, 'ad-save--product.scenes.json'), 'utf8'));
    expect(scenes.map((s: { caption: string }) => s.caption)).toEqual(['Save in one click.', 'Click Save.', 'And read the notes.']);
    expect(readFileSync(join(c.out, 'intro--product-16x9.vtt'), 'utf8')).toContain('Then save.');
  }, 600_000);
});
