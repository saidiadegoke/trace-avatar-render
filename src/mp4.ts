/**
 * MP4 (H.264) through the system ffmpeg: composed RGBA frames are piped in at a steady fps.
 * The ffmpeg is FFMPEG, else one on the PATH, else ffmpeg-static (an optional dependency, installed with the
 * package where its platform has a build). Without any, MP4 output fails with a clear message.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const works = (bin: string) => {
  try { return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
};

/** ffmpeg-static's binary, when it is installed. */
function bundled(): string | null {
  try {
    const p = createRequire(import.meta.url)('ffmpeg-static') as string | null;
    return p && existsSync(p) ? p : null;
  } catch { return null; }
}

/** The ffmpeg to use, or null. `FFMPEG` is used as given (no fallback); else the PATH's; else ffmpeg-static's. */
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env, o: { bundled?: () => string | null } = {}): string | null {
  if (env.FFMPEG) return works(env.FFMPEG) ? env.FFMPEG : null;
  if (works('ffmpeg')) return 'ffmpeg';
  const b = (o.bundled ?? bundled)();
  return b && works(b) ? b : null;
}

/**
 * The ffmpeg arguments for raw RGBA frames of width×height piped in (the renderer composes them), and an
 * optional audio track (a WAV as long as the video). Exported for tests.
 */
/** What to say when there is no ffmpeg. */
export const FFMPEG_MISSING = 'MP4 needs ffmpeg: install ffmpeg-static (npm install ffmpeg-static), install ffmpeg (brew install ffmpeg, apt install ffmpeg), or set FFMPEG to its path. GIF works without it.';

export function mp4Args(file: string, fps: number, size: { width: number; height: number }, audio?: string): string[] {
  return [
    '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${size.width}x${size.height}`, '-framerate', String(fps), '-i', '-',
    ...(audio ? ['-i', audio, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '128k'] : []),
    '-vf', 'format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(fps),
    ...(audio ? ['-shortest'] : []),
    '-movflags', '+faststart',
    file,
  ];
}

/** Write RGBA frames (one per output frame, even width and height) to an MP4. */
export async function encodeMp4(frames: Iterable<Uint8Array>, o: { file: string; fps: number; width: number; height: number; ffmpeg?: string; audio?: string }): Promise<void> {
  const bin = o.ffmpeg ?? findFfmpeg();
  if (!bin) throw new Error(FFMPEG_MISSING);
  if (o.width % 2 || o.height % 2) throw new Error(`MP4 needs an even size (got ${o.width}×${o.height})`);
  const p = spawn(bin, mp4Args(o.file, o.fps, o, o.audio), { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += String(d); });
  const done = new Promise<void>((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${err.trim()}`))));
  });
  p.stdin.on('error', () => { /* ffmpeg died: `done` reports why */ });
  for (const f of frames) {
    if (p.exitCode !== null) break;
    if (!p.stdin.write(f)) {
      // Wait for room, or for ffmpeg to end; either way take both listeners off (one per frame would pile up).
      await new Promise<void>((r) => {
        const go = () => { p.stdin.off('drain', go); p.off('close', go); r(); };
        p.stdin.once('drain', go);
        p.once('close', go);
      });
    }
  }
  p.stdin.end();
  await done;
}
