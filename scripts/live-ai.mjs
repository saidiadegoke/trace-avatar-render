#!/usr/bin/env node
/**
 * Real calls through the AI gateway (not run in CI; it spends a little): captions, a title, alt text, and a
 * visual check of two real frames, for each provider named (default: deepseek openai).
 *
 *   AI_GATEWAY_URL=… AI_GATEWAY_KEY=… npm run live:ai [-- deepseek openai gemini]
 *
 * Or put the two variables in .env.live or .env (both git-ignored); this script reads them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { chooseRepair, describe, gateway, suggest } from 'trace-avatar/assist';
import { runQa } from '../dist/index.js';

for (const file of ['.env.live', '.env'].filter((f) => existsSync(f))) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
if (!process.env.AI_GATEWAY_URL || !process.env.AI_GATEWAY_KEY) {
  console.error('live-ai: set AI_GATEWAY_URL and AI_GATEWAY_KEY (or put them in .env.live or .env)');
  process.exit(2);
}

const trace = {
  version: 1,
  meta: { title: 'x' },
  steps: [
    { type: 'click', target: { role: 'button', name: 'New invoice' } },
    { type: 'type', target: { role: 'textbox', name: 'Customer' }, text: 'Grace Hopper' },
    { type: 'click', target: { role: 'button', name: 'Save' } },
  ],
};

/** A 320×200 frame: a white page with a red error banner across the top (or a plain page). */
const frame = (error) => {
  const png = new PNG({ width: 320, height: 200 });
  for (let y = 0; y < 200; y += 1) for (let x = 0; x < 320; x += 1) {
    const i = (y * 320 + x) * 4;
    const red = error && y < 40;
    png.data[i] = red ? 220 : 250; png.data[i + 1] = red ? 38 : 250; png.data[i + 2] = red ? 38 : 250; png.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
};

const providers = process.argv.slice(2).length ? process.argv.slice(2) : ['deepseek', 'openai'];
let failed = 0;
for (const provider of providers) {
  const ai = gateway({ provider });
  const t0 = Date.now();
  try {
    const caps = await suggest('captions', trace, { ai });
    const title = await suggest('title', trace, { ai });
    const desc = await describe(trace, { ai });
    const qa = await runQa(ai, [
      { at: 1000, label: 'after step 1 (click)', png: frame(false) },
      { at: 2000, label: 'after step 3 (click)', png: frame(true) },
    ], { title: 'Make an invoice', steps: [{ n: 1, type: 'click' }, { n: 2, type: 'type' }, { n: 3, type: 'click' }] });
    console.log(`\n${provider} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    console.log('  captions:', caps.suggestions.map((s) => `${s.index + 1}: ${s.value}`).join(' | '), caps.dropped.length ? `(dropped ${caps.dropped.length})` : '');
    console.log('  title:', title.suggestions[0]?.value ?? '(none)');
    console.log('  alt:', desc.alt);
    // An unsure repair: "Next" is gone; the page has "Continue" and "Back".
    const broken = { version: 1, steps: [...trace.steps, { type: 'click', target: { role: 'link', name: 'Next' }, say: 'Go on to the next part' }] };
    const fix = await chooseRepair(broken, 3, [
      { id: 0, role: 'link', name: 'Back', near: 'New invoice' },
      { id: 1, role: 'button', name: 'Save invoice', near: 'New invoice' },
      { id: 2, role: 'link', name: 'Continue', near: 'New invoice' },
      { id: 3, role: 'link', name: 'Invoices', near: 'Menu' },
    ], { ai });
    console.log('  repair:', fix.by, fix.id === 2 ? 'Continue ✓' : `chose ${fix.id}`, fix.why ?? '');
    if (fix.id !== 2) throw new Error('the repair chose the wrong element');
    console.log('  qa:', qa.length ? qa.map((f) => `${f.at} ms ${f.kind}: ${f.note}`).join(' | ') : 'nothing flagged');
    if (!caps.suggestions.length) throw new Error('no captions');
  } catch (e) {
    failed += 1;
    console.error(`\n${provider}: FAILED ${e.message}${e.info?.requestId ? ` (request ${e.info.requestId})` : ''}${e.info?.allowed ? ` allowed: ${e.info.allowed.join(', ')}` : ''}`);
  }
}
process.exit(failed ? 1 : 0);
