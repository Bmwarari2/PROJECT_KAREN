import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/** Phase 12.4: the secret scan in `pnpm verify` catches planted credentials and passes a clean tree. */
const scanner = join(__dirname, '..', 'secret-scan.mjs');
// Fake credentials are assembled at run time so this file never contains one.
const FAKE = {
  awsKeyId: ['AK', 'IA', 'Q'.repeat(16)].join(''),
  privateKey: ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
  githubToken: ['gh', 'p_', 'x'.repeat(36)].join(''),
  stripeLive: ['sk', '_live_', 'y'.repeat(24)].join(''),
  password: ['pass', 'word = "', 'z'.repeat(20), '"'].join(''),
};

let repo = '';
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = '';
});

function scan(files: Record<string, string>, ignore = '') {
  repo = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  if (ignore) writeFileSync(join(repo, '.gitignore'), ignore);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
  const r = spawnSync(process.execPath, [scanner], { cwd: repo, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('secret scan', () => {
  it('passes a tree with no credentials', () => {
    const r = scan({ 'src/app.ts': 'export const region = "eu-west-2";\n' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Secret scan passed');
  });

  it.each([
    ['AWS access key id', `const id = "${FAKE.awsKeyId}";`],
    ['Private key block', `${FAKE.privateKey}\nabc\n`],
    ['GitHub token', `TOKEN=${FAKE.githubToken}`],
    ['Stripe live key', `key: ${FAKE.stripeLive}`],
    ['Generic password assignment', `const ${FAKE.password};`],
  ])('fails on a %s in an untracked file and names the file', (rule, text) => {
    const r = scan({ 'src/config.ts': text });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`src/config.ts: ${rule}`);
  });

  it('allows fictional passwords in tests, but never real credential formats there', () => {
    expect(scan({ 'apps/api/test/a.test.ts': `const ${FAKE.password};` }).code).toBe(0);
    const r = scan({ 'apps/api/test/a.test.ts': `const id = "${FAKE.awsKeyId}";` });
    expect(r.code).toBe(1);
    expect(r.out).toContain('AWS access key id');
  });

  it('skips git-ignored files such as local .env files', () => {
    expect(scan({ '.env': `AWS_KEY=${FAKE.awsKeyId}\n` }, '.env\n').code).toBe(0);
  });
});
