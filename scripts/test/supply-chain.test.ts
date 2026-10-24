import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { checkWorkspace, MIN_RELEASE_AGE_MINUTES } from '../supply-chain.mjs';

/** Plan §5 (P0): the install policy in pnpm-workspace.yaml cannot be removed or weakened unnoticed. */
const workspace = readFileSync(join(__dirname, '..', '..', 'pnpm-workspace.yaml'), 'utf8');
const without = (key: string) =>
  workspace
    .split('\n')
    .filter((l) => !l.startsWith(`${key}:`))
    .join('\n');

describe('supply-chain install policy', () => {
  it("holds for the repository's pnpm-workspace.yaml", () => {
    expect(checkWorkspace(workspace)).toEqual([]);
    expect(MIN_RELEASE_AGE_MINUTES).toBe(10_080);
  });

  it('fails when the release-age cooldown is removed or shortened', () => {
    expect(checkWorkspace(without('minimumReleaseAge')).join()).toMatch(/minimumReleaseAge must be at least/);
    expect(
      checkWorkspace(workspace.replace(/^minimumReleaseAge: .*$/m, 'minimumReleaseAge: 1440')).join(),
    ).toMatch(/found 1440/);
    expect(checkWorkspace(`${workspace}\nminimumReleaseAgeStrict: false\n`).join()).toMatch(/Strict/);
    // an exclusion names one exact version, never a whole package or a pattern
    const widen = (entry: string) =>
      checkWorkspace(
        workspace.replace(/^minimumReleaseAgeExclude:\n/m, `minimumReleaseAgeExclude:\n  - '${entry}'\n`),
      );
    expect(widen('left-pad@1.3.0')).toEqual([]);
    expect(widen('@scope/left-pad@1.3.0')).toEqual([]);
    for (const bad of ['left-pad', '@scope/*', 'left-pad@^1.3.0', 'left-pad@1.x'])
      expect(widen(bad).join(), bad).toMatch(/must name one exact version/);
  });

  it('fails when the install-script allowlist is removed or bypassed', () => {
    const noAllowlist = workspace.replace(/^allowBuilds:\n(?:\s+.*\n?)*/m, '');
    expect(checkWorkspace(noAllowlist).join()).toMatch(/allowBuilds .* is missing/);
    expect(checkWorkspace(without('strictDepBuilds')).join()).toMatch(/strictDepBuilds must be true/);
    expect(checkWorkspace(`${workspace}\ndangerouslyAllowAllBuilds: true\n`).join()).toMatch(
      /dangerouslyAllowAllBuilds/,
    );
  });
});
