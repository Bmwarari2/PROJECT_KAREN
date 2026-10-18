import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIRECTORY_FIELDS, PgDirectory } from '../src/lib/directory';

/**
 * The global tenant directory must never hold personal data. Adding a field to the directory
 * schema fails these tests until the allow-list below is changed deliberately (and reviewed).
 */
const ALLOWED = ['tenantId', 'slug', 'homeRegion', 'status', 'planRef', 'verifiedDomains', 'createdAt', 'updatedAt'];
const PERSONAL = /email|name$|phone|address|birth|ssn|nino|national|salary|ip$|user/i;
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe('tenant directory schema', () => {
  it('is exactly the reviewed allow-list and names nothing personal', () => {
    expect([...DIRECTORY_FIELDS].sort()).toEqual([...ALLOWED].sort());
    for (const f of DIRECTORY_FIELDS) expect(f).not.toMatch(PERSONAL);
  });

  it('the local/regional Postgres directory table has only those columns', () => {
    const columns = PgDirectory.DDL.replace(/^[^(]*\(/, '')
      .split(/,(?![^(]*\))/)
      .map((c) => c.trim().split(/\s+/)[0]!)
      .map(camel);
    expect(columns).toHaveLength(DIRECTORY_FIELDS.length);
    for (const c of columns) expect(DIRECTORY_FIELDS as readonly string[]).toContain(c);
  });

  it('every directory field is an allow-listed attribute of the global DynamoDB table', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', '..', 'infra', 'lib', 'global-stack.ts'), 'utf8');
    const block = /export const DIRECTORY_ATTRIBUTES = \[([^\]]*)\]/.exec(src)?.[1];
    expect(block).toBeDefined();
    const attrs = [...block!.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    for (const f of DIRECTORY_FIELDS) expect(attrs).toContain(f);
    for (const a of attrs) expect(a).not.toMatch(PERSONAL);
  });
});
