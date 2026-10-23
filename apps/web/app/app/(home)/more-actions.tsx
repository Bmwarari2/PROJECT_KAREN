'use client';
import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { Menu, MenuContent, MenuItem, MenuTrigger, buttonVariants } from '@thapsus/ui';
import { IntentLink as Link } from '@/components/intent-link';
import { useT } from '@/lib/i18n-client';
import type { QuickAction } from '../workspace';

/** The quick actions that do not fit as buttons, in a menu (loaded after the page; see page.tsx). */
export function MoreActionsMenu({
  actions,
  defaultOpen = false,
}: {
  actions: QuickAction[];
  defaultOpen?: boolean;
}) {
  const t = useT();
  return (
    <Menu defaultOpen={defaultOpen}>
      <MenuTrigger className={buttonVariants({ variant: 'secondary', size: 'md' })}>
        {t('dashboard.moreActions')}
        <ChevronDown aria-hidden className="h-4 w-4 stroke-[1.5]" />
      </MenuTrigger>
      <MenuContent>
        {actions.map((a) => {
          const Icon = a.icon;
          return (
            <MenuItem key={a.key} asChild>
              <Link href={a.href} className="text-text no-underline">
                <Icon aria-hidden />
                {t(a.label)}
              </Link>
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}
