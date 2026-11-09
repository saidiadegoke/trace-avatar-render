/**
 * The parts of a frame that have text in them (the window's title bar, burned-in captions, title and end
 * cards) are drawn once each by Chromium and composed in JS. One page, reused.
 */

import { PNG } from 'pngjs';
import type { Browser, Page } from 'playwright';
import type { Image } from './image';
import type { Layout } from './layout';

export interface CardOptions { title: string; sub?: string; color?: string }

export interface Layers {
  /** The background, the window and its title bar, for a page path. */
  base(layout: Layout, o: { background: string; title?: string; path?: string }): Promise<Image>;
  /** A caption with its own backdrop, on transparent pixels, at most `maxWidth` wide. */
  caption(text: string, o: { maxWidth: number; fontPx: number }): Promise<Image>;
  /** A full-frame card. */
  card(layout: Layout, o: CardOptions & { background: string }): Promise<Image>;
  close(): Promise<void>;
}

/** The default background behind a framed capture. */
export const DEFAULT_BACKGROUND = 'linear-gradient(135deg, #dfe7fb 0%, #eef0f6 50%, #f6e9f1 100%)';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"; // single quotes: it goes inside style="…"

const decode = (buf: Buffer): Image => {
  const p = PNG.sync.read(buf);
  return { width: p.width, height: p.height, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.length) };
};

export async function createLayers(browser: Browser): Promise<Layers> {
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const page: Page = await ctx.newPage();
  const shoot = async (w: number, h: number, html: string, transparent = false, sel?: string): Promise<Image> => {
    await page.setViewportSize({ width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;${transparent ? 'background:transparent' : ''}}</style></head><body>${html}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const buf = sel
      ? await page.locator(sel).screenshot({ omitBackground: transparent })
      : await page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: Math.round(w), height: Math.round(h) } });
    return decode(buf);
  };

  return {
    async base(l, o) {
      const win = l.window;
      const bar = l.bar;
      const r = Math.round(l.width * 0.012);
      const dot = bar ? Math.round(bar.h * 0.36) : 0;
      const chrome = bar ? `
        <div style="position:absolute;left:${win.x}px;top:${win.y}px;width:${win.w}px;height:${win.h}px;border-radius:${r}px;background:#fff;box-shadow:0 ${Math.round(r * 1.5)}px ${r * 5}px rgb(15 23 42/.22),0 0 0 1px rgb(15 23 42/.08)"></div>
        <div style="position:absolute;left:${bar.x}px;top:${bar.y}px;width:${bar.w}px;height:${bar.h}px;border-radius:${r}px ${r}px 0 0;background:#eef0f4;border-bottom:1px solid #d9dde5;box-sizing:border-box;display:flex;align-items:center;gap:${Math.round(dot * 0.6)}px;padding:0 ${Math.round(dot * 1.2)}px;font:${Math.round(bar.h * 0.42)}px/1 ${FONT};color:#475569">
          <span style="width:${dot}px;height:${dot}px;border-radius:50%;background:#ff5f57;flex:none"></span>
          <span style="width:${dot}px;height:${dot}px;border-radius:50%;background:#febc2e;flex:none"></span>
          <span style="width:${dot}px;height:${dot}px;border-radius:50%;background:#28c840;flex:none"></span>
          <span style="flex:1;display:flex;justify-content:center;min-width:0"><span style="background:#fff;border-radius:${Math.round(bar.h * 0.3)}px;padding:${Math.round(bar.h * 0.12)}px ${Math.round(bar.h * 0.6)}px;max-width:70%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(o.path ?? '/')}</span></span>
          <span style="flex:none;max-width:22%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600">${esc(o.title ?? '')}</span>
        </div>` : '';
      return shoot(l.width, l.height, `<div style="position:relative;width:100%;height:100%;background:${o.background}">${chrome}</div>`);
    },
    async caption(text, o) {
      const pad = Math.round(o.fontPx * 0.6);
      return shoot(o.maxWidth, o.fontPx * 8, `<div style="display:flex;justify-content:center"><div id="c" style="max-width:${o.maxWidth - 2}px;box-sizing:border-box;padding:${pad}px ${Math.round(pad * 1.5)}px;border-radius:${pad}px;background:rgb(17 24 39/.88);color:#f9fafb;font:500 ${o.fontPx}px/1.35 ${FONT};text-align:center">${esc(text)}</div></div>`, true, '#c');
    },
    async card(l, o) {
      const s = Math.round(l.width * 0.045);
      const initial = esc((o.sub ?? o.title).trim().charAt(0).toUpperCase() || '•');
      // The words sit on their own white panel, so they read on any background.
      return shoot(l.width, l.height, `<div style="width:100%;height:100%;background:${o.background};display:flex;align-items:center;justify-content:center;font-family:${FONT}">
        <div style="max-width:76%;box-sizing:border-box;padding:${Math.round(s * 0.8)}px ${Math.round(s * 1.2)}px;border-radius:${Math.round(s * 0.5)}px;background:#fff;box-shadow:0 ${Math.round(s * 0.3)}px ${s}px rgb(15 23 42/.25);display:flex;flex-direction:column;align-items:center;gap:${Math.round(s * 0.45)}px;color:#0f172a;text-align:center">
          <div style="font:700 ${s}px/1.2 ${FONT}">${esc(o.title)}</div>
          ${o.sub ? `<div style="display:flex;align-items:center;gap:${Math.round(s * 0.25)}px;font:500 ${Math.round(s * 0.45)}px/1 ${FONT};color:#334155"><span style="width:${Math.round(s * 0.7)}px;height:${Math.round(s * 0.7)}px;border-radius:50%;background:${o.color ?? '#2456d8'};color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:700">${initial}</span>${esc(o.sub)}</div>` : ''}
        </div>
      </div>`);
    },
    close: () => ctx.close(),
  };
}
