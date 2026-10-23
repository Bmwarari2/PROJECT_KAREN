import * as React from 'react';
import { cn } from './primitives';

/** The toolbar above data tables and its filter chips (DESIGN.md §6). */
export function TableToolbar({
  title,
  count,
  search,
  filters,
  actions,
  className,
  titleAs: Title = 'h2',
}: {
  title?: React.ReactNode;
  /** Heading level of the title, to nest under the page's headings. */
  titleAs?: 'h2' | 'h3' | 'h4';
  count?: React.ReactNode;
  search?: React.ReactNode;
  filters?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-3 border-b border-border px-4 py-3', className)}>
      {title || count ? (
        <div className="flex min-w-0 items-baseline gap-2">
          {title ? <Title className="text-callout font-semibold">{title}</Title> : null}
          {count ? <span className="text-footnote text-text-secondary">{count}</span> : null}
        </div>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {search}
        {filters}
        {actions}
      </div>
    </div>
  );
}

/** A removable chip for an applied filter. */
export function FilterChip({
  label,
  onRemove,
  removeLabel,
}: {
  label: string;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <span className="inline-flex h-8 items-center gap-1 rounded-full border border-border bg-surface pl-3 pr-1 text-footnote">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-text-secondary hover:bg-surface-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span aria-hidden>×</span>
      </button>
    </span>
  );
}

/** Unstyled dialog parts for full-custom overlays such as the command palette (global search). */
