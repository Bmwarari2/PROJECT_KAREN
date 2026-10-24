import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PDFJS_VERSION } from '../components/documents/pdfjs';

describe('self-hosted PDF.js', () => {
  it('is the installed version, so the copied library, worker and data match what the viewer types against', () => {
    const pkg = createRequire(import.meta.url).resolve('pdfjs-dist/package.json');
    expect(PDFJS_VERSION).toBe(JSON.parse(readFileSync(pkg, 'utf8')).version);
  });
});
