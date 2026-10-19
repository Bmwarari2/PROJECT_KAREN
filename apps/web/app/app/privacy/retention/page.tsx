'use client';
import * as React from 'react';
import { Lock, Play, ScanSearch } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Field, Input, Skeleton, Table, TD, TH, THead, TR, useToast } from '@thapsus/ui';
import { formatDate, formatNumber } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { SELECT_CLASS, type RuleRef } from '../types';

interface RetentionView {
  jurisdictions: string[];
  categories: Array<{ category: string; rules: Array<{ jurisdiction: string; key: string; period: string; from: string; statutoryMinimum: boolean; legalReview: string; afterEmploymentEnds: string | null; rule: RuleRef }> }>;
  policies: Array<{ category: string; jurisdiction: string; period: string | null; anchor: string; action: string; enabled: boolean }>;
}
interface RunLine {
  category: string;
  jurisdiction: string;
  action: string;
  rows: number;
  cutoff: string | null;
}
interface LogRow {
  id: string;
  runAt: string;
  trigger: string;
  dryRun: boolean;
  category: string;
  jurisdiction: string;
  action: string;
  rowsAffected: number;
}
interface Hold {
  id: string;
  employeeName: string | null;
  category: string | null;
  reason: string;
  createdAt: string;
  releasedAt: string | null;
}

/** ISO-8601 period (P2Y, P18M, P30D) for display: the numbers go through the locale formatter. */
function usePeriod() {
  const t = useT();
  const locale = useLocale();
  return (p: string | null) => {
    if (!p) return t('privacy.ui.retention.packOnly');
    const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(p);
    if (!m) return p;
    const parts = [
      m[1] ? t('privacy.ui.period.years', { n: formatNumber(Number(m[1]), locale) }) : '',
      m[2] ? t('privacy.ui.period.months', { n: formatNumber(Number(m[2]), locale) }) : '',
      m[3] ? t('privacy.ui.period.weeks', { n: formatNumber(Number(m[3]), locale) }) : '',
      m[4] ? t('privacy.ui.period.days', { n: formatNumber(Number(m[4]), locale) }) : '',
    ];
    return parts.filter(Boolean).join(' ');
  };
}

export default function RetentionPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const period = usePeriod();
  const view = useApi<RetentionView>('/v1/privacy/retention');
  const log = useApi<LogRow[]>('/v1/privacy/retention/runs');
  const holds = useApi<Hold[]>('/v1/privacy/legal-holds');
  const [dry, setDry] = React.useState<RunLine[] | null>(null);
  const [form, setForm] = React.useState({ category: 'time_records', jurisdiction: '*', years: '', enabled: false });
  const [hold, setHold] = React.useState({ category: '', reason: '' });
  const [busy, setBusy] = React.useState<string | null>(null);
  const fail = (err: unknown) => toast({ title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'), tone: 'danger' });

  async function run<T>(name: string, fn: () => Promise<T>, ok?: string) {
    setBusy(name);
    try {
      const r = await fn();
      if (ok) toast({ title: ok, tone: 'success' });
      return r;
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 422 && Array.isArray(err.body.minimums)) toast({ title: t('privacy.ui.retention.belowMinimum', { list: (err.body.minimums as string[]).join(', ') }), tone: 'danger' });
      else fail(err);
    } finally {
      setBusy(null);
    }
  }

  if (!view.data) return <Skeleton className="h-64" />;
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardTitle>{t('privacy.ui.retention.rulesTitle')}</CardTitle>
        <p className="mt-1 max-w-[var(--prose-width)] text-footnote text-text-secondary">{t('privacy.ui.retention.rulesLead')}</p>
        <div className="mt-3">
          <Table dense scrollLabel={t('privacy.ui.retention.rulesTitle')}>
            <THead>
              <tr>
                <TH>{t('privacy.ui.retention.category')}</TH>
                <TH>{t('privacy.ui.retention.jurisdiction')}</TH>
                <TH>{t('privacy.ui.retention.period')}</TH>
                <TH>{t('privacy.ui.retention.kind')}</TH>
                <TH>{t('privacy.ui.retention.source')}</TH>
              </tr>
            </THead>
            <tbody>
              {view.data.categories.flatMap((c) =>
                c.rules.length
                  ? c.rules.map((r) => (
                      <TR key={`${c.category}-${r.jurisdiction}-${r.key}`}>
                        <TD>{t(`privacy.ui.category.${c.category}`)}</TD>
                        <TD>{r.jurisdiction}</TD>
                        <TD>
                          {period(r.period)} {t(`privacy.ui.anchor.${r.from}`)}
                        </TD>
                        <TD>
                          {r.statutoryMinimum ? (
                            <Badge tone="accent">
                              <Lock aria-hidden className="h-3 w-3 stroke-[1.5]" />
                              {t('privacy.ui.retention.statutory')}
                            </Badge>
                          ) : (
                            <Badge>{t('privacy.ui.retention.suggested')}</Badge>
                          )}{' '}
                          <Badge tone="warning">{t('privacy.ui.retention.legalReview')}</Badge>
                        </TD>
                        <TD>
                          <a href={r.rule.source.url} rel="noopener noreferrer" target="_blank">
                            {r.rule.source.title}
                          </a>
                        </TD>
                      </TR>
                    ))
                  : [
                      <TR key={c.category}>
                        <TD>{t(`privacy.ui.category.${c.category}`)}</TD>
                        <TD>—</TD>
                        <TD colSpan={3} className="text-text-secondary">
                          {t('privacy.ui.retention.noRule')}
                        </TD>
                      </TR>,
                    ],
              )}
            </tbody>
          </Table>
        </div>
      </Card>

      <Card>
        <CardTitle>{t('privacy.ui.retention.policiesTitle')}</CardTitle>
        <p className="mt-1 max-w-[var(--prose-width)] text-footnote text-text-secondary">{t('privacy.ui.retention.policiesLead')}</p>
        <form
          className="mt-4 grid gap-3 md:grid-cols-5 md:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            await run('policy', () => api('/v1/privacy/retention/policies', { method: 'PUT', json: { category: form.category, jurisdiction: form.jurisdiction, period: form.years ? `P${form.years}Y` : null, enabled: form.enabled } }), t('privacy.ui.retention.saved'));
            view.reload();
          }}
        >
          <Field id="pol-category" label={t('privacy.ui.retention.category')}>
            {(p) => (
              <select {...p} className={SELECT_CLASS} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {view.data!.categories.map((c) => (
                  <option key={c.category} value={c.category}>
                    {t(`privacy.ui.category.${c.category}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="pol-jurisdiction" label={t('privacy.ui.retention.jurisdiction')}>
            {(p) => (
              <select {...p} className={SELECT_CLASS} value={form.jurisdiction} onChange={(e) => setForm({ ...form, jurisdiction: e.target.value })}>
                <option value="*">{t('privacy.ui.retention.everywhere')}</option>
                {view.data!.jurisdictions.map((j) => (
                  <option key={j} value={j}>
                    {j}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="pol-years" label={t('privacy.ui.retention.years')} hint={t('privacy.ui.retention.yearsHint')}>
            {(p) => <Input {...p} type="number" min={1} max={100} inputMode="numeric" value={form.years} onChange={(e) => setForm({ ...form, years: e.target.value })} />}
          </Field>
          <label className="flex h-10 items-center gap-2 text-callout">
            <input type="checkbox" className="h-5 w-5 accent-[var(--color-accent)]" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            {t('privacy.ui.retention.enableAuto')}
          </label>
          <Button type="submit" loading={busy === 'policy'}>
            {t('common.save')}
          </Button>
        </form>
        {view.data.policies.length ? (
          <ul className="mt-4 grid gap-1 text-callout">
            {view.data.policies.map((p) => (
              <li key={`${p.category}-${p.jurisdiction}`}>
                {t('privacy.ui.retention.policyLine', { category: t(`privacy.ui.category.${p.category}`), jurisdiction: p.jurisdiction === '*' ? t('privacy.ui.retention.everywhere') : p.jurisdiction, period: period(p.period), state: t(p.enabled ? 'privacy.ui.retention.on' : 'privacy.ui.retention.off') })}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" loading={busy === 'dry'} onClick={async () => setDry((await run('dry', () => api<RunLine[]>('/v1/privacy/retention/dry-run', { method: 'POST', json: {} }))) ?? null)}>
            <ScanSearch aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('privacy.ui.retention.dryRun')}
          </Button>
          <Button variant="secondary" loading={busy === 'run'} onClick={() => run('run', () => api('/v1/privacy/retention/run', { method: 'POST' }), t('privacy.ui.retention.runQueued'))}>
            <Play aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('privacy.ui.retention.runNow')}
          </Button>
        </div>
        {dry ? (
          <div className="mt-4" role="status">
            <h3 className="text-callout font-semibold">{t('privacy.ui.retention.dryResult')}</h3>
            {dry.filter((l) => l.rows > 0).length ? (
              <ul className="mt-2 grid gap-1 text-callout">
                {dry
                  .filter((l) => l.rows > 0)
                  .map((l) => (
                    <li key={`${l.category}-${l.jurisdiction}`}>{t('privacy.ui.retention.dryLine', { category: t(`privacy.ui.category.${l.category}`), jurisdiction: l.jurisdiction, rows: formatNumber(l.rows, locale), action: t(`privacy.ui.action.${l.action}`) })}</li>
                  ))}
              </ul>
            ) : (
              <p className="mt-2 text-callout text-text-secondary">{t('privacy.ui.retention.dryNothing')}</p>
            )}
          </div>
        ) : null}
      </Card>

      <Card>
        <CardTitle>{t('privacy.ui.holds.title')}</CardTitle>
        <p className="mt-1 text-footnote text-text-secondary">{t('privacy.ui.holds.lead')}</p>
        <form
          className="mt-4 grid gap-3 md:grid-cols-[1fr_2fr_auto] md:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            await run('hold', () => api('/v1/privacy/legal-holds', { method: 'POST', json: { category: hold.category || null, reason: hold.reason } }), t('privacy.ui.holds.created'));
            setHold({ category: '', reason: '' });
            holds.reload();
          }}
        >
          <Field id="hold-category" label={t('privacy.ui.retention.category')}>
            {(p) => (
              <select {...p} className={SELECT_CLASS} value={hold.category} onChange={(e) => setHold({ ...hold, category: e.target.value })}>
                <option value="">{t('privacy.ui.holds.allCategories')}</option>
                {view.data!.categories.map((c) => (
                  <option key={c.category} value={c.category}>
                    {t(`privacy.ui.category.${c.category}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="hold-reason" label={t('privacy.ui.holds.reason')}>
            {(p) => <Input {...p} required minLength={3} value={hold.reason} onChange={(e) => setHold({ ...hold, reason: e.target.value })} />}
          </Field>
          <Button type="submit" variant="secondary" loading={busy === 'hold'}>
            {t('privacy.ui.holds.add')}
          </Button>
        </form>
        <ul className="mt-4 grid gap-2 text-callout">
          {(holds.data ?? []).map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-2">
              <span>
                {t('privacy.ui.holds.line', { who: h.employeeName ?? t('privacy.ui.holds.everyone'), category: h.category ? t(`privacy.ui.category.${h.category}`) : t('privacy.ui.holds.allCategories'), reason: h.reason })}
              </span>
              {h.releasedAt ? (
                <Badge>{t('privacy.ui.holds.released')}</Badge>
              ) : (
                <Button size="sm" variant="ghost" onClick={async () => (await run('release', () => api(`/v1/privacy/legal-holds/${h.id}/release`, { method: 'POST' }), t('privacy.ui.holds.releasedToast')), holds.reload())}>
                  {t('privacy.ui.holds.release')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardTitle>{t('privacy.ui.retention.logTitle')}</CardTitle>
        <p className="mt-1 text-footnote text-text-secondary">{t('privacy.ui.retention.logLead')}</p>
        {log.data?.length ? (
          <div className="mt-3">
            <Table dense scrollLabel={t('privacy.ui.retention.logTitle')}>
              <THead>
                <tr>
                  <TH>{t('privacy.ui.retention.when')}</TH>
                  <TH>{t('privacy.ui.retention.category')}</TH>
                  <TH>{t('privacy.ui.retention.jurisdiction')}</TH>
                  <TH>{t('privacy.ui.retention.what')}</TH>
                  <TH className="text-right">{t('privacy.ui.retention.rows')}</TH>
                </tr>
              </THead>
              <tbody>
                {log.data.slice(0, 100).map((l) => (
                  <TR key={l.id}>
                    <TD className="tabular-nums">{formatDate(l.runAt.slice(0, 10), locale)}</TD>
                    <TD>{t(`privacy.ui.category.${l.category.replace('vault:', '')}`)}</TD>
                    <TD>{l.jurisdiction}</TD>
                    <TD>
                      {t(`privacy.ui.action.${l.action}`)}
                      {l.dryRun ? ` · ${t('privacy.ui.retention.dryTag')}` : ''}
                    </TD>
                    <TD className="text-right tabular-nums">{formatNumber(l.rowsAffected, locale)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </div>
        ) : (
          <p className="mt-2 text-callout text-text-secondary">{t('privacy.ui.retention.logEmpty')}</p>
        )}
      </Card>
    </div>
  );
}
