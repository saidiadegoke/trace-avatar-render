/**
 * The check after filming (websites/docs/TRACE_AVATAR_STUDIO_V3.md §4), the same for guide and director videos:
 * frames are taken from the finished MP4, code flags blank ones, and an AI looks at the rest (runQa) with the video's
 * lines beside them.
 */
import { spawnSync } from 'node:child_process';
import type { Ai } from 'trace-avatar/assist';
import { runQa } from './ai';
import type { QaFlag } from './ai';

export interface CheckResult { flags: QaFlag[]; blank: number[]; frames: number; at: string }

/** A frame of the video at `s` seconds: a PNG (960 wide) and an 32×18 grey thumbnail for the blank test. */
function frameAt(ffmpeg: string, file: string, s: number): { png: Buffer; grey: Buffer } | null {
  const grab = (vf: string, codec: string[]) => spawnSync(ffmpeg, ['-v', 'error', '-ss', s.toFixed(2), '-i', file, '-frames:v', '1', '-vf', vf, ...codec, '-'], { maxBuffer: 20 * 1024 * 1024 });
  const png = grab('scale=960:-2', ['-f', 'image2pipe', '-vcodec', 'png']);
  const grey = grab('scale=32:18', ['-f', 'rawvideo', '-pix_fmt', 'gray']);
  if (png.status !== 0 || !png.stdout?.length || grey.status !== 0 || grey.stdout?.length !== 576) return null;
  return { png: png.stdout, grey: grey.stdout };
}

/** One colour all over (a white or black frame): the spread of its grey levels is tiny. */
export function isBlank(grey: Uint8Array): boolean {
  let sum = 0;
  for (const v of grey) sum += v;
  const mean = sum / grey.length;
  let sq = 0;
  for (const v of grey) sq += (v - mean) ** 2;
  return Math.sqrt(sq / grey.length) < 2;
}

/** The times frames are taken at: evenly through the video, `n` of them. */
export function checkTimes(seconds: number, n: number): number[] {
  return Array.from({ length: n }, (_, k) => Math.round(seconds * ((k + 0.5) / n) * 100) / 100);
}

/**
 * Checks a made MP4. `lines` are what it says, in order (shown to the AI as the video's steps). Frames: one per
 * line plus two, between 4 and 12.
 */
export async function checkVideo(o: { ai: Ai; file: string; seconds: number; ffmpeg: string; title?: string; lines?: string[] }): Promise<CheckResult> {
  const lines = o.lines ?? [];
  const n = Math.min(12, Math.max(4, lines.length + 2));
  const frames: Array<{ at: number; label: string; png: Uint8Array }> = [];
  const blank: number[] = [];
  for (const t of checkTimes(o.seconds, n)) {
    const f = frameAt(o.ffmpeg, o.file, t);
    if (!f) continue;
    if (isBlank(f.grey)) { blank.push(t); continue; }
    frames.push({ at: Math.round(t * 1000), label: `at ${t.toFixed(1)} s`, png: f.png });
  }
  const flags = frames.length ? await runQa(o.ai, frames, { ...(o.title ? { title: o.title } : {}), steps: lines.map((say, i) => ({ n: i + 1, type: 'line', say })) }) : [];
  return { flags, blank, frames: frames.length + blank.length, at: new Date().toISOString() };
}
