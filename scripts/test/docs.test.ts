import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Brief §9: every document exists, carries what the brief asks of it, and its relative links resolve. */
const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const SECTION_9 = [
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/DESIGN.md',
  'docs/SECURITY.md',
  'docs/DECISIONS.md',
  'docs/COSTS.md',
  'docs/PERFORMANCE.md',
  'docs/COVERAGE.md',
  'docs/SUBPROCESSORS.md',
  'docs/COMPLIANCE.md',
  'docs/HUMAN_TODO.md',
  'docs/api.md',
  'docs/runbooks/deploy.md',
  'docs/runbooks/rollback.md',
  'docs/runbooks/backup-restore.md',
  'docs/runbooks/incident-and-breach-response.md',
  'docs/runbooks/move-tenant-to-dedicated-db.md',
  'docs/legal/dpia-template.md',
  'docs/legal/records-of-processing.md',
  'docs/guides/admin-guide.md',
  'docs/guides/employee-guide.md',
];
const JURISDICTIONS = ['uk', 'eu', 'us'];
const LEGAL_TEMPLATES = [
  'docs/legal/dpia-template.md',
  'docs/legal/records-of-processing.md',
  ...JURISDICTIONS.flatMap((j) => [`docs/legal/dpa-${j}.md`, `docs/legal/privacy-notice-${j}.md`]),
];

function markdownFiles(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(join(root, p)).isDirectory()) return markdownFiles(p);
    return p.endsWith('.md') ? [p] : [];
  });
}

describe('documentation (brief §9)', () => {
  it.each(SECTION_9)('%s exists and has a title and content', (p) => {
    const text = read(p);
    expect(text.startsWith('# ')).toBe(true);
    expect(text.split('\n').filter((l) => l.trim()).length).toBeGreaterThan(10);
  });

  it.each(LEGAL_TEMPLATES)('%s is marked "for legal review"', (p) => {
    expect(read(p).toLowerCase()).toContain('for legal review');
  });

  it('ARCHITECTURE has diagrams', () => {
    expect(read('docs/ARCHITECTURE.md').match(/```mermaid/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('COSTS covers each environment and each home region', () => {
    const costs = read('docs/COSTS.md');
    for (const heading of ['## Staging', '## Production', '## Development', '## Load test'])
      expect(costs).toContain(heading);
    for (const region of ['eu-west-2', 'eu-central-1', 'us-east-2']) expect(costs).toContain(region);
  });

  it('COMPLIANCE maps to SOC 2 and ISO 27001', () => {
    const compliance = read('docs/COMPLIANCE.md');
    expect(compliance).toContain('SOC 2');
    expect(compliance).toMatch(/ISO(\/IEC)? 27001/);
  });

  it('SECURITY holds the STRIDE threat model', () => {
    expect(read('docs/SECURITY.md')).toContain('## Threat model (STRIDE)');
  });

  it('every relative link in the docs resolves', () => {
    const broken: string[] = [];
    for (const file of ['README.md', ...markdownFiles('docs')]) {
      const text = read(file).replace(/```[\s\S]*?```/g, '');
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (!target || /^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
        const path = target.split('#')[0]!;
        if (path && !existsSync(join(root, normalize(join(dirname(file), path)))))
          broken.push(`${file} → ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
