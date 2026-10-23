'use client';
import * as React from 'react';
import Link from 'next/link';
import { Building2, CalendarDays, ChevronRight, Clock, GitBranch, KeyRound, Settings, ShieldCheck } from 'lucide-react';
import { Card, CardTitle, EmptyState } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { SETTINGS_GROUPS, visibleSections, type SettingsGroup } from './sections';
import { PageHeader, usePermission } from './kit';
import { PlatformSettingsLinks } from './platform-links';

const ICONS: Record<SettingsGroup, React.ReactNode> = {
  workspace: <Building2 aria-hidden />,
  access: <ShieldCheck aria-hidden />,
  signIn: <KeyRound aria-hidden />,
  approvals: <GitBranch aria-hidden />,
  timeOff: <CalendarDays aria-hidden />,
  time: <Clock aria-hidden />,
};

/** The settings index: every section the user may configure, grouped. */
export default function SettingsPage() {
  const t = useT();
  const has = usePermission();
  const sections = visibleSections(has);
  return (
    <>
      <PageHeader title={t('app.settings.title')} lead={t('admin.index.lead')} />
      {sections.length === 0 ? (
        <EmptyState icon={<Settings aria-hidden />} title={t('admin.index.none')} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {SETTINGS_GROUPS.map((g) => {
            const items = sections.filter((s) => s.group === g);
            if (!items.length) return null;
            return (
              <section key={g} aria-labelledby={`group-${g}`}>
                <Card className="flex h-full flex-col gap-3">
                  <div className="flex items-center gap-3 text-accent [&_svg]:h-5 [&_svg]:w-5 [&_svg]:stroke-[1.5]">
                    {ICONS[g]}
                    <CardTitle id={`group-${g}`}>{t(`admin.group.${g}.title`)}</CardTitle>
                  </div>
                  <p className="text-callout text-text-secondary">{t(`admin.group.${g}.body`)}</p>
                  <ul className="flex flex-col divide-y divide-border">
                    {items.map((s) => (
                      <li key={s.key}>
                        <Link href={s.href} className="flex items-center gap-3 rounded-sm py-3 no-underline hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent">
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="text-callout font-semibold text-text">{t(`admin.section.${s.key}.title`)}</span>
                            <span className="text-footnote text-text-secondary">{t(`admin.section.${s.key}.body`)}</span>
                          </span>
                          <ChevronRight aria-hidden className="h-4 w-4 shrink-0 stroke-[1.5] text-text-secondary" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              </section>
            );
          })}
        </div>
      )}
      {/* Enterprise platform settings (API, webhooks, streaming, sandboxes, branding, Ask HR, features) */}
      <PlatformSettingsLinks />
    </>
  );
}
