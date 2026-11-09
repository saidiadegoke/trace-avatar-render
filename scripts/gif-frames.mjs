// Dump frames of a GIF as PNGs (composited, as a viewer sees them): node scripts/gif-frames.mjs in.gif outdir t1 t2 …(seconds)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import omggif from 'omggif';
import { PNG } from 'pngjs';
const [file, dir, ...times] = process.argv.slice(2);
const r = new omggif.GifReader(new Uint8Array(readFileSync(file)));
mkdirSync(dir, { recursive: true });
const want = times.map(Number);
const canvas = new Uint8Array(r.width * r.height * 4);
let at = 0;
for (let i = 0, k = 0; i < r.numFrames() && k < want.length; i += 1) {
  r.decodeAndBlitFrameRGBA(i, canvas);
  const info = r.frameInfo(i);
  const next = at + info.delay * 10;
  while (k < want.length && want[k] * 1000 < next) {
    const png = new PNG({ width: r.width, height: r.height });
    png.data = Buffer.from(canvas);
    writeFileSync(`${dir}/t${want[k]}.png`, PNG.sync.write(png));
    k += 1;
  }
  at = next;
}
console.log(r.numFrames(), 'frames', at, 'ms');
