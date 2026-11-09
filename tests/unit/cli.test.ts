import { describe, expect, it } from 'vitest';
import { main, parse, USAGE } from '../../src/cli';
import { mp4Args, findFfmpeg } from '../../src/mp4';
import { cardOf, formatOf } from '../../src/render';

describe('cli', () => {
  it('parses options into render options', () => {
    const p = parse(['a.trace.json', '--url', 'http://x/app', '--out', 'a.gif', '--out', 'a.mp4', '--mode', 'perform', '--allow-perform',
      '--width', '640', '--fps', '15', '--viewport', '1024x768', '--scale', '2', '--storage-state', 'auth.json', '--max-wait', '0',
      '--hide', '.dev', '--blur', '.email', '--blur', '.phone', '--allow-stall', '--player', 'p.js', '--timeline', 't.json', '--timeout', '5000', '--headed']);
    expect(p.trace).toBe('a.trace.json');
    expect(p.options).toEqual({
      trace: 'a.trace.json', url: 'http://x/app', mode: 'perform', allowPerform: true,
      out: [{ file: 'a.gif', width: 640, fps: 15 }, { file: 'a.mp4', width: 640, fps: 15 }],
      viewport: { w: 1024, h: 768 }, scale: 2, storageState: 'auth.json', cuts: { maxWaitMs: 0 },
      hide: ['.dev'], blur: ['.email', '.phone'], allowStall: true, player: 'p.js', timeline: 't.json', timeoutMs: 5000, headless: false,
    });
    expect(parse(['a.json', '--url', 'u', '--out', 'o.gif']).options).toMatchObject({ mode: 'overlay', allowPerform: false, allowStall: false, headless: true });
  });

  it('parses the polish flags; all off by default; optional values', () => {
    const base = ['a.trace.json', '--url', 'u', '--out', 'o.gif'];
    const none = parse(base).options;
    for (const k of ['frame', 'background', 'camera', 'captions', 'poster', 'titleCard', 'endCard']) expect(none).not.toHaveProperty(k);
    expect(parse([...base, '--frame', 'browser', '--background', '#123', '--camera', '--captions', 'both', '--poster', '--title-card', '--end-card']).options)
      .toMatchObject({ frame: 'browser', background: '#123', camera: true, captions: 'both', poster: true, titleCard: true, endCard: true });
    expect(parse([...base, '--zoom', '2', '--poster', 'p.png', '--title-card', 'Make an invoice', '--end-card=Try it']).options)
      .toMatchObject({ camera: { zoom: 2 }, poster: 'p.png', titleCard: 'Make an invoice', endCard: 'Try it' });
    // A trace after a value-less flag is still the trace.
    expect(parse(['--title-card', 'a.trace.json', '--url', 'u', '--out', 'o.gif'])).toMatchObject({ trace: 'a.trace.json', options: { titleCard: true } });
    expect(() => parse([...base, '--frame', 'mac'])).toThrow('--frame is none or browser');
    expect(() => parse([...base, '--captions', 'srt'])).toThrow('burn, vtt or both');
    expect(() => parse([...base, '--zoom', '0.5'])).toThrow('--zoom must be');
  });

  it('cards: true takes the fallback, a string the title, an object merges', () => {
    const fb = { title: 'How to', sub: 'Ren', color: '#f0a' };
    expect(cardOf(undefined, fb)).toBeUndefined();
    expect(cardOf(false, fb)).toBeUndefined();
    expect(cardOf(true, fb)).toEqual(fb);
    expect(cardOf('Pay a bill', fb)).toEqual({ ...fb, title: 'Pay a bill' });
    expect(cardOf({ title: 'X', sub: 'acme.com' }, fb)).toEqual({ title: 'X', sub: 'acme.com', color: '#f0a' });
  });

  it('wrong usage exits 2 with the reason and the usage; --help exits 0', async () => {
    const run = async (argv: string[]) => { const err: string[] = []; const code = await main(argv, { log: () => {}, error: (m: string) => err.push(m) }); return { code, err: err.join('\n') }; };
    for (const [argv, why] of [
      [[], 'a trace file is needed'], [['a', 'b', '--url', 'u', '--out', 'o.gif'], 'one trace at a time'], [['a'], '--url is needed'],
      [['a', '--url', 'u'], '--out is needed'], [['a', '--url', 'u', '--out', 'o.gif', '--mode', 'x'], 'overlay or perform'],
      [['a', '--url', 'u', '--out', 'o.gif', '--viewport', '10'], 'WIDTHxHEIGHT'], [['a', '--url', 'u', '--out', 'o.gif', '--fps', '0'], '--fps must be'],
    ] as const) {
      const r = await run([...argv]);
      expect(r.code, why).toBe(2);
      expect(r.err).toContain(why);
      expect(r.err).toContain('Usage:');
    }
    const h = await run(['--help']);
    expect(h.code).toBe(0);
    expect(h.err).toBe(USAGE);
    // A render that fails (here: Do it for me without --allow-perform) exits 1.
    const f = await run(['tests/e2e/fixtures/basic.trace.json', '--url', 'http://127.0.0.1:9/', '--out', 'o.gif', '--mode', 'perform']);
    expect(f.code).toBe(1);
    expect(f.err).toContain('--allow-perform');
  });

  it('knows its formats and the ffmpeg arguments', () => {
    expect(formatOf('x/A.GIF')).toBe('gif');
    expect(formatOf('a.mp4')).toBe('mp4');
    expect(() => formatOf('a.webm')).toThrow('use .gif or .mp4');
    expect(mp4Args('o.mp4', 30, { width: 640, height: 400 })).toEqual(['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '640x400', '-framerate', '30', '-i', '-',
      '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', '30', '-movflags', '+faststart', 'o.mp4']);
    expect(findFfmpeg({ FFMPEG: '/no/such/ffmpeg' })).toBeNull();
  });
});
