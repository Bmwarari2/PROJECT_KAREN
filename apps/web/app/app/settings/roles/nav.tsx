'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { TabNav, type TabLink } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';

/** The two views of roles: the list (and each role) and the side-by-side comparison with the preview. */
export function RolesNav() {
  const t = useT();
  const path = usePathname();
  const compare = path.startsWith('/app/settings/roles/compare');
  const tabs: TabLink[] = [
    { href: '/app/settings/roles', label: t('access.compare.tabRoles'), active: !compare },
    { href: '/app/settings/roles/compare', label: t('access.compare.tabCompare'), active: compare },
  ];
  return (
    <div className="border-b border-border">
      <TabNav
        tabs={tabs}
        label={t('access.compare.navLabel')}
        renderLink={(tab, className, children) => (
          <Link href={tab.href} className={className} aria-current={tab.active ? 'page' : undefined}>
            {children}
          </Link>
        )}
      />
    </div>
  );
}
