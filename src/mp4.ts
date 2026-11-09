/**
 * MP4 (H.264) through the system ffmpeg: PNG frames are piped in at a steady fps.
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

/** The ffmpeg arguments for frames piped in as PNG. Exported for tests. */
export function mp4Args(file: string, fps: number, width?: number): string[] {
  const scale = width ? `scale=${Math.round(width / 2) * 2}:-2` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  return [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-vf', `${scale}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(fps),
    '-movflags', '+faststart',
    file,
  ];
}

/** Write PNG frames (one per output frame, repeats allowed) to an MP4. */
export async function encodeMp4(pngs: Iterable<Buffer>, o: { file: string; fps: number; width?: number; ffmpeg?: string }): Promise<void> {
  const bin = o.ffmpeg ?? findFfmpeg();
  if (!bin) throw new Error('MP4 needs ffmpeg: install it (brew install ffmpeg, apt install ffmpeg) or set FFMPEG to its path. GIF works without it.');
  const p = spawn(bin, mp4Args(o.file, o.fps, o.width), { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += String(d); });
  const done = new Promise<void>((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${err.trim()}`))));
  });
  for (const png of pngs) {
    if (!p.stdin.write(png)) await new Promise<void>((r) => p.stdin.once('drain', () => r()));
  }
  p.stdin.end();
  await done;
}
