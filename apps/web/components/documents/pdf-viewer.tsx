'use client';
import * as React from 'react';
import { ChevronLeft, ChevronRight, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
// the legacy build: it carries polyfills for the newest built-ins, so older phone browsers work too
import { getDocument, GlobalWorkerOptions, TextLayer, version } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Button, Skeleton } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import styles from './pdf-viewer.module.css';

/**
 * The in-app PDF viewer (ADR-0168), loaded only on the pages that show a document. PDF.js renders each page to
 * a canvas, so it never depends on the browser's own PDF plug-in (Android Chrome has none inline), and lays the
 * page's text over it as an invisible, selectable text layer that screen readers read. The worker and the font
 * and image-decoder data are self-hosted under /pdfjs/<version>/ with their own policy (next.config.ts); the
 * document's bytes come from the API, which audits the view, and are handed to the worker, which fetches nothing.
 *
 * One page is shown at a time (light on low-cost phones): previous and next, a page number, zoom in and out and
 * fit to width, with the page change announced politely.
 */
const BASE = `/pdfjs/${version}/`;
GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.mjs`;

type PdfDocument = Awaited<ReturnType<typeof getDocument>['promise']>;
type Zoom = 'fit' | number;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** The largest canvas (in device pixels) we draw: big pages on small phones would otherwise run out of memory. */
const MAX_CANVAS_PIXELS = 12_000_000;

export interface PdfViewerProps {
  /** Same-origin URL of the PDF bytes. */
  src: string;
  /** The document's title, for the page region's accessible name. */
  title: string;
  /** Shown instead of the page when the PDF cannot be shown (with a download, for example). */
  fallback?: React.ReactNode;
  onPages?: (count: number) => void;
  onPage?: (page: number) => void;
}

export default function PdfViewer({ src, title, fallback, onPages, onPage }: PdfViewerProps) {
  const t = useT();
  const [doc, setDoc] = React.useState<PdfDocument | null>(null);
  const [error, setError] = React.useState<'unsupported' | 'password' | 'failed' | null>(null);
  const [page, setPage] = React.useState(1);
  const [pageInput, setPageInput] = React.useState('1');
  const [zoom, setZoom] = React.useState<Zoom>('fit');
  const [width, setWidth] = React.useState(0);
  const [scale, setScale] = React.useState(1);
  const [rendering, setRendering] = React.useState(true);
  const frame = React.useRef<HTMLDivElement>(null);
  const pageRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const textRef = React.useRef<HTMLDivElement>(null);

  // load the document once per source
  React.useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof getDocument> | null = null;
    // without workers or canvas there is nothing to draw with: the download stays
    if (typeof Worker === 'undefined' || !document.createElement('canvas').getContext) {
      setError('unsupported');
      return;
    }
    (async () => {
      try {
        const res = await fetch(src, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(String(res.status));
        const data = new Uint8Array(await res.arrayBuffer());
        task = getDocument({
          data,
          standardFontDataUrl: `${BASE}standard_fonts/`,
          cMapUrl: `${BASE}cmaps/`,
          cMapPacked: true,
          wasmUrl: `${BASE}wasm/`,
          // the page fetches font and decoder data and hands it over: the worker's own policy allows no fetching
          useWorkerFetch: false,
          enableXfa: false,
        });
        const loaded = await task.promise;
        if (cancelled) return;
        setDoc(loaded);
        onPages?.(loaded.numPages);
      } catch (err) {
        if (!cancelled)
          setError((err as { name?: string }).name === 'PasswordException' ? 'password' : 'failed');
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
    // onPages is a notification only, deliberately not a dependency
  }, [src]);

  // the frame's width decides "fit to width"
  React.useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);

  // render the current page (canvas, then its text layer); a newer render cancels an older one
  React.useEffect(() => {
    if (!doc || !width || !canvasRef.current || !textRef.current) return;
    let cancelled = false;
    let renderTask: { cancel(): void; promise: Promise<void> } | null = null;
    let textLayer: TextLayer | null = null;
    setRendering(true);
    (async () => {
      try {
        const p = await doc.getPage(page);
        if (cancelled) return;
        const base = p.getViewport({ scale: 1 });
        const s = zoom === 'fit' ? width / base.width : zoom;
        const viewport = p.getViewport({ scale: s });
        const canvas = canvasRef.current!;
        let ratio = Math.min(window.devicePixelRatio || 1, 2);
        while (viewport.width * viewport.height * ratio * ratio > MAX_CANVAS_PIXELS && ratio > 0.5)
          ratio -= 0.25;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        pageRef.current!.style.setProperty('--total-scale-factor', String(viewport.scale));
        pageRef.current!.style.width = `${Math.floor(viewport.width)}px`;
        renderTask = p.render({
          canvas,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        });
        await renderTask.promise;
        if (cancelled) return;
        const text = textRef.current!;
        text.replaceChildren();
        textLayer = new TextLayer({ textContentSource: p.streamTextContent(), container: text, viewport });
        await textLayer.render();
        if (cancelled) return;
        setScale(s);
        setRendering(false);
        onPage?.(page);
      } catch (err) {
        if (!cancelled && (err as { name?: string }).name !== 'RenderingCancelledException')
          setError('failed');
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
    // onPage is a notification only, deliberately not a dependency
  }, [doc, page, zoom, width]);

  React.useEffect(() => setPageInput(String(page)), [page]);

  if (error)
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-border p-5" role="status">
        <p className="text-callout text-text-secondary">{t(`docView.error.${error}`)}</p>
        {fallback}
      </div>
    );

  const count = doc?.numPages ?? 0;
  const go = (n: number) => setPage(Math.min(Math.max(1, n), count || 1));
  const zoomBy = (dir: 1 | -1) => {
    const current = zoom === 'fit' ? scale : zoom;
    const next =
      dir > 0
        ? ZOOM_STEPS.find((z) => z > current + 0.01)
        : [...ZOOM_STEPS].reverse().find((z) => z < current - 0.01);
    if (next) setZoom(next);
  };
  return (
    <div className="flex flex-col gap-3">
      <div
        role="group"
        aria-label={t('docView.toolbar')}
        className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-raised p-2 shadow-sm"
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={() => go(page - 1)}
          disabled={!doc || page <= 1}
          aria-label={t('docView.previousPage')}
        >
          <ChevronLeft aria-hidden className="h-5 w-5 stroke-[1.5]" />
        </Button>
        <label className="flex items-center gap-2 text-callout text-text-secondary">
          <span className="sr-only">{t('docView.pageNumber')}</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={count || 1}
            value={pageInput}
            disabled={!doc}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={() => go(Number(pageInput) || page)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go(Number(pageInput) || page);
            }}
            className="h-10 w-16 rounded-sm border border-border-strong bg-surface-raised px-2 text-center text-callout text-text tabular-nums focus-visible:outline-2 focus-visible:outline-accent"
          />
          <span aria-hidden>{t('docView.ofPages', { count })}</span>
        </label>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => go(page + 1)}
          disabled={!doc || page >= count}
          aria-label={t('docView.nextPage')}
        >
          <ChevronRight aria-hidden className="h-5 w-5 stroke-[1.5]" />
        </Button>
        <span className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden />
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => zoomBy(-1)}
            disabled={!doc}
            aria-label={t('docView.zoomOut')}
          >
            <ZoomOut aria-hidden className="h-5 w-5 stroke-[1.5]" />
          </Button>
          <span className="w-12 text-center text-footnote text-text-secondary tabular-nums" aria-hidden>
            {Math.round(scale * 75)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => zoomBy(1)}
            disabled={!doc}
            aria-label={t('docView.zoomIn')}
          >
            <ZoomIn aria-hidden className="h-5 w-5 stroke-[1.5]" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setZoom('fit')}
            disabled={!doc || zoom === 'fit'}
            aria-label={t('docView.fitWidth')}
            aria-pressed={zoom === 'fit'}
          >
            <Maximize2 aria-hidden className="h-5 w-5 stroke-[1.5]" />
          </Button>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {doc ? t('docView.pageOf', { page, count }) : ''}
      </p>
      <div
        ref={frame}
        className="w-full overflow-x-auto"
        tabIndex={zoom === 'fit' ? undefined : 0}
        aria-label={zoom === 'fit' ? undefined : t('docView.scrollPage')}
        role={zoom === 'fit' ? undefined : 'region'}
      >
        {!doc ? <Skeleton className="aspect-[1/1.414] w-full" /> : null}
        <div
          ref={pageRef}
          role="region"
          aria-label={t('docView.pageRegion', { title, page, count })}
          aria-busy={rendering || undefined}
          className={`${styles.page} ${doc ? '' : 'hidden'}`}
        >
          <canvas ref={canvasRef} className={styles.canvas} aria-hidden />
          <div ref={textRef} className="textLayer" />
        </div>
      </div>
    </div>
  );
}
