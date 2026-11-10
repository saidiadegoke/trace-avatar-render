# Changelog

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
