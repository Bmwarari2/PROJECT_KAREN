'use client';
import * as React from 'react';
import { KeyRound, Play, Plug, ShieldCheck } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Field,
  Input,
  Table,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@thapsus/ui';
import { formatDateTime } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useSession } from '../shell';

type Provider = 'microsoft365' | 'google_workspace';
interface Connection {
  provider: Provider;
  status: 'not_configured' | 'pending_consent' | 'connected' | 'disabled';
  domain: string | null;
  directoryId: string | null;
  clientId: string | null;
  adminSubject: string | null;
  consentedAt: string | null;
  credentials: string[];
  scopes: string[];
  rules: number;
}
interface Rule {
  id: string;
  name: string;
  licences: Array<{ skuId: string; productId?: string }>;
  groups: string[];
}
interface Plan {
  principalName: string;
  operations: Array<{ seq: number; op: string; method: string; url: string; body?: Record<string, unknown> }>;
  skipped?: string;
}
interface Operation {
  id: string;
  employeeName: string | null;
  provider: Provider;
  lifecycle: string;
  op: string;
  status: string;
  error: string | null;
  executedAt: string | null;
  createdAt: string;
}

const statusTone = {
  connected: 'success',
  pending_consent: 'warning',
  disabled: 'neutral',
  not_configured: 'neutral',
} as const;
const opTone = { succeeded: 'success', failed: 'danger', pending: 'neutral', skipped: 'warning' } as const;
const select = 'h-10 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout';

function ProviderCard({
  c,
  canManage,
  onChange,
}: {
  c: Connection;
  canManage: boolean;
  onChange: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const google = c.provider === 'google_workspace';
  const rules = useApi<Rule[]>(`/v1/integrations/it/${c.provider}/rules`);
  const [form, setForm] = React.useState({
    domain: c.domain ?? '',
    directoryId: c.directoryId ?? '',
    clientId: c.clientId ?? '',
    adminSubject: c.adminSubject ?? '',
  });
  const [secret, setSecret] = React.useState('');
  const [rule, setRule] = React.useState({ name: '', skuId: '', group: '' });
  const [busy, setBusy] = React.useState<string | null>(null);
  const id = (k: string) => `${c.provider}-${k}`;
  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
      onChange();
    } catch (err) {
      toast({
        title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  }
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void run('save', async () => {
      await api(`/v1/integrations/it/${c.provider}`, {
        method: 'PUT',
        json: {
          domain: form.domain.trim().toLowerCase(),
          directoryId: form.directoryId || null,
          clientId: form.clientId || null,
          ...(google ? { adminSubject: form.adminSubject || null } : {}),
        },
      });
      toast({ title: t('integrations.saved'), tone: 'success' });
    });
  };
  const saveSecret = (e: React.FormEvent) => {
    e.preventDefault();
    void run('secret', async () => {
      await api(`/v1/integrations/it/${c.provider}/credentials`, {
        method: 'PUT',
        json: google ? { serviceAccountKey: secret } : { clientSecret: secret },
      });
      setSecret('');
      toast({ title: t('integrations.secretSaved'), tone: 'success' });
    });
  };
  const consent = () =>
    run('consent', async () => {
      const r = await api<{ url: string | null; clientId: string | null }>(
        `/v1/integrations/it/${c.provider}/consent`,
        { method: 'POST' },
      );
      if (r.url) window.location.assign(r.url);
      else toast({ title: t('integrations.googleDelegation', { clientId: r.clientId ?? '' }) });
    });
  const verify = () =>
    run('verify', async () => {
      await api(`/v1/integrations/it/${c.provider}/verify`, { method: 'POST' });
      toast({ title: t('integrations.verified'), tone: 'success' });
    });
  const addRule = (e: React.FormEvent) => {
    e.preventDefault();
    void run('rule', async () => {
      await api(`/v1/integrations/it/${c.provider}/rules`, {
        method: 'POST',
        json: {
          name: rule.name,
          match: {},
          licences: rule.skuId ? [{ skuId: rule.skuId }] : [],
          groups: rule.group ? [rule.group] : [],
        },
      });
      setRule({ name: '', skuId: '', group: '' });
      rules.reload();
    });
  };

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Plug aria-hidden className="h-5 w-5 stroke-[1.5] text-accent" />
        <CardTitle className="mr-auto">{t(`integrations.providers.${c.provider}`)}</CardTitle>
        <Badge tone={statusTone[c.status]}>{t(`integrations.status.${c.status}`)}</Badge>
      </div>
      <details className="text-callout">
        <summary className="cursor-pointer text-accent">{t('integrations.scopesTitle')}</summary>
        <ul className="mt-2 flex flex-wrap gap-2">
          {c.scopes.map((s) => (
            <li key={s}>
              <code className="rounded-sm bg-surface px-2 py-0.5 text-footnote">{s}</code>
            </li>
          ))}
        </ul>
      </details>
      {canManage ? (
        <>
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
            <Field id={id('domain')} label={t('integrations.domain')} hint={t('integrations.domainHint')}>
              {(p) => (
                <Input
                  {...p}
                  required
                  value={form.domain}
                  onChange={(e) => setForm({ ...form, domain: e.target.value })}
                />
              )}
            </Field>
            <Field
              id={id('directory')}
              label={t(google ? 'integrations.customerId' : 'integrations.tenantId')}
            >
              {(p) => (
                <Input
                  {...p}
                  value={form.directoryId}
                  onChange={(e) => setForm({ ...form, directoryId: e.target.value })}
                />
              )}
            </Field>
            <Field
              id={id('client')}
              label={t(google ? 'integrations.serviceAccount' : 'integrations.clientId')}
              hint={t(google ? 'integrations.serviceAccountHint' : 'integrations.clientIdHint')}
            >
              {(p) => (
                <Input
                  {...p}
                  value={form.clientId}
                  onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                />
              )}
            </Field>
            {google ? (
              <Field
                id={id('admin')}
                label={t('integrations.adminSubject')}
                hint={t('integrations.adminSubjectHint')}
              >
                {(p) => (
                  <Input
                    {...p}
                    type="email"
                    value={form.adminSubject}
                    onChange={(e) => setForm({ ...form, adminSubject: e.target.value })}
                  />
                )}
              </Field>
            ) : null}
            <div className="sm:col-span-2">
              <Button type="submit" size="sm" loading={busy === 'save'}>
                {t('common.save')}
              </Button>
            </div>
          </form>
          {c.status !== 'not_configured' ? (
            <>
              <form onSubmit={saveSecret} className="flex flex-wrap items-end gap-3">
                <Field
                  id={id('secret')}
                  label={t(google ? 'integrations.serviceAccountKey' : 'integrations.clientSecret')}
                  hint={
                    c.credentials.length ? t('integrations.secretConfigured') : t('integrations.secretNever')
                  }
                  className="min-w-[16rem] flex-1"
                >
                  {(p) =>
                    google ? (
                      <textarea
                        {...p}
                        rows={3}
                        className="w-full rounded-sm border border-border-strong bg-surface-raised px-3 py-2 font-mono text-footnote"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                      />
                    ) : (
                      <Input
                        {...p}
                        type="password"
                        autoComplete="off"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                      />
                    )
                  }
                </Field>
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={!secret}
                  loading={busy === 'secret'}
                >
                  <KeyRound aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('integrations.saveSecret')}
                </Button>
              </form>
              <div className="flex flex-wrap gap-3">
                <Button size="sm" variant="secondary" onClick={consent} loading={busy === 'consent'}>
                  <ShieldCheck aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t(google ? 'integrations.showDelegation' : 'integrations.grantConsent')}
                </Button>
                <Button size="sm" variant="ghost" onClick={verify} loading={busy === 'verify'}>
                  {t('integrations.verify')}
                </Button>
              </div>
            </>
          ) : null}
        </>
      ) : null}
      {c.status !== 'not_configured' ? (
        <div>
          <h3 className="text-callout font-semibold">{t('integrations.rules')}</h3>
          {rules.data?.length ? (
            <ul className="mt-2 flex flex-col gap-1 text-callout">
              {rules.data.map((r) => (
                <li key={r.id}>
                  <span className="font-semibold">{r.name}</span>{' '}
                  <span className="text-text-secondary">
                    {t('integrations.ruleSummary', {
                      licences: t('integrations.ruleLicences', { count: r.licences.length }),
                      groups: t('integrations.ruleGroups', { count: r.groups.length }),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-footnote text-text-secondary">{t('integrations.noRules')}</p>
          )}
          {canManage ? (
            <form onSubmit={addRule} className="mt-3 grid gap-3 sm:grid-cols-4 sm:items-end">
              <Field id={id('rule-name')} label={t('integrations.ruleName')}>
                {(p) => (
                  <Input
                    {...p}
                    required
                    value={rule.name}
                    onChange={(e) => setRule({ ...rule, name: e.target.value })}
                  />
                )}
              </Field>
              <Field id={id('rule-sku')} label={t('integrations.licenceSku')}>
                {(p) => (
                  <Input
                    {...p}
                    value={rule.skuId}
                    onChange={(e) => setRule({ ...rule, skuId: e.target.value })}
                  />
                )}
              </Field>
              <Field
                id={id('rule-group')}
                label={t(google ? 'integrations.groupEmail' : 'integrations.groupId')}
              >
                {(p) => (
                  <Input
                    {...p}
                    value={rule.group}
                    onChange={(e) => setRule({ ...rule, group: e.target.value })}
                  />
                )}
              </Field>
              <Button type="submit" size="sm" variant="secondary" loading={busy === 'rule'}>
                {t('integrations.addRule')}
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

export default function IntegrationsPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const canManage = !!session?.permissions.some(
    (g) => g === '*' || g === 'integrations.*' || g === 'integrations.manage',
  );
  const connections = useApi<Connection[]>('/v1/integrations/it');
  const people = useApi<{ data: Array<{ id: string; displayName: string }> }>(
    '/v1/employees?limit=200&status=all',
  );
  const log = useApi<Operation[]>('/v1/integrations/it/operations');
  const [dry, setDry] = React.useState({
    provider: 'microsoft365' as Provider,
    employeeId: '',
    lifecycle: 'joiner',
  });
  const [plan, setPlan] = React.useState<Plan | null>(null);
  const tz = session?.timeZone ?? 'Europe/London';

  async function preview(e: React.FormEvent) {
    e.preventDefault();
    try {
      setPlan(
        await api<Plan>(
          `/v1/integrations/it/${dry.provider}/preview/${dry.employeeId}?lifecycle=${dry.lifecycle}`,
        ),
      );
    } catch (err) {
      toast({
        title: err instanceof ApiProblem ? ((err.body.detail as string) ?? err.title) : t('common.error'),
        tone: 'danger',
      });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title-2">{t('integrations.title')}</h1>
        <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">
          {t('integrations.intro')}
        </p>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {(connections.data ?? []).map((c) => (
          <ProviderCard
            key={`${c.provider}:${c.status}:${c.domain ?? ''}`}
            c={c}
            canManage={canManage}
            onChange={connections.reload}
          />
        ))}
      </div>

      <Card>
        <CardTitle>{t('integrations.dryRun')}</CardTitle>
        <p className="mt-1 text-callout text-text-secondary">{t('integrations.dryRunBody')}</p>
        <form onSubmit={preview} className="mt-3 grid gap-3 md:grid-cols-4 md:items-end">
          <Field id="dry-provider" label={t('integrations.provider')}>
            {(p) => (
              <select
                {...p}
                className={select}
                value={dry.provider}
                onChange={(e) => setDry({ ...dry, provider: e.target.value as Provider })}
              >
                <option value="microsoft365">{t('integrations.providers.microsoft365')}</option>
                <option value="google_workspace">{t('integrations.providers.google_workspace')}</option>
              </select>
            )}
          </Field>
          <Field id="dry-employee" label={t('integrations.employee')}>
            {(p) => (
              <select
                {...p}
                required
                className={select}
                value={dry.employeeId}
                onChange={(e) => setDry({ ...dry, employeeId: e.target.value })}
              >
                <option value="">{t('integrations.chooseEmployee')}</option>
                {(people.data?.data ?? []).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.displayName}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="dry-lifecycle" label={t('integrations.lifecycle')}>
            {(p) => (
              <select
                {...p}
                className={select}
                value={dry.lifecycle}
                onChange={(e) => setDry({ ...dry, lifecycle: e.target.value })}
              >
                <option value="joiner">{t('integrations.joiner')}</option>
                <option value="leaver">{t('integrations.leaver')}</option>
              </select>
            )}
          </Field>
          <Button type="submit" variant="secondary">
            <Play aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('integrations.preview')}
          </Button>
        </form>
        {plan ? (
          <div className="mt-4">
            <p className="text-callout">
              {plan.skipped
                ? t('integrations.nothingToDo')
                : t('integrations.planFor', { name: plan.principalName })}
            </p>
            <ol className="mt-2 flex flex-col gap-2">
              {plan.operations.map((o) => (
                <li key={o.seq} className="rounded-md border border-border p-3">
                  <p className="text-callout font-semibold">
                    {o.seq}. {t(`integrations.ops.${o.op}`)}
                  </p>
                  <p className="break-all font-mono text-footnote text-text-secondary">
                    {o.method} {o.url}
                  </p>
                  {o.body ? (
                    <pre className="mt-2 overflow-x-auto rounded-sm bg-surface p-2 text-footnote">
                      {JSON.stringify(o.body, null, 2)}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardTitle>{t('integrations.log')}</CardTitle>
        {log.data?.length ? (
          <Table dense className="mt-3">
            <THead>
              <tr>
                <TH>{t('integrations.when')}</TH>
                <TH>{t('integrations.employee')}</TH>
                <TH>{t('integrations.step')}</TH>
                <TH>{t('common.status')}</TH>
              </tr>
            </THead>
            <tbody>
              {log.data.map((o) => (
                <TR key={o.id}>
                  <TD>{formatDateTime(o.executedAt ?? o.createdAt, locale, tz)}</TD>
                  <TD>{o.employeeName ?? ''}</TD>
                  <TD>
                    {t(`integrations.providers.${o.provider}`)} · {t(`integrations.ops.${o.op}`)}
                  </TD>
                  <TD>
                    <Badge tone={opTone[o.status as keyof typeof opTone] ?? 'neutral'}>
                      {t(`integrations.opStatus.${o.status}`)}
                    </Badge>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="mt-2 text-callout text-text-secondary">{t('integrations.noLog')}</p>
        )}
      </Card>
    </div>
  );
}
