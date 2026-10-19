import Link from 'next/link';
import { ArrowRight, Database, FileCheck2, Globe2, KeyRound, ListChecks, Lock, Mail, ShieldCheck, Activity } from 'lucide-react';
import { Badge, buttonVariants, Card, Section } from '@thapsus/ui';
import { HOME_REGIONS, REGIONS } from '@thapsus/core';
import { env } from '@thapsus/core/config';
import { LEGAL } from '@thapsus/core/trust';
import { serverContext } from '@/lib/server';

export async function generateMetadata() {
  const { t } = await serverContext();
  return { title: t('trust.meta.title'), description: t('trust.meta.description') };
}

export default async function TrustPage() {
  const { t } = await serverContext();
  const domain = env('THAPSUS_HR_DOMAIN', 'thapsus-hr.localhost');
  const securityEmail = `${LEGAL.securityContactLocalPart}@${domain}`;
  const controls = [
    { key: 'isolation', icon: <Database aria-hidden className="h-6 w-6 stroke-[1.5]" /> },
    { key: 'encryption', icon: <Lock aria-hidden className="h-6 w-6 stroke-[1.5]" /> },
    { key: 'vault', icon: <KeyRound aria-hidden className="h-6 w-6 stroke-[1.5]" /> },
    { key: 'access', icon: <ShieldCheck aria-hidden className="h-6 w-6 stroke-[1.5]" /> },
    { key: 'audit', icon: <ListChecks aria-hidden className="h-6 w-6 stroke-[1.5]" /> },
    { key: 'backups', icon: <FileCheck2 aria-hidden className="h-6 w-6 stroke-[1.5]" /> },
  ];
  const tools = ['dsr', 'retention', 'export', 'closure', 'incidents', 'dpa'] as const;
  return (
    <>
      <Section tone="bg" className="pt-16 md:pt-24" labelledBy="trust-title">
        <div className="flex flex-col items-center text-center">
          <Badge tone="accent">{t('trust.hero.eyebrow')}</Badge>
          <h1 id="trust-title" className="mt-5 max-w-[16ch] text-title-1 text-text md:text-headline">
            {t('trust.hero.title')}
          </h1>
          <p className="mt-6 max-w-[var(--prose-width)] text-body-lg text-text-secondary">{t('trust.hero.lead')}</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/trust/subprocessors" className={buttonVariants({ size: 'lg' }) + ' no-underline'}>
              {t('trust.hero.subprocessors')}
            </Link>
            <a href={`mailto:${securityEmail}`} className={buttonVariants({ size: 'lg', variant: 'secondary' }) + ' no-underline'}>
              {t('trust.hero.contact')}
            </a>
          </div>
        </div>
      </Section>

      <Section tone="inverse" labelledBy="residency-title">
        <Globe2 aria-hidden className="h-10 w-10 stroke-[1.5]" />
        <h2 id="residency-title" className="mt-6 text-title-1 md:text-headline">
          {t('trust.residency.title')}
        </h2>
        <p className="mt-4 max-w-[var(--prose-width)] text-body-lg opacity-80">{t('trust.residency.lead')}</p>
        <ul className="mt-10 grid gap-4 md:grid-cols-3">
          {HOME_REGIONS.map((r) => (
            <li key={r} className="rounded-xl border border-text-inverse/20 p-6">
              <h3 className="text-title-3">{t(`regions.${r}`)}</h3>
              <p className="mt-2 text-callout opacity-80">{t('trust.residency.primary', { region: REGIONS[r].awsRegion })}</p>
              <p className="mt-1 text-callout opacity-80">{REGIONS[r].backupRegion ? t('trust.residency.backup', { region: REGIONS[r].backupRegion! }) : t('trust.residency.backupHome')}</p>
            </li>
          ))}
        </ul>
        <p className="mt-6 max-w-[var(--prose-width)] text-callout opacity-80">{t('trust.residency.global')}</p>
      </Section>

      <Section tone="bg" labelledBy="security-title">
        <h2 id="security-title" className="text-title-1 md:text-headline">
          {t('trust.security.title')}
        </h2>
        <ul className="mt-10 grid gap-6 md:grid-cols-3">
          {controls.map((c) => (
            <li key={c.key}>
              <Card size="marketing" className="h-full bg-surface shadow-none">
                <span className="text-accent">{c.icon}</span>
                <h3 className="mt-4 text-title-3">{t(`trust.security.${c.key}.title`)}</h3>
                <p className="mt-2 text-callout text-text-secondary">{t(`trust.security.${c.key}.body`, { days: LEGAL.backupRetentionDays.prod })}</p>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <Section tone="surface" labelledBy="privacy-title">
        <h2 id="privacy-title" className="text-title-1 md:text-headline">
          {t('trust.privacy.title')}
        </h2>
        <p className="mt-4 max-w-[var(--prose-width)] text-body-lg text-text-secondary">{t('trust.privacy.lead')}</p>
        <ul className="mt-8 grid gap-x-8 gap-y-5 md:grid-cols-2">
          {tools.map((k) => (
            <li key={k} className="border-t border-border pt-4">
              <h3 className="text-title-3">{t(`trust.privacy.${k}.title`)}</h3>
              <p className="mt-1 text-callout text-text-secondary">{t(`trust.privacy.${k}.body`, { days: LEGAL.backupRetentionDays.prod, grace: LEGAL.closureGraceDays })}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section tone="bg" labelledBy="compliance-title">
        <div className="grid gap-10 md:grid-cols-2">
          <div>
            <h2 id="compliance-title" className="text-title-1">
              {t('trust.compliance.title')}
            </h2>
            <p className="mt-4 text-body text-text-secondary">{t('trust.compliance.body')}</p>
            <ul className="mt-4 grid gap-2 text-callout">
              <li>{t('trust.compliance.soc2')}</li>
              <li>{t('trust.compliance.iso')}</li>
              <li>{t('trust.compliance.gdpr')}</li>
            </ul>
            <p className="mt-4 text-footnote text-text-secondary">{t('trust.compliance.status')}</p>
          </div>
          <div className="grid gap-4">
            <Card size="marketing" className="bg-surface shadow-none">
              <h3 className="text-title-3">{t('trust.links.subprocessors.title')}</h3>
              <p className="mt-2 text-callout text-text-secondary">{t('trust.links.subprocessors.body', { days: LEGAL.subprocessorNoticeDays })}</p>
              <Link href="/trust/subprocessors" className="mt-3 inline-flex items-center gap-1 text-callout font-semibold">
                {t('trust.links.subprocessors.cta')}
                <ArrowRight aria-hidden className="h-4 w-4 stroke-[1.5]" />
              </Link>
            </Card>
            <Card size="marketing" className="bg-surface shadow-none">
              <h3 className="flex items-center gap-2 text-title-3">
                <Activity aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
                {t('trust.links.status.title')}
              </h3>
              <p className="mt-2 text-callout text-text-secondary">{t('trust.links.status.body')}</p>
              <Link href="/status" className="mt-3 inline-flex items-center gap-1 text-callout font-semibold">
                {t('trust.links.status.cta')}
                <ArrowRight aria-hidden className="h-4 w-4 stroke-[1.5]" />
              </Link>
            </Card>
            <Card size="marketing" className="bg-surface shadow-none">
              <h3 className="flex items-center gap-2 text-title-3">
                <Mail aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
                {t('trust.links.security.title')}
              </h3>
              <p className="mt-2 text-callout text-text-secondary">{t('trust.links.security.body')}</p>
              <a href={`mailto:${securityEmail}`} className="mt-3 inline-block text-callout font-semibold">
                {securityEmail}
              </a>
            </Card>
          </div>
        </div>
      </Section>
    </>
  );
}
