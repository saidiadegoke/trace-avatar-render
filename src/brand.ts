/**
 * A brand: the look of a video in one place (canvas, watermark, cards, frame, background, camera, captions),
 * so every clip of a product, or of a showcase, looks the same. PURE except brandFile (reads the file).
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { CardOptions } from './layers';

/** An output picture of a fixed size, the app composed onto it (for social: 9:16 Reels, 4:5 and 1:1 feeds). */
export interface Canvas { width: number; height: number }
export type CanvasSpec = Canvas | '9:16' | '4:5' | '1:1' | '16:9' | string;

/** The named shapes, at the sizes the platforms ask for. */
export const CANVASES: Record<string, Canvas> = {
  '9:16': { width: 1080, height: 1920 },
  '4:5': { width: 1080, height: 1350 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
};

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export const CORNERS: readonly Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** A small badge on every frame (cards too), e.g. "Created with TraceAvatar · traceavatar.com". */
export interface Watermark {
  text: string;
  /** Default bottom-right. */
  at?: Corner;
  /** 0–1, default 0.9. */
  opacity?: number;
  /** An image file (PNG, JPEG, SVG, WebP) shown before the text. */
  logo?: string;
}

/** A canvas from a name ('9:16'), 'WIDTHxHEIGHT', or { width, height }. Throws on anything else. */
export function canvasOf(v: CanvasSpec): Canvas {
  if (typeof v === 'object' && v) {
    if (!(Number.isInteger(v.width) && Number.isInteger(v.height) && v.width >= 16 && v.height >= 16)) throw new Error('a canvas is { width, height } in whole pixels, at least 16');
    return { width: v.width, height: v.height };
  }
  if (CANVASES[v]) return CANVASES[v];
  const m = /^(\d+)x(\d+)$/i.exec(String(v));
  if (!m || Number(m[1]) < 16 || Number(m[2]) < 16) throw new Error(`a canvas is ${Object.keys(CANVASES).join(', ')} or WIDTHxHEIGHT (got ${String(v)})`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** A watermark from its text or its options. Throws on a bad corner or opacity. */
export function watermarkOf(v: string | Watermark): Watermark {
  const w = typeof v === 'string' ? { text: v } : v;
  if (!w || typeof w.text !== 'string' || !w.text.trim()) throw new Error('a watermark needs its text');
  if (w.at !== undefined && !CORNERS.includes(w.at)) throw new Error(`a watermark sits at ${CORNERS.join(', ')}`);
  if (w.opacity !== undefined && !(w.opacity > 0 && w.opacity <= 1)) throw new Error('a watermark\'s opacity is above 0, up to 1');
  return { ...w, text: w.text.trim() };
}

/** What a brand file may set: the polish options, nothing about what is played. */
export interface Brand {
  canvas?: CanvasSpec;
  watermark?: string | Watermark;
  frame?: 'none' | 'browser';
  background?: string;
  camera?: boolean | { zoom?: number };
  captions?: 'burn' | 'vtt' | 'both';
  captionsAt?: 'top' | 'bottom';
  titleCard?: boolean | string | CardOptions;
  endCard?: boolean | string | CardOptions;
}

const KEYS = ['$comment', 'name', 'canvas', 'watermark', 'frame', 'background', 'camera', 'captions', 'captionsAt', 'titleCard', 'endCard'];

/**
 * A brand checked: unknown keys and bad values are refused, naming each. Logo paths are resolved against
 * `dir` (the brand file's folder), so a brand can sit beside its logo.
 */
export function brandOf(json: unknown, dir = '.'): Brand {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('a brand is a JSON object');
  const b = json as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of Object.keys(b)) if (!KEYS.includes(k)) problems.push(`unknown key ${k}`);
  const out: Brand = {};
  const at = (p?: string) => (p && !isAbsolute(p) && !/^data:/.test(p) ? resolve(dir, p) : p);
  const card = (v: unknown, name: string): Brand['titleCard'] => {
    if (typeof v === 'boolean' || typeof v === 'string') return v;
    if (v && typeof v === 'object' && typeof (v as CardOptions).title === 'string') {
      const c = v as CardOptions;
      return { ...c, ...(c.logo ? { logo: at(c.logo) } : {}) };
    }
    problems.push(`${name} is true, a title, or { title, sub?, url?, logo?, color? }`);
    return undefined;
  };
  const tryIt = (f: () => void) => { try { f(); } catch (e) { problems.push((e as Error).message); } };
  if (b.canvas !== undefined) tryIt(() => { canvasOf(b.canvas as CanvasSpec); out.canvas = b.canvas as CanvasSpec; });
  if (b.watermark !== undefined) tryIt(() => { const w = watermarkOf(b.watermark as string | Watermark); out.watermark = { ...w, ...(w.logo ? { logo: at(w.logo) } : {}) }; });
  if (b.frame !== undefined) { if (b.frame === 'none' || b.frame === 'browser') out.frame = b.frame; else problems.push('frame is none or browser'); }
  if (b.background !== undefined) { if (typeof b.background === 'string') out.background = b.background; else problems.push('background is a CSS colour or gradient'); }
  if (b.camera !== undefined) {
    const z = (b.camera as { zoom?: unknown })?.zoom;
    if (typeof b.camera === 'boolean' || (typeof b.camera === 'object' && b.camera && (z === undefined || (typeof z === 'number' && z >= 1)))) out.camera = b.camera as Brand['camera'];
    else problems.push('camera is true, false or { zoom ≥ 1 }');
  }
  if (b.captions !== undefined) { if (['burn', 'vtt', 'both'].includes(b.captions as string)) out.captions = b.captions as Brand['captions']; else problems.push('captions is burn, vtt or both'); }
  if (b.captionsAt !== undefined) { if (b.captionsAt === 'top' || b.captionsAt === 'bottom') out.captionsAt = b.captionsAt; else problems.push('captionsAt is top or bottom'); }
  if (b.titleCard !== undefined) { const c = card(b.titleCard, 'titleCard'); if (c !== undefined) out.titleCard = c; }
  if (b.endCard !== undefined) { const c = card(b.endCard, 'endCard'); if (c !== undefined) out.endCard = c; }
  if (problems.length) throw new Error(`brand: ${problems.join('; ')}`);
  return out;
}

/** A brand file, read and checked. */
export function brandFile(file: string): Brand {
  let json: unknown;
  try { json = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`brand ${file}: ${(e as Error).message}`); }
  return brandOf(json, dirname(resolve(file)));
}
