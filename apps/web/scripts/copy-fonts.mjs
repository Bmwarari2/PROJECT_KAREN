// Self-hosts the handwriting font typed signatures are shown in (ADR-0197): Alex Brush by Robert Leuschke, SIL Open
// Font License 1.1, bundled once in the repository (assets/fonts/alex-brush, with its licence) and used by the API
// to stamp signatures into PDFs. It is copied into public/fonts/alex-brush/ before `next dev` and `next build`
// (git-ignored), served from the home region with the static-asset policy (next.config.ts), and loaded by the
// browser only where a signature is previewed. Never SF Pro or any Apple asset.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(web, '..', '..', 'assets', 'fonts', 'alex-brush');
const out = join(web, 'public', 'fonts', 'alex-brush');
mkdirSync(out, { recursive: true });
for (const f of ['AlexBrush-Regular.ttf', 'OFL.txt']) cpSync(join(src, f), join(out, f));
console.log('signature font (Alex Brush, OFL) in public/fonts/alex-brush');
