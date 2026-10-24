import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * docs/ASVS.md (PROGRESS 12.3) stays a complete, honest checklist: every OWASP ASVS 5.0.0 level 1 and 2
 * requirement has exactly one row with a known status, and every evidence link points at a file that
 * exists and, for tests, at test names that the file still contains.
 */
const root = join(__dirname, '..', '..');
const doc = readFileSync(join(root, 'docs', 'ASVS.md'), 'utf8');
/** Level 1 + 2 requirements per chapter in ASVS 5.0.0 (253 in total). */
const PER_CHAPTER: Record<string, number> = {
  V1: 27,
  V2: 11,
  V3: 19,
  V4: 10,
  V5: 9,
  V6: 35,
  V7: 18,
  V8: 7,
  V9: 7,
  V10: 29,
  V11: 14,
  V12: 9,
  V13: 13,
  V14: 9,
  V15: 13,
  V16: 16,
  V17: 7,
};
const STATUS =
  /^(Met|Met by platform \(AWS, .+\)|Not applicable \(.+\)|Fixed in this review|Fixed in hardening P0|Gap — recorded in .+)$/;

const rows = doc
  .split('\n')
  .filter((l) => /^\| V\d+\.\d+\.\d+ \|/.test(l))
  .map((l) => {
    const cells = l.split(' | ');
    return {
      id: cells[0]!.replace('| ', ''),
      level: cells[2]!,
      status: cells[3]!,
      evidence: cells.slice(4).join(' | ').replace(/ \|$/, ''),
    };
  });

describe('docs/ASVS.md', () => {
  it('has one row per level 1 and 2 requirement, each with a level and a known status', () => {
    expect(rows).toHaveLength(253);
    expect(new Set(rows.map((r) => r.id)).size).toBe(253);
    const chapters: Record<string, number> = {};
    for (const r of rows) chapters[r.id.split('.')[0]!] = (chapters[r.id.split('.')[0]!] ?? 0) + 1;
    expect(chapters).toEqual(PER_CHAPTER);
    for (const r of rows) {
      expect(r.level, r.id).toMatch(/^L[12]$/);
      expect(r.status, r.id).toMatch(STATUS);
      if (r.status === 'Met' || r.status.startsWith('Fixed in ')) expect(r.evidence, r.id).not.toBe('—');
    }
  });

  it('the summary counts match the rows', () => {
    const count = (re: RegExp) => rows.filter((r) => re.test(r.status)).length;
    const total = (label: string) =>
      Number(new RegExp(`^\\| ${label} \\| \\d+ \\| \\d+ \\| (\\d+) \\|$`, 'm').exec(doc)?.[1]);
    expect(total('Met')).toBe(count(/^Met$/));
    expect(total('Met by platform')).toBe(count(/^Met by platform/));
    expect(total('Fixed in this review')).toBe(count(/^Fixed in this review$/));
    expect(total('Fixed in hardening P0')).toBe(count(/^Fixed in hardening P0$/));
    expect(total('Not applicable')).toBe(count(/^Not applicable/));
    expect(total('Gap \\(recorded\\)')).toBe(count(/^Gap/));
  });

  it('every evidence link resolves, and every cited test name is still in its test file', () => {
    const problems: string[] = [];
    for (const r of rows) {
      for (const m of r.evidence.matchAll(/\]\((\.\.\/[^)#]+)\)(?: \(((?:"[^"]+"(?:; )?)+)\))?/g)) {
        const path = normalize(join(root, 'docs', m[1]!));
        if (!existsSync(path)) {
          problems.push(`${r.id}: missing ${m[1]}`);
          continue;
        }
        if (!m[2]) continue;
        const text = readFileSync(path, 'utf8');
        for (const name of m[2].matchAll(/"([^"]+)"/g))
          if (!text.includes(name[1]!)) problems.push(`${r.id}: "${name[1]}" not in ${m[1]}`);
      }
      for (const m of r.evidence.matchAll(/\]\((SECURITY|DECISIONS|HUMAN_TODO)\.md(?:#([a-z0-9-]+))?\)/g)) {
        const target = readFileSync(join(root, 'docs', `${m[1]}.md`), 'utf8');
        const anchors = new Set(
          target
            .split('\n')
            .filter((l) => l.startsWith('#'))
            .map((l) =>
              l
                .replace(/^#+\s*/, '')
                .toLowerCase()
                .replace(/[^a-z0-9 -]/g, '')
                .trim()
                .replace(/\s+/g, '-'),
            ),
        );
        if (m[2] && !anchors.has(m[2])) problems.push(`${r.id}: no heading #${m[2]} in ${m[1]}.md`);
      }
    }
    expect(problems).toEqual([]);
  });
});
