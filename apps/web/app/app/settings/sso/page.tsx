'use client';
import * as React from 'react';
import { ExternalLink, KeyRound, Plus } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Skeleton, Textarea, useToast } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { Checkbox, ConfirmAction, CopyValue, FormError, PageHeader, RadioGroup, ReadOnlyNote, SettingsCard, useAction, useFormat, usePermission } from '../kit';

interface SsoConnection {
  id: string;
  protocol: 'oidc' | 'saml';
  name: string;
  enabled: boolean;
  jitProvisioning: boolean;
  createdAt: string;
  idpUrl: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  acsUrl: string;
  redirectUri: string;
  spEntityId: string;
  testSignInUrl: string;
}
interface Security {
  ssoEnforced: boolean;
}
interface Created {
  id: string;
  protocol: 'oidc' | 'saml';
  acsUrl: string;
  redirectUri: string;
  spEntityId: string;
}

/** The values the customer's identity provider needs from us, per protocol. */
function SetupValues({ protocol, redirectUri, acsUrl, spEntityId, prefix }: { protocol: 'oidc' | 'saml'; redirectUri: string; acsUrl: string; spEntityId: string; prefix: string }) {
  const t = useT();
  return protocol === 'oidc' ? (
    <CopyValue label={t('admin.sso.redirectUri')} value={redirectUri} testId={`${prefix}-redirect-uri`} />
  ) : (
    <div className="grid gap-3 md:grid-cols-2">
      <CopyValue label={t('admin.sso.acsUrl')} value={acsUrl} testId={`${prefix}-acs-url`} />
      <CopyValue label={t('admin.sso.spEntityId')} value={spEntityId} testId={`${prefix}-sp-entity-id`} />
    </div>
  );
}

function ConnectionItem({ c, canManage, onChanged }: { c: SsoConnection; canManage: boolean; onChanged: () => void }) {
  const t = useT();
  const fmt = useFormat();
  const action = useAction();
  const patch = (body: Record<string, unknown>, success: string) => action.run(() => api(`/v1/settings/sso-connections/${c.id}`, { method: 'PATCH', json: body }), success).then((ok) => ok && onChanged());
  return (
    <li className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-callout font-semibold">{c.name}</h3>
        <Badge>{t(`admin.sso.protocol.${c.protocol}`)}</Badge>
        {c.enabled ? <Badge tone="success">{t('admin.on')}</Badge> : <Badge>{t('admin.off')}</Badge>}
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-footnote sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="text-text-secondary">{t(c.protocol === 'oidc' ? 'admin.sso.issuer' : 'admin.sso.entryPoint')}</dt>
        <dd className="break-all">{c.idpUrl ?? '—'}</dd>
        {c.protocol === 'oidc' ? (
          <>
            <dt className="text-text-secondary">{t('admin.sso.clientId')}</dt>
            <dd className="break-all">{c.clientId ?? '—'}</dd>
            <dt className="text-text-secondary">{t('admin.sso.clientSecret')}</dt>
            <dd>{c.hasClientSecret ? t('admin.sso.secretStored') : t('admin.sso.noSecret')}</dd>
          </>
        ) : null}
        <dt className="text-text-secondary">{t('admin.sso.jit')}</dt>
        <dd>{c.jitProvisioning ? t('common.yes') : t('common.no')}</dd>
        <dt className="text-text-secondary">{t('admin.created')}</dt>
        <dd>{fmt.instantDate(c.createdAt)}</dd>
      </dl>
      <SetupValues protocol={c.protocol} redirectUri={c.redirectUri} acsUrl={c.acsUrl} spEntityId={c.spEntityId} prefix={`conn-${c.id}`} />
      <FormError message={action.error} />
      <div className="flex flex-wrap items-center gap-2">
        {c.enabled ? (
          <a href={c.testSignInUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-callout" data-testid={`conn-${c.id}-test`}>
            {t('admin.sso.test')}
            <ExternalLink aria-hidden className="h-4 w-4 stroke-[1.5]" />
            <span className="sr-only">{t('time.opensNewTab')}</span>
          </a>
        ) : null}
        {canManage ? (
          <span className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" loading={action.busy} onClick={() => patch({ jitProvisioning: !c.jitProvisioning }, t('admin.saved'))}>
              {c.jitProvisioning ? t('admin.sso.jitOff') : t('admin.sso.jitOn')}
            </Button>
            <Button size="sm" variant="secondary" loading={action.busy} onClick={() => patch({ enabled: !c.enabled }, c.enabled ? t('admin.sso.turnedOff') : t('admin.sso.turnedOn'))}>
              {c.enabled ? t('admin.turnOff') : t('admin.turnOn')}
            </Button>
            <ConfirmAction
              label={t('common.delete')}
              ariaLabel={t('admin.sso.deleteLabel', { name: c.name })}
              title={t('admin.sso.deleteTitle', { name: c.name })}
              body={t('admin.sso.deleteBody')}
              confirmLabel={t('common.delete')}
              onConfirm={async () => {
                await api(`/v1/settings/sso-connections/${c.id}`, { method: 'DELETE' });
                onChanged();
              }}
            />
          </span>
        ) : null}
      </div>
    </li>
  );
}

function AddConnection({ onCreated }: { onCreated: () => void }) {
  const t = useT();
  const action = useAction();
  const [protocol, setProtocol] = React.useState<'oidc' | 'saml'>('oidc');
  const [v, setV] = React.useState({ name: '', issuer: '', clientId: '', clientSecret: '', scopes: '', entryPoint: '', idpIssuer: '', idpCert: '' });
  const [jit, setJit] = React.useState(true);
  const [created, setCreated] = React.useState<Created | null>(null);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV((x) => ({ ...x, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body =
      protocol === 'oidc'
        ? { protocol, name: v.name, jitProvisioning: jit, oidc: { issuer: v.issuer.trim(), clientId: v.clientId.trim(), ...(v.clientSecret ? { clientSecret: v.clientSecret } : {}), ...(v.scopes.trim() ? { scopes: v.scopes.trim() } : {}) } }
        : { protocol, name: v.name, jitProvisioning: jit, saml: { entryPoint: v.entryPoint.trim(), idpCert: v.idpCert.trim(), ...(v.idpIssuer.trim() ? { idpIssuer: v.idpIssuer.trim() } : {}) } };
    await action.run(async () => {
      const r = await api<Omit<Created, 'protocol'>>('/v1/settings/sso-connections', { method: 'POST', json: body });
      setCreated({ ...r, protocol });
      // the client secret is sealed by the API and never shown again
      setV({ name: '', issuer: '', clientId: '', clientSecret: '', scopes: '', entryPoint: '', idpIssuer: '', idpCert: '' });
      onCreated();
    });
  }

  return (
    <SettingsCard id="sso-add" title={t('admin.sso.addTitle')} description={t('admin.sso.addBody')}>
      {created ? (
        <div role="status" className="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4" data-testid="sso-created">
          <p className="text-callout font-semibold">{t('admin.sso.created')}</p>
          <p className="text-footnote text-text-secondary">{t(created.protocol === 'oidc' ? 'admin.sso.createdOidc' : 'admin.sso.createdSaml')}</p>
          <SetupValues protocol={created.protocol} redirectUri={created.redirectUri} acsUrl={created.acsUrl} spEntityId={created.spEntityId} prefix="created" />
          <Button size="sm" variant="secondary" className="self-start" onClick={() => setCreated(null)}>
            {t('admin.sso.addAnother')}
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <RadioGroup
            name="sso-protocol"
            legend={t('admin.sso.protocolLegend')}
            value={protocol}
            onChange={setProtocol}
            options={[
              { value: 'oidc', label: t('admin.sso.protocol.oidc'), hint: t('admin.sso.oidcHint') },
              { value: 'saml', label: t('admin.sso.protocol.saml'), hint: t('admin.sso.samlHint') },
            ]}
          />
          <Field id="sso-name" label={t('admin.name')} hint={t('admin.sso.nameHint')}>
            {(p) => <Input {...p} required maxLength={100} value={v.name} onChange={set('name')} />}
          </Field>
          {protocol === 'oidc' ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Field id="sso-issuer" label={t('admin.sso.issuer')} hint={t('admin.sso.issuerHint')}>
                {(p) => <Input {...p} type="url" required spellCheck={false} value={v.issuer} onChange={set('issuer')} />}
              </Field>
              <Field id="sso-client-id" label={t('admin.sso.clientId')}>
                {(p) => <Input {...p} required spellCheck={false} autoComplete="off" value={v.clientId} onChange={set('clientId')} />}
              </Field>
              <Field id="sso-client-secret" label={t('admin.sso.clientSecret')} hint={t('admin.sso.clientSecretHint')}>
                {(p) => <Input {...p} type="password" autoComplete="new-password" spellCheck={false} value={v.clientSecret} onChange={set('clientSecret')} />}
              </Field>
              <Field id="sso-scopes" label={t('admin.sso.scopes')} hint={t('admin.sso.scopesHint')}>
                {(p) => <Input {...p} spellCheck={false} value={v.scopes} onChange={set('scopes')} />}
              </Field>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <Field id="sso-entry-point" label={t('admin.sso.entryPoint')} hint={t('admin.sso.entryPointHint')}>
                {(p) => <Input {...p} type="url" required spellCheck={false} value={v.entryPoint} onChange={set('entryPoint')} />}
              </Field>
              <Field id="sso-idp-issuer" label={t('admin.sso.idpIssuer')} hint={t('admin.optional')}>
                {(p) => <Input {...p} spellCheck={false} value={v.idpIssuer} onChange={set('idpIssuer')} />}
              </Field>
              <Field id="sso-idp-cert" label={t('admin.sso.idpCert')} hint={t('admin.sso.idpCertHint')} className="md:col-span-2">
                {(p) => <Textarea {...p} required minLength={20} spellCheck={false} className="min-h-32 font-mono text-footnote" value={v.idpCert} onChange={set('idpCert')} />}
              </Field>
            </div>
          )}
          <Checkbox id="sso-jit" label={t('admin.sso.jit')} hint={t('admin.sso.jitHint')} checked={jit} onChange={setJit} />
          <FormError message={action.error} />
          <Button type="submit" className="self-start" loading={action.busy}>
            <Plus aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('admin.sso.add')}
          </Button>
        </form>
      )}
    </SettingsCard>
  );
}

function Enforcement({ security, connections, canManage, onChanged }: { security: Security; connections: SsoConnection[]; canManage: boolean; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const action = useAction();
  const anyEnabled = connections.some((c) => c.enabled);
  return (
    <SettingsCard id="sso-enforce" title={t('admin.sso.enforceTitle')} description={t('admin.sso.enforceBody')}>
      <p className="flex flex-wrap items-center gap-2 text-callout" data-testid="sso-enforced">
        {security.ssoEnforced ? <Badge tone="success">{t('admin.sso.required')}</Badge> : <Badge>{t('admin.sso.optionalBadge')}</Badge>}
        <span className="text-text-secondary">{security.ssoEnforced ? t('admin.sso.requiredBody') : t('admin.sso.optionalBody')}</span>
      </p>
      <FormError message={action.error} />
      {!canManage ? null : security.ssoEnforced ? (
        <Button
          variant="secondary"
          className="self-start"
          loading={action.busy}
          onClick={async () => (await action.run(() => api('/v1/settings/security', { method: 'PATCH', json: { ssoEnforced: false } }), t('admin.sso.enforcedOff'))) && onChanged()}
        >
          {t('admin.sso.stopRequiring')}
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <ConfirmAction
            label={t('admin.sso.require')}
            title={t('admin.sso.requireTitle')}
            body={t('admin.sso.requireBody')}
            confirmLabel={t('admin.sso.require')}
            disabled={!anyEnabled}
            onConfirm={async () => {
              await api('/v1/settings/security', { method: 'PATCH', json: { ssoEnforced: true } });
              toast({ title: t('admin.sso.enforcedOn'), tone: 'success' });
              onChanged();
            }}
          />
          {!anyEnabled ? <p className="text-footnote text-text-secondary">{t('admin.sso.requireNeedsConnection')}</p> : null}
        </div>
      )}
    </SettingsCard>
  );
}

export default function SsoPage() {
  const t = useT();
  const has = usePermission();
  const canManage = has('settings.manage');
  const connections = useApi<SsoConnection[]>('/v1/settings/sso-connections');
  const security = useApi<Security>('/v1/settings/security');
  const reload = () => (connections.reload(), security.reload());

  return (
    <>
      <PageHeader title={t('admin.section.sso.title')} lead={t('admin.sso.lead')} />
      {connections.error?.status === 403 ? <EmptyState title={t('errors.forbidden')} /> : null}
      {security.data && connections.data ? <Enforcement security={security.data} connections={connections.data} canManage={canManage} onChanged={reload} /> : null}
      <SettingsCard id="sso-connections" title={t('admin.sso.connections')}>
        {!connections.data ? (
          <Skeleton className="h-24" />
        ) : connections.data.length === 0 ? (
          <EmptyState icon={<KeyRound aria-hidden />} title={t('admin.sso.none')} body={t('admin.sso.noneBody')} />
        ) : (
          <ul className="flex flex-col gap-3">
            {connections.data.map((c) => (
              <ConnectionItem key={c.id} c={c} canManage={canManage} onChanged={reload} />
            ))}
          </ul>
        )}
      </SettingsCard>
      {canManage ? <AddConnection onCreated={connections.reload} /> : <ReadOnlyNote />}
    </>
  );
}
