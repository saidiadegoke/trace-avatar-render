import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeMp4 } from '../../src/mp4';

/** A stand-in ffmpeg that reads its input slowly (so writes back up) and exits with `code`. */
function fakeFfmpeg(code = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'tar-ff-'));
  const bin = join(dir, 'ffmpeg');
  // Pauses after every chunk, so the writer's buffer fills and it has to wait for 'drain'.
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdin.on('data', () => { process.stdin.pause(); setTimeout(() => process.stdin.resume(), 1); });\nprocess.stdin.on('end', () => process.exit(${code}));\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const warnings: Error[] = [];
const onWarn = (w: Error) => { warnings.push(w); };
afterEach(() => { process.off('warning', onWarn); warnings.length = 0; });

describe('encodeMp4', () => {
  it('waits for ffmpeg when its input backs up, without piling up listeners', async () => {
    process.on('warning', onWarn);
    const frame = new Uint8Array(512 * 512 * 4);
    function* frames() { for (let k = 0; k < 20; k += 1) yield frame; }
    await encodeMp4(frames(), { file: join(tmpdir(), 'x.mp4'), fps: 30, width: 512, height: 512, ffmpeg: fakeFfmpeg() });
    await new Promise((r) => setTimeout(r, 20));
    expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
  }, 30_000);

  it('a failing ffmpeg is reported', async () => {
    const frame = new Uint8Array(64 * 64 * 4);
    await expect(encodeMp4([frame, frame], { file: join(tmpdir(), 'y.mp4'), fps: 30, width: 64, height: 64, ffmpeg: fakeFfmpeg(3) })).rejects.toThrow(/ffmpeg exited with 3/);
  });
});
