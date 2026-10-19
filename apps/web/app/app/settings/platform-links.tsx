'use client';
import Link from 'next/link';
import { BookOpen, Bot, FlaskConical, KeyRound, Palette, Radio, ToggleRight, Webhook } from 'lucide-react';
import type { FeatureKey } from '@thapsus/core/features';
import { Card } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { useExperience, useFeature, useSession } from '../shell';

/** Enterprise platform settings (Phase 9); a card is hidden when its feature is off for the workspace. */
const LINKS: Array<{ href: string; key: string; icon: React.ReactNode; feature?: FeatureKey; manage?: boolean }> = [
  { href: '/app/settings/api', key: 'api', icon: <KeyRound aria-hidden />, feature: 'publicApi', manage: true },
  { href: '/app/settings/webhooks', key: 'webhooks', icon: <Webhook aria-hidden />, feature: 'webhooks', manage: true },
  { href: '/app/settings/audit-streams', key: 'streams', icon: <Radio aria-hidden />, feature: 'auditStreaming', manage: true },
  { href: '/app/settings/sandbox', key: 'sandbox', icon: <FlaskConical aria-hidden />, feature: 'sandboxes', manage: true },
  { href: '/app/settings/branding', key: 'branding', icon: <Palette aria-hidden />, feature: 'customBranding' },
  { href: '/app/settings/ask-hr', key: 'askHr', icon: <Bot aria-hidden />, feature: 'aiAssistant' },
  { href: '/app/settings/features', key: 'features', icon: <ToggleRight aria-hidden /> },
  { href: '/developers', key: 'developers', icon: <BookOpen aria-hidden /> },
];

function LinkCard({ l }: { l: (typeof LINKS)[number] }) {
  const t = useT();
  const on = useFeature(l.feature ?? 'publicApi');
  if (l.feature && !on) return null;
  return (
    <li>
      <Card className="h-full">
        <Link href={l.href} className="flex items-start gap-3 no-underline">
          <span className="text-accent [&>svg]:h-5 [&>svg]:w-5 [&>svg]:stroke-[1.5]">{l.icon}</span>
          <span>
            <span className="block text-callout font-semibold text-text">{t(`platform.links.${l.key}.title`)}</span>
            <span className="mt-1 block text-footnote text-text-secondary">{t(`platform.links.${l.key}.body`)}</span>
          </span>
        </Link>
      </Card>
    </li>
  );
}

export function PlatformSettingsLinks() {
  const t = useT();
  const session = useSession();
  const { experience } = useExperience();
  const canManage = !!session?.permissions.some((p) => p === '*' || p === 'settings.manage' || p === 'settings.*');
  const links = LINKS.filter((l) => (!l.manage || canManage) && !(l.key === 'sandbox' && experience?.kind === 'sandbox'));
  return (
    <section aria-labelledby="platform-settings-title" className="flex flex-col gap-3">
      <h2 id="platform-settings-title" className="text-title-3">
        {t('platform.links.title')}
      </h2>
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {links.map((l) => (
          <LinkCard key={l.key} l={l} />
        ))}
      </ul>
    </section>
  );
}
