'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import { cn } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { SETTINGS_GROUPS, visibleSections } from './sections';
import { usePermission } from './kit';

const linkClass = (active: boolean) =>
  cn(
    'flex min-h-9 items-center rounded-md px-3 text-callout no-underline transition-colors duration-[var(--duration-fast)] focus-visible:outline-2 focus-visible:outline-accent',
    active ? 'bg-accent-subtle font-semibold text-text' : 'text-text-secondary hover:bg-surface hover:text-text',
  );

/**
 * Settings sub-navigation: a column beside the page on large screens, a disclosure above it on
 * phones. Only sections the user may open are listed.
 */
export function SettingsFrame({ children }: { children: React.ReactNode }) {
  const t = useT();
  const path = usePathname();
  const has = usePermission();
  const [open, setOpen] = React.useState(false);
  const sections = visibleSections(has);
  const current = sections.find((s) => path.startsWith(s.href));
  React.useEffect(() => setOpen(false), [path]);

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
      <nav aria-label={t('admin.nav.label')} className="lg:sticky lg:top-20 lg:w-60 lg:shrink-0">
        <button
          type="button"
          className="flex h-10 w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-raised px-3 text-callout font-semibold focus-visible:outline-2 focus-visible:outline-accent lg:hidden"
          aria-expanded={open}
          aria-controls="settings-sections"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="truncate">{current ? t(`admin.section.${current.key}.title`) : t('admin.nav.overview')}</span>
          <ChevronDown aria-hidden className={cn('h-4 w-4 shrink-0 stroke-[1.5] transition-transform duration-[var(--duration-fast)]', open && 'rotate-180')} />
        </button>
        <div id="settings-sections" className={cn('mt-2 flex-col gap-4 lg:mt-0 lg:flex', open ? 'flex' : 'hidden')}>
          <Link href="/app/settings" className={linkClass(path === '/app/settings')} aria-current={path === '/app/settings' ? 'page' : undefined}>
            {t('admin.nav.overview')}
          </Link>
          {SETTINGS_GROUPS.map((g) => {
            const items = sections.filter((s) => s.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="flex flex-col gap-0.5">
                <p id={`settings-group-${g}`} className="px-3 pb-1 text-footnote font-semibold text-text-secondary">
                  {t(`admin.group.${g}.title`)}
                </p>
                <ul aria-labelledby={`settings-group-${g}`} className="flex flex-col gap-0.5">
                  {items.map((s) => {
                    const active = path.startsWith(s.href);
                    return (
                      <li key={s.key}>
                        <Link href={s.href} className={linkClass(active)} aria-current={active ? 'page' : undefined}>
                          {t(`admin.section.${s.key}.title`)}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
    </div>
  );
}
