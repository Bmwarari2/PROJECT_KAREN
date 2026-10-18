'use client';
import * as React from 'react';
import { KeyRound, Plus } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { ConfirmAction, CopyValue, FormError, OnceSecret, PageHeader, ReadOnlyNote, SettingsCard, useAction, useFormat, usePermission } from '../kit';

interface ScimToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** SCIM 2.0 provisioning from the customer's directory (Microsoft Entra ID, Okta, …). */
export default function ScimPage() {
  const t = useT();
  const fmt = useFormat();
  const has = usePermission();
  const canManage = has('settings.manage');
  const tokens = useApi<ScimToken[]>('/v1/settings/scim-tokens');
  const [name, setName] = React.useState('');
  const [secret, setSecret] = React.useState<string | null>(null);
  const [baseUrl, setBaseUrl] = React.useState('');
  const create = useAction();
  React.useEffect(() => setBaseUrl(`${window.location.origin}/scim/v2`), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await create.run(async () => {
      const r = await api<{ id: string; token: string }>('/v1/settings/scim-tokens', { method: 'POST', json: { name: name.trim() } });
      setSecret(r.token);
      setName('');
      tokens.reload();
    });
  }

  return (
    <>
      <PageHeader title={t('admin.section.scim.title')} lead={t('admin.scim.lead')} />
      <SettingsCard id="scim-endpoint" title={t('admin.scim.endpointTitle')} description={t('admin.scim.endpointBody')}>
        {baseUrl ? <CopyValue label={t('admin.scim.baseUrl')} value={baseUrl} testId="scim-base-url" /> : null}
      </SettingsCard>
      <SettingsCard id="scim-tokens" title={t('admin.scim.tokensTitle')} description={t('admin.scim.tokensBody')}>
        {secret ? <OnceSecret title={t('admin.scim.created')} label={t('admin.scim.token')} value={secret} testId="scim-token" onDone={() => setSecret(null)} /> : null}
        {canManage && !secret ? (
          <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field id="scim-name" label={t('admin.scim.name')} hint={t('admin.scim.nameHint')} className="flex-1">
              {(p) => <Input {...p} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Button type="submit" loading={create.busy}>
              <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('admin.scim.create')}
            </Button>
          </form>
        ) : null}
        {!canManage ? <ReadOnlyNote /> : null}
        <FormError message={create.error} />
        {!tokens.data ? (
          <Skeleton className="h-24" />
        ) : tokens.data.length === 0 ? (
          <EmptyState icon={<KeyRound aria-hidden />} title={t('admin.scim.none')} />
        ) : (
          <Table dense scrollLabel={t('admin.tableScroll', { name: t('admin.scim.tokensTitle') })}>
            <THead>
              <tr>
                <TH>{t('admin.name')}</TH>
                <TH>{t('admin.created')}</TH>
                <TH>{t('admin.scim.lastUsed')}</TH>
                <TH>{t('common.status')}</TH>
                <TH>
                  <span className="sr-only">{t('common.actions')}</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {tokens.data.map((k) => (
                <TR key={k.id}>
                  <TD className="font-semibold">{k.name}</TD>
                  <TD>{fmt.dateTime(k.createdAt)}</TD>
                  <TD>{k.lastUsedAt ? fmt.dateTime(k.lastUsedAt) : t('admin.never')}</TD>
                  <TD>{k.revokedAt ? <Badge>{t('admin.revoked')}</Badge> : <Badge tone="success">{t('admin.active')}</Badge>}</TD>
                  <TD className="text-right">
                    {canManage && !k.revokedAt ? (
                      <ConfirmAction
                        label={t('admin.revoke')}
                        ariaLabel={t('admin.scim.revokeLabel', { name: k.name })}
                        title={t('admin.scim.revokeTitle', { name: k.name })}
                        body={t('admin.scim.revokeBody')}
                        confirmLabel={t('admin.revoke')}
                        onConfirm={async () => {
                          await api(`/v1/settings/scim-tokens/${k.id}`, { method: 'DELETE' });
                          tokens.reload();
                        }}
                      />
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
