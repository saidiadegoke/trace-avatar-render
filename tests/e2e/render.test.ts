/**
 * End to end: the fixture app on a local server, the published trace-avatar player, real Chromium.
 * MP4 runs only where ffmpeg is installed.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import omggif from 'omggif';
import { PNG } from 'pngjs';
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

  it('polish: a browser window, the camera, burned-in captions, title and end cards, VTT and a poster', async () => {
    const file = join(out, 'polish.gif');
    const r = await render({
      trace: join(FIX, 'show.trace.json'), url: `${base}/app.html`, out: [{ file, fps: 10 }],
      frame: 'browser', background: '#204060', camera: true, captions: 'both', poster: true, titleCard: true, endCard: 'All saved',
    });
    // A 640-wide capture in a window: the page stays 640 (never upscaled), plus padding and the bar.
    expect(r.outputs[0]).toMatchObject({ width: 696, height: 482 });
    expect(r.offsetMs).toBe(1500);
    const { g, list, total } = frames(file);
    expect(Math.abs(total - r.durationMs)).toBeLessThanOrEqual(100);
    const W = g.width;
    const px = (f: Uint8Array, x: number, y: number) => Array.from(f.subarray((y * W + x) * 4, (y * W + x) * 4 + 3));
    const close = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 40;
    // The title card: the background at the edges, a white panel in the middle.
    expect(close(px(list[0].rgba, 5, 5), [0x20, 0x40, 0x60])).toBe(true);
    expect(close(px(list[0].rgba, 348, 241 - 60), [255, 255, 255]) || close(px(list[0].rgba, 200, 241), [255, 255, 255])).toBe(true);
    // During the guide: background at the corner, the title bar (light grey), the app inside the window.
    const mid = frameAt(list, 1500 + 400).rgba;
    expect(close(px(mid, 3, 3), [0x20, 0x40, 0x60])).toBe(true);
    expect(close(px(mid, 160, 40), [0xee, 0xf0, 0xf4])).toBe(true); // the bar, left of the path
    const click = r.events.find((e) => e.type === 'step' && e.stepType === 'click')!;
    expect(click.rect).toMatchObject({ x: 100, y: 100, w: 160, h: 48 });
    expect(click.say).toBe('Save it');
    const at = r.offsetMs + outputAt(r.segments, click.t)!;
    const f = frameAt(list, at).rgba;
    // The burned-in caption: a dark box low in the window, centred.
    const capY = 482 - 28 - 20; // the content's bottom, less 5%
    let dark = 0;
    for (let x = 250; x < 450; x += 1) for (let y = capY - 30; y < capY; y += 1) { const [rr, gg, bb] = px(f, x, y); if (rr + gg + bb < 200) dark += 1; }
    expect(dark).toBeGreaterThan(500);
    // The end card shows last.
    expect(close(px(list[list.length - 1].rgba, 5, 5), [0x20, 0x40, 0x60])).toBe(true);
    // VTT beside the GIF, shifted by the title card.
    const vtt = readFileSync(r.vtt!, 'utf8');
    expect(r.vtt).toBe(join(out, 'polish.vtt'));
    expect(vtt).toMatch(/^WEBVTT\n\n1\n00:00:01\.500 --> /);
    expect(vtt).toContain('The app loads…');
    expect(vtt).toContain('Save it');
    expect(readFileSync(r.chapters!, 'utf8')).toContain('Save it');
    const poster = PNG.sync.read(readFileSync(r.poster!));
    expect([poster.width, poster.height]).toEqual([696, 482]);
    // The poster is the click: the avatar's pink is on it.
    expect(near(new Uint8Array(poster.data), 696, 348, 240, 200, [255, 0, 170])).toBeGreaterThan(10);
  });

  it('AI: qa looks at a frame per step (640 px PNGs), alt text and chapter names; strict qa fails the CLI', async () => {
    const calls: Array<{ task: string; input: unknown; images?: Array<{ png: Uint8Array; label: string }> }> = [];
    const ai = async (task: string, input: unknown, _schema: unknown, o: { images?: Array<{ png: Uint8Array; label: string }> }) => {
      calls.push({ task, input, images: o.images });
      if (task === 'qa') return { flags: [{ frame: 1, kind: 'empty', note: 'the status says Loading…' }] };
      return { alt: 'A cursor waits for the app, then clicks Save.', chapters: [{ n: 1, name: 'Wait for the app' }, { n: 2, name: 'Save' }] };
    };
    const file = join(out, 'ai.gif');
    const r = await render({ trace: join(FIX, 'show.trace.json'), url: `${base}/app.html`, out: [{ file, fps: 10 }], captions: 'vtt', ai: ai as never, qa: true, alt: true, titleCard: true });
    const qa = calls.find((c) => c.task === 'qa')!;
    expect(qa.images!.map((i) => i.label)).toEqual(['Frame 1: after step 1 (wait)', 'Frame 2: after step 2 (click)', 'Frame 3: the end']);
    const png = PNG.sync.read(Buffer.from(qa.images![0].png));
    expect(png.width).toBeLessThanOrEqual(640);
    expect(r.qa).toEqual([{ at: expect.any(Number), kind: 'empty', note: 'the status says Loading…' }]);
    expect(r.qa![0].at).toBeGreaterThanOrEqual(r.offsetMs); // times in the video, after the title card
    expect(readFileSync(r.alt!, 'utf8')).toBe('A cursor waits for the app, then clicks Save.\n');
    const chapters = readFileSync(r.chapters!, 'utf8');
    expect(chapters).toContain('Wait for the app');
    expect(chapters).toMatch(/00:00:01\.500 --> /); // after the title card
    // Strict qa through the CLI with a provider file: exit 1, the flag printed.
    const prov = join(out, 'qa-provider.mjs');
    writeFileSync(prov, "export default async (task) => task === 'qa' ? { flags: [{ frame: 2, kind: 'error', note: 'Error toast' }] } : {};");
    const logs: string[] = [];
    const io = { log: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    expect(await main([join(FIX, 'show.trace.json'), '--url', `${base}/app.html`, '--out', join(out, 'qa.gif'), '--ai', prov, '--qa', 'strict'], io)).toBe(1);
    expect(logs.join('\n')).toMatch(/qa: \d+\.\d s {2}error {2}Error toast/);
    expect(logs.join('\n')).toContain('(--qa strict)');
  });

  it('blurred elements are blurred in the video', async () => {
    const sharp = join(out, 'sharp.gif');
    const soft = join(out, 'soft.gif');
    await render({ trace: join(FIX, 'show.trace.json'), url: `${base}/app.html`, out: [sharp] });
    await render({ trace: join(FIX, 'show.trace.json'), url: `${base}/app.html`, out: [soft], blur: ['#go'] });
    /** The largest step between neighbouring pixels across the button's left edge (x 95..105, y 110..140). */
    const edge = (file: string) => {
      const f = frames(file).list[0].rgba;
      let max = 0;
      for (let y = 110; y < 140; y += 1) for (let x = 95; x < 105; x += 1) {
        const a = (y * 640 + x) * 4;
        max = Math.max(max, Math.abs(f[a] - f[a + 4]) + Math.abs(f[a + 1] - f[a + 5]) + Math.abs(f[a + 2] - f[a + 6]));
      }
      return max;
    };
    expect(edge(sharp)).toBeGreaterThan(60);
    expect(edge(soft)).toBeLessThan(edge(sharp) / 2);
  });

  it.runIf(!!findFfmpeg())('MP4 through ffmpeg', async () => {
    const file = join(out, 'show.mp4');
    const r = await render({ trace: join(FIX, 'show.trace.json'), url: `${base}/app.html`, out: [{ file, fps: 24 }] });
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames,pix_fmt', '-of', 'json', file], { encoding: 'utf8' });
    const s = JSON.parse(probe.stdout).streams[0];
    expect(s).toMatchObject({ width: 640, height: 400, pix_fmt: 'yuv420p' });
    expect(Number(s.nb_read_frames)).toBe(r.outputs[0].frames);
    // With the window and cards, the MP4 is the composed size.
    const framed = join(out, 'framed.mp4');
    const f = await render({ trace: join(FIX, 'show.trace.json'), url: `${base}/app.html`, out: [{ file: framed, fps: 24 }], frame: 'browser', titleCard: true });
    const p2 = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', framed], { encoding: 'utf8' }).stdout).streams[0];
    expect(p2).toMatchObject({ width: f.outputs[0].width, height: f.outputs[0].height });
    expect(Number(p2.nb_read_frames)).toBe(f.outputs[0].frames);
  });

  it.runIf(!!findFfmpeg())('narration: the voice speaks each line, the video holds where one runs long, the GIF keeps its timing', async () => {
    // A stand-in voice: a 440 Hz tone, 3 s for the first line (longer than the gap before its step), 0.6 s for the second.
    const said: string[] = [];
    const voice = async (text: string) => {
      said.push(text);
      const ms = text.startsWith('The app') ? 3000 : 600;
      return { pcm: Int16Array.from({ length: (ms * 24000) / 1000 }, (_, i) => Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 24000))), sampleRate: 24000 };
    };
    const mp4 = join(out, 'narrated.mp4');
    const gif = join(out, 'narrated.gif');
    const wav = join(out, 'narrated.wav');
    const r = await render({ trace: join(FIX, 'show.trace.json'), url: `${base}/app.html`, out: [{ file: mp4, fps: 24 }, { file: gif, fps: 10 }], voice, voiceOut: wav, titleCard: true, captions: 'vtt' });
    expect(said).toEqual(['The app loads…', 'Save it']);
    const n = r.narration!;
    expect(n.lines.map((l) => l.text)).toEqual(['The app loads…', 'Save it']);
    expect(n.holdMs).toBeGreaterThan(0);
    // The MP4 has sound; it is longer than the GIF by the holds (within a frame of each).
    const audio = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate', '-of', 'json', mp4], { encoding: 'utf8' }).stdout).streams[0];
    expect(audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000' });
    const [m, g] = r.outputs;
    expect(Math.abs(m.durationMs - g.durationMs - n.holdMs)).toBeLessThanOrEqual(1000 / 24 + 1000 / 10);
    // Each tone starts where it was planned (within a frame), after the title card.
    const track = readFileSync(wav);
    const pcm = new Int16Array(track.buffer.slice(track.byteOffset + 44, track.byteOffset + track.length));
    for (const l of n.lines) {
      expect(l.start).toBeGreaterThanOrEqual(r.offsetMs);
      const from = Math.round(((l.start - 200) * 48000) / 1000);
      let k = Math.max(0, from);
      while (k < pcm.length && Math.abs(pcm[k]) < 1500) k += 1;
      expect(Math.abs((k * 1000) / 48000 - l.start)).toBeLessThan(1000 / 24);
    }
    expect(pcm.length / 48).toBeCloseTo(m.durationMs, -2);
    // Inside a hold the picture doesn't move.
    let at = r.offsetMs;
    const hold = r.segments.find((sg) => { if (sg.hold) return true; at += sg.to - sg.from; return false; })!;
    expect(hold.hold).toBeGreaterThan(300);
    const grab = (ms: number) => spawnSync('ffmpeg', ['-v', 'error', '-ss', String(ms / 1000), '-i', mp4, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 }).stdout as Buffer;
    const a = grab(at + 80);
    const b = grab(at + hold.hold! - 80);
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff += Math.abs(a[i] - b[i]);
    expect(a.length).toBe(640 * 400);
    expect(diff / a.length).toBeLessThan(1);
    // The captions follow the held timeline: "Save it" ends 600 ms after its step acts in the video.
    const click = r.events.find((e) => e.type === 'step' && e.index === 1)!;
    const acts = outputAt(r.segments, click.t)! + r.offsetMs;
    const cues = readFileSync(r.vtt!, 'utf8').match(/(\d\d):(\d\d):(\d\d)\.(\d{3}) --> (\d\d):(\d\d):(\d\d)\.(\d{3})\nSave it/)!;
    const end = (+cues[5] * 3600 + +cues[6] * 60 + +cues[7]) * 1000 + +cues[8];
    expect(Math.abs(end - (acts + 600))).toBeLessThanOrEqual(2);
    expect(readFileSync(n.text, 'utf8')).toMatch(/^\[0:0\d\] The app loads…\n\[0:\d\d\] Save it\n$/);
  });

  it.runIf(!!findFfmpeg())('narration through the CLI: a voice file and a script; a line far too long fails --voice-strict', async () => {
    const voice = join(out, 'tone-voice.mjs');
    writeFileSync(voice, `export default async (text) => ({ pcm: Int16Array.from({ length: (text.includes('LONG') ? 9000 : 500) * 24 }, (_, i) => Math.round(8000 * Math.sin(i / 4))), sampleRate: 24000 });`);
    const script = join(out, 'script.json');
    writeFileSync(script, JSON.stringify({ lines: [{ n: 1, text: '' }, { n: 2, text: 'Now save it' }] }));
    const logs: string[] = [];
    const io = { log: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    const file = join(out, 'cli-voice.mp4');
    expect(await main([join(FIX, 'show.trace.json'), '--url', `${base}/app.html`, '--out', file, '--voice', voice, '--script', script, '--no-voice-cache'], io)).toBe(0);
    expect(logs.join('\n')).toMatch(/narration: 1 line/);
    expect(readFileSync(file.replace(/\.mp4$/, '.narration.txt'), 'utf8')).toMatch(/^\[0:\d\d\] Now save it\n$/);
    writeFileSync(script, JSON.stringify({ lines: [{ n: 2, text: 'A LONG line' }] }));
    logs.length = 0;
    expect(await main([join(FIX, 'show.trace.json'), '--url', `${base}/app.html`, '--out', join(out, 'cli-long.mp4'), '--voice', voice, '--script', script, '--no-voice-cache', '--voice-strict'], io)).toBe(1);
    expect(logs.join('\n')).toContain("step 2's line needs the video to hold");
  });

  it('repair: a renamed button is fixed by score (no AI) and verified; an unsure link is left to a person', async () => {
    const file = join(out, 'changed.gif');
    const err = await render({ trace: join(FIX, 'changed.trace.json'), url: `${base}/changed.html`, out: [file], repair: true, hide: ['.dev'] }).catch((e) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect(err.message).toContain('step 1 stalled (not-found)');
    expect(err.message).toMatch(/repair: 1 fix \(1 verified\); unresolved: step 2/);
    const rep = JSON.parse(readFileSync(join(out, 'changed.repair.json'), 'utf8'));
    expect(rep.passed).toBe(false);
    expect(rep.suggestions).toEqual([expect.objectContaining({ id: 1, task: 'repair', kind: 'target', index: 0, by: 'score', verified: true, before: 'button “Save the invoice”', value: 'button “Save invoice”', target: expect.objectContaining({ sel: '#store', role: 'button', name: 'Save invoice' }) })]);
    expect(rep.unresolved).toEqual([expect.objectContaining({ index: 1, reason: 'not-found' })]);
    const top = rep.unresolved[0].top.map((c: { name: string }) => c.name);
    expect(top).toContain('Continue');
    expect(top).not.toContain('Save (dev)');                // hidden areas are never offered
    expect(existsSync(file)).toBe(false);                    // nothing rendered: a person decides
  });

  it('repair with an AI for the unsure step: both fixed and verified; apply + render then plays to the end', async () => {
    const calls: Array<{ task: string; input: { candidates: Array<{ id: number; name: string }> } }> = [];
    const ai = async (task: string, input: unknown) => {
      calls.push({ task, input: input as never });
      const c = (input as { candidates: Array<{ id: number; name: string }> }).candidates.find((x) => x.name === 'Continue');
      return { id: c?.id ?? null, why: '"Next" became "Continue"' };
    };
    const file = join(out, 'changed-ai.gif');
    const err = await render({ trace: join(FIX, 'changed.trace.json'), url: `${base}/changed.html`, out: [file], repair: true, ai: ai as never }).catch((e) => e);
    expect(err.message).toMatch(/repair: 2 fixes \(2 verified, the guide now plays to the end\)/);
    expect(calls.map((c) => c.task)).toEqual(['repair']);   // the button was settled by score
    expect(JSON.stringify(calls[0].input)).not.toContain('"key"');
    const repFile = join(out, 'changed-ai.repair.json');
    const rep = JSON.parse(readFileSync(repFile, 'utf8'));
    expect(rep.passed).toBe(true);
    expect(rep.suggestions.map((x: { by: string; verified: boolean; why?: string }) => [x.by, x.verified])).toEqual([['score', true], ['ai', true]]);
    expect(rep.suggestions[1].why).toBe('"Next" became "Continue"');
    // A person accepts both; the repaired guide renders.
    const fixed = join(out, 'changed.fixed.trace.json');
    const logs: string[] = [];
    expect(await main(['apply', join(FIX, 'changed.trace.json'), repFile, '--accept', '1,2', '--out', fixed], { log: (m) => logs.push(m), error: (m) => logs.push(m) })).toBe(0);
    const r = await render({ trace: fixed, url: `${base}/changed.html`, out: [file] });
    expect(r.events.filter((e) => e.type === 'step').map((e) => e.index)).toEqual([0, 1]);
    expect(r.events.some((e) => e.type === 'stalled')).toBe(false);
  });

  it('repair through the CLI: exits 1 with where the fixes are; --repair-vision needs --ai', async () => {
    const logs: string[] = [];
    const io = { log: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    expect(await main([join(FIX, 'changed.trace.json'), '--url', `${base}/changed.html`, '--out', join(out, 'cli-changed.gif'), '--repair'], io)).toBe(1);
    expect(logs.join('\n')).toContain('cli-changed.repair.json, then: trace-avatar-render apply');
    expect(await main([join(FIX, 'changed.trace.json'), '--url', 'u', '--out', 'o.gif', '--repair-vision'], io)).toBe(2);
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
