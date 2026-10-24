'use client';
import * as React from 'react';
import Link from 'next/link';
import { Check, Copy, KeyRound, PowerOff } from 'lucide-react';
import { Badge, Button, Card, CardTitle, EmptyState } from '@thapsus/ui';
import { formatDateTime } from '@thapsus/core/i18n';
import { useLocale, useT } from '@/lib/i18n-client';
import { PageTitle, useSession } from '@/app/app/shell';
import { useSectionLevel } from '@/components/module-page';

/** Shared building blocks for the enterprise platform settings screens (Phase 9). */

/**
 * The page header of a platform settings screen: its title (`PageTitle`: an h2 under the Settings module
 * header, large on phones) and lead. The settings frame gives it the back link (ADR-0181).
 */
export function PageHeader({ title, lead }: { title: string; lead?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <PageTitle>{title}</PageTitle>
      {lead ? <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">{lead}</p> : null}
    </div>
  );
}

/** A secret shown exactly once, with copy buttons. The parent drops it from memory on "Done". */
export function SecretOnce({
  title,
  items,
  onDone,
}: {
  title: string;
  items: Array<{ label: string; value: string }>;
  onDone: () => void;
}) {
  const t = useT();
  const sec = useSectionLevel();
  const [copied, setCopied] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => ref.current?.focus(), []);
  return (
    <Card className="border border-accent" role="region" aria-labelledby="secret-once-title">
      <div ref={ref} tabIndex={-1} className="flex flex-col gap-3 outline-none">
        <CardTitle id="secret-once-title" as={sec.heading} className="flex items-center gap-2">
          <KeyRound aria-hidden className="h-5 w-5 stroke-[1.5]" />
          {title}
        </CardTitle>
        <p className="text-callout text-text-secondary" role="status">
          {t('platform.secretOnce.warning')}
        </p>
        {items.map((i) => (
          <div key={i.label} className="flex flex-col gap-1">
            <span className="text-footnote font-semibold">{i.label}</span>
            <div className="flex flex-wrap items-center gap-2">
              <code
                data-testid="secret-value"
                className="break-all rounded-sm bg-surface px-2 py-1 text-footnote"
              >
                {i.value}
              </code>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard?.writeText(i.value).catch(() => undefined);
                  setCopied(i.label);
                }}
                aria-label={t('platform.secretOnce.copy', { label: i.label })}
              >
                {copied === i.label ? (
                  <Check aria-hidden className="h-4 w-4 stroke-[1.5]" />
                ) : (
                  <Copy aria-hidden className="h-4 w-4 stroke-[1.5]" />
                )}
                {copied === i.label ? t('platform.secretOnce.copied') : t('platform.secretOnce.copyShort')}
              </Button>
            </div>
          </div>
        ))}
        <div>
          <Button onClick={onDone}>{t('platform.secretOnce.done')}</Button>
        </div>
      </div>
    </Card>
  );
}

export function FeatureOff() {
  const t = useT();
  const sec = useSectionLevel();
  return (
    <EmptyState
      level={sec.level}
      icon={<PowerOff aria-hidden />}
      title={t('platform.featureOff.title')}
      body={t('platform.featureOff.body')}
      action={<Link href="/app/settings/features">{t('platform.featureOff.action')}</Link>}
    />
  );
}

const TONES: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'accent'> = {
  active: 'success',
  ready: 'success',
  succeeded: 'success',
  delivered: 'success',
  pending: 'neutral',
  creating: 'neutral',
  retrying: 'warning',
  paused: 'warning',
  disabled: 'neutral',
  revoked: 'neutral',
  failed: 'danger',
};
export function StatusBadge({ status }: { status: string }) {
  const t = useT();
  return <Badge tone={TONES[status] ?? 'neutral'}>{t(`platform.status.${status}`)}</Badge>;
}

export function useDateTime() {
  const locale = useLocale();
  const session = useSession();
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return React.useCallback(
    (iso: string | null | undefined) => (iso ? formatDateTime(iso, locale, zone) : '—'),
    [locale, zone],
  );
}

export function errorText(
  t: (k: string, v?: Record<string, string | number>) => string,
  err: unknown,
): string {
  const e = err as { body?: { detail?: string }; title?: string };
  const detail = e?.body?.detail;
  if (detail) {
    const key = `platform.errors.${detail}`;
    const msg = t(key);
    if (msg !== key) return msg;
  }
  return e?.title ?? t('common.error');
}
