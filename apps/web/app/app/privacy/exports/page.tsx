'use client';
import * as React from 'react';
import { Archive, Download, Undo2, XOctagon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
  useToast,
  PageSection,
} from '@thapsus/ui';
import { formatDate, formatNumber } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';

interface ExportRow {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  sizeBytes: number | null;
  progressDone: number | null;
  progressTotal: number | null;
  tables: number | null;
  files: number | null;
}
interface ClosureView {
  closure: {
    id: string;
    status: string;
    requestedAt: string;
    purgeAfter: string;
    graceDays: number;
    cancelledAt: string | null;
  } | null;
  graceDays: number;
  backupRetentionDays: number;
  workspace: string;
}

export default function ExportsPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const exports = useApi<ExportRow[]>('/v1/privacy/company-exports');
  const closure = useApi<ClosureView>('/v1/privacy/closure');
  const [confirm, setConfirm] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  const fail = (err: unknown) =>
    toast({
      title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
      tone: 'danger',
    });
  const running = exports.data?.some((e) => e.status === 'queued' || e.status === 'running');
  const reload = React.useRef(exports.reload);
  reload.current = exports.reload;
  React.useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => reload.current(), 4000);
    return () => clearInterval(timer);
  }, [running]);

  if (exports.error?.status === 403 || closure.error?.status === 403) {
    return (
      <PageSection
        headingLevel={2}
        title={t('privacy.ui.exports.ownerOnlyTitle')}
        description={t('privacy.ui.exports.ownerOnly')}
      >
        <Card></Card>
      </PageSection>
    );
  }

  async function act(name: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(name);
    try {
      await fn();
      toast({ title: ok, tone: 'success' });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  const c = closure.data?.closure;
  const scheduled = c && c.status === 'scheduled';
  return (
    <div className="grid grid-cols-1 gap-6">
      <PageSection
        headingLevel={2}
        title={t('privacy.ui.exports.title')}
        landmark={false}
        description={t('privacy.ui.exports.lead')}
      >
        <Card>
          <Button
            className="mt-4"
            loading={busy === 'export'}
            onClick={() =>
              act(
                'export',
                () => api('/v1/privacy/company-exports', { method: 'POST' }).then(exports.reload),
                t('privacy.ui.exports.started'),
              )
            }
          >
            <Archive aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('privacy.ui.exports.start')}
          </Button>
          {exports.data?.length ? (
            <div className="mt-4">
              <Table dense scrollLabel={t('privacy.ui.exports.title')}>
                <THead>
                  <tr>
                    <TH>{t('privacy.ui.exports.requested')}</TH>
                    <TH>{t('common.status')}</TH>
                    <TH className="text-right">{t('privacy.ui.exports.size')}</TH>
                    <TH>
                      <span className="sr-only">{t('common.actions')}</span>
                    </TH>
                  </tr>
                </THead>
                <tbody>
                  {exports.data.map((e) => (
                    <TR key={e.id}>
                      <TD className="tabular-nums">{formatDate(e.createdAt.slice(0, 10), locale)}</TD>
                      <TD>
                        {e.status === 'ready' ? (
                          <Badge tone="success">
                            {t('privacy.ui.exports.ready', {
                              tables: t('privacy.ui.exports.readyTables', { count: e.tables ?? 0 }),
                              files: t('privacy.ui.exports.readyFiles', { count: e.files ?? 0 }),
                            })}
                          </Badge>
                        ) : e.status === 'failed' ? (
                          <Badge tone="danger">{t('privacy.ui.exports.failed')}</Badge>
                        ) : (
                          <span role="status">
                            {t('privacy.ui.exports.progress', {
                              done: e.progressDone ?? 0,
                              total: e.progressTotal ?? '…',
                              count: e.progressTotal ?? '…',
                            })}
                          </span>
                        )}
                      </TD>
                      <TD className="text-right tabular-nums" label={t('privacy.ui.exports.size')}>
                        {e.sizeBytes !== null
                          ? formatNumber(e.sizeBytes / 1_000_000, locale, {
                              style: 'unit',
                              unit: 'megabyte',
                              maximumFractionDigits: 1,
                            })
                          : '—'}
                      </TD>
                      <TD className="text-right">
                        {e.status === 'ready' ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={async () => {
                              try {
                                const { url } = await api<{ url: string }>(
                                  `/v1/privacy/company-exports/${e.id}/download`,
                                );
                                window.location.assign(url);
                              } catch (err) {
                                fail(err);
                              }
                            }}
                          >
                            <Download aria-hidden className="h-4 w-4 stroke-[1.5]" />
                            {t('privacy.ui.exports.download')}
                          </Button>
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : null}
        </Card>
      </PageSection>

      <Card aria-labelledby="closure-title">
        <h2 id="closure-title" className="text-title-3">
          {t('privacy.ui.closure.title')}
        </h2>
        {!closure.data ? (
          <Skeleton className="mt-3 h-24" />
        ) : scheduled ? (
          <div className="mt-3 grid gap-3">
            <p className="text-callout" role="status">
              {t('privacy.ui.closure.scheduled', {
                date: formatDate(c.purgeAfter.slice(0, 10), locale, 'long'),
              })}
            </p>
            <p className="text-footnote text-text-secondary">
              {t('privacy.ui.closure.afterwards', {
                days: closure.data.backupRetentionDays,
                count: closure.data.backupRetentionDays,
              })}
            </p>
            <div>
              <Button
                variant="secondary"
                loading={busy === 'cancel'}
                onClick={() =>
                  act(
                    'cancel',
                    () => api('/v1/privacy/closure/cancel', { method: 'POST' }).then(closure.reload),
                    t('privacy.ui.closure.cancelled'),
                  )
                }
              >
                <Undo2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('privacy.ui.closure.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="mt-3 grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                'close',
                () =>
                  api('/v1/privacy/closure', {
                    method: 'POST',
                    json: { confirmWorkspace: confirm, reason: reason || undefined },
                  }).then(closure.reload),
                t('privacy.ui.closure.scheduledToast'),
              );
            }}
          >
            <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">
              {t('privacy.ui.closure.lead', {
                days: closure.data.graceDays,
                backups: closure.data.backupRetentionDays,
                count: closure.data.backupRetentionDays,
              })}
            </p>
            <Field
              id="close-confirm"
              label={t('privacy.ui.closure.confirmLabel', { workspace: closure.data.workspace })}
            >
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              )}
            </Field>
            <Field id="close-reason" label={t('privacy.ui.closure.reason')}>
              {(p) => (
                <Input {...p} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
              )}
            </Field>
            <div>
              <Button
                type="submit"
                variant="danger"
                disabled={confirm !== closure.data.workspace}
                loading={busy === 'close'}
              >
                <XOctagon aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('privacy.ui.closure.schedule')}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
