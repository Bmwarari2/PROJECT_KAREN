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
 * A module's tab bar: page links with an underline on the current one, scrolling sideways on narrow
 * screens. A navigation landmark (not ARIA tabs), because each tab is its own page.
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
    <nav aria-label={label} className={cn('-mb-px overflow-x-auto', className)}>
      <ul className="flex min-w-max gap-1">
        {tabs.map((tab) => {
          const cls = cn(
            'inline-flex h-11 items-center gap-2 border-b-2 px-3 text-callout no-underline transition-colors duration-[var(--duration-fast)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
            tab.active
              ? 'border-accent font-semibold text-text'
              : 'border-transparent text-text-secondary hover:text-text',
          );
          const children = (
            <>
              {tab.label}
              {tab.count ? (
                <span className="rounded-full bg-accent-subtle px-1.5 text-footnote tabular-nums text-text">
                  {tab.count}
                </span>
              ) : null}
            </>
          );
          return (
            <li key={tab.href}>
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

/** The band at the top of a module: its icon tile, its name (the page's h1) and its tab bar. */
export function ModuleHeader({
  icon,
  title,
  description,
  actions,
  tabs,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  tabs?: React.ReactNode;
}) {
  return (
    <div className="border-b border-border bg-surface-raised">
      <div className="mx-auto flex w-full max-w-[var(--app-width)] flex-col gap-3 px-4 pt-5 md:px-8">
        <div className="flex flex-wrap items-center gap-4">
          <span
            aria-hidden
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-chrome text-on-chrome [&_svg]:h-6 [&_svg]:w-6 [&_svg]:stroke-[1.5]"
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-title-2">{title}</h1>
            {description ? <p className="text-footnote text-text-secondary">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {tabs ?? <div className="h-3" />}
      </div>
    </div>
  );
}

/** The row above a data table: search, filters and the result count on one line, wrapping on phones. */
