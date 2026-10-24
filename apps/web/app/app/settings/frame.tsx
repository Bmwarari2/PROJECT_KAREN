'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@thapsus/ui';
import { FEATURE_FLAGS, type FeatureKey } from '@thapsus/core/features';
import { BackLink } from '@/components/breadcrumbs';
import { useT } from '@/lib/i18n-client';
import { revealIn } from '@/lib/reveal';
import { useExperience } from '../shell';
import { sectionFor, SETTINGS_GROUPS, visibleSections } from './sections';
import { sectionMessages } from './section-text';
import { usePermission } from './kit';

const linkClass = (active: boolean) =>
  cn(
    'flex min-h-9 items-center rounded-md px-3 text-callout no-underline transition-colors duration-[var(--duration-fast)] focus-visible:outline-2 focus-visible:outline-accent',
    active
      ? 'bg-accent-subtle font-semibold text-text'
      : 'text-text-secondary hover:bg-surface hover:text-text',
  );

/** The settings sections this viewer may open, with the workspace's features applied. */
export function useSettingsSections() {
  const has = usePermission();
  const { experience } = useExperience();
  return React.useMemo(
    () =>
      visibleSections(has, {
        feature: (k: FeatureKey) => experience?.features[k] ?? FEATURE_FLAGS[k].default,
        sandbox: experience?.kind === 'sandbox',
      }),
    [has, experience],
  );
}

/** Views of a section that sit beside it rather than under it (they keep the back link to Settings). */
const SIBLING_VIEWS = new Set(['/app/settings/roles/compare']);

/**
 * The settings area (ADR-0181), the way a phone's settings app works:
 * - phones and tablets: the index is the list of sections; a section opens with a "‹ Settings" back
 *   link and its own large title, and a page inside a section (a role, a person) goes back to it;
 * - large screens: the sections stay in a side list beside the page, and pages inside a section keep
 *   their back link.
 * Only sections the user may open are listed.
 */
export function SettingsFrame({ children }: { children: React.ReactNode }) {
  const t = useT();
  const path = usePathname().replace(/\/$/, '');
  const sections = useSettingsSections();
  const index = path === '/app/settings';
  const section = sectionFor(path);
  const deep = !!section && path !== section.href && !SIBLING_VIEWS.has(path);
  // The list scrolls on its own on large screens: bring the current section into view.
  const navRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    revealIn(
      navRef.current,
      navRef.current?.querySelector<HTMLElement>('#settings-sections [aria-current="page"]') ?? null,
    );
  }, [path]);

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
      {/* On large screens the list is sticky and scrolls on its own, so entries below the fold stay reachable (WCAG 2.4.11). */}
      <nav
        ref={navRef}
        aria-label={t('admin.nav.label')}
        className="hidden lg:sticky lg:top-[calc(var(--topbar-height)_+_var(--space-6))] lg:-mx-1 lg:block lg:max-h-[calc(100dvh_-_var(--topbar-height)_-_2_*_var(--space-6))] lg:w-60 lg:shrink-0 lg:scroll-py-2 lg:overflow-y-auto lg:overscroll-contain lg:px-1 lg:py-1"
      >
        <div id="settings-sections" className="flex flex-col gap-4">
          <Link href="/app/settings" className={linkClass(index)} aria-current={index ? 'page' : undefined}>
            {t('admin.nav.overview')}
          </Link>
          {SETTINGS_GROUPS.map((g) => {
            const items = sections.filter((s) => s.group === g && !s.external);
            if (!items.length) return null;
            return (
              <div key={g} className="flex flex-col gap-0.5">
                <p
                  id={`settings-group-${g}`}
                  className="px-3 pb-1 text-footnote font-semibold text-text-secondary"
                >
                  {t(`admin.group.${g}.title`)}
                </p>
                <ul aria-labelledby={`settings-group-${g}`} className="flex flex-col gap-0.5">
                  {items.map((s) => {
                    const active = section?.key === s.key;
                    return (
                      <li key={s.key}>
                        <Link
                          href={s.href}
                          className={linkClass(active)}
                          aria-current={active ? 'page' : undefined}
                        >
                          {t(`${sectionMessages(s)}.title`)}
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
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        {index ? null : deep && section ? (
          <BackLink
            href={section.href}
            label={t(`${sectionMessages(section)}.title`)}
            className="-mb-4 -mt-2"
          />
        ) : (
          <BackLink href="/app/settings" label={t('app.settings.title')} className="-mb-4 -mt-2 lg:hidden" />
        )}
        {children}
      </div>
    </div>
  );
}
