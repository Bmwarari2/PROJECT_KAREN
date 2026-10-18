// Merges a JSON fragment of new message keys into a catalogue: node scripts/i18n-merge.mjs <fragment.json> [en-GB|en-US]
import { readFileSync, writeFileSync } from 'node:fs';

const [fragment, locale = 'en-GB'] = process.argv.slice(2);
const path = `packages/core/src/i18n/messages/${locale}.json`;
const base = JSON.parse(readFileSync(path, 'utf8'));
const add = JSON.parse(readFileSync(fragment, 'utf8'));
const merge = (a, b) => {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && a[k] && typeof a[k] === 'object') merge(a[k], v);
    else a[k] = v;
  }
  return a;
};
writeFileSync(path, JSON.stringify(merge(base, add), null, 2) + '\n');
console.log(`merged ${fragment} into ${path}`);
