import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSpec } from '../openapi';

/** Writes the published OpenAPI 3.1 document to packages/sdk/openapi.json. */
const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'sdk',
  'openapi.json',
);
writeFileSync(out, JSON.stringify(await buildSpec(), null, 2) + '\n');
console.log(`wrote ${out}`);
process.exit(0);
