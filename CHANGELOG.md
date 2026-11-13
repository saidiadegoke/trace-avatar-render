# Changelog

## 0.2.0 (unreleased)

- **Campaigns** (`campaign.json`): a product's marketing videos, made on the real app in every look and shape.
  - `trace-avatar-render campaign check | make | status [campaign.json]`, and `readCampaign`, `makeCampaign`,
    `statusOf`, `rendersOf`, `filesOf`, `endsWithOf`, `saysOf` from code.
  - Per video and look: one desktop capture written as 16:9, 1:1 and 4:5 (captions as a file), and a phone capture
    (390×844) for 9:16 with captions burned in. A video is a guide or a director script.
  - The app: started with `--start` (`app.start`, ready at `app.ready` or when it prints `app.readyText`), put back
    to a known state before each video (`app.reset`: `{ post }` or `{ run }`, with the video's `reset` as its body),
    signed in with `app.storageState` or a session module (`storageStateFor(url, options)`), shown under its public
    name (`app.alias`), with prop folders served at its address (`app.routes`).
  - Looks are named brand files; a look's `endsWith` (or its brand's end card) is what its videos end with.
  - Progress in `<out>/progress.json` while it runs; a run stopped part way carries on (`--fresh` starts over);
    `<out>/made.json` lists what was made. It stops before capturing anything when there's no ffmpeg or the voice
    can't be reached.
- **Director videos** (`direct()`): a script plays a person using the app — `d.scene`, `d.card`, `d.click`,
  `d.type`, `d.hover`, `d.press`, `d.read`, `d.skip`, `d.open`, `d.window`, `d.expect` (with `@playwright/test`) —
  with the cursor drawn on afterwards; narrated, the captions say the spoken lines. Writes `<id>.scenes.json`.
  `lookOptions()` gives finish() options from a brand and the video's flags.
- **Narrated from a script, captions say the spoken lines** (render, `--script`): each step's caption is its line,
  so the captions file and burned-in captions show what is heard (they kept the steps' own words).
- **ffmpeg**: `ffmpeg-static` is an optional dependency, used when there's no `FFMPEG` and no ffmpeg on the PATH.

## 0.1.7 (13 Nov 2026)

- **The clip catalogue, `trace-avatar-catalogue/1`** (`schemas/catalogue-1.json`, also at
  https://traceavatar.com/schemas/catalogue-1.json): a public JSON file of a product's published videos, one entry per
  file and shape, with each clip's own words (`says`), so a scheduler can post it and write about it truthfully.
  - `trace-avatar-render catalogue check <file|url> [--fetch]` checks one: every field, unique ids, burned captions
    with no captions file. With `--fetch` it checks the links too: they answer without cookies, with the right type;
    the captions end within the video; the mp4 is H.264 (with AAC sound when narrated) and starts playing before it
    has all loaded (`moov` first).
  - `checkCatalogue()`, `catalogueId()`, `vttEnds()`, `mp4Head()` in the library.

## 0.1.6 (12 Nov 2026)

- **Cards between scenes** (`Capture.cards` in `finish()`; `withCards`, `cardFrames`): a card shown for its time at a
  moment of the capture, in the title and end cards' look, fading in and out. A narrated card lasts as long as its
  line. For pitch videos: the problem, the result and the ask on cards, between the app's scenes.

## 0.1.5 (12 Nov 2026)

- **Several shapes from one capture**: `--out file.mp4@1:1` (`OutSpec.canvas` in `render()` and `finish()`) gives
  that output its own canvas, over `--canvas`. A 16:9, a 1:1 and a 4:5 cut of one run need one capture, not three
  (found making SpeedyMessaging's campaign videos: three captures took three times as long, and a Do it for me run
  sent three test messages).

## 0.1.4 (11 Nov 2026)

- `--canvas 9:16|4:5|1:1|16:9|WxH` (`canvas` in `render()` and `finish()`): the app is composed onto a picture of that
  shape, between safe margins on the background, for Reels, Stories and feeds.
  - `--width` scales the whole canvas.
  - A phone capture is scaled up to fill a tall canvas, so capture it at `--scale 2`.
  - Burned-in captions are sized to the canvas and sit below the app (above it with `--captions-at top`).
- `--watermark <text>` and `--watermark-at <corner>` (`watermark: text | { text, at, opacity, logo }`): a small
  badge on every frame, the title and end cards included.
  - It is drawn after the camera, so it never zooms.
  - A burned-in caption that would touch it moves clear of it.
- **Cards** take `url` (large, in the card's colour) and `logo` (an image file above the title), e.g.
  `{ "title": "For more info visit", "url": "naijaprices.com" }`.
- `--brand <file.json>` (`brandOf`, `brandFile`): the look in one checked file.
  - It covers canvas, watermark, frame, background, camera, captions, captionsAt, titleCard and endCard.
  - Logo paths resolve beside the file.
  - Flags given on the command line win over it.

## 0.1.3 (11 Nov 2026)

- `--captions-at top|bottom` (`captionsAt` in `render()` and `finish()`): burned-in captions can sit at the top. At
  the bottom they covered the app's own UI when it is low on the page: trace-avatar's Fix this step card, found
  making traceavatar.com's Repair clip.
- Needs trace-avatar ^0.1.14 (was ^0.1.13): `--value` and `--security` are 0.1.14's `values` and `security`. With
  0.1.13 a `--value` was silently ignored, and Do it for me skipped the field (found making a SpeedyMessaging clip).

## 0.1.2 (10 Nov 2026)

- `--navigate` (`navigate: true` in `render()`): when a step is on another page, the renderer loads that page, as the
  app's router would (the player's `navigate`), and the guide carries on there. Without it, a Show me guide that
  crosses pages (Show me never clicks) waited on "Open … to continue" until the render timed out. Found rendering
  DutyCaptain's guides for traceavatar.com, and needed by its nightly guide checks.
- `--security [guards]` and `--value name=text` (`security`, `values` in `render()`): Do it for me's security and
  run-time values, passed to the player (trace-avatar 0.1.14 or later). An upload hand-off no longer writes into the
  step's element.
- trace-avatar ^0.1.13: 0.1.9 typed the first letter of a rich-text field (Lexical) away ("ind the opening hours").

## 0.1.1 (10 Nov 2026)

- `--report <file>` writes one guide's outcome as JSON, whatever the exit code: `{ outcome: 'passed' | 'stalled' |
  'failed', step, reason, message }`. A stall names its step (from 0), why (`not-found` or `until-timeout`) and
  that step's caption, plus `repair` when `--repair` wrote `<out>.repair.json`. For CI jobs that check many guides
  and keep the results (DutyCaptain's guide checks).

- `--repair` fixes a wait whose text changed (`until-timeout`): the texts where it looks and those that showed while
  it waited are scored (code first, `--ai` only when unsure); a fix of `kind: 'until'` goes to `<out>.repair.json`,
  verified by playing again. With no clear winner, a guess (`by: 'guess'`) is offered and kept only when the replay
  passes. `--hide` and `--blur` areas are never offered. Needs trace-avatar 0.1.9 or later.

## 0.1.0 (first release)

- Render a trace-avatar guide to a **GIF** or an **MP4** by playing it on your real app in headless Chromium, in
  Show me or Do it for me (`--allow-perform`). Signed-in sessions with `--storage-state`.
- Long waits are cut (`--max-wait`); a stalled guide fails the render (exit 1, with a screenshot) so docs GIFs that no
  longer match the app fail CI; masked fields only ever get dots; guides that cross full page loads keep playing.
- Polish: a browser frame, a camera that zooms in on each action, burned-in or VTT captions and chapters, a poster,
  title and end cards, `--hide` and `--blur`.
- AI (only with `--ai`; DeepSeek first through a gateway, or OpenAI-compatible, or your own `provider.js`): `--qa`
  (a visual check of frames), `--alt`, and `suggest` / `apply` for captions, waits, a title and narration lines.
- Narration in the MP4 (`--voice`: a gateway's Gemini speech, OpenAI-compatible speech, macOS `say`, or your own
  `voice.js`), with holds so speech never talks over an action, and a cache by voice and text.
- Repair (`--repair`): a step that can't find its element is matched to what the page shows now (code first, AI only
  when unsure), re-recorded, and verified by playing the guide again; fixes go to `<out>.repair.json` for `apply`.
- `render()` from code, with `RenderError` (and its screenshot).
