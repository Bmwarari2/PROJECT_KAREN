'use client';
import * as React from 'react';
import { IntentLink } from '@/components/intent-link';

/**
 * The link of a `ListItem` row (ADR-0180) that also tells the list it was followed: the notification
 * lists mark what was opened as read. Provide `RowLinkContext` around the list.
 */
export const RowLinkContext = React.createContext<((href: string) => void) | null>(null);

export function RowLink({
  href,
  className,
  children,
  ...rest
}: {
  href: string;
  className?: string;
  children?: React.ReactNode;
  'data-row-link'?: boolean;
}) {
  const onFollow = React.useContext(RowLinkContext);
  return (
    <IntentLink href={href} className={className} onClick={() => onFollow?.(href)} {...rest}>
      {children}
    </IntentLink>
  );
}
