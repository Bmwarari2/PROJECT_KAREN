'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Bell, LogOut, ShieldCheck, UserRound } from 'lucide-react';
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
import { roleNames, USER_MENU_TRIGGER, UserMenuFace } from './user-menu-button';

/**
 * The account menu in the top bar: who you are and with which roles, your profile and security,
 * appearance, language and sign out.
 */
export function UserMenu({
  session,
  theme,
  onSignOut,
  defaultOpen = false,
}: {
  session: SessionInfo;
  theme: ThemeChoice;
  onSignOut: () => void;
  /** Open straight away (the placeholder button was clicked before the menu had loaded). */
  defaultOpen?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [choice, setChoice] = React.useState<ThemeChoice>(theme);
  const roles = roleNames(t, session.roles);
  return (
    <Menu defaultOpen={defaultOpen}>
      <MenuTrigger className={USER_MENU_TRIGGER}>
        <UserMenuFace session={session} />
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
