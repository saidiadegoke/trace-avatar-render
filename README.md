# trace-avatar-render

Turn a [trace-avatar](https://github.com/saidiadegoke/trace-avatar) guide into a **GIF** or an **MP4** by playing it
on your real app in headless Chromium.

```bash
npm i -D trace-avatar-render         # or run it with npx
npx playwright install chromium      # once
npx trace-avatar-render invoice.trace.json --url http://localhost:3000/app --out invoice.gif
```

Node 20 or later. GIFs need nothing else; MP4 needs ffmpeg (below).

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
| `--navigate` | when a step is on another page, load that page as your app's router would. Without it, a Show me guide that crosses pages waits on "Open … to continue" |
| `--security [guards]` | Do it for me: leave these to the viewer, as trace-avatar's `security`: `all`, or `secrets,money,files`. A hand-off is held for a beat, then the guide plays on |
| `--value name=text` | Do it for me: a value to type, by name or field label (`password=demo-pass`), as trace-avatar's `values`; repeatable. A password field still shows bullets |
| `--player <file>` | the `trace-perform.min.js` to use (default: the installed trace-avatar; or set `TRACE_AVATAR_PLAYER`) |
| `--timeline <file>` | write the player's events and the cuts as JSON |
| `--timeout <ms>` | give up after this long (default 120000) |
| `--headed` | watch the browser |

**Polish** (all off by default):

| | |
|---|---|
| `--frame browser` | the app in a browser window (title bar with the page path and title) on a background |
| `--background <css>` | a colour or gradient behind the window and on the cards |
| `--camera` | zoom in on each click and typing step before it happens, pan between close ones, back out between bursts; never on scrolls, at most one zoom change per 1.5 s. Pair with `--scale 2` for crisp zooms |
| `--zoom <n>` | how far the camera goes in (default 1.6); implies `--camera` |
| `--captions burn\|vtt\|both` | `burn` draws the steps' words low in the picture (the player's own bubble is then off); `vtt` writes `<out>.vtt` and `<out>.chapters.vtt` beside the first output |
| `--captions-at top\|bottom` | where burned-in captions sit (default `bottom`); `top` when the app's own UI is low on the page (a toolbar, a card, a cookie bar) |
| `--poster [file]` | a PNG at the first click (default `<out>.png`) |
| `--title-card [title]` | 1.5 s first: the trace's title and the avatar, or your title; fades into the guide |
| `--end-card [title]` | 2 s last: "Done", or your text (e.g. a URL) |
| `--canvas <shape>` | compose onto `9:16` (1080×1920), `4:5`, `1:1`, `16:9` or `WxH`: the app between safe margins on the background, captions sized to the canvas and below the app; `--width` scales the canvas. For a phone-shaped clip, capture at `--viewport 390x844 --scale 2` |
| `--watermark <text>` | a small badge on every frame, cards included (never zoomed by the camera; captions keep clear of it) |
| `--watermark-at <corner>` | `top-left`, `top-right`, `bottom-left` or `bottom-right` (default) |
| `--brand <file.json>` | the look in one file (below); flags given on the command line win over it |

```sh
trace-avatar-render invoice.trace.json --url http://localhost:3000/app --out invoice.mp4 \
  --scale 2 --frame browser --camera --captions both --poster --title-card --end-card "acme.com/invoices"
```

**A brand** keeps every clip of a product looking the same, in every shape:

```json
{
  "frame": "browser",
  "background": "linear-gradient(135deg, #e6eefc, #e9f6f1)",
  "watermark": { "text": "Made by Acme", "at": "bottom-right", "logo": "acme-mark.svg" },
  "endCard": { "title": "For more info visit", "url": "acme.com", "logo": "acme-logo.png", "color": "#2456d8" }
}
```

```sh
trace-avatar-render invoice.trace.json --url http://localhost:3000/app --brand acme.json --canvas 9:16 \
  --viewport 390x844 --scale 2 --captions burn --out invoice-reel.mp4
```

Exit codes: 0 rendered, 1 the render failed, 2 wrong usage.

**MP4 needs ffmpeg** on the PATH (or `FFMPEG=/path/to/ffmpeg`): `brew install ffmpeg`, `apt install ffmpeg`. GIF
needs nothing else (it uses [gifenc](https://github.com/mattdesl/gifenc), pure JS).

**AI** (nothing calls a model without `--ai`):

| | |
|---|---|
| `--ai <provider>` | `gateway`: an AI gateway that forwards each provider's own API (`AI_GATEWAY_URL`, `AI_GATEWAY_KEY`), DeepSeek first (usually the cheapest), then Gemini, then OpenAI; `gateway:<provider>[/<model>][,<provider>…]` for another order; `openai:<model>` (`OPENAI_API_KEY`; `OPENAI_BASE_URL` for any OpenAI-compatible server, e.g. Ollama), or `./provider.js` whose default export is `(task, input, schema, { instructions, images }) => json` |
| `--ai-vision <model>` | the model for `--qa`'s frames (the gateway's DeepSeek default is `deepseek-flash`) |
| `--qa [strict]` | sends a frame after each step and the last one (640 px) to the AI, which flags error messages, empty states, a stuck "Looking for …", personal data on screen or a wrong page. `strict` exits 1 when anything is flagged. Needs a vision model |
| `--alt` | writes `<out>.alt.txt`; with `--captions vtt` the AI names the chapters |

The renderer never changes a trace. Suggestions go to a file, and a person picks what goes in:

```sh
trace-avatar-render suggest invoice.trace.json --task captions --ai gateway --out suggestions.json
trace-avatar-render apply invoice.trace.json suggestions.json --accept 1,3 --out invoice.trace.json
```

What is sent and never sent is the same as in the studio ([trace-avatar's AI suggestions](https://github.com/saidiadegoke/trace-avatar#ai-suggestions-optional));
frames are sent only with `--qa`.

**Repair** (`--repair`): when a step can't find its element, the renderer looks at the page as it is now, picks
what the step means, and re-records that element as the step's target. Code scores the candidates first; an AI
is asked only when unsure (with `--ai`, DeepSeek first; `--repair-vision` adds a screenshot). Each fix is verified by
playing the guide again, up to 5 stalls in one run. The fixes go to `<out>.repair.json` with
`verified`, how each was chosen and, for an unresolved step, the best 3 candidates. The render still exits 1.

A wait whose text never showed (`until-timeout`: it waited for "Saved", the app now says "Changes stored") is
repaired the same way, with a fix of `kind: 'until'`. The candidates are the short texts where the wait looks, plus
those that showed while it waited (a message that came and went counts). When no text is a clear winner and no AI
settles it, the best one that scores well, else what the app showed after the action, is offered as
`by: 'guess'`; it is kept only when playing the guide again gets past the wait. `--hide` and `--blur` areas are
never offered:

```sh
trace-avatar-render invoice.trace.json --url … --out invoice.gif --repair --ai gateway
trace-avatar-render apply invoice.trace.json invoice.repair.json --accept 1,2 --out invoice.trace.json
```

**Narration** (MP4; nothing speaks without `--voice`):

| | |
|---|---|
| `--voice <voice>` | `gateway`: Gemini speech through an AI gateway (`AI_GATEWAY_URL`, `AI_GATEWAY_KEY`; `gateway:gemini/<model>:<voice>`, default `gemini-2.5-flash-preview-tts`, Kore). DeepSeek would go first, but it has no speech API. `openai:<model>[:<voice>]`: `/audio/speech` at `OPENAI_BASE_URL` (OpenAI, or a local server such as Kokoro). `say[:<voice>]`: macOS, offline and free. Or `./voice.js`, whose default export is `(text) => ({ pcm: Int16Array, sampleRate })` |
| `--script <file.json>` | the spoken lines, `{ "lines": [{ "n": 1, "text": "…" }] }`; by default each step's caption is spoken. An empty line silences a step |
| `--voice-out <file.wav>` | also write the narration track |
| `--voice-strict` | fail when a line needs the video to hold longer than 8 s (otherwise a warning) |
| `--no-voice-cache` | spoken lines are kept in `.trace-avatar-cache/voice` by (voice, text), so a re-render pays only for changed lines |

Each line plays while the cursor travels to its step. Where a line is longer than that, the video holds on the frame
just before the step until the line ends, so the voice never talks over an action. Captions, chapters and the QA
frames move with the holds. GIFs from the same render keep the original timing. The script goes to
`<out>.narration.txt`. `suggest --task narration` drafts spoken lines from the steps (nothing typed is sent) for a
person to edit and pass with `--script`.

## From code

```js
import { render } from 'trace-avatar-render';

const r = await render({
  trace: './invoice.trace.json',            // or the trace object
  url: 'http://localhost:3000/app',
  mode: 'overlay',
  out: ['invoice.gif', { file: 'invoice.mp4', fps: 30 }],
  storageState: './auth.json',
  frame: 'browser', camera: true, captions: 'both', poster: true, titleCard: true,   // optional polish
});
r.durationMs; r.rawMs; r.outputs;           // the video's length, as played, the files written
r.poster; r.vtt; r.chapters;                // with those options
r.offsetMs + outputAt(r.segments, t);       // where a moment of the capture lands in the video
// With an AI: render({ …, ai, qa: true, alt: true }) → r.qa (flags with times), r.alt (the .alt.txt file)
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
       frames at the target fps
          ▼
       compose: background + window (drawn once per page by Chromium), the camera's view of the capture,
                a burned-in caption, title / end cards with a fade
          ▼
       GIF (one palette, unchanged pixels transparent, written frame by frame) · MP4 (ffmpeg, raw RGBA in, H.264)
```

The camera is a pure function of the steps' positions and times, so the same trace gives the same camera.

A guide's own pause steps (and Do it for me's hand-offs) are held for 1.2 s, then it plays on: a video can't wait
for a viewer.

## Not yet

Planned: click sounds, other languages, a phone frame, both modes in one file. For a video without a server, trace-avatar's own
[Save as video](https://github.com/saidiadegoke/trace-avatar#save-as-video-in-the-browser) records the guide in the viewer's browser.

## Developing

`npm test` (unit), `npm run test:e2e` (real Chromium against `tests/e2e/fixtures`; the MP4 and narration tests run only
where ffmpeg is installed, as in CI). `npm run live:ai [-- deepseek openai gemini]` makes real calls through the AI
gateway (`AI_GATEWAY_URL`, `AI_GATEWAY_KEY`, or a git-ignored `.env.live`): captions, a title, alt text and a visual
check, per provider. `node scripts/readme-gifs.mjs ../trace-avatar` rebuilds trace-avatar's README GIFs from its
fresh build. `node scripts/gif-frames.mjs file.gif dir 2 6` dumps frames at those seconds to look at.

MIT
