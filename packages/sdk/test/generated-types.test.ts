import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript';

/**
 * Phase 9.1: the committed SDK types are generated from the committed spec. Runs openapi-typescript the
 * way the `generate` script does (`openapi-typescript openapi.json -o src/generated/schema.ts`: no flags,
 * so every option at its default, and the CLI's comment header) and compares with the committed file.
 * Only the trailing newline is normalised. The spec itself is checked against the implementation in
 * apps/api/test/openapi.contract.test.ts.
 */
const lines = (s: string) => s.replace(/\n+$/, '').split('\n');

describe('SDK generation', () => {
  it('the generated SDK types match openapi.json (run: pnpm --filter @thapsus/sdk generate)', async () => {
    const generated = lines(`${COMMENT_HEADER}${astToString(await openapiTS(new URL('../openapi.json', import.meta.url), { silent: true }))}`);
    const committed = lines(readFileSync(new URL('../src/generated/schema.ts', import.meta.url), 'utf8'));
    const at = generated.findIndex((l, i) => l !== committed[i]);
    const first = at === -1 && generated.length !== committed.length ? Math.min(generated.length, committed.length) : at;
    // Report the first differing line instead of a diff of the whole file.
    expect(first === -1 ? null : { line: first + 1, generated: generated[first] ?? '<end of file>', committed: committed[first] ?? '<end of file>' }).toBeNull();
    expect(generated.length).toBeGreaterThan(1000);
  }, 60_000);
});
