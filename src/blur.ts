/**
 * Auto-blur (websites/docs/TRACE_AVATAR_STUDIO_V3.md §3): personal data is blurred in the page before frames are
 * taken, so no unblurred frame exists. Code finds contact details and account numbers by pattern; exact texts (names,
 * addresses an AI picked from the page) are blurred wherever they show. The page is watched, so rows that load later
 * are blurred as they appear.
 */

export interface BlurSpec {
  /** Exact texts to blur wherever an element's own text holds one (names, addresses). */
  texts?: string[];
  /** Blur e-mails, phone numbers and long account-like numbers: true for all of them, or a list of the kinds. */
  patterns?: boolean | BlurKind[];
  /** How strongly, in pixels of blur: 2 (light) to 24 (strong). Default 8. */
  strength?: number;
}

export type BlurKind = 'email' | 'phone' | 'account';
export const BLUR_KINDS: BlurKind[] = ['email', 'phone', 'account'];
export const BLUR_STRENGTH = { min: 2, max: 24, default: 8 };

/** The strength used: a number clamped to 2–24, else the default 8. */
export function blurStrength(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(BLUR_STRENGTH.max, Math.max(BLUR_STRENGTH.min, Math.round(n))) : BLUR_STRENGTH.default;
}

/** The pattern kinds a spec turns on. */
export function blurKinds(patterns: BlurSpec['patterns']): BlurKind[] {
  if (patterns === true) return [...BLUR_KINDS];
  return Array.isArray(patterns) ? BLUR_KINDS.filter((k) => patterns.includes(k)) : [];
}

/**
 * The patterns, as sources (they also run in the page). Phone numbers: Nigerian forms (080…, +234 80…) and any
 * number written with a leading +. Account-like: 10–19 digits in a row, or a card's groups of four. Order numbers,
 * dates and prices don't match: they're shorter runs, or broken by other characters.
 */
export const BLUR_PATTERNS: Record<BlurKind, string> = {
  email: String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`,
  phone: String.raw`(?:\+234[\s-]?|\b0)[789][01]\d(?:[\s-]?\d){7}\b|\+\d{1,3}[\s-]?\d(?:[\s-]?\d){6,12}\b`,
  account: String.raw`\b\d{10,19}\b|\b\d{4}(?:[\s-]\d{4}){2,4}\b`,
};

/** Which kinds of personal data a text holds, by pattern. */
export function patternsIn(text: string): Array<keyof typeof BLUR_PATTERNS> {
  return (Object.keys(BLUR_PATTERNS) as Array<keyof typeof BLUR_PATTERNS>).filter((k) => new RegExp(BLUR_PATTERNS[k]).test(text));
}

/** The texts kept: trimmed, 3–120 characters, distinct, at most 300. */
export function blurTexts(texts: unknown): string[] {
  if (!Array.isArray(texts)) return [];
  return [...new Set(texts.filter((t): t is string => typeof t === 'string').map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t.length >= 3 && t.length <= 120))].slice(0, 300);
}

/** Runs in the page (serialised with its spec): marks what to blur with [data-trace-blur], and keeps watching. */
export function blurInPage(spec: { texts: string[]; patterns: Record<string, string> | null; strength: number }) {
  if ((window as unknown as { __taBlur?: boolean }).__taBlur) return;
  (window as unknown as { __taBlur?: boolean }).__taBlur = true;
  const res = spec.patterns ? Object.values(spec.patterns).map((p) => new RegExp(p)) : [];
  const texts = spec.texts;
  const personal = (t: string) => !!t && (res.some((r) => r.test(t)) || texts.some((x) => t.includes(x)));
  const mark = (el: Element | null) => { if (el && !el.hasAttribute('data-trace-blur')) el.setAttribute('data-trace-blur', ''); };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const visit = (root: Node) => {
    if (root.nodeType === Node.TEXT_NODE) {
      if (personal(root.textContent ?? '')) mark(root.parentElement);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || SKIP.has((root as Element).tagName)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n: Node | null = root; n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) { if (personal(n.textContent ?? '')) mark(n.parentElement); continue; }
      const el = n as Element;
      // A field's value (a pre-filled phone or e-mail), and labels kept in attributes.
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && personal((el as HTMLInputElement).value)) mark(el);
      else if (personal(el.getAttribute('title') ?? '') || personal(el.getAttribute('aria-label') ?? '')) mark(el);
    }
  };
  const start = () => {
    const style = document.createElement('style');
    style.setAttribute('data-trace-blur-style', '');
    // Doubled for weight over capture's own [data-trace-blur] rule, so the strength set here wins.
    style.textContent = `[data-trace-blur][data-trace-blur]{filter:blur(${spec.strength}px)!important}`;
    (document.head || document.documentElement).append(style);
    if (document.body) visit(document.body);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') visit(m.target);
        else m.addedNodes.forEach((n) => visit(n));
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    // Typed values: a field is re-checked as it changes.
    document.addEventListener('input', (e) => { const t = e.target as HTMLInputElement; if (t && personal(t.value)) mark(t); }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

/** The init script for a spec, or null when there's nothing to blur. */
export function blurScript(spec: BlurSpec | undefined): string | null {
  const texts = blurTexts(spec?.texts);
  const kinds = blurKinds(spec?.patterns);
  if (!texts.length && !kinds.length) return null;
  const patterns = kinds.length ? Object.fromEntries(kinds.map((k) => [k, BLUR_PATTERNS[k]])) : null;
  return `(${blurInPage.toString()})(${JSON.stringify({ texts, patterns, strength: blurStrength(spec?.strength) })});`;
}
