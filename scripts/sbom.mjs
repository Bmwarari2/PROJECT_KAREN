// Writes the CycloneDX software bill of materials of everything that ships (production dependencies of
// every workspace package, from the lockfile) to .verify/sbom.cdx.json and checks that every component
// comes from the npm registry with an integrity hash. Part of `pnpm verify` (security step), so CI keeps
// the SBOM as a build artifact (.verify/ is uploaded). No external service is involved.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { checkSbom } from './lib/sbom.mjs';

const out = process.env.SBOM_OUT ?? '.verify/sbom.cdx.json';
const json = execFileSync('pnpm', ['sbom', '--sbom-format', 'cyclonedx', '--lockfile-only', '--sbom-type', 'application', '--prod'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const bom = JSON.parse(json);
mkdirSync(out.split('/').slice(0, -1).join('/') || '.', { recursive: true });
writeFileSync(out, JSON.stringify(bom, null, 2) + '\n');
const { components, problems } = checkSbom(bom);
if (problems.length) {
  console.error(`SBOM check FAILED (${problems.length}):\n${problems.slice(0, 50).join('\n')}`);
  process.exit(1);
}
console.log(`SBOM written to ${out}: ${components} components, all from ${'registry.npmjs.org'} with integrity hashes.`);
