/** Where the capture goes in the output picture. PURE. */

import type { Rect } from './camera';
import { fitWidth } from './image';

export type FrameStyle = 'none' | 'browser';

export interface Layout {
  width: number;
  height: number;
  /** Where the page is drawn. */
  content: Rect;
  /** The window's title bar (browser frame only). */
  bar: Rect | null;
  /** The window (bar + content), for the shadow and corners. */
  window: Rect;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * The output size for a capture of srcW×srcH shown `width` wide (default: the capture's width, never
 * upscaled), with or without a browser window around it.
 */
export function layoutOf(srcW: number, srcH: number, width: number | undefined, frame: FrameStyle = 'none'): Layout {
  if (frame === 'none') {
    // As E1: scaled down to the width, or cropped by a pixel to even sizes, never scaled up.
    const { width: W, height: H } = fitWidth(srcW, srcH, width);
    const r = { x: 0, y: 0, w: W, h: H };
    return { width: W, height: H, content: r, bar: null, window: r };
  }
  // Padding is 4% a side: at most as wide as keeps the page at its own size (never upscaled).
  const W = even(Math.min(width ?? Infinity, srcW / 0.92));
  const pad = Math.round(W * 0.04);
  const barH = Math.max(18, Math.round(W * 0.036));
  const cw = W - 2 * pad;
  const ch = Math.round((srcH * cw) / srcW);
  const H = even(ch + barH + 2 * pad);
  const top = Math.floor((H - ch - barH) / 2);
  return {
    width: W,
    height: H,
    bar: { x: pad, y: top, w: cw, h: barH },
    content: { x: pad, y: top + barH, w: cw, h: ch },
    window: { x: pad, y: top, w: cw, h: barH + ch },
  };
}
