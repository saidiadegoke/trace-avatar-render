/**
 * trace-avatar-render — turn a trace-avatar guide into a GIF or MP4 by playing it on the real app.
 *
 *   import { render } from 'trace-avatar-render';
 *   await render({ trace: './invoice.trace.json', url: 'http://localhost:3000/app', out: ['invoice.gif'] });
 */

export { render, finish, formatOf } from './render';
export type { OutFormat, OutSpec, RenderOptions, RenderOutput, RenderResult } from './render';
export { capture, findPlayer, RenderError } from './capture';
export type { Capture, CaptureOptions, CapturedFrame } from './capture';
export { editList, spansOf, durationOf, sourceAt, outputAt, frameTimes, pickFrames, DEFAULT_MAX_WAIT_MS } from './timeline';
export type { Phase, Segment, Span, TimelineEvent, EditOptions } from './timeline';
export { encodeGif, paletteOf } from './gif';
export type { GifOptions, GifResult } from './gif';
export { encodeMp4, findFfmpeg, mp4Args } from './mp4';
export { resize, crop, fitWidth, pixel } from './image';
export type { Image } from './image';
