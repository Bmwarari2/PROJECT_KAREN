import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokensCss } from '../src/tokens';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'theme.css');
writeFileSync(out, tokensCss());
console.log(`wrote ${out}`);
