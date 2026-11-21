import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { blurKinds, blurScript, blurStrength, blurTexts, patternsIn } from '../../src/blur';
import { checkTimes, isBlank } from '../../src/check';
import { runQa } from '../../src/ai';

describe('blur patterns', () => {
  it('find contact details and account numbers', () => {
    expect(patternsIn('Bisi Ogunleye · 08142257790')).toEqual(['phone', 'account']);
    expect(patternsIn('call +234 803 123 4567')).toEqual(['phone']);
    expect(patternsIn('+44 20 7946 0958')).toEqual(['phone']);
    expect(patternsIn('demo-1795266527567@demo.smartstore.local')).toContain('email');
    expect(patternsIn('Account 0123456789')).toEqual(['account']);
    expect(patternsIn('Card 4111 1111 1111 1111')).toEqual(['account']);
  });

  it('leave order numbers, dates, prices and amounts alone', () => {
    for (const t of ['ORD-20261121-0005', '11/21/2026', '₦199,800', '₦42,000', '6 Total Orders', 'SAVE10', 'Used 0 times', '2026-11-21 14:05']) {
      expect(patternsIn(t), t).toEqual([]);
    }
  });

  it('texts are trimmed, distinct and of a useful length', () => {
    expect(blurTexts(['  Amaka  Nwosu ', 'Amaka Nwosu', 'ab', 7, ''])).toEqual(['Amaka Nwosu']);
    expect(blurScript({})).toBeNull();
    expect(blurScript({ texts: ['x'] })).toBeNull();
    expect(blurScript({ patterns: true })).toContain('data-trace-blur');
  });

  it('kinds and strength can be tuned; strength stays within 2–24', () => {
    expect(blurKinds(true)).toEqual(['email', 'phone', 'account']);
    expect(blurKinds(['phone', 'nope' as never])).toEqual(['phone']);
    expect(blurKinds(false)).toEqual([]);
    expect(blurScript({ patterns: [] })).toBeNull();
    const s = blurScript({ patterns: ['email'], strength: 14 })!;
    expect(s).toContain('"strength":14');
    expect(s).toContain('"email"');
    expect(s).not.toContain('"phone"');
    expect([blurStrength(1), blurStrength(40), blurStrength('x'), blurStrength(5.6)]).toEqual([2, 24, 8, 6]);
  });
});

describe('blur in the page', () => {
  it('marks names and contact details as they show, rows added later too, and nothing else', async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.addInitScript({ content: blurScript({ texts: ['Amaka Nwosu'], patterns: true, strength: 12 })! });
      const page = await context.newPage();
      const html = `<!doctype html><h1>Adaeze's Closet</h1><ul id="l"><li><b>Amaka Nwosu</b> <span>ORD-20261121-0005</span></li></ul>
        <p>₦42,000</p><input id="phone" value="08031186624"><input id="note" value="Gift wrap">`;
      await page.route('http://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
      await page.goto('http://app.test/orders');
      await page.evaluate(() => {
        const li = document.createElement('li');
        li.innerHTML = '<b>Chioma Eze</b> <i>chioma@example.com</i>';
        document.getElementById('l')!.append(li);
      });
      await page.waitForTimeout(50);
      const marked = await page.evaluate(() => Array.from(document.querySelectorAll("[data-trace-blur]")).map((e) => e.textContent || (e as HTMLInputElement).value));
      expect(marked.sort()).toEqual(['08031186624', 'Amaka Nwosu', 'chioma@example.com']);
      const filter = await page.evaluate(() => getComputedStyle(document.querySelector('[data-trace-blur]')!).filter);
      expect(filter).toBe('blur(12px)');
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe('the check', () => {
  it('frames are spread through the video; one-colour frames are blank', () => {
    expect(checkTimes(10, 4)).toEqual([1.25, 3.75, 6.25, 8.75]);
    expect(isBlank(new Uint8Array(576).fill(255))).toBe(true);
    expect(isBlank(Uint8Array.from({ length: 576 }, (_, i) => (i % 7) * 30))).toBe(false);
  });

  it('personal data comes back with the text seen; other kinds carry none', async () => {
    const png = new Uint8Array([0x89, 0x50]);
    const ai = async () => ({ flags: [
      { frame: 1, kind: 'personal-data', note: 'a name', text: '  Bisi  Ogunleye ' },
      { frame: 2, kind: 'line-mismatch', note: 'says Save; shows the list', text: 'ignored' },
    ] });
    const flags = await runQa(ai as never, [{ at: 0, label: 'a', png }, { at: 1000, label: 'b', png }], { steps: [] });
    expect(flags).toEqual([
      { at: 0, kind: 'personal-data', note: 'a name', text: 'Bisi Ogunleye' },
      { at: 1000, kind: 'line-mismatch', note: 'says Save; shows the list' },
    ]);
  });
});
