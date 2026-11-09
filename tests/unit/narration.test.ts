import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fromS16le, fromWav, mix, msOf, resample, toWav, trimSilence, TRACK_RATE } from '../../src/audio';
import { main, parse } from '../../src/cli';
import { mp4Args } from '../../src/mp4';
import { linesOf, narrationText, parseScript, planNarration, suggestScript } from '../../src/narration';
import { durationOf, frameTimes, outputAt, sourceAt, withHolds } from '../../src/timeline';
import { cached, geminiVoice, openAiVoice, voiceOf } from '../../src/voice';

const dir = mkdtempSync(join(tmpdir(), 'tar-narr-'));
const tone = (ms: number, rate = 24000, amp = 8000) => ({ pcm: Int16Array.from({ length: Math.round((ms * rate) / 1000) }, (_, i) => Math.round(amp * Math.sin(i / 5))), sampleRate: rate });

describe('holds in the edit list', () => {
  const segs = [{ from: 1000, to: 3000 }, { from: 5000, to: 6000 }];
  it('a hold freezes the frame at its place; later times move by it', () => {
    const h = withHolds(segs, [{ at: 500, ms: 700 }, { at: 2500, ms: 300 }]);
    expect(h).toEqual([{ from: 1000, to: 1500 }, { from: 1500, to: 1500, hold: 700 }, { from: 1500, to: 3000 }, { from: 5000, to: 5500 }, { from: 5500, to: 5500, hold: 300 }, { from: 5500, to: 6000 }]);
    expect(durationOf(h)).toBe(durationOf(segs) + 1000);
    expect(sourceAt(h, 600)).toBe(1500);
    expect(sourceAt(h, 1199)).toBe(1500);
    expect(sourceAt(h, 1300)).toBe(1600);
    expect(outputAt(h, 1500)).toBe(500);           // where it starts, not after the hold
    expect(outputAt(h, 2000)).toBe(500 + 700 + 500);
    expect(outputAt(h, 5800)).toBe(2000 + 700 + 800 + 300);
    expect(outputAt(h, 4000)).toBeNull();
    // Frames inside a hold all show the same source moment.
    const ft = frameTimes(h, 10);
    expect(new Set(ft.slice(6, 12))).toEqual(new Set([1500]));
  });
  it('a hold at the very end, and none at all', () => {
    expect(withHolds(segs, [{ at: 3000, ms: 400 }]).slice(-1)).toEqual([{ from: 6000, to: 6000, hold: 400 }]);
    expect(withHolds(segs, [])).toEqual(segs);
    expect(withHolds(segs, [{ at: 100, ms: 0 }])).toEqual(segs);
  });
});

describe('planning narration', () => {
  const acts = [{ index: 0, t: 1000 }, { index: 1, t: 3000 }, { index: 2, t: 4000 }];
  it('lines that fit need no hold', () => {
    const p = planNarration(acts, new Map([[0, { text: 'a', ms: 400 }], [1, { text: 'b', ms: 1000 }]]), 5000);
    expect(p.lines).toEqual([{ index: 0, text: 'a', start: 300, ms: 400 }, { index: 1, text: 'b', start: 1200, ms: 1000 }]);
    expect(p.holds).toEqual([]);
    expect(p.long).toEqual([]);
  });
  it('a long line holds before its step, exactly enough; later lines move with it', () => {
    const p = planNarration(acts, new Map([[1, { text: 'b', ms: 2500 }], [2, { text: 'c', ms: 500 }]]), 5000);
    // b: from 1200 to 3700; must end by 3000 - 250 → hold 950 at 2750.
    expect(p.holds[0]).toEqual({ at: 2750, ms: 950 });
    expect(p.lines[0]).toMatchObject({ start: 1200, ms: 2500 });
    // c: once b's step has acted (3000 + 950 + 200 = 4150); ends 4650, by 4000 + 950 − 250 = 4700: fits.
    expect(p.lines[1]).toMatchObject({ start: 4150, ms: 500 });
    expect(p.holds).toHaveLength(1);
  });
  it('the first line starts at 300; steps close together put the hold after the step before', () => {
    const p = planNarration([{ index: 0, t: 100 }, { index: 1, t: 300 }], new Map([[0, { text: 'a', ms: 1000 }], [1, { text: 'b', ms: 1000 }]]), 1000);
    expect(p.holds[0]).toEqual({ at: 0, ms: 1450 });          // 300 + 1000 − (100 − 250)
    expect(p.holds[1].at).toBe(100);                         // max(300 − 250, 100)
    // The track ends 400 ms after the last line.
    const last = p.lines[1];
    const total = 1000 + p.holds.slice(0, 2).reduce((a, h) => a + h.ms, 0) + p.endHoldMs;
    expect(last.start + last.ms + 400).toBeLessThanOrEqual(total);
  });
  it('a hold over the cap is reported; the video still holds', () => {
    const p = planNarration([{ index: 0, t: 500 }], new Map([[0, { text: 'long', ms: 9000 }]]), 1000);
    expect(p.long).toEqual([{ index: 0, ms: 9050 }]);
    expect(p.holds[0].ms).toBe(9050);
  });
  it('the script overrides captions; an empty line silences; a wrong step number is an error', () => {
    const steps = [{ say: 'Click New' }, {}, { say: 'Save' }];
    expect([...linesOf(steps)]).toEqual([[0, 'Click New'], [2, 'Save']]);
    expect([...linesOf(steps, { lines: [{ n: 2, text: ' Type the name ' }, { n: 3, text: '' }] })]).toEqual([[0, 'Click New'], [1, 'Type the name']]);
    expect(() => linesOf(steps, { lines: [{ n: 4, text: 'x' }] })).toThrow('step 4, but the trace has 3 steps');
    expect(() => parseScript({ lines: [{ n: '1', text: 'x' }] })).toThrow('{ "lines"');
    expect(parseScript({ lines: [{ n: 1, text: 'x', extra: 1 }] })).toEqual({ lines: [{ n: 1, text: 'x' }] });
    expect(narrationText([{ index: 0, text: 'Hi', start: 300, ms: 500 }, { index: 1, text: 'Save', start: 61_000, ms: 500 }], 1500)).toBe('[0:02] Hi\n[1:03] Save\n');
  });
});

describe('audio', () => {
  it('WAV round trip; stereo mixed down; raw s16le', () => {
    const p = tone(50);
    const back = fromWav(toWav(p.pcm, p.sampleRate));
    expect(back.sampleRate).toBe(24000);
    expect([...back.pcm]).toEqual([...p.pcm]);
    // A stereo WAV: header from toWav, patched to 2 channels.
    const st = toWav(Int16Array.from([100, 300, -100, -300]), 8000);
    const v = new DataView(st.buffer);
    v.setUint16(22, 2, true);
    expect([...fromWav(st).pcm]).toEqual([200, -200]);
    expect(() => fromWav(new Uint8Array(20))).toThrow('not a WAV');
    expect([...fromS16le(new Uint8Array([1, 0, 255, 255]))]).toEqual([1, -1]);
  });
  it('resampling keeps the length in time; silence trimmed at both ends with a little kept', () => {
    const p = tone(100);
    expect(resample(p.pcm, 24000, 48000).length).toBe(4800);
    expect(resample(p.pcm, 24000, 24000)).not.toBe(p.pcm);
    const padded = new Int16Array(24000 * 0.5);
    padded.set(p.pcm, 6000);
    const t = trimSilence({ pcm: padded, sampleRate: 24000 });
    expect(msOf(t)).toBeGreaterThan(100);
    expect(msOf(t)).toBeLessThan(100 + 2 * 40 + 1);
    expect(trimSilence({ pcm: new Int16Array(100), sampleRate: 24000 }).pcm.length).toBe(0);
  });
  it('mix: each line at its sample offset, faded at the edges, clipped, cut at the end', () => {
    const one = { pcm: new Int16Array(4800).fill(20000), sampleRate: 48000 }; // 100 ms
    const track = mix([{ start: 500, audio: one }, { start: 550, audio: one }, { start: 980, audio: one }], 1000);
    expect(track.length).toBe(TRACK_RATE);
    expect(track[24000 - 1]).toBe(0);                       // before the first line
    expect(track[24000]).toBe(0);                           // its first sample is faded to 0
    expect(track[24000 + 720]).toBe(20000);                  // past the 15 ms fade
    expect(track[26400 + 1000]).toBe(32767);                 // two lines overlap: clipped
    expect(track[track.length - 1]).toBeGreaterThan(0);      // the last line is cut at the end, not dropped
  });
});

describe('voices', () => {
  it('gemini: generateContent with audio out and the voice; reads the base64 PCM at its rate', async () => {
    const pcm = Buffer.from(new Int16Array([5, -5, 7]).buffer).toString('base64');
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm } }] } }] })));
    const v = geminiVoice({ url: 'https://gw/v1/gemini/', key: 'aik', bearer: true, voice: 'Puck', headers: { 'x-ai-feature': 'trace-avatar-voice' }, fetch: f as unknown as typeof fetch });
    expect(await v('Click Save')).toEqual({ pcm: new Int16Array([5, -5, 7]), sampleRate: 24000 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://gw/v1/gemini/models/gemini-2.5-flash-preview-tts:generateContent');
    expect(init!.headers).toMatchObject({ authorization: 'Bearer aik', 'x-ai-feature': 'trace-avatar-voice' });
    const body = JSON.parse(String(init!.body));
    expect(body.contents[0].parts[0].text).toBe('Click Save');
    expect(body.generationConfig).toEqual({ responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } } });
    const none = geminiVoice({ url: 'https://g', key: 'k', fetch: (async () => new Response(JSON.stringify({ candidates: [] }))) as unknown as typeof fetch });
    await expect(none('x')).rejects.toThrow('without audio');
  });
  it('openai: /audio/speech as raw pcm; retries a 503; never retries a gateway refusal', async () => {
    let n = 0;
    const f = vi.fn(async (_u: string, _i?: RequestInit) => (n++ === 0 ? new Response('busy', { status: 503 }) : new Response(new Uint8Array([2, 0, 254, 255]))));
    const v = openAiVoice({ baseUrl: 'http://localhost:8880/v1', model: 'kokoro', voice: 'af_bella', fetch: f as unknown as typeof fetch });
    expect(await v('Hello')).toEqual({ pcm: new Int16Array([2, -2]), sampleRate: 24000 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(f.mock.calls[1][1]!.body))).toEqual({ model: 'kokoro', voice: 'af_bella', input: 'Hello', response_format: 'pcm' });
    const g = vi.fn(async () => new Response(JSON.stringify({ error: { source: 'ai-interface', message: 'model not allowed' } }), { status: 403 }));
    await expect(openAiVoice({ baseUrl: 'http://x', model: 'm', fetch: g as unknown as typeof fetch })('x')).rejects.toThrow('refused the voice call: model not allowed');
    expect(g).toHaveBeenCalledTimes(1);
  });
  it('the cache: a line spoken once is read back, not asked again', async () => {
    const inner = vi.fn(async (t: string) => tone(t.length * 10));
    const c = cached(inner, 'say:Alex', join(dir, 'cache'));
    const a = await c('Click New');
    const b = await c('Click New');
    expect([...b.pcm]).toEqual([...a.pcm]);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(c.hits).toBe(1);
    await cached(inner, 'say:Fred', join(dir, 'cache'))('Click New'); // another voice is another line
    expect(inner).toHaveBeenCalledTimes(2);
  });
  it('voiceOf: gateway (Gemini) from the environment; openai; a .js file; anything else is a mistake', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: 'AQA=' } }] } }] })));
    await (await voiceOf('gateway', { AI_GATEWAY_URL: 'https://gw', AI_GATEWAY_KEY: 'k' }, { cacheDir: null, fetch: f as unknown as typeof fetch }))('x');
    expect(f.mock.calls[0][0]).toBe('https://gw/v1/gemini/models/gemini-2.5-flash-preview-tts:generateContent');
    await (await voiceOf('gateway:gemini/gemini-2.5-pro-preview-tts:Charon', { AI_GATEWAY_URL: 'https://gw', AI_GATEWAY_KEY: 'k' }, { cacheDir: null, fetch: f as unknown as typeof fetch }))('x');
    expect(f.mock.calls[1][0]).toContain('gemini-2.5-pro-preview-tts:generateContent');
    expect(JSON.parse(String(f.mock.calls[1][1]!.body)).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Charon');
    await expect(voiceOf('gateway', {})).rejects.toThrow('AI_GATEWAY_URL');
    await expect(voiceOf('openai:tts-1', {})).rejects.toThrow('OPENAI_API_KEY');
    const file = join(dir, 'voice.mjs');
    writeFileSync(file, 'export default async (t) => ({ pcm: new Int16Array(t.length), sampleRate: 8000 });');
    expect((await (await voiceOf(file, {}, { cacheDir: null }))('abc')).pcm.length).toBe(3);
    await expect(voiceOf('elevenlabs')).rejects.toThrow('--voice is');
  });
});

describe('cli: narration', () => {
  const base = ['a.trace.json', '--url', 'u', '--out', 'o.mp4'];
  it('parses --voice, --script, --voice-out, --voice-strict, --no-voice-cache; they need --voice and an MP4', () => {
    expect(parse([...base, '--voice', 'say', '--script', 's.json', '--voice-out', 'v.wav', '--voice-strict', '--no-voice-cache']))
      .toMatchObject({ voice: 'say', noVoiceCache: true, options: { script: 's.json', voiceOut: 'v.wav', voiceStrict: true } });
    expect(() => parse([...base, '--script', 's.json'])).toThrow('need --voice');
    expect(() => parse(['a.trace.json', '--url', 'u', '--out', 'o.gif', '--voice', 'say'])).toThrow('needs an .mp4 output');
  });
  it('the ffmpeg arguments with a narration track', () => {
    expect(mp4Args('o.mp4', 30, { width: 640, height: 400 }, 'n.wav')).toEqual(['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '640x400', '-framerate', '30', '-i', '-',
      '-i', 'n.wav', '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '128k',
      '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', '30', '-shortest', '-movflags', '+faststart', 'o.mp4']);
  });
  it('suggest --task narration writes a script from the steps (nothing typed sent), checked', async () => {
    const trace = join(dir, 'n.trace.json');
    writeFileSync(trace, JSON.stringify({ version: 1, meta: { title: 'x' }, steps: [
      { type: 'click', target: { role: 'button', name: 'New' }, say: 'Click New' },
      { type: 'type', target: { role: 'textbox', name: 'Customer' }, text: 'Grace Hopper' },
    ] }));
    const prov = join(dir, 'narr-ai.mjs');
    writeFileSync(prov, `import { appendFileSync } from 'node:fs';
export default async (task, input) => { appendFileSync(${JSON.stringify(join(dir, 'narr-sent.log'))}, JSON.stringify({ task, input })); return { lines: [{ n: 1, text: 'Start by clicking New.' }, { n: 2, text: 'Now type the customer name.' }, { n: 2, text: 'again' }, { n: 9, text: 'x' }] }; };`);
    const out = join(dir, 'script.json');
    const logs: string[] = [];
    expect(await main(['suggest', trace, '--task', 'narration', '--ai', prov, '--out', out], { log: (m) => logs.push(m), error: (m) => logs.push(m) })).toBe(0);
    const s = JSON.parse(readFileSync(out, 'utf8'));
    expect(s.lines).toEqual([{ n: 1, text: 'Start by clicking New.' }, { n: 2, text: 'Now type the customer name.' }]);
    expect(s.dropped).toEqual([{ n: 2, why: 'a second line for the step' }, { n: 9, why: 'no such step' }]);
    expect(logs.join()).toContain(`--script ${out}`);
    const sent = readFileSync(join(dir, 'narr-sent.log'), 'utf8');
    expect(sent).toContain('"task":"narration"');
    expect(sent).not.toContain('Grace Hopper');
    expect((await suggestScript(async () => ({}), JSON.parse(readFileSync(trace, 'utf8')))).script.lines).toEqual([]);
  });
});
