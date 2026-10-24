'use client';
import * as React from 'react';
import { personHref, type ProfileTab } from '@thapsus/core/links';
import { cn } from '@thapsus/ui';
import { IntentLink } from '@/components/intent-link';
import { Avatar } from '@/components/dashboard/parts';
import { usePersonVisible } from '@/lib/person-visibility';
import { useSession } from '@/app/app/shell';

/**
 * The look of a link to a record in a list or a sentence (ADR-0161): accent text, underlined, so a
 * name or a request reads as something to open; the global focus ring shows on keyboard focus.
 */
export const ENTITY_LINK =
  'rounded-sm font-semibold text-accent underline decoration-1 underline-offset-2 hover:decoration-2';
/** A quieter look for places where every row is a name (the org chart): text colour, underlined on hover. */
export const QUIET_LINK = 'rounded-sm text-text no-underline hover:text-accent hover:underline';

/** A link to a record's page with the entity look, prefetched on intent. */
export function EntityLink({
  className,
  quiet = false,
  ...props
}: React.ComponentProps<typeof IntentLink> & { className?: string; quiet?: boolean }) {
  return <IntentLink className={cn(quiet ? QUIET_LINK : ENTITY_LINK, className)} {...props} />;
}

/**
 * A person's name (and, optionally, their initials) that opens their profile, or the tab of it that
 * fits the context, when the viewer may open it; plain text otherwise. Use it wherever a person is
 * named (ADR-0161).
 */
export function PersonLink({
  id,
  name,
  tab,
  avatar = false,
  quiet = false,
  className,
  plainClassName = 'font-semibold',
}: {
  id: string | null | undefined;
  name: string | null | undefined;
  tab?: ProfileTab;
  avatar?: boolean;
  /** The quiet look (text colour) for lists where every row is a name. */
  quiet?: boolean;
  className?: string;
  /** Classes of the text when it is not a link (defaults to the same weight as the link). */
  plainClassName?: string;
}) {
  const session = useSession();
  const visible = usePersonVisible(session, id);
  const label = name ?? '—';
  const face = avatar ? <Avatar name={label} size="sm" /> : null;
  if (!id || !visible)
    return face ? (
      <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
        {face}
        <span className={cn('min-w-0 break-words', plainClassName)}>{label}</span>
      </span>
    ) : (
      <span className={cn('break-words', plainClassName, className)}>{label}</span>
    );
  return face ? (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      {face}
      <EntityLink href={personHref(id, tab)} quiet={quiet} className="min-w-0 break-words">
        {label}
      </EntityLink>
    </span>
  ) : (
    <EntityLink href={personHref(id, tab)} quiet={quiet} className={cn('break-words', className)}>
      {label}
    </EntityLink>
  );
}
