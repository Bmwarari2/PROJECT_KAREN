import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSbom } from '../lib/sbom.mjs';

/** ASVS V15.1.2: an SBOM of every shipped third-party component, all from the trusted registry. */
const root = join(__dirname, '..', '..');
const npm = (name: string, url = `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`) => ({
  type: 'library',
  name,
  version: '1.0.0',
  purl: `pkg:npm/${name}@1.0.0`,
  externalReferences: [{ type: 'distribution', url, hashes: [{ alg: 'SHA-512', content: 'ab'.repeat(64) }] }],
});

describe('software bill of materials', () => {
  it('accepts registry packages with integrity hashes and our own workspace packages', () => {
    const bom = { bomFormat: 'CycloneDX', components: [npm('left-pad'), { type: 'library', name: 'core', group: '@thapsus', version: '0.1.0', purl: 'pkg:npm/%40thapsus/core@0.1.0' }] };
    expect(checkSbom(bom)).toEqual({ components: 2, problems: [] });
  });

  it('flags components from other locations or without a hash', () => {
    const git = npm('forked', 'https://codeload.github.com/someone/forked/tar.gz/abc');
    const noHash = { ...npm('nohash'), externalReferences: [{ type: 'distribution', url: 'https://registry.npmjs.org/nohash/-/nohash-1.0.0.tgz', hashes: [] }] };
    const { problems } = checkSbom({ bomFormat: 'CycloneDX', components: [git, noHash, { name: 'mystery', version: '1.0.0' }] });
    expect(problems).toEqual([
      'pkg:npm/forked@1.0.0: from an untrusted location https://codeload.github.com/someone/forked/tar.gz/abc',
      'pkg:npm/nohash@1.0.0: no integrity hash',
      'mystery@1.0.0: not an npm package',
      'mystery@1.0.0: no distribution location',
    ]);
  });

  it('the lockfile yields a clean CycloneDX SBOM of the production dependencies', () => {
    const bom = JSON.parse(execFileSync('pnpm', ['sbom', '--sbom-format', 'cyclonedx', '--lockfile-only', '--sbom-type', 'application', '--prod'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
    const result = checkSbom(bom);
    expect(result.problems).toEqual([]);
    expect(result.components).toBeGreaterThan(100);
    expect(bom.specVersion).toMatch(/^1\.[5-7]$/);
  });
});
