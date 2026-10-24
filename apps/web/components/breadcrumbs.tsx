'use client';
import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@thapsus/ui';
import { IntentLink } from '@/components/intent-link';
import { useT } from '@/lib/i18n-client';

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * The trail above a detail page (ADR-0161; the idea of EasyUI's breadcrumb, rebuilt with our tokens):
 * the list a record belongs to, then the record. The last crumb is the current page and is not a link.
 * On phones the page's own title is already the next line, so the trail is a back link to its list
 * ("‹ Tasks") with a full-size tap target.
 */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  const t = useT();
  if (!items.length) return null;
  return (
    <nav aria-label={t('actionable.crumbs.label')} className={cn('min-w-0', className)}>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-footnote text-text-secondary">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          const parent = i === items.length - 2;
          return (
            <li
              key={`${i}-${c.label}`}
              className={cn(
                'flex min-w-0 items-center gap-1',
                last && items.length > 1 && 'max-sm:hidden',
                !last && !parent && 'max-sm:hidden',
              )}
            >
              {i > 0 ? (
                <ChevronRight aria-hidden className="h-4 w-4 shrink-0 stroke-[1.5] max-sm:hidden" />
              ) : null}
              {c.href && !last ? (
                <IntentLink
                  href={c.href}
                  className="inline-flex min-h-6 items-center rounded-sm text-text-secondary no-underline hover:text-accent hover:underline max-sm:-ml-1 max-sm:min-h-11 max-sm:pr-2 max-sm:text-callout max-sm:text-accent"
                >
                  {parent ? (
                    <ChevronLeft aria-hidden className="h-5 w-5 shrink-0 stroke-[1.5] sm:hidden" />
                  ) : null}
                  {c.label}
                </IntentLink>
              ) : (
                <span aria-current={last ? 'page' : undefined} className="min-w-0 break-words text-text">
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
