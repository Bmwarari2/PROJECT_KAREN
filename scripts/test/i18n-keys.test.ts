import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import enGB from '../../packages/core/src/i18n/messages/en-GB.json';
import { pluralBase } from '../../packages/core/src/i18n/format';

/**
 * Every literal message key the code passes to `t('…')` exists in the en-GB catalogue (en-US falls back
 * to it). Merges can drop a key that another branch still uses; the UI would then show the raw key.
 * Keys built at runtime (template literals) are not checked here.
 */
const root = join(__dirname, '..', '..');

/** Plural forms (`org.reports_one`, `org.reports_other`) are looked up by their base key (ADR-0151). */
function flatten(o: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (o && typeof o === 'object')
    for (const [k, v] of Object.entries(o)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  else out.add(pluralBase(prefix));
  return out;
}

describe('message keys used in code', () => {
  it('exist in the en-GB catalogue', () => {
    const keys = flatten(enGB);
    const known = (k: string) => keys.has(k) || [...keys].some((x) => x.startsWith(`${k}.`));
    const files = execFileSync(
      'git',
      [
        'ls-files',
        'apps/web/app',
        'apps/web/components',
        'apps/web/lib',
        'apps/api/src',
        'apps/worker/src',
        'packages/ui/src',
      ],
      { cwd: root, encoding: 'utf8' },
    )
      .split('\n')
      .filter((f) => /\.tsx?$/.test(f));
    const missing: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(join(root, f), 'utf8').matchAll(
        /\bt\(\s*['"]([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+)['"]/g,
      )) {
        if (!known(m[1]!)) missing.push(`${m[1]} (${f})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
