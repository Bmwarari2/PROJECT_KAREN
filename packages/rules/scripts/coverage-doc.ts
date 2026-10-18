import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleBook } from '../src/engine';
import { RULE_KEYS } from '../src/schema';

/** Generates docs/COVERAGE.md from the pack data (run: pnpm --filter @thapsus/rules coverage-doc). */
export function coverageMarkdown(book = RuleBook.fromDirectory()): string {
  const packs = book.jurisdictions().sort((a, b) => {
    const rank = (j: string) => (j === 'GB' || j.startsWith('GB-') ? 0 : j === 'EU' ? 1 : j === 'US' ? 2 : j.startsWith('US-') ? 4 : 3);
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
  // UK nations (and any other pack with subdivisions): which subdivisions each rule answers for
  for (const p of packs.filter((x) => x.subdivisions?.length)) {
    const subs = p.subdivisions!;
    const children = packs.filter((c) => c.parent === p.jurisdiction && subs.includes(c.jurisdiction));
    lines.push('', `## Subdivision extent — ${p.jurisdiction}`, '', `Rule versions in the ${p.jurisdiction} pack list the subdivisions they were verified for (ADR-0022). A lookup for a subdivision gets its own pack's rule first, then only ${p.jurisdiction} versions that list it; anything else fails rather than being inherited.`, '', `| Rule | ${subs.join(' | ')} |`, `| --- | ${subs.map(() => '---').join(' | ')} |`);
    const ruleKeys = [...new Set([...p.rules.map((r) => r.key), ...children.flatMap((c) => c.rules.map((r) => r.key))])].sort();
    const notAvailable = new Map<string, string[]>();
    for (const key of ruleKeys) {
      const cells = subs.map((sub) => {
        const own = children.find((c) => c.jurisdiction === sub)?.rules.some((r) => r.key === key);
        const inherited = p.rules.find((r) => r.key === key)?.versions.some((v) => v.regions?.includes(sub));
        if (!own && !inherited) notAvailable.set(sub, [...(notAvailable.get(sub) ?? []), key]);
        return own ? `✔ ${sub} pack` : inherited ? `✔ ${p.jurisdiction}` : '✘';
      });
      lines.push(`| \`${key}\` | ${cells.join(' | ')} |`);
    }
    lines.push('', '✘ = not verified for that subdivision: lookups fail explicitly (coverage to-do).');
    for (const [sub, keys] of notAvailable) lines.push(`- **${sub}** not modelled: ${keys.map((k) => `\`${k}\``).join(', ')}`);
  }
  lines.push('', '## Verification log', '', 'Every rule version with the date it was last checked against its official source (`verifiedOn`). Holiday definitions are summarised per pack.', '', '| Jurisdiction | Rule | Effective from | Effective to | Regions | Verified on | Source |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const p of packs) {
    for (const r of [...p.rules].sort((a, b) => a.key.localeCompare(b.key))) {
      for (const v of r.versions) lines.push(`| ${p.jurisdiction} | \`${r.key}\` | ${v.effectiveFrom} | ${v.effectiveTo ?? '—'} | ${v.regions?.join(', ') ?? 'all'} | ${v.verifiedOn} | ${v.source.url.replace(/\|/g, '%7C')} |`);
    }
  }
  lines.push('', '| Jurisdiction | Holiday definitions | Verified on |', '| --- | --- | --- |');
  for (const p of packs.filter((x) => x.holidays.length)) {
    const dates = [...new Set(p.holidays.map((h) => h.verifiedOn))].sort();
    lines.push(`| ${p.jurisdiction} | ${p.holidays.length} | ${dates.join(', ')} |`);
  }
  lines.push('', '## Sources', '', 'Each rule version and holiday definition links its official source in the pack JSON (`source.url`).', '');
  return lines.join('\n');
}

if (process.argv[1]?.endsWith('coverage-doc.ts')) {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'COVERAGE.md');
  writeFileSync(out, coverageMarkdown());
  console.log(`wrote ${out}`);
}
