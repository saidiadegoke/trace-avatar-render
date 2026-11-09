// The README GIFs of trace-avatar: its vanilla example in both modes, rendered from its own fresh build.
//   node scripts/readme-gifs.mjs [path to the trace-avatar repo, default ../trace-avatar]
// Build trace-avatar first (npm run build there); the GIFs go to <repo>/media/.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { render } from '../dist/index.js';

const repo = resolve(process.argv[2] ?? '../trace-avatar');
const player = join(repo, 'dist', 'trace-perform.min.js');
if (!existsSync(player)) { console.error(`no ${player}: run npm run build in ${repo} first`); process.exit(2); }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = createServer((req, res) => {
  let file = join(repo, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file.startsWith(repo) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/examples/vanilla-html/?mode=off`;
const trace = join(repo, 'examples', 'vanilla-html', 'demo.trace.json');
try {
  for (const [mode, name] of [['overlay', 'show-me'], ['perform', 'do-it-for-me']]) {
    const r = await render({ trace, url, mode, allowPerform: true, player, hide: ['.modes'], out: [{ file: join(repo, 'media', `${name}.gif`), width: 800, fps: 12 }] });
    for (const o of r.outputs) console.log(`${o.file}  ${o.width}×${o.height}  ${(r.durationMs / 1000).toFixed(1)} s  ${(o.bytes / 1024).toFixed(0)} KB`);
  }
} finally { server.close(); }
