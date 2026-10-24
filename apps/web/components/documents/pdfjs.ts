import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs';

/** The self-hosted PDF.js version (scripts/copy-pdfjs.mjs; a unit test keeps it equal to the installed package). */
export const PDFJS_VERSION = '6.4.299';
export const PDFJS_BASE = `/pdfjs/${PDFJS_VERSION}/`;
export type PdfJs = typeof PdfJsModule;

let loading: Promise<PdfJs> | null = null;

/**
 * PDF.js, loaded as a native module from its self-hosted copy rather than from the page's bundle (ADR-0168):
 * the browser then parses and compiles it off the main thread, so a low-cost phone is not blocked while the
 * viewer starts. The page's policy allows it ('strict-dynamic' trusts what the page's own scripts import).
 */
export function loadPdfJs(): Promise<PdfJs> {
  loading ??= (
    import(/* webpackIgnore: true */ /* turbopackIgnore: true */ `${PDFJS_BASE}pdf.min.mjs`) as Promise<PdfJs>
  ).then(
    (m) => {
      m.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.mjs`;
      return m;
    },
    (err: unknown) => {
      loading = null; // a later attempt may succeed (a dropped connection)
      throw err;
    },
  );
  return loading;
}
