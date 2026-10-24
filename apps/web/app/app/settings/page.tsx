'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  BookOpen,
  Bot,
  Braces,
  Building2,
  CalendarDays,
  CalendarRange,
  Clock,
  FlaskConical,
  Forward,
  GitBranch,
  Globe,
  KeyRound,
  LifeBuoy,
  ListChecks,
  LockKeyhole,
  Palette,
  Radio,
  RefreshCw,
  Settings,
  ShieldCheck,
  Stethoscope,
  ToggleRight,
  Users,
  Webhook,
} from 'lucide-react';
import { EmptyState, ListItem, ListSection } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { SETTINGS_GROUPS } from './sections';
import { sectionMessages } from './section-text';
import { PageIntro } from '@/components/module-page';
import { useSettingsSections } from './frame';

const ICONS: Record<string, React.ReactNode> = {
  organisation: <Building2 aria-hidden />,
  roles: <ShieldCheck aria-hidden />,
  users: <Users aria-hidden />,
  sso: <KeyRound aria-hidden />,
  signInPolicy: <LockKeyhole aria-hidden />,
  domains: <Globe aria-hidden />,
  scim: <RefreshCw aria-hidden />,
  supportAccess: <LifeBuoy aria-hidden />,
  approvalChains: <GitBranch aria-hidden />,
  workflows: <ListChecks aria-hidden />,
  delegations: <Forward aria-hidden />,
  leave: <CalendarDays aria-hidden />,
  calendars: <CalendarRange aria-hidden />,
  absence: <Stethoscope aria-hidden />,
  time: <Clock aria-hidden />,
  api: <Braces aria-hidden />,
  webhooks: <Webhook aria-hidden />,
  streams: <Radio aria-hidden />,
  sandbox: <FlaskConical aria-hidden />,
  branding: <Palette aria-hidden />,
  askHr: <Bot aria-hidden />,
  features: <ToggleRight aria-hidden />,
  developers: <BookOpen aria-hidden />,
};

/**
 * The settings index (ADR-0181): every section the user may configure, as grouped lists. On phones
 * this is the settings navigation; each row opens its section.
 */
export default function SettingsPage() {
  const t = useT();
  const sections = useSettingsSections();
  return (
    <>
      <PageIntro title={t('app.settings.title')} titleIsTab lead={t('admin.index.lead')} />
      {sections.length === 0 ? (
        <EmptyState icon={<Settings aria-hidden />} title={t('admin.index.none')} />
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-2">
          {SETTINGS_GROUPS.map((g) => {
            const items = sections.filter((s) => s.group === g);
            if (!items.length) return null;
            return (
              <ListSection key={g} id={`group-${g}`} title={t(`admin.group.${g}.title`)}>
                {items.map((s) => (
                  <ListItem
                    key={s.key}
                    href={s.href}
                    linkAs={Link}
                    leading={ICONS[s.key] ?? <Settings aria-hidden />}
                    title={t(`${sectionMessages(s)}.title`)}
                    subtitle={t(`${sectionMessages(s)}.body`)}
                  />
                ))}
              </ListSection>
            );
          })}
        </div>
      )}
    </>
  );
}
