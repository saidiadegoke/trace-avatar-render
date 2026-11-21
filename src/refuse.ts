/**
 * Actions the owner switched off, refused while filming (websites/docs/TRACE_AVATAR_STUDIO_V3.md §5): the last line,
 * in code, for anything the checks before filming missed. With paying refused, card fields take no input, a form
 * holding one is never sent, and requests that write to a payment address never leave the browser.
 */

export interface RefuseSpec {
  /** Paying: card fields, their forms, and writes to payment addresses. */
  pay?: boolean;
}

/** Payment addresses, by path segment (a "pay links" page isn't one; /checkout, /payments/… are). */
export const PAYMENT_PATH = String.raw`(?:^|/)(?:pay|payments?|checkout|charges?|transfers?|withdraw(?:als?)?|payouts?)(?:/|$)`;

/** Whether a request is a payment, refused when paying is off: a write (not GET, HEAD, OPTIONS) to a payment path. */
export function isPayment(method: string, url: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return false;
  try { return new RegExp(PAYMENT_PATH, 'i').test(new URL(url).pathname); } catch { return false; }
}

/** Runs in the page: card fields stay empty and their forms unsent. */
export function refuseInPage() {
  const CARD = /card.?(number|no)|cc-?(number|csc|exp)|cvv|cvc|security code|expiry/i;
  const isCard = (el: EventTarget | null): boolean => {
    const f = el as HTMLInputElement | null;
    if (!f || f.tagName !== 'INPUT') return false;
    const words = [f.getAttribute('autocomplete'), f.name, f.id, f.placeholder, f.getAttribute('aria-label'), f.labels?.[0]?.textContent].join(' ');
    return CARD.test(words);
  };
  const stop = (e: Event) => { if (isCard(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); (e.target as HTMLInputElement).value = ''; } };
  for (const t of ['beforeinput', 'keydown', 'paste', 'input']) document.addEventListener(t, stop, true);
  document.addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement;
    if (Array.from(form.querySelectorAll("input")).some((i) => isCard(i))) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}

/** The init script for a spec, or null. */
export function refuseScript(spec: RefuseSpec | undefined): string | null {
  return spec?.pay ? `(${refuseInPage.toString()})();` : null;
}
