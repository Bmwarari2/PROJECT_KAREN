import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleBook } from '../src/engine';
import { RULE_KEYS } from '../src/schema';

/** Generates docs/COVERAGE.md from the pack data (run: pnpm --filter @thapsus/rules coverage-doc). */
export function coverageMarkdown(book = RuleBook.fromDirectory()): string {
  const packs = book.jurisdictions().sort((a, b) => {
    const rank = (j: string) => (j === 'EU' ? 1 : j === 'GB' ? 0 : j === 'US' ? 2 : j.startsWith('US-') ? 4 : 3);
    return rank(a.jurisdiction) - rank(b.jurisdiction) || a.jurisdiction.localeCompare(b.jurisdiction);
  });
  const keys = Object.keys(RULE_KEYS) as Array<keyof typeof RULE_KEYS>;
  const lines: string[] = [
    '# Jurisdiction coverage',
    '',
    '> Generated from `packages/rules/packs` by `pnpm --filter @thapsus/rules coverage-doc`. Do not edit by hand.',
    '> Every value carries an official source URL and the date it was verified; all research-agent values are pending legal review (HUMAN_TODO.md).',
    '',
    '## Summary',
    '',
    '| Jurisdiction | Parent | Priority | Pack version | Rules | Holiday definitions | Latest verification |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const p of packs) {
    const verified = [...p.rules.flatMap((r) => r.versions.map((v) => v.verifiedOn)), ...p.holidays.map((h) => h.verifiedOn)].sort().at(-1) ?? '—';
    lines.push(`| ${p.jurisdiction} — ${p.name} | ${p.parent ?? '—'} | ${p.coverage?.priority ?? '—'} | ${p.version} | ${p.rules.length} | ${p.holidays.length} | ${verified} |`);
  }
  lines.push('', '## Rules by jurisdiction', '', `| Jurisdiction | ${keys.map((k) => `\`${k}\``).join(' | ')} |`, `| --- | ${keys.map(() => '---').join(' | ')} |`);
  for (const p of packs) lines.push(`| ${p.jurisdiction} | ${keys.map((k) => (p.rules.some((r) => r.key === k) ? '✔' : '')).join(' | ')} |`);
  lines.push('', '✔ = modelled in this pack. Blank cells fall back to the parent layer (EU baseline, US federal) or are not yet modelled.', '', '## Deeper rules to do (prioritised)', '');
  for (const p of packs) {
    const todo = p.coverage?.deeperRulesTodo ?? [];
    const notes = p.coverage?.notes;
    if (todo.length || notes) lines.push(`- **${p.jurisdiction}** (${p.coverage?.priority ?? 'n/a'})${todo.length ? `: ${todo.join('; ')}` : ''}${notes ? ` — ${notes}` : ''}`);
  }
  lines.push('', '## Sources', '', 'Each rule version and holiday definition links its official source in the pack JSON (`source.url`).', '');
  return lines.join('\n');
}

if (process.argv[1]?.endsWith('coverage-doc.ts')) {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'COVERAGE.md');
  writeFileSync(out, coverageMarkdown());
  console.log(`wrote ${out}`);
}
