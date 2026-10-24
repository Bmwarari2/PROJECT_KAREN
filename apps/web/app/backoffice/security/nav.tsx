'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { Badge, TabNav, useToast } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { ApiProblem } from '@/lib/api';

/** The Security module's sections (ADR-0180 segmented control of links). */
const SECTIONS = [
  ['overview', '/backoffice/security'],
  ['incidents', '/backoffice/security/incidents'],
  ['rules', '/backoffice/security/rules'],
  ['honeytokens', '/backoffice/security/honeytokens'],
] as const;

export function SecurityNav() {
  const t = useT();
  const path = usePathname();
  const tabs = SECTIONS.map(([key, href]) => ({
    href,
    label: t(`backoffice.security.tab.${key}`),
    active: key === 'overview' ? path === href : path.startsWith(href),
  }));
  return (
    <TabNav
      tabs={tabs}
      label={t('backoffice.security.sections')}
      renderLink={(tab, className, children) => (
        <Link href={tab.href} className={className} aria-current={tab.active ? 'page' : undefined}>
          {children}
        </Link>
      )}
    />
  );
}

export const SEVERITY_TONE = {
  low: 'neutral',
  medium: 'warning',
  high: 'danger',
  critical: 'danger',
} as const;

export function SeverityBadge({ severity }: { severity: string }) {
  const t = useT();
  return (
    <Badge tone={SEVERITY_TONE[severity as keyof typeof SEVERITY_TONE] ?? 'neutral'}>
      {t(`backoffice.security.severity.${severity}`)}
    </Badge>
  );
}

/** Runs an action with a busy flag and a toast for its outcome (the problem's title on failure). */
export function useRun() {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const run = React.useCallback(
    async <T,>(
      key: string,
      fn: () => Promise<T>,
      done?: string | ((r: T) => string),
    ): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (done) toast({ title: typeof done === 'function' ? done(r) : done, tone: 'success' });
        return r;
      } catch (err) {
        toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [t, toast],
  );
  return { busy, run };
}
