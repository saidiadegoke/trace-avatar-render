import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { isPayment, refuseScript } from '../../src/refuse';

describe('refusing payments', () => {
  it('a write to a payment address is a payment; pay links and reads are not', () => {
    expect(isPayment('POST', 'https://shop.test/api/checkout')).toBe(true);
    expect(isPayment('POST', 'https://shop.test/payments/intent')).toBe(true);
    expect(isPayment('PUT', 'https://shop.test/api/payouts/42')).toBe(true);
    expect(isPayment('GET', 'https://shop.test/checkout')).toBe(false);
    expect(isPayment('POST', 'https://shop.test/api/paylinks')).toBe(false);
    expect(isPayment('POST', 'https://shop.test/api/products')).toBe(false);
    expect(refuseScript({})).toBeNull();
  });

  it('a card field takes no typing and its form is never sent; other fields work', async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.addInitScript({ content: refuseScript({ pay: true })! });
      const page = await context.newPage();
      await page.route('http://shop.test/**', (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <form id="f" onsubmit="window.sent=true;return false"><label for="c">Card number</label><input id="c"><input id="n" name="note"><button>Pay</button></form>` }));
      await page.goto('http://shop.test/checkout');
      await page.fill('#n', 'Gift wrap');
      await page.locator('#c').pressSequentially('4111111111111111');
      await page.click('button');
      expect(await page.inputValue('#c')).toBe('');
      expect(await page.inputValue('#n')).toBe('Gift wrap');
      expect(await page.evaluate(() => (window as unknown as { sent?: boolean }).sent ?? false)).toBe(false);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
