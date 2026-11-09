/**
 * trace-avatar-render — turn a trace-avatar guide into a GIF or MP4 by playing it on the real app.
 *
 *   import { render } from 'trace-avatar-render';
 *   await render({ trace: './invoice.trace.json', url: 'http://localhost:3000/app', out: ['invoice.gif'] });
 */

export { render, finish, formatOf, cardOf } from './render';
export type { FinishOptions, OutFormat, OutSpec, RenderOptions, RenderOutput, RenderResult } from './render';
export { capture, findPlayer, RenderError } from './capture';
export type { Capture, CaptureOptions, CapturedFrame } from './capture';
export { editList, spansOf, durationOf, sourceAt, outputAt, frameTimes, pickFrames, DEFAULT_MAX_WAIT_MS } from './timeline';
export type { Phase, Segment, Span, TimelineEvent, EditOptions } from './timeline';
export { encodeGif, createGifWriter, paletteOf } from './gif';
export type { GifOptions, GifResult, GifWriter } from './gif';
export { encodeMp4, findFfmpeg, mp4Args } from './mp4';
export { resize, crop, fitWidth, pixel } from './image';
export type { Image } from './image';
export { cameraKeys, cameraPath, ZOOM_KINDS } from './camera';
export type { Action, CameraOptions, Rect } from './camera';
export { layoutOf } from './layout';
export type { FrameStyle, Layout } from './layout';
export { drawRegion, overlay, crossfade, blank } from './compose';
export { createLayers, DEFAULT_BACKGROUND } from './layers';
export type { CardOptions, Layers } from './layers';
export { actionsOf, stepCues, pageAt, cueAt } from './plan';
export { toVtt, captionCues, chapterCues } from './vtt';
export type { Cue } from './vtt';
