'use client';
import * as React from 'react';
import { BookCheck, Building2, Crown } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  ListItem,
  ListSection,
  Skeleton,
  Textarea,
  useToast,
} from '@thapsus/ui';
import { formatDateTime } from '@thapsus/core/i18n';
import { ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { PageTitle, selectClass, useStaff, useStaffApi } from '../ui';

type Scope = 'super_admin' | 'rules_publish' | 'support_grant';
interface Elevation {
  id: string;
  staffEmail: string;
  scope: Scope;
  subjectTenantId: string | null;
  reason: string;
  minutes: number;
  requestedAt: string;
  expiresAt: string | null;
  status: 'pending' | 'active' | 'expired' | 'denied' | 'revoked';
}
/** Who may ask for (and approve) each scope; the API enforces the same rule. */
const SCOPES: Record<Scope, string[]> = {
  super_admin: ['super_admin'],
  rules_publish: ['rules_editor', 'super_admin'],
  support_grant: ['support', 'super_admin'],
};
const ICON: Record<Scope, React.ReactNode> = {
  super_admin: <Crown />,
  rules_publish: <BookCheck />,
  support_grant: <Building2 />,
};
const DURATIONS = [15, 30, 60, 120, 240];
const TONE = {
  pending: 'warning',
  active: 'success',
  expired: 'neutral',
  denied: 'danger',
  revoked: 'neutral',
} as const;
const PROBLEMS = ['ownRequest', 'scopeNotForYourRole', 'elevationRequired'];

/**
 * Just-in-time access for Thapsus staff (plan 2.2.3, ADR-0174): ask for a scope with a reason and a
 * duration, approve other people's requests (after a fresh key assertion), and see what is in force.
 */
export default function AccessPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const staff = useStaff();
  const call = useStaffApi();
  const list = useApi<{ mine: Elevation[]; toApprove: Elevation[] }>('/v1/backoffice/elevations');
  const allowed = (Object.keys(SCOPES) as Scope[]).filter((s) => staff && SCOPES[s].includes(staff.role));
  const [scope, setScope] = React.useState<Scope | ''>('');
  const [reason, setReason] = React.useState('');
  const [minutes, setMinutes] = React.useState(60);
  const [tenantId, setTenantId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const chosen = scope || allowed[0] || '';
  const when = (iso: string) => formatDateTime(iso, locale, zone);
  const message = (err: unknown) => {
    const reasonCode = err instanceof ApiProblem ? String(err.body.reason ?? '') : '';
    return PROBLEMS.includes(reasonCode)
      ? t(`backoffice.elevation.problem.${reasonCode}`)
      : err instanceof ApiProblem
        ? err.title
        : t('common.error');
  };

  async function request(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await call('/v1/backoffice/elevations', {
        method: 'POST',
        json: { scope: chosen, reason, minutes, ...(tenantId.trim() ? { tenantId: tenantId.trim() } : {}) },
      });
      setReason('');
      setTenantId('');
      toast({ title: t('backoffice.elevation.requested'), tone: 'success' });
      list.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const act = async (path: string, done: string) => {
    try {
      await call(path, { method: 'POST' });
      toast({ title: done, tone: 'success' });
      list.reload();
    } catch (err) {
      toast({ title: message(err), tone: 'danger' });
    }
  };
  const scopeName = (s: Scope) => t(`backoffice.elevation.scopes.${s}`);
  const duration = (m: number) =>
    m % 60 === 0
      ? t('backoffice.elevation.hours', { count: m / 60 })
      : t('backoffice.elevation.duration', { count: m });

  return (
    <div className="flex flex-col gap-8">
      <PageTitle title={t('backoffice.elevation.title')} lead={t('backoffice.elevation.lead')} />

      {list.data ? (
        <ListSection title={t('backoffice.elevation.toApproveTitle')} id="to-approve">
          {list.data.toApprove.length === 0 ? (
            <ListItem title={t('backoffice.elevation.noneToApprove')} />
          ) : (
            list.data.toApprove.map((e) => (
              <ListItem
                key={e.id}
                leading={ICON[e.scope]}
                title={`${scopeName(e.scope)} · ${duration(e.minutes)}`}
                subtitle={e.reason}
                meta={t('backoffice.elevation.requestedBy', {
                  email: e.staffEmail,
                  when: when(e.requestedAt),
                })}
                actions={
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-11 sm:h-8"
                      aria-label={t('backoffice.elevation.approveLabel', {
                        scope: scopeName(e.scope),
                        email: e.staffEmail,
                      })}
                      onClick={() =>
                        act(`/v1/backoffice/elevations/${e.id}/approve`, t('backoffice.elevation.approved'))
                      }
                    >
                      {t('backoffice.elevation.approve')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-11 sm:h-8"
                      aria-label={t('backoffice.elevation.denyLabel', {
                        scope: scopeName(e.scope),
                        email: e.staffEmail,
                      })}
                      onClick={() =>
                        act(`/v1/backoffice/elevations/${e.id}/deny`, t('backoffice.elevation.denied'))
                      }
                    >
                      {t('backoffice.elevation.deny')}
                    </Button>
                  </>
                }
              />
            ))
          )}
        </ListSection>
      ) : (
        <Skeleton className="h-24" />
      )}

      {allowed.length ? (
        <section aria-labelledby="request-title">
          <Card className="flex flex-col gap-4">
            <h2 id="request-title" className="text-title-3">
              {t('backoffice.elevation.requestTitle')}
            </h2>
            <form onSubmit={request} className="flex flex-col gap-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Field id="elevation-scope" label={t('backoffice.elevation.scope')}>
                  {(p) => (
                    <select
                      {...p}
                      className={`${selectClass} h-11`}
                      value={chosen}
                      onChange={(e) => setScope(e.target.value as Scope)}
                    >
                      {allowed.map((s) => (
                        <option key={s} value={s}>
                          {scopeName(s)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field id="elevation-minutes" label={t('backoffice.elevation.minutes')}>
                  {(p) => (
                    <select
                      {...p}
                      className={`${selectClass} h-11`}
                      value={minutes}
                      onChange={(e) => setMinutes(Number(e.target.value))}
                    >
                      {DURATIONS.map((m) => (
                        <option key={m} value={m}>
                          {duration(m)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </div>
              <Field
                id="elevation-reason"
                label={t('backoffice.elevation.reason')}
                hint={t('backoffice.elevation.reasonHint')}
              >
                {(p) => (
                  <Textarea
                    {...p}
                    required
                    minLength={10}
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                )}
              </Field>
              {chosen === 'support_grant' ? (
                <Field
                  id="elevation-tenant"
                  label={t('backoffice.elevation.tenant')}
                  hint={t('backoffice.elevation.tenantHint')}
                >
                  {(p) => (
                    <Input
                      {...p}
                      className="h-11"
                      inputMode="text"
                      autoComplete="off"
                      pattern="[0-9a-fA-F-]{36}"
                      value={tenantId}
                      onChange={(e) => setTenantId(e.target.value)}
                    />
                  )}
                </Field>
              ) : null}
              {error ? (
                <p role="alert" className="text-callout text-danger">
                  {error}
                </p>
              ) : null}
              <Button
                type="submit"
                className="h-11 self-start"
                loading={busy}
                disabled={reason.trim().length < 10}
              >
                {t('backoffice.elevation.submit')}
              </Button>
            </form>
          </Card>
        </section>
      ) : null}

      {list.data ? (
        <ListSection title={t('backoffice.elevation.mineTitle')} id="mine">
          {list.data.mine.length === 0 ? (
            <ListItem title={t('backoffice.elevation.noneMine')} />
          ) : (
            list.data.mine.map((e) => (
              <ListItem
                key={e.id}
                leading={ICON[e.scope]}
                title={scopeName(e.scope)}
                subtitle={e.reason}
                meta={
                  <span className="flex flex-col items-start gap-1 sm:items-end">
                    <Badge tone={TONE[e.status]}>{t(`backoffice.elevation.status.${e.status}`)}</Badge>
                    {e.status === 'active' && e.expiresAt ? (
                      <span>{t('backoffice.elevation.until', { when: when(e.expiresAt) })}</span>
                    ) : null}
                  </span>
                }
                actions={
                  e.status === 'active' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-11 sm:h-8"
                      onClick={() =>
                        act(`/v1/backoffice/elevations/${e.id}/revoke`, t('backoffice.elevation.revoked'))
                      }
                    >
                      {t('backoffice.elevation.revoke')}
                    </Button>
                  ) : undefined
                }
              />
            ))
          )}
        </ListSection>
      ) : null}
    </div>
  );
}
