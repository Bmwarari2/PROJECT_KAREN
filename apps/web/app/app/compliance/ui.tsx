'use client';
import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@thapsus/ui';
import { formatNumber } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  missing: 'danger',
  expired: 'danger',
  section2_overdue: 'danger',
  reverification_overdue: 'danger',
  follow_up_due: 'warning',
  expiring: 'warning',
  section1_due: 'warning',
  section2_due: 'warning',
  reverification_due: 'warning',
  exempt_at_risk: 'warning',
  valid: 'success',
  compliant: 'success',
  complete: 'success',
  exempt: 'success',
};

export function StatusBadge({ status }: { status: string }) {
  const t = useT();
  return <Badge tone={TONE[status] ?? 'neutral'}>{t(`compliance.status.${status}`)}</Badge>;
}

export function SourceLink({
  source,
  verifiedOn,
}: {
  source: { url: string; title: string } | null | undefined;
  verifiedOn?: string | null;
}) {
  const t = useT();
  if (!source) return null;
  return (
    <p className="text-footnote text-text-secondary">
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-accent"
      >
        {t('compliance.source', { title: source.title })}
        <ExternalLink aria-hidden className="h-3.5 w-3.5 stroke-[1.5]" />
        <span className="sr-only">{t('compliance.opensNewTab')}</span>
      </a>
      {verifiedOn ? <span> · {t('compliance.verifiedOn', { date: verifiedOn })}</span> : null}
    </p>
  );
}

export function usePct() {
  const locale = useLocale();
  const t = useT();
  return React.useCallback(
    (v: number | null | undefined) =>
      v === null || v === undefined
        ? t('compliance.notAvailable')
        : `${formatNumber(v, locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`,
    [locale, t],
  );
}

export const selectClass =
  'h-10 w-full rounded-sm border border-border-strong bg-surface-raised px-2 text-callout text-text';
