/** Where the capture goes in the output picture. PURE. */

import type { Rect } from './camera';
import { fitWidth } from './image';
import type { Canvas } from './brand';

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
  /** On a canvas: the picture is the canvas's shape, the app placed on it (always drawn over a background). */
  canvas?: boolean;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * The output size for a capture of srcW×srcH shown `width` wide (default: the capture's width, never
 * upscaled), with or without a browser window around it.
 */
export function layoutOf(srcW: number, srcH: number, width: number | undefined, frame: FrameStyle = 'none', canvas?: Canvas): Layout {
  if (canvas) return onCanvas(srcW, srcH, width, frame, canvas);
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

/**
 * The app on a canvas of a fixed shape (`width` scales the whole canvas down, never up). The app (in its window,
 * with a browser frame) is as large as fits between the side margins and the safe areas: a tall canvas keeps
 * more room at the bottom, where the platforms put their own buttons and the captions go. Unlike the other
 * layouts the app may be scaled up, to fill a phone-shaped canvas: capture at --scale 2 to keep it sharp.
 */
function onCanvas(srcW: number, srcH: number, width: number | undefined, frame: FrameStyle, canvas: Canvas): Layout {
  const W = even(width ? Math.min(width, canvas.width) : canvas.width);
  const H = even((canvas.height * W) / canvas.width);
  const tall = H / W > 1.2;
  const padX = Math.round(W * 0.05);
  const top = Math.round(H * (tall ? 0.1 : 0.07));
  const bottom = Math.round(H * (tall ? 0.16 : 0.09));
  const boxW = W - 2 * padX;
  const boxH = H - top - bottom;
  // The bar's height is a share of the window's width (as in the browser layout: 3.6% of the picture ≈ 3.9% of the window).
  const barK = frame === 'browser' ? 0.039 : 0;
  const cw = Math.max(2, Math.floor(Math.min(boxW, boxH / (srcH / srcW + barK))));
  const ch = Math.max(2, Math.round((srcH * cw) / srcW));
  const barH = frame === 'browser' ? Math.max(18, Math.round(cw * barK)) : 0;
  const x = Math.round((W - cw) / 2);
  const y = top + Math.max(0, Math.round((boxH - ch - barH) / 2));
  return {
    width: W,
    height: H,
    bar: frame === 'browser' ? { x, y, w: cw, h: barH } : null,
    content: { x, y: y + barH, w: cw, h: ch },
    window: { x, y, w: cw, h: barH + ch },
    canvas: true,
  };
}
