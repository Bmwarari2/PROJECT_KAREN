'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';

const TABS = [
  { href: '/app/privacy', key: 'requests' },
  { href: '/app/privacy/retention', key: 'retention' },
  { href: '/app/privacy/incidents', key: 'incidents' },
  { href: '/app/privacy/legal', key: 'legal' },
  { href: '/app/privacy/exports', key: 'exports' },
] as const;

/** Privacy and trust area for administrators: requests, retention, incidents, legal and account data. */
export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  const path = usePathname();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title-2">{t('privacy.ui.title')}</h1>
        <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">{t('privacy.ui.lead')}</p>
      </div>
      <nav aria-label={t('privacy.ui.sections')} className="-mx-1 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((tab) => {
          const active = tab.href === '/app/privacy' ? path === tab.href : path.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-callout font-semibold no-underline transition-colors duration-[var(--duration-fast)]', active ? 'border-accent text-text' : 'border-transparent text-text-secondary hover:text-text')}
            >
              {t(`privacy.ui.tab.${tab.key}`)}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
