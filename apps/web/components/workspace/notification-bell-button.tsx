'use client';
import * as React from 'react';
import { Bell } from 'lucide-react';
import { useT } from '@/lib/i18n-client';

export const BELL_TRIGGER =
  'relative inline-flex h-10 w-10 items-center justify-center rounded-md text-on-chrome hover:bg-chrome-raised focus-visible:outline-2 focus-visible:outline-chrome-focus';

/** The bell's accessible name: "Notifications" or "Notifications, 3 unread". */
export function useBellLabel(unread: number): string {
  const t = useT();
  return unread ? t('app.ws.notificationsUnread', { count: unread }) : t('app.nav.notifications');
}

/** What the bell shows: the icon and, when there are unread notifications, their number. */
export function BellFace({ unread }: { unread: number }) {
  return (
    <>
      <Bell aria-hidden className="h-5 w-5 stroke-[1.5]" />
      {unread ? (
        <span
          aria-hidden
          className="absolute right-1 top-1 min-w-[18px] rounded-full bg-chrome-focus px-1 text-center text-footnote font-semibold leading-[18px] text-chrome"
        >
          {unread > 9 ? '9+' : unread}
        </span>
      ) : null}
    </>
  );
}

/**
 * The notification bell as rendered before its panel's code has loaded (ADR-0160): it looks the same.
 * Pointing at or touching it loads the panel (`onIntent`); a click, Enter or Space loads and opens it
 * (`onOpen`). Keyboard focus alone does not swap the button, so the focus never moves by itself.
 */
export function NotificationBellButton({
  unread,
  onIntent,
  onOpen,
}: {
  unread: number;
  onIntent: () => void;
  onOpen: () => void;
}) {
  const label = useBellLabel(unread);
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={false}
      aria-label={label}
      title={label}
      className={BELL_TRIGGER}
      onPointerEnter={onIntent}
      onTouchStart={onIntent}
      onClick={onOpen}
    >
      <BellFace unread={unread} />
    </button>
  );
}
