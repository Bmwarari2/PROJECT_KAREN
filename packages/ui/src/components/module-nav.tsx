import * as React from 'react';
import { cn } from './primitives';

/** The module header and its tab bar (DESIGN.md §6, ADR-0154). No Radix: plain links. */
export interface TabLink {
  href: string;
  label: string;
  active: boolean;
  /** Small count shown after the label (pending items). */
  count?: number;
}

/**
 * A module's sections as a segmented control (ADR-0180): a grey track with the current section raised
 * on it, scrolling sideways on narrow screens (faded at the edges) so no label is ever cut. A
 * navigation landmark (not ARIA tabs), because each section is its own page.
 */
export function TabNav({
  tabs,
  label,
  renderLink,
  className,
}: {
  tabs: TabLink[];
  label: string;
  renderLink?: (tab: TabLink, className: string, children: React.ReactNode) => React.ReactNode;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      data-tab-nav
      className={cn(
        '-mx-4 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      <ul className="inline-flex min-w-max gap-0.5 rounded-pill bg-segment-track p-0.5">
        {tabs.map((tab) => {
          const cls = cn(
            'inline-flex h-9 items-center gap-1.5 rounded-pill px-4 text-callout no-underline transition-[background-color,color,box-shadow] duration-[var(--duration-fast)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
            tab.active
              ? 'bg-segment-selected font-semibold text-text shadow-sm'
              : 'text-text-secondary hover:text-text',
          );
          const children = (
            <>
              {tab.label}
              {tab.count ? (
                <span className="min-w-5 rounded-pill bg-accent px-1.5 text-center text-footnote font-semibold tabular-nums text-on-accent">
                  {tab.count}
                </span>
              ) : null}
            </>
          );
          return (
            <li key={tab.href} data-active={tab.active || undefined}>
              {renderLink ? (
                renderLink(tab, cls, children)
              ) : (
                <a href={tab.href} className={cls} aria-current={tab.active ? 'page' : undefined}>
                  {children}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The top of a module page (ADR-0180): its name as one bold large title (the page's h1) on the page
 * background, with a small icon tile from `sm` up, optional actions and the sections control.
 *
 * `drilled` is for a page one step into a module whose index lists its pages (Settings, ADR-0181):
 * below `lg` the page shows its own back link and large title, so the module's name stays the h1 for
 * screen readers but is not shown, and the header takes no space.
 */
export function ModuleHeader({
  icon,
  title,
  description,
  actions,
  tabs,
  drilled = false,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  tabs?: React.ReactNode;
  drilled?: boolean;
}) {
  return (
    <div className="bg-surface">
      <div
        className={cn(
          'mx-auto flex w-full max-w-[var(--app-width)] flex-col gap-4 px-4 pt-5 md:px-8 md:pt-8',
          drilled && 'max-lg:pt-0',
        )}
      >
        <div className="flex flex-wrap items-center gap-3">
          <span
            aria-hidden
            className={cn(
              'hidden h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-accent-subtle text-accent sm:inline-flex [&_svg]:h-[22px] [&_svg]:w-[22px] [&_svg]:stroke-[1.75]',
              drilled && 'max-lg:!hidden',
            )}
          >
            {icon}
          </span>
          <div className={cn('min-w-0 flex-1', drilled && 'max-lg:sr-only')}>
            <h1 className="text-large-title text-text">{title}</h1>
            {description ? <p className="text-callout text-text-secondary">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {tabs}
      </div>
    </div>
  );
}

/** The row above a data table: search, filters and the result count on one line, wrapping on phones. */
