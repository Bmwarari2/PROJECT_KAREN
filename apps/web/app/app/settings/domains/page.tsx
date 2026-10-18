'use client';
import * as React from 'react';
import { Globe } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { FormError, PageHeader, ReadOnlyNote, SettingsCard, useAction, usePermission } from '../kit';

interface Domain {
  id: string;
  domain: string;
  txtName: string;
  txtValue: string;
  verifiedAt: string | null;
}

/** Verified email domains: needed for SSO just-in-time accounts and workspace discovery. */
export default function DomainsPage() {
  const t = useT();
  const has = usePermission();
  const canManage = has('settings.manage');
  const domains = useApi<Domain[]>('/v1/settings/domains');
  const [domain, setDomain] = React.useState('');
  const add = useAction();
  const verify = useAction();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await add.run(() => api('/v1/settings/domains', { method: 'POST', json: { domain: domain.trim().toLowerCase() } }));
    if (ok) {
      setDomain('');
      domains.reload();
    }
  }

  return (
    <>
      <PageHeader title={t('admin.section.domains.title')} lead={t('app.settings.domainsBody')} />
      <SettingsCard id="domains" title={t('app.settings.domainsTitle')}>
        {canManage ? (
          <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field id="domain" label={t('app.settings.domainLabel')} hint={t('admin.domains.hint')} className="flex-1">
              {(p) => <Input {...p} required inputMode="url" autoCapitalize="none" spellCheck={false} value={domain} onChange={(e) => setDomain(e.target.value)} />}
            </Field>
            <Button type="submit" loading={add.busy}>
              {t('common.add')}
            </Button>
          </form>
        ) : (
          <ReadOnlyNote />
        )}
        <FormError message={add.error ?? verify.error} />
        {!domains.data ? (
          <Skeleton className="h-24" />
        ) : domains.data.length === 0 ? (
          <EmptyState icon={<Globe aria-hidden />} title={t('app.settings.noDomains')} />
        ) : (
          <Table dense>
            <THead>
              <tr>
                <TH>{t('app.settings.domainLabel')}</TH>
                <TH>{t('app.settings.txtRecord')}</TH>
                <TH>{t('common.status')}</TH>
                <TH>
                  <span className="sr-only">{t('common.actions')}</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {domains.data.map((d) => (
                <TR key={d.id}>
                  <TD className="font-semibold">{d.domain}</TD>
                  <TD className="break-all text-footnote text-text-secondary">
                    {d.txtName} → {d.txtValue}
                  </TD>
                  <TD>{d.verifiedAt ? <Badge tone="success">{t('app.settings.verified')}</Badge> : <Badge tone="warning">{t('app.settings.pending')}</Badge>}</TD>
                  <TD className="text-right">
                    {!d.verifiedAt && canManage ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={verify.busy}
                        aria-label={t('admin.domains.verifyLabel', { domain: d.domain })}
                        onClick={async () => (await verify.run(() => api(`/v1/settings/domains/${d.id}/verify`, { method: 'POST' }), t('app.settings.domainVerified'))) && domains.reload()}
                      >
                        {t('app.settings.verify')}
                      </Button>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </SettingsCard>
    </>
  );
}
