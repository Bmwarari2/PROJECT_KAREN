'use client';
import * as React from 'react';
import { CheckCheck, ChevronRight, Inbox } from 'lucide-react';
import { Button, Popover, PopoverClose, PopoverContent, PopoverTrigger, Skeleton, cn } from '@thapsus/ui';
import { formatDateTime } from '@thapsus/core/i18n';
import { IntentLink } from '@/components/intent-link';
import { useNotificationHref, type NotificationItem } from '@/components/notification-link';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useSession } from '@/app/app/shell';
import { BELL_TRIGGER, BellFace, useBellLabel } from './notification-bell-button';

/** How many recent notifications the panel shows; the notifications page has the rest. */
const RECENT = 8;

function Row({ n, onOpen }: { n: NotificationItem; onOpen: (n: NotificationItem) => void }) {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const href = useNotificationHref(n);
  return (
    <li>
      <IntentLink
        href={href}
        onClick={() => onOpen(n)}
        className="flex min-h-11 items-start gap-3 rounded-md px-3 py-2 text-text no-underline hover:bg-surface"
      >
        <span
          aria-hidden
          className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-accent')}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {!n.read ? <span className="sr-only">{t('actionable.bell.new')}</span> : null}
          <span className={cn('break-words text-callout', !n.read && 'font-semibold')}>{n.title}</span>
          <span className="text-footnote text-text-secondary">
            {formatDateTime(n.createdAt, locale, zone)}
          </span>
        </span>
        <ChevronRight aria-hidden className="mt-0.5 h-4 w-4 shrink-0 stroke-[1.5] text-text-secondary" />
      </IntentLink>
    </li>
  );
}

/**
 * The top bar's notification bell and its panel of recent items (ADR-0160; the idea of EasyUI's
 * notification bell and stack, rebuilt with Radix Popover and our tokens, without animation
 * libraries). Every item is a link to what it is about; opening one marks it read. The code loads on
 * intent (the shell shows `NotificationBellButton` until then).
 */
export function NotificationPanel({
  unread,
  onUnreadChange,
  defaultOpen = false,
}: {
  unread: number;
  onUnreadChange: (n: number) => void;
  defaultOpen?: boolean;
}) {
  const t = useT();
  const label = useBellLabel(unread);
  const [open, setOpen] = React.useState(defaultOpen);
  const [items, setItems] = React.useState<NotificationItem[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setFailed(false);
    api<{ data: NotificationItem[]; unread: number }>(`/v1/me/notifications?limit=${RECENT}`)
      .then((r) => {
        if (!live) return;
        setItems(r.data);
        onUnreadChange(r.unread);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // onUnreadChange is the shell's stable setter; the list refreshes each time the panel opens
  }, [open, onUnreadChange]);

  const markRead = (ids: string[] | 'all') => {
    void api('/v1/me/notifications/read', {
      method: 'POST',
      json: ids === 'all' ? { all: true } : { ids },
    }).catch(() => undefined);
    setItems((cur) =>
      cur ? cur.map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, read: true } : n)) : cur,
    );
    onUnreadChange(ids === 'all' ? 0 : Math.max(0, unread - ids.length));
  };
  const openItem = (n: NotificationItem) => {
    if (!n.read) markRead([n.id]);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger aria-label={label} title={label} className={BELL_TRIGGER}>
        <BellFace unread={unread} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={t('actionable.bell.title')}
        className="flex w-[min(380px,calc(100vw-32px))] flex-col p-0"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <p className="mr-auto text-callout font-semibold text-text">{t('actionable.bell.title')}</p>
          <Button
            size="sm"
            variant="ghost"
            disabled={!unread}
            onClick={() => markRead('all')}
            aria-label={t('actionable.bell.markAll')}
          >
            <CheckCheck aria-hidden className="h-4 w-4 stroke-[1.5]" />
            <span className="hidden sm:inline">{t('actionable.bell.markAll')}</span>
          </Button>
        </div>
        <div className="max-h-[min(60vh,480px)] overflow-y-auto p-2">
          {failed ? (
            <p className="px-3 py-6 text-center text-callout text-text-secondary">{t('common.error')}</p>
          ) : !items ? (
            <div className="flex flex-col gap-2 p-2" aria-hidden>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : items.length ? (
            <ul className="flex flex-col gap-1" aria-label={t('actionable.bell.recent')}>
              {items.map((n) => (
                <Row key={n.id} n={n} onOpen={openItem} />
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
              <Inbox aria-hidden className="h-8 w-8 stroke-[1.5] text-text-secondary" />
              <p className="text-callout text-text-secondary">{t('actionable.bell.empty')}</p>
            </div>
          )}
        </div>
        <div className="border-t border-border p-2">
          <PopoverClose asChild>
            <IntentLink
              href="/app/notifications"
              className="flex min-h-10 items-center justify-center rounded-md text-callout font-semibold text-accent no-underline hover:underline"
            >
              {t('actionable.bell.seeAll')}
            </IntentLink>
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  );
}
