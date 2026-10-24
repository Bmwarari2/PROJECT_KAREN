'use client';
import { notificationFallbackHref } from '@thapsus/core/links';
import { usePersonVisible } from '@/lib/person-visibility';
import { useSession } from '@/app/app/shell';

/** A notification as GET /v1/me/notifications returns it. */
export interface NotificationItem {
  id: string;
  kind: string;
  category: string;
  title: string;
  link: string | null;
  target: { type: string; id: string } | null;
  href: string;
  createdAt: string;
  read: boolean;
}

/**
 * Where a notification opens (ADR-0160): the page the API names for it, except a person's profile the
 * viewer may not open, which falls back to the list page for the notification's kind, so a link never
 * leads to a page the viewer cannot see.
 */
export function useNotificationHref(n: NotificationItem): string {
  const session = useSession();
  const person = n.target?.type === 'employee' ? n.target.id : null;
  const visible = usePersonVisible(session, person);
  // until the answer arrives the list page stands in, so the link is never to a page it cannot open
  if (person && visible !== true) return notificationFallbackHref(n.kind);
  return n.href;
}
