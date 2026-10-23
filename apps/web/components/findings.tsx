'use client';
import { TriangleAlert, ExternalLink } from 'lucide-react';
import { formatDate } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';

export interface FindingDto {
  rule: string;
  date?: string;
  detail: Record<string, number | string>;
  source?: string;
}

/** Working-time and policy findings with the rule's official source (rule values come from the jurisdiction packs). */
export function FindingList({
  findings,
  tone = 'warning',
}: {
  findings: FindingDto[];
  tone?: 'warning' | 'danger';
}) {
  const t = useT();
  const locale = useLocale();
  if (!findings.length) return null;
  return (
    <ul className="flex flex-col gap-2">
      {findings.map((f, i) => (
        <li key={`${f.rule}-${f.date ?? ''}-${i}`} className="flex items-start gap-2 text-callout">
          <TriangleAlert
            aria-hidden
            className={`mt-0.5 h-4 w-4 shrink-0 stroke-[1.5] ${tone === 'danger' ? 'text-danger' : 'text-warning'}`}
          />
          <span>
            <span className="font-semibold">{t(`time.rule.${f.rule}`)}</span>
            {f.date ? <span className="text-text-secondary"> · {formatDate(f.date, locale)}</span> : null}
            {f.source ? (
              <>
                {' '}
                <a
                  href={f.source}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-footnote"
                >
                  {t('time.source')}
                  <ExternalLink aria-hidden className="h-3 w-3 stroke-[1.5]" />
                  <span className="sr-only">{t('time.opensNewTab')}</span>
                </a>
              </>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
