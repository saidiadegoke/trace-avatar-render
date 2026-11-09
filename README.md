# trace-avatar-render

Turn a [trace-avatar](https://github.com/saidiadegoke/trace-avatar) guide into a **GIF** or an **MP4** by playing it
on your real app in headless Chromium.

```bash
npx playwright install chromium      # once
npx trace-avatar-render invoice.trace.json --url http://localhost:3000/app --out invoice.gif
```

```
invoice.gif  800×500  12 fps  9.6 s  210 KB
cut 4.2 s of waiting
```

Because the guide is known before it plays, the render can do what a screen recorder can't:

- **Long waits are cut.** While the app loads or saves ("Saving…" → "Saved"), the player is waiting; anything
  longer than `--max-wait` (default 0.8 s) keeps its first and last 0.4 s and loses the middle.
- **A stalled guide fails the render** (exit code 1, with a screenshot of the page at that moment). Run it in CI and
  a GIF in your docs that no longer matches the app fails the build. `--allow-stall` renders it anyway.
- **Masked fields only ever get dots.** Do it for me hands a masked field to the viewer; the render types the
  trace's bullets there, so no real text is ever in the app or the file.
- **A guide that crosses full page loads** keeps playing: the player is injected into every page.

## Options

| | |
|---|---|
| `--url <url>` | the page the guide starts on (required) |
| `--out <file>` | `.gif` or `.mp4`, repeatable (required) |
| `--mode overlay\|perform` | Show me (default) or Do it for me |
| `--allow-perform` | needed for Do it for me: it clicks and types in the app for real. **Use a sandbox account.** |
| `--width <px>` | output width (GIF default 800, MP4 the capture's) |
| `--fps <n>` | GIF default 12, MP4 30 |
| `--viewport <WxH>` | default: the trace's `meta.viewport`, else 1280x800 |
| `--scale <n>` | device pixel ratio of the capture; 2 makes video text crisp |
| `--storage-state <file>` | a signed-in Playwright session ([how to save one](https://playwright.dev/docs/auth)) |
| `--max-wait <ms>` | waits longer than this are cut to it; 0 keeps them |
| `--hide <selector>` | hidden before capture (your dev toolbars); repeatable |
| `--blur <selector>` | blurred before capture, as well as `[data-trace-blur]` in your app; repeatable |
| `--allow-stall` | render a stalled guide instead of failing |
| `--player <file>` | the `trace-perform.min.js` to use (default: the installed trace-avatar; or set `TRACE_AVATAR_PLAYER`) |
| `--timeline <file>` | write the player's events and the cuts as JSON |
| `--timeout <ms>` | give up after this long (default 120000) |
| `--headed` | watch the browser |

Exit codes: 0 rendered, 1 the render failed, 2 wrong usage.

**MP4 needs ffmpeg** on the PATH (or `FFMPEG=/path/to/ffmpeg`): `brew install ffmpeg`, `apt install ffmpeg`. GIF
needs nothing else (it uses [gifenc](https://github.com/mattdesl/gifenc), pure JS).

## From code

```js
import { render } from 'trace-avatar-render';

const r = await render({
  trace: './invoice.trace.json',            // or the trace object
  url: 'http://localhost:3000/app',
  mode: 'overlay',
  out: ['invoice.gif', { file: 'invoice.mp4', fps: 30 }],
  storageState: './auth.json',
});
r.durationMs; r.rawMs; r.outputs;           // after cuts, as played, the files written
```

`render` rejects with a `RenderError` (with `.screenshot`) when the guide stalls, errors, or can't start.

## How it works

```
trace ──► headless Chromium at meta.viewport, trace-perform.min.js + an event logger in every page
          │  player events (state, step, stalled, handoff, end) and page loads, timestamped
          │  frames from Chromium's screencast, on the same clock
          ▼
       edit list: keep everything except the middle of each long wait
          ▼
       frames at the target fps ──► GIF (one palette, unchanged pixels transparent) · MP4 (ffmpeg, H.264)
```

A guide's own pause steps (and Do it for me's hand-offs) are held for 1.2 s, then it plays on: a video can't wait
for a viewer.

## Not yet

Planned: a browser frame, auto camera zoom, burned-in captions and VTT files, poster frames, title cards, and
narration. In-browser export ("Save as video" without a server) will be a separate entry in trace-avatar.

## Developing

`npm test` (unit), `npm run test:e2e` (real Chromium against `tests/e2e/fixtures`; the MP4 test runs only where
ffmpeg is installed). `node scripts/readme-gifs.mjs ../trace-avatar` rebuilds trace-avatar's README GIFs from its
fresh build. `node scripts/gif-frames.mjs file.gif dir 2 6` dumps frames at those seconds to look at.

MIT
