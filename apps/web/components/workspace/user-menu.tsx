'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Bell, ChevronDown, LogOut, ShieldCheck, UserRound } from 'lucide-react';
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@thapsus/ui';
import type { SessionInfo } from '@/lib/api';
import { applyTheme, switchLocale } from '@/components/client';
import { useLocale, useT } from '@/lib/i18n-client';
import type { ThemeChoice } from '@/lib/i18n-shared';
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

/**
 * The account menu in the top bar: who you are and with which roles, your profile and security,
 * appearance, language and sign out.
 */
export function UserMenu({
  session,
  theme,
  onSignOut,
}: {
  session: SessionInfo;
  theme: ThemeChoice;
  onSignOut: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [choice, setChoice] = React.useState<ThemeChoice>(theme);
  const roles = roleNames(t, session.roles);
  return (
    <Menu>
      <MenuTrigger className="flex h-10 items-center gap-2 rounded-pill pl-1 pr-2 text-on-chrome hover:bg-chrome-raised focus-visible:outline-2 focus-visible:outline-chrome-focus">
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
          <span className="max-w-[22ch] truncate text-footnote text-on-chrome-secondary">
            {roles[0] ?? ''}
          </span>
        </span>
        <ChevronDown aria-hidden className="hidden h-4 w-4 stroke-[1.5] sm:block" />
      </MenuTrigger>
      <MenuContent className="w-[280px]">
        <MenuLabel className="flex flex-col gap-0.5 text-text">
          <span className="text-callout font-semibold">{session.displayName}</span>
          <span className="truncate text-footnote text-text-secondary">{session.email}</span>
          <span className="mt-1 text-footnote text-text-secondary">
            {t('app.ws.yourRoles')}: {roles.join(', ')}
          </span>
        </MenuLabel>
        <MenuSeparator />
        <MenuGroup>
          {session.employeeId ? (
            <MenuItem onSelect={() => router.push('/app/me')}>
              <UserRound aria-hidden />
              {t('app.ws.myProfile')}
            </MenuItem>
          ) : null}
          <MenuItem onSelect={() => router.push('/app/security')}>
            <ShieldCheck aria-hidden />
            {t('app.nav.security')}
          </MenuItem>
          <MenuItem onSelect={() => router.push('/app/notifications')}>
            <Bell aria-hidden />
            {t('app.ws.notificationSettings')}
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuLabel>{t('common.theme')}</MenuLabel>
        <MenuRadioGroup
          value={choice}
          onValueChange={(v) => {
            setChoice(v as ThemeChoice);
            applyTheme(v as ThemeChoice);
          }}
        >
          <MenuRadioItem value="system">{t('common.themeSystem')}</MenuRadioItem>
          <MenuRadioItem value="light">{t('common.themeLight')}</MenuRadioItem>
          <MenuRadioItem value="dark">{t('common.themeDark')}</MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuLabel>{t('common.language')}</MenuLabel>
        <MenuRadioGroup value={locale} onValueChange={(v) => v !== locale && switchLocale(v)}>
          <MenuRadioItem value="en-GB">{t('locales.en-GB')}</MenuRadioItem>
          <MenuRadioItem value="en-US">{t('locales.en-US')}</MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onSelect={onSignOut}>
          <LogOut aria-hidden />
          {t('common.signOut')}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
