'use client';
import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import type { SessionInfo } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { bySeniority } from '@/lib/role-order';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')
  ).toUpperCase();
}

/** Readable names of the session's roles (built-in names from the catalogue, custom roles as stored). */
export function roleNames(t: (k: string) => string, roles: string[]): string[] {
  return bySeniority(roles).map((r) => (t(`roles.${r}`) === `roles.${r}` ? r : t(`roles.${r}`)));
}

export const USER_MENU_TRIGGER =
  'flex h-10 items-center gap-2 rounded-pill pl-1 pr-2 text-on-chrome hover:bg-chrome-raised focus-visible:outline-2 focus-visible:outline-chrome-focus';

/** What the account button shows: initials, and from md the name and most senior role. */
export function UserMenuFace({ session }: { session: SessionInfo }) {
  const t = useT();
  const roles = roleNames(t, session.roles);
  return (
    <>
      <span
        aria-hidden
        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-chrome-raised text-footnote font-semibold"
      >
        {initials(session.displayName)}
      </span>
      {/* the name (and, from md, the role) is the button's accessible name, as seen */}
      <span className="sr-only md:hidden">{session.displayName}</span>
      <span className="hidden min-w-0 flex-col text-left leading-tight md:flex">
        <span className="max-w-[18ch] truncate text-footnote font-semibold">{session.displayName}</span>
        <span className="max-w-[22ch] truncate text-footnote text-on-chrome-secondary">{roles[0] ?? ''}</span>
      </span>
      <ChevronDown aria-hidden className="hidden h-4 w-4 stroke-[1.5] sm:block" />
    </>
  );
}

/**
 * The account button as rendered before the menu's code has loaded: it looks the same, and a click
 * loads the menu and opens it.
 */
export function UserMenuButton({ session, onOpen }: { session: SessionInfo; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={false}
      className={USER_MENU_TRIGGER}
      onClick={onOpen}
    >
      <UserMenuFace session={session} />
    </button>
  );
}
