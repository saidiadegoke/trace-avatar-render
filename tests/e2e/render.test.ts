/**
 * End to end: the fixture app on a local server, the published trace-avatar player, real Chromium.
 * MP4 runs only where ffmpeg is installed.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import omggif from 'omggif';
import { RenderError, findFfmpeg, outputAt, render } from '../../src/index';
import { main } from '../../src/cli';

const FIX = join(import.meta.dirname, 'fixtures');
let server: Server;
let base = '';
/** What page 2 reported reached the masked field. */
const seen: string[] = [];
const out = mkdtempSync(join(tmpdir(), 'tar-e2e-'));

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/seen') { seen.push(url.searchParams.get('v') ?? ''); res.writeHead(204).end(); return; }
    const file = join(FIX, decodeURIComponent(url.pathname));
    if (!file.startsWith(FIX) || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html; charset=utf-8' : 'application/json' }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The frames as a viewer sees them, with their start times. */
function frames(file: string) {
  const g = new omggif.GifReader(new Uint8Array(readFileSync(file)));
  const canvas = new Uint8Array(g.width * g.height * 4);
  const list: Array<{ at: number; rgba: Uint8Array }> = [];
  let at = 0;
  for (let i = 0; i < g.numFrames(); i += 1) {
    g.decodeAndBlitFrameRGBA(i, canvas);
    list.push({ at, rgba: canvas.slice() });
    at += g.frameInfo(i).delay * 10;
  }
  return { g, list, total: at };
}
const frameAt = (list: Array<{ at: number; rgba: Uint8Array }>, t: number) => [...list].reverse().find((f) => f.at <= t)!;
/** Pixels near (x, y) close to a colour. */
function near(rgba: Uint8Array, w: number, x: number, y: number, r: number, c: [number, number, number]) {
  let n = 0;
  for (let yy = y - r; yy <= y + r; yy += 1) for (let xx = x - r; xx <= x + r; xx += 1) {
    const i = (yy * w + xx) * 4;
    if (Math.abs(rgba[i] - c[0]) + Math.abs(rgba[i + 1] - c[1]) + Math.abs(rgba[i + 2] - c[2]) < 90) n += 1;
  }
  return n;
}

describe('render (Chromium)', () => {
  it('Show me: cuts the app’s long wait, writes frames at the fps, the cursor is at the button when it clicks', async () => {
    const file = join(out, 'show.gif');
    const r = await render({ trace: join(FIX, 'show.trace.json'), url: `${base}/app.html`, out: [{ file, fps: 10 }], timeline: join(out, 'show.json') });
    expect(r.outputs[0]).toMatchObject({ format: 'gif', width: 640, height: 400, fps: 10 });
    // The 3 s "Loading…" wait is cut to 0.8 s.
    expect(r.rawMs - r.durationMs).toBeGreaterThan(1500);
    expect(r.segments.length).toBeGreaterThan(1);
    const { g, list, total } = frames(file);
    expect([g.width, g.height]).toEqual([640, 400]);
    expect(Math.abs(total - r.durationMs)).toBeLessThanOrEqual(100);
    expect(r.outputs[0].frames).toBe(Math.max(1, Math.round((r.durationMs / 1000) * 10)));
    // At the click, the avatar's colour (#ff00aa: badge and click ring) is around the Save button.
    const click = r.events.find((e) => e.type === 'step' && e.stepType === 'click')!;
    const t = outputAt(r.segments, click.t)!;
    expect(t).not.toBeNull();
    const f = frameAt(list, t + 150);
    expect(near(f.rgba, 640, 180, 124, 40, [255, 0, 170])).toBeGreaterThan(10);
    // Before the guide moves, nothing of it is there.
    expect(near(list[0].rgba, 640, 180, 124, 40, [255, 0, 170])).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'show.json'), 'utf8')).segments).toEqual(r.segments);
  });

  it('Do it for me across a full page load; a masked field gets only dots', async () => {
    const file = join(out, 'pages.gif');
    const r = await render({ trace: join(FIX, 'pages.trace.json'), url: `${base}/app.html`, mode: 'perform', allowPerform: true, out: [{ file, width: 320 }] });
    const types = r.events.map((e) => e.type);
    expect(types).toContain('handoff');
    expect(types).toContain('unload');
    expect(types).not.toContain('error');
    expect(r.events.find((e) => e.type === 'end')!.url).toBe('/page2.html');
    expect(r.outputs[0]).toMatchObject({ width: 320, height: 200 });
    // The "Saving…" → "Saved" wait (2.5 s) was cut.
    expect(r.rawMs - r.durationMs).toBeGreaterThan(1000);
    // The app saw only the dots in the masked field.
    expect(seen).toEqual(['|••••••']);
  });

  it('a stalled guide fails (RenderError, with a screenshot); --allow-stall renders it', async () => {
    const err = await render({ trace: join(FIX, 'stall.trace.json'), url: `${base}/app.html`, out: [join(out, 's.gif')] }).catch((e) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect(err.message).toContain('step 1 stalled (not-found)');
    expect(err.screenshot?.length).toBeGreaterThan(1000);
    const ok = await render({ trace: join(FIX, 'stall.trace.json'), url: `${base}/app.html`, out: [join(out, 's2.gif')], allowStall: true });
    expect(ok.outputs[0].bytes).toBeGreaterThan(0);
  });

  it('the CLI renders (exit 0) and fails a stall (exit 1, screenshot beside the output)', async () => {
    const logs: string[] = [];
    const io = { log: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    expect(await main([join(FIX, 'show.trace.json'), '--url', `${base}/app.html`, '--out', join(out, 'cli.gif'), '--fps', '8'], io)).toBe(0);
    expect(logs.join('\n')).toMatch(/cli\.gif {2}640×400 {2}8 fps/);
    expect(logs.join('\n')).toMatch(/cut \d+\.\d s of waiting/);
    expect(await main([join(FIX, 'stall.trace.json'), '--url', `${base}/app.html`, '--out', join(out, 'bad.gif')], io)).toBe(1);
    expect(existsSync(join(out, 'bad.failure.png'))).toBe(true);
  });

  it.runIf(!!findFfmpeg())('MP4 through ffmpeg', async () => {
    const file = join(out, 'show.mp4');
    const r = await render({ trace: join(FIX, 'show.trace.json'), url: `${base}/app.html`, out: [{ file, fps: 24 }] });
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames,pix_fmt', '-of', 'json', file], { encoding: 'utf8' });
    const s = JSON.parse(probe.stdout).streams[0];
    expect(s).toMatchObject({ width: 640, height: 400, pix_fmt: 'yuv420p' });
    expect(Number(s.nb_read_frames)).toBe(r.outputs[0].frames);
  });

  it('without ffmpeg, an MP4 fails before anything is captured', async () => {
    const was = process.env.FFMPEG;
    process.env.FFMPEG = '/no/such/ffmpeg';
    try {
      const t0 = Date.now();
      const err = await render({ trace: join(FIX, 'show.trace.json'), url: `${base}/app.html`, out: [join(out, 'x.mp4')] }).catch((e) => e);
      expect(err.message).toContain('MP4 needs ffmpeg');
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally { if (was === undefined) delete process.env.FFMPEG; else process.env.FFMPEG = was; }
  });
});
