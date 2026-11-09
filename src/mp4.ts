/**
 * MP4 (H.264) through the system ffmpeg: composed RGBA frames are piped in at a steady fps.
 * There is no bundled ffmpeg; without one on the PATH (or FFMPEG), MP4 output fails with a clear message.
 */

import { spawn, spawnSync } from 'node:child_process';

/** The ffmpeg to use, or null. `FFMPEG` overrides the PATH. */
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  const bin = env.FFMPEG || 'ffmpeg';
  try {
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
    return r.status === 0 ? bin : null;
  } catch { return null; }
}

/** The ffmpeg arguments for raw RGBA frames of width×height piped in (the renderer composes them). Exported for tests. */
export function mp4Args(file: string, fps: number, size: { width: number; height: number }): string[] {
  return [
    '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${size.width}x${size.height}`, '-framerate', String(fps), '-i', '-',
    '-vf', 'format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(fps),
    '-movflags', '+faststart',
    file,
  ];
}

/** Write RGBA frames (one per output frame, even width and height) to an MP4. */
export async function encodeMp4(frames: Iterable<Uint8Array>, o: { file: string; fps: number; width: number; height: number; ffmpeg?: string }): Promise<void> {
  const bin = o.ffmpeg ?? findFfmpeg();
  if (!bin) throw new Error('MP4 needs ffmpeg: install it (brew install ffmpeg, apt install ffmpeg) or set FFMPEG to its path. GIF works without it.');
  if (o.width % 2 || o.height % 2) throw new Error(`MP4 needs an even size (got ${o.width}×${o.height})`);
  const p = spawn(bin, mp4Args(o.file, o.fps, o), { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += String(d); });
  const done = new Promise<void>((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${err.trim()}`))));
  });
  p.stdin.on('error', () => { /* ffmpeg died: `done` reports why */ });
  for (const f of frames) {
    if (p.exitCode !== null) break;
    if (!p.stdin.write(f)) await new Promise<void>((r) => { p.stdin.once('drain', r); p.once('close', r); });
  }
  p.stdin.end();
  await done;
}
