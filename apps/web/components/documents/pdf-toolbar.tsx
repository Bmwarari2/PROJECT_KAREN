'use client';
import { ChevronLeft, ChevronRight, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { Button, Skeleton } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';

/**
 * The document viewer's page controls (ADR-0168), kept apart from PDF.js so the page can show them while the
 * viewer's code loads: previous and next, the page number, zoom out and in, and fit to width. Every control is
 * a 44px target.
 */
export interface PdfToolbarProps {
  page: number;
  count: number;
  pageInput: string;
  /** The current scale (fit to width has one too); shown as a percentage of the page's real size. */
  scale: number;
  fit: boolean;
  ready: boolean;
  onPageInput?: (value: string) => void;
  onGo?: (page: number) => void;
  onZoom?: (dir: 1 | -1) => void;
  onFit?: () => void;
}

const icon = 'h-11 w-11';

export function PdfToolbar({
  page,
  count,
  pageInput,
  scale,
  fit,
  ready,
  onPageInput,
  onGo,
  onZoom,
  onFit,
}: PdfToolbarProps) {
  const t = useT();
  const go = (n: number) => onGo?.(n);
  return (
    <div
      role="group"
      aria-label={t('docView.toolbar')}
      className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-raised p-2 shadow-sm"
    >
      <Button
        variant="ghost"
        size="icon"
        className={icon}
        onClick={() => go(page - 1)}
        disabled={!ready || page <= 1}
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
          disabled={!ready}
          onChange={(e) => onPageInput?.(e.target.value)}
          onBlur={() => go(Number(pageInput) || page)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(Number(pageInput) || page);
          }}
          className="h-11 w-16 rounded-sm border border-border-strong bg-surface-raised px-2 text-center text-callout text-text tabular-nums focus-visible:outline-2 focus-visible:outline-accent"
        />
        <span aria-hidden>{t('docView.ofPages', { count })}</span>
      </label>
      <Button
        variant="ghost"
        size="icon"
        className={icon}
        onClick={() => go(page + 1)}
        disabled={!ready || page >= count}
        aria-label={t('docView.nextPage')}
      >
        <ChevronRight aria-hidden className="h-5 w-5 stroke-[1.5]" />
      </Button>
      <span className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden />
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className={icon}
          onClick={() => onZoom?.(-1)}
          disabled={!ready}
          aria-label={t('docView.zoomOut')}
        >
          <ZoomOut aria-hidden className="h-5 w-5 stroke-[1.5]" />
        </Button>
        <span className="w-12 text-center text-footnote text-text-secondary tabular-nums" aria-hidden>
          {ready ? `${Math.round(scale * 75)}%` : ''}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className={icon}
          onClick={() => onZoom?.(1)}
          disabled={!ready}
          aria-label={t('docView.zoomIn')}
        >
          <ZoomIn aria-hidden className="h-5 w-5 stroke-[1.5]" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={icon}
          onClick={() => onFit?.()}
          disabled={!ready || fit}
          aria-label={t('docView.fitWidth')}
          aria-pressed={fit}
        >
          <Maximize2 aria-hidden className="h-5 w-5 stroke-[1.5]" />
        </Button>
      </div>
    </div>
  );
}

/**
 * The viewer while PDF.js loads: the same controls (not yet usable) over a page-shaped placeholder, so nothing
 * on the page moves when the document appears.
 */
export function PdfViewerPlaceholder() {
  return (
    <div className="flex flex-col gap-3">
      <PdfToolbar page={1} count={0} pageInput="1" scale={1} fit ready={false} />
      <Skeleton className="aspect-[1/1.414] w-full" />
    </div>
  );
}
