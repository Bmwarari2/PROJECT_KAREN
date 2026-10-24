import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from './primitives';

/**
 * Grouped lists (DESIGN.md §6, ADR-0180): the way an app on a phone shows a collection. A section has
 * an optional heading and one rounded container. Its rows are separated by hairlines inset to the
 * text, and a whole row is the tap target when it leads somewhere.
 *
 * Layout rules that hold at every width:
 * - The text column always takes the free width (`min-w-0 flex-1`), so it is never squeezed.
 * - `meta` (a date or an amount) sits under the subtitle on phones and in its own right-hand column
 *   from `sm` up.
 * - `actions` (text buttons) move under the text on phones and sit at the end of the row from `sm` up.
 * - `accessory` (a chevron, a count, a switch or an icon button) always stays at the end of the row.
 */
/** The heading row shared by `ListSection` and `PageSection`: a `title-3` heading, an action and a lead. */
function SectionHead({
  title,
  description,
  action,
  headingLevel,
  headingId,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  headingLevel: 2 | 3 | 4;
  headingId?: string;
}) {
  const Heading = `h${headingLevel}` as const;
  return (
    <>
      {title || action ? (
        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2 px-1">
          {title ? (
            <Heading id={headingId} className="min-w-0 text-title-3 text-text">
              {title}
            </Heading>
          ) : (
            <span />
          )}
          {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
        </div>
      ) : null}
      {description ? (
        <div className="max-w-[var(--prose-width)] px-1 text-callout text-text-secondary">{description}</div>
      ) : null}
    </>
  );
}

export function ListSection({
  title,
  description,
  action,
  footer,
  children,
  className,
  headingLevel = 2,
  id,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** A small control on the heading line: "See all", a filter, a button. */
  action?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  headingLevel?: 2 | 3 | 4;
  id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={cn('flex flex-col gap-2', className)} aria-labelledby={headingId} id={id}>
      <SectionHead
        title={title}
        description={description}
        action={action}
        headingLevel={headingLevel}
        headingId={headingId}
      />
      <ul role="list" className="overflow-hidden rounded-lg bg-surface-raised shadow-sm">
        {children}
      </ul>
      {footer ? <div className="px-1 text-footnote text-text-secondary">{footer}</div> : null}
    </section>
  );
}

/**
 * A titled part of a page (`PageSection`) whose body is not a list: a table, a form card or a chart (DESIGN.md §6).
 * It has the same heading as `ListSection` (above the container, never inside a card), so a page reads
 * as one column of grouped sections. The heading names the region for screen readers.
 */
export function PageSection({
  title,
  description,
  action,
  footer,
  children,
  className,
  headingLevel = 2,
  headingId,
  id,
  landmark = true,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  headingLevel?: 2 | 3 | 4;
  /** The heading's id (defaults to a generated one), which also names the region. */
  headingId?: string;
  id?: string;
  /**
   * false when the body is already a landmark with the same name (a scrollable table labelled like the
   * section), so the page has no two regions called the same (WCAG 1.3.1, axe landmark-unique).
   */
  landmark?: boolean;
}) {
  const generated = React.useId();
  const hid = title ? (headingId ?? `${generated}-title`) : undefined;
  return (
    <section
      className={cn('flex min-w-0 flex-col gap-2', className)}
      aria-labelledby={landmark ? hid : undefined}
      id={id}
    >
      <SectionHead
        title={title}
        description={description}
        action={action}
        headingLevel={headingLevel}
        headingId={hid}
      />
      {children}
      {footer ? <div className="px-1 text-footnote text-text-secondary">{footer}</div> : null}
    </section>
  );
}

type LinkComponent = React.ElementType<{
  href: string;
  className?: string;
  children?: React.ReactNode;
  'data-row-link'?: boolean;
}>;

export interface ListItemProps {
  /** Where the row leads; the title becomes the link and the whole row is its tap target. */
  href?: string;
  /** The link element to render (`next/link` or the app's IntentLink); a plain `<a>` by default. */
  linkAs?: LinkComponent;
  /** An icon (shown in a tinted tile), an avatar or any small leading element. */
  leading?: React.ReactNode;
  /** Wrap `leading` in the tinted icon tile (default for icons; pass false for avatars). */
  leadingTile?: boolean;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** A date, an amount or a short status: under the subtitle on phones, right-aligned from `sm`. */
  meta?: React.ReactNode;
  /** Text buttons: under the text on phones, at the end of the row from `sm`. They stay clickable. */
  actions?: React.ReactNode;
  /** A count, a badge, a switch or an icon button that always stays at the end of the row. */
  accessory?: React.ReactNode;
  /** Show a chevron (defaults to on for rows with `href`). */
  chevron?: boolean;
  /** Unread or new: a small accent dot before the title and a heavier title. */
  unread?: boolean;
  /** Screen-reader text for the unread dot (localised by the caller). */
  unreadLabel?: string;
  className?: string;
}

export function ListItem({
  href,
  linkAs: LinkAs = 'a',
  leading,
  leadingTile = true,
  title,
  subtitle,
  meta,
  actions,
  accessory,
  chevron,
  unread,
  unreadLabel,
  className,
}: ListItemProps) {
  const showChevron = chevron ?? !!href;
  const titleClass = cn(
    'text-body leading-snug text-text',
    unread ? 'font-semibold' : 'font-medium',
    // the link's ::after covers the whole row, so the row is one tap target; actions sit above it
    href &&
      "no-underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none hover:text-text",
  );
  return (
    <li
      className={cn(
        'group/row relative flex items-start gap-3 pl-4 has-[[data-row-link]:focus-visible]:outline has-[[data-row-link]:focus-visible]:outline-2 has-[[data-row-link]:focus-visible]:-outline-offset-2 has-[[data-row-link]:focus-visible]:outline-accent',
        href && 'hover:bg-surface/60 active:bg-surface',
        className,
      )}
    >
      {leading ? (
        <div className="shrink-0 py-3">
          {leadingTile ? (
            <span
              aria-hidden
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] bg-accent-subtle text-accent [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:stroke-[1.75]"
            >
              {leading}
            </span>
          ) : (
            leading
          )}
        </div>
      ) : null}
      {/* everything right of the leading element; the hairline between rows starts here */}
      <div className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 border-t border-border py-3 pr-4 group-first/row:border-t-0">
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex min-w-0 items-start gap-2">
            {unread ? (
              // level with the title's first line when the title wraps
              <span className="mt-[0.45em] inline-flex h-2 w-2 shrink-0 rounded-full bg-accent">
                {unreadLabel ? <span className="sr-only">{unreadLabel}</span> : null}
              </span>
            ) : null}
            {href ? (
              <LinkAs href={href} className={titleClass} data-row-link>
                {title}
              </LinkAs>
            ) : (
              <span className={titleClass}>{title}</span>
            )}
          </div>
          {subtitle ? (
            <div className="min-w-0 text-callout text-text-secondary sm:col-start-1">{subtitle}</div>
          ) : null}
          {meta || actions ? (
            <div className="flex flex-col items-start gap-2 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:flex-row sm:items-center sm:justify-end sm:self-center">
              {meta ? (
                <div className="text-footnote text-text-secondary tabular-nums sm:text-right">{meta}</div>
              ) : null}
              {actions ? (
                <div className="relative z-10 flex flex-wrap items-center gap-2 sm:justify-end">
                  {actions}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {accessory ? <div className="relative z-10 flex shrink-0 items-center">{accessory}</div> : null}
        {showChevron ? (
          <ChevronRight aria-hidden className="h-5 w-5 shrink-0 stroke-[1.5] text-text-secondary/70" />
        ) : null}
      </div>
    </li>
  );
}

/** A count or short value at the end of a row (iOS "detail" text). */
export function ListValue({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('text-callout text-text-secondary tabular-nums', className)}>{children}</span>;
}
