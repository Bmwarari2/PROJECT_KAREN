'use client';
import * as React from 'react';
import { IntentLink as Link } from '@/components/intent-link';
import { ArrowRight } from 'lucide-react';
import { cn, focusRing } from '@thapsus/ui';
import { initials } from '@/components/workspace/user-menu-button';

/**
 * Dashboard building blocks (DESIGN.md §4 page body, §6 cards): panels on `surface-raised` over the
 * `surface` page, with a heading at the level the page needs (h2 on a module page, h3 under a Home
 * section), so headings never skip a level.
 */

export type HeadingLevel = 2 | 3;

export function Panel({
  title,
  level,
  description,
  action,
  children,
  className,
  ...rest
}: {
  title: React.ReactNode;
  level: HeadingLevel;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  const Heading = `h${level}` as const;
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface-raised p-5',
        className,
      )}
      {...rest}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <Heading className="text-body font-semibold text-text">{title}</Heading>
          {description ? <p className="text-footnote text-text-secondary">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

/** A quiet "go there" link for a panel's corner or foot (at least 32px high). */
export function PanelLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex min-h-8 items-center gap-1 rounded-sm text-callout font-semibold text-accent no-underline hover:underline',
        focusRing,
        className,
      )}
    >
      {children}
      <ArrowRight aria-hidden className="h-4 w-4 shrink-0 stroke-[1.5]" />
    </Link>
  );
}

/** Generated initials (DESIGN.md §8: no photos of real people in product UI). Decorative. */
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-pill bg-accent-subtle font-semibold text-accent',
        size === 'sm' && 'h-8 w-8 text-footnote',
        size === 'md' && 'h-10 w-10 text-callout',
        size === 'lg' && 'h-16 w-16 text-title-3',
      )}
    >
      {initials(name) || '?'}
    </span>
  );
}

/** A section of the home page: an h2 with optional links on the right. */
export function SectionHeading({
  id,
  title,
  children,
}: {
  id?: string;
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h2 id={id} className="text-title-3 text-text">
        {title}
      </h2>
      {children ? <div className="flex flex-wrap items-center gap-x-4">{children}</div> : null}
    </div>
  );
}

/** An icon in a small rounded tile, for panel and attention-item headers. */
export function IconTile({
  children,
  tone = 'accent',
}: {
  children: React.ReactNode;
  tone?: 'accent' | 'muted';
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md [&_svg]:h-5 [&_svg]:w-5 [&_svg]:stroke-[1.5]',
        tone === 'accent' ? 'bg-accent-subtle text-accent' : 'bg-surface text-text-secondary',
      )}
    >
      {children}
    </span>
  );
}
