import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The handwriting font typed signatures are drawn in (ADR-0197): Alex Brush by Robert Leuschke, SIL Open Font
 * License 1.1 (assets/fonts/alex-brush/OFL.txt), from the Google Fonts library. It is bundled in the repository
 * and embedded (subset) into the signed PDF in the home region; no font is fetched from a third party. Never SF
 * Pro or any Apple asset (CLAUDE.md).
 *
 * The file is found from the source tree (apps/api/src/modules/documents → repository root) or next to a bundle
 * (dist/main.mjs → ../assets, which the API and worker images copy, as they copy the jurisdiction packs).
 */
export const SIGNATURE_FONT_FILE = join('assets', 'fonts', 'alex-brush', 'AlexBrush-Regular.ttf');

let cached: Uint8Array | null = null;
export function signatureFont(): Uint8Array {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.SIGNATURE_FONT_PATH,
    join(here, '..', '..', '..', '..', '..', SIGNATURE_FONT_FILE),
    join(here, '..', SIGNATURE_FONT_FILE),
    join(here, '..', '..', '..', SIGNATURE_FONT_FILE),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`Signature font not found (looked in ${candidates.join(', ')})`);
  cached = new Uint8Array(readFileSync(found));
  return cached;
}
