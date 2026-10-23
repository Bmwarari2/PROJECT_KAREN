'use client';
import * as React from 'react';
import { Search } from 'lucide-react';
import { Button, Card, cn, EmptyState, FilterChip, Input, TableToolbar } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { ModuleFrameContext, PageTitle } from '@/app/app/shell';

/**
 * Page parts for module pages (ADR-0154, DESIGN.md §4 and §6). Inside a module the shell renders the
 * module header (the page's h1) and the tab bar; a page adds a header row and its content cards.
 */

/** True on a page the shell frames with a module header and tab bar. */
export function useInModule(): boolean {
  return React.useContext(ModuleFrameContext);
}

/**
 * The heading level for sections under a page title that is kept (`PageTitle`): h3 under the h2 it is
 * inside a module, h2 under the h1 it is elsewhere, so headings never skip a level (WCAG 1.3.1).
 */
export function useSectionLevel(): { heading: 'h2' | 'h3'; level: 2 | 3 } {
  return useInModule() ? { heading: 'h3', level: 3 } : { heading: 'h2', level: 2 };
}

/**
 * A page's header row: its title, a lead paragraph and the primary actions. A title that only repeats
 * the tab's name (`titleIsTab`) is dropped under the module header, which already shows it, and stays
 * as the h1 when the page opens outside a module. Any other title is a `PageTitle`.
 */
export function PageIntro({
  title,
  titleIsTab = false,
  lead,
  actions,
  children,
}: {
  title?: React.ReactNode;
  titleIsTab?: boolean;
  lead?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const inModule = useInModule();
  const showTitle = !!title && !(titleIsTab && inModule);
  if (!showTitle && !lead && !actions && !children) return null;
  return (
    <div className="flex flex-wrap items-start gap-3">
      {showTitle || lead || children ? (
        <div className="mr-auto flex min-w-0 max-w-[var(--prose-width)] flex-col gap-1">
          {showTitle ? <PageTitle>{title}</PageTitle> : null}
          {lead ? <p className="text-callout text-text-secondary">{lead}</p> : null}
          {children}
        </div>
      ) : null}
      {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export const filterSelectClass =
  'h-10 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout text-text focus-visible:outline-2 focus-visible:outline-accent';

/** The search field of a list toolbar (filters rows already on the page). */
export function ListSearch({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <span className="relative inline-flex w-full sm:w-60">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 stroke-[1.5] text-text-secondary"
      />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        placeholder={label}
        className="pl-9"
      />
    </span>
  );
}

/** A filter of a list toolbar: a labelled select whose first option means "any". */
export function ListFilter({
  value,
  onChange,
  label,
  anyLabel,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  anyLabel: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(filterSelectClass, 'w-full sm:w-auto')}
    >
      <option value="">{anyLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** An applied filter, shown as a removable chip under the toolbar. */
export interface AppliedFilter {
  key: string;
  label: string;
  clear: () => void;
}

/**
 * A list the way the workspace shows records: a card with a toolbar (title, count, search, filters and
 * actions), chips for the applied filters and the table flush with the card's edges.
 */
export function ListCard({
  title,
  count,
  search,
  filters,
  actions,
  applied = [],
  empty,
  children,
  className,
}: {
  title: React.ReactNode;
  /** Shown beside the title and announced when it changes (filtering). */
  count?: React.ReactNode;
  search?: React.ReactNode;
  filters?: React.ReactNode;
  actions?: React.ReactNode;
  applied?: AppliedFilter[];
  /** Replaces the table when there are no rows to show (an EmptyState or a ListNoMatches). */
  empty?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  const t = useT();
  return (
    <Card className={cn('flex flex-col p-0', className)}>
      <TableToolbar
        title={title}
        count={count !== undefined ? <span role="status">{count}</span> : undefined}
        search={search}
        filters={filters}
        actions={actions}
      />
      {applied.length ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <span className="text-footnote text-text-secondary">{t('listView.applied')}</span>
          {applied.map((f) => (
            <FilterChip
              key={f.key}
              label={f.label}
              onRemove={f.clear}
              removeLabel={t('listView.removeFilter', { label: f.label })}
            />
          ))}
          {applied.length > 1 ? (
            <Button variant="ghost" size="sm" onClick={() => applied.forEach((f) => f.clear())}>
              {t('listView.clearAll')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {empty ? (
        <div className="p-4">{empty}</div>
      ) : (
        <div className="[&>div]:rounded-t-none [&>div]:border-0">{children}</div>
      )}
    </Card>
  );
}

/** What a filtered list shows when no row matches: says so and offers to clear the filters. */
export function ListNoMatches({ onClear, level = 3 }: { onClear: () => void; level?: 2 | 3 }) {
  const t = useT();
  return (
    <EmptyState
      level={level}
      icon={<Search aria-hidden />}
      title={t('listView.noMatches')}
      action={
        <Button variant="secondary" size="sm" onClick={onClear}>
          {t('listView.clearAll')}
        </Button>
      }
    />
  );
}

/** Case- and accent-insensitive "contains" for client-side search. */
export function matches(query: string, ...values: Array<string | null | undefined>): boolean {
  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLocaleLowerCase();
  const q = norm(query.trim());
  if (!q) return true;
  return values.some((v) => !!v && norm(v).includes(q));
}
