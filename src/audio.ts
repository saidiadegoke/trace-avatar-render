/**
 * Mono 16-bit PCM: read and write WAV, resample, trim silence, and lay lines on one track. PURE.
 */

export interface Pcm { pcm: Int16Array; sampleRate: number }

/** The output track's rate. */
export const TRACK_RATE = 48000;

/** A WAV file (mono, 16-bit) for these samples. */
export function toWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const data = pcm.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (at: number, s: string) => { for (let i = 0; i < s.length; i += 1) v.setUint8(at + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + data, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, data, true);
  for (let i = 0; i < pcm.length; i += 1) v.setInt16(44 + i * 2, pcm[i], true);
  return new Uint8Array(buf);
}

/** Samples from a WAV file: 16-bit PCM, any number of channels (mixed down to mono). */
export function fromWav(bytes: Uint8Array): Pcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let at = 12;
  let rate = 0;
  let channels = 1;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    if (id === 'fmt ') {
      const format = v.getUint16(at + 8, true);
      channels = v.getUint16(at + 10, true);
      rate = v.getUint32(at + 12, true);
      const bits = v.getUint16(at + 22, true);
      if ((format !== 1 && format !== 0xfffe) || bits !== 16) throw new Error(`only 16-bit PCM WAV is read (format ${format}, ${bits} bits)`);
    } else if (id === 'data') {
      if (!rate) throw new Error('a WAV data chunk before its format');
      // Some writers (a pipe, a stream) leave the size at 0 or 0xffffffff: read to the end.
      const len = size === 0 || size === 0xffffffff || at + 8 + size > bytes.length ? bytes.length - at - 8 : size;
      const n = Math.floor(len / 2 / channels);
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i += 1) {
        let sum = 0;
        for (let c = 0; c < channels; c += 1) sum += v.getInt16(at + 8 + (i * channels + c) * 2, true);
        pcm[i] = Math.round(sum / channels);
      }
      return { pcm, sampleRate: rate };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('a WAV file without data');
}

/** Little-endian 16-bit samples from raw bytes. */
export function fromS16le(bytes: Uint8Array): Int16Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = v.getInt16(i * 2, true);
  return out;
}

/** Linear resampling. */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to || !pcm.length) return pcm.slice();
  const n = Math.max(1, Math.round((pcm.length * to) / from));
  const out = new Int16Array(n);
  const step = from / to;
  for (let i = 0; i < n; i += 1) {
    const x = i * step;
    const a = Math.min(pcm.length - 1, Math.floor(x));
    const b = Math.min(pcm.length - 1, a + 1);
    out[i] = Math.round(pcm[a] + (pcm[b] - pcm[a]) * (x - a));
  }
  return out;
}

/** Without the silence at either end (below `level`), keeping `padMs` of it. All silence gives nothing. */
export function trimSilence(p: Pcm, o: { level?: number; padMs?: number } = {}): Pcm {
  const level = o.level ?? 400;
  const pad = Math.round(((o.padMs ?? 40) * p.sampleRate) / 1000);
  let a = 0;
  while (a < p.pcm.length && Math.abs(p.pcm[a]) < level) a += 1;
  if (a === p.pcm.length) return { pcm: new Int16Array(0), sampleRate: p.sampleRate };
  let b = p.pcm.length - 1;
  while (b > a && Math.abs(p.pcm[b]) < level) b -= 1;
  return { pcm: p.pcm.slice(Math.max(0, a - pad), Math.min(p.pcm.length, b + 1 + pad)), sampleRate: p.sampleRate };
}

export const msOf = (p: Pcm): number => (p.pcm.length * 1000) / p.sampleRate;

/**
 * One track `totalMs` long at TRACK_RATE: each line from its start (ms), with a short fade in and out, summed
 * and clipped. A line that runs past the end is cut there.
 */
export function mix(lines: ReadonlyArray<{ start: number; audio: Pcm }>, totalMs: number, o: { fadeMs?: number } = {}): Int16Array {
  const out = new Float64Array(Math.max(0, Math.round((totalMs * TRACK_RATE) / 1000)));
  const fade = Math.round(((o.fadeMs ?? 15) * TRACK_RATE) / 1000);
  for (const l of lines) {
    const s = resample(l.audio.pcm, l.audio.sampleRate, TRACK_RATE);
    const at = Math.round((l.start * TRACK_RATE) / 1000);
    const f = Math.min(fade, Math.floor(s.length / 2));
    for (let i = 0; i < s.length; i += 1) {
      const k = at + i;
      if (k < 0) continue;
      if (k >= out.length) break;
      const g = f ? Math.min(1, i / f, (s.length - 1 - i) / f) : 1;
      out[k] += s[i] * g;
    }
  }
  const pcm = new Int16Array(out.length);
  for (let i = 0; i < out.length; i += 1) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(out[i])));
  return pcm;
}
