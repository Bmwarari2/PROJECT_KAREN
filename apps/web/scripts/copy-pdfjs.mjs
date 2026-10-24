// Self-hosts the PDF.js worker and its data files (ADR-0168): copies them from the installed pdfjs-dist into
// public/pdfjs/<version>/ before `next dev` and `next build`, so the document viewer never loads code or fonts
// from a third party and the files are served from the home region with their own policy (next.config.ts).
// The folder is generated (git-ignored); the version in the path makes every file safe to cache for good.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgJson = createRequire(join(web, 'package.json')).resolve('pdfjs-dist/package.json');
const src = dirname(pkgJson);
const { version } = JSON.parse(readFileSync(pkgJson, 'utf8'));
const root = join(web, 'public', 'pdfjs');
const out = join(root, version);
const MARK = join(out, 'build.txt'); // which build was copied, so a switch of build copies again
if (!existsSync(MARK) || readFileSync(MARK, 'utf8') !== 'legacy\n') {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // the legacy build, like the viewer's library: it polyfills the newest built-ins for older phone browsers
  cpSync(join(src, 'legacy', 'build', 'pdf.worker.min.mjs'), join(out, 'pdf.worker.min.mjs'));
  for (const dir of ['standard_fonts', 'cmaps', 'wasm'])
    cpSync(join(src, dir), join(out, dir), { recursive: true });
  cpSync(join(src, 'LICENSE'), join(out, 'LICENSE'));
  writeFileSync(MARK, 'legacy\n');
}
console.log(`pdf.js ${version} worker and data in public/pdfjs/${version}`);
