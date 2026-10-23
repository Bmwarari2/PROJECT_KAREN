'use client';
import * as React from 'react';
import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Table,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@thapsus/ui';
import { API_SCOPE_KEYS } from '@thapsus/core/api-scopes';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import {
  errorText,
  FeatureOff,
  PageHeader,
  SecretOnce,
  StatusBadge,
  useDateTime,
} from '@/components/platform';
import { useFeature } from '../../shell';
import { useSectionLevel } from '@/components/module-page';

interface Credential {
  id: string;
  name: string;
  scopes: string[];
  roleKey: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}
interface ApiKey extends Credential {
  prefix: string;
  expiresAt: string | null;
}
interface OAuthClient extends Credential {
  clientId: string;
  tokenTtlSeconds: number;
}
interface Role {
  id: string;
  key: string;
  name: string;
  builtIn: boolean;
}
type Page<T> = { data: T[]; nextCursor: string | null };

const scopeLabel = (s: string) => `platform.scopes.${s.replace(':', '_')}`;

export default function ApiAccessPage() {
  const t = useT();
  const sec = useSectionLevel();
  const toast = useToast();
  const when = useDateTime();
  const enabled = useFeature('publicApi');
  const keys = useApi<Page<ApiKey>>(enabled ? '/v1/settings/api-keys?limit=200' : null);
  const clients = useApi<Page<OAuthClient>>(enabled ? '/v1/settings/oauth-clients?limit=200' : null);
  const roles = useApi<Role[]>(enabled ? '/v1/settings/api-access/roles' : null);
  const [kind, setKind] = React.useState<'key' | 'oauth'>('key');
  const [name, setName] = React.useState('');
  const [roleKey, setRoleKey] = React.useState('hr_admin');
  const [scopes, setScopes] = React.useState<string[]>(['employees:read']);
  const [secret, setSecret] = React.useState<{
    title: string;
    items: Array<{ label: string; value: string }>;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (!enabled)
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('platform.api.title')} />
        <FeatureOff />
      </div>
    );

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (kind === 'key') {
        const r = await api<ApiKey & { key: string }>('/v1/settings/api-keys', {
          method: 'POST',
          json: { name, scopes, roleKey },
        });
        setSecret({
          title: t('platform.api.keyCreated'),
          items: [{ label: t('platform.api.apiKey'), value: r.key }],
        });
        keys.reload();
      } else {
        const r = await api<OAuthClient & { clientSecret: string }>('/v1/settings/oauth-clients', {
          method: 'POST',
          json: { name, scopes, roleKey },
        });
        setSecret({
          title: t('platform.api.clientCreated'),
          items: [
            { label: t('platform.api.clientId'), value: r.clientId },
            { label: t('platform.api.clientSecret'), value: r.clientSecret },
          ],
        });
        clients.reload();
      }
      setName('');
    } catch (err) {
      toast({ title: errorText(t, err), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(path: string, reload: () => void) {
    try {
      await api(path, { method: 'POST' });
      toast({ title: t('platform.api.revoked'), tone: 'success' });
      reload();
    } catch (err) {
      toast({ title: errorText(t, err), tone: 'danger' });
    }
  }

  async function rotate(c: OAuthClient) {
    try {
      const r = await api<OAuthClient & { clientSecret: string }>(
        `/v1/settings/oauth-clients/${c.id}/rotate-secret`,
        { method: 'POST', json: { graceHours: 24 } },
      );
      setSecret({
        title: t('platform.api.secretRotated'),
        items: [{ label: t('platform.api.clientSecret'), value: r.clientSecret }],
      });
      clients.reload();
    } catch (err) {
      toast({ title: errorText(t, err), tone: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('platform.api.title')} lead={t('platform.api.lead')} />
      <p className="text-callout">
        <Link href="/developers">{t('platform.api.docsLink')}</Link>
      </p>

      {secret ? (
        <SecretOnce title={secret.title} items={secret.items} onDone={() => setSecret(null)} />
      ) : null}

      <Card>
        <CardTitle as={sec.heading}>{t('platform.api.createTitle')}</CardTitle>
        <form onSubmit={create} className="mt-4 flex flex-col gap-4">
          <fieldset className="flex flex-wrap gap-4">
            <legend className="mb-2 text-callout font-semibold">{t('platform.api.kind')}</legend>
            {(['key', 'oauth'] as const).map((k) => (
              <label key={k} className="flex items-center gap-2 text-callout">
                <input
                  type="radio"
                  name="kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                  className="h-5 w-5 accent-[var(--color-accent)]"
                />
                {t(`platform.api.kind_${k}`)}
              </label>
            ))}
          </fieldset>
          <div className="grid gap-4 md:grid-cols-2">
            <Field id="cred-name" label={t('platform.api.name')} hint={t('platform.api.nameHint')}>
              {(p) => (
                <Input
                  {...p}
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <Field id="cred-role" label={t('platform.api.role')} hint={t('platform.api.roleHint')}>
              {(p) => (
                <select
                  {...p}
                  value={roleKey}
                  onChange={(e) => setRoleKey(e.target.value)}
                  className="h-10 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout"
                >
                  {(
                    roles.data ?? [
                      { id: 'hr_admin', key: 'hr_admin', name: t('roles.hr_admin'), builtIn: true },
                    ]
                  ).map((r) => (
                    <option key={r.id} value={r.key}>
                      {r.builtIn ? t(`roles.${r.key}`) : r.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-callout font-semibold">{t('platform.api.scopes')}</legend>
            <p className="mb-3 text-footnote text-text-secondary">{t('platform.api.scopesHint')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {API_SCOPE_KEYS.map((s) => (
                <label key={s} className="flex items-start gap-2 text-callout">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-5 w-5 accent-[var(--color-accent)]"
                    checked={scopes.includes(s)}
                    onChange={(e) =>
                      setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))
                    }
                  />
                  <span>
                    <code className="text-footnote">{s}</code> {t(scopeLabel(s))}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <Button type="submit" loading={busy} disabled={!scopes.length || !name.trim()}>
              {t(kind === 'key' ? 'platform.api.createKey' : 'platform.api.createClient')}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardTitle as={sec.heading}>{t('platform.api.keysTitle')}</CardTitle>
        <div className="mt-4">
          {keys.data && keys.data.data.length === 0 ? (
            <EmptyState level={sec.level} icon={<KeyRound aria-hidden />} title={t('platform.api.noKeys')} />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>{t('platform.api.name')}</TH>
                  <TH>{t('platform.api.identifier')}</TH>
                  <TH>{t('platform.api.scopes')}</TH>
                  <TH>{t('platform.api.lastUsed')}</TH>
                  <TH>{t('common.status')}</TH>
                  <TH>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TH>
                </tr>
              </THead>
              <tbody>
                {(keys.data?.data ?? []).map((k) => (
                  <TR key={k.id}>
                    <TD>{k.name}</TD>
                    <TD>
                      <code className="text-footnote">{`thr_sk_…${k.prefix}`}</code>
                    </TD>
                    <TD className="text-footnote">{k.scopes.join(', ')}</TD>
                    <TD className="text-footnote">{when(k.lastUsedAt)}</TD>
                    <TD>
                      <StatusBadge status={k.revokedAt ? 'revoked' : 'active'} />
                    </TD>
                    <TD>
                      {!k.revokedAt ? (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => revoke(`/v1/settings/api-keys/${k.id}/revoke`, keys.reload)}
                          aria-label={t('platform.api.revokeNamed', { name: k.name })}
                        >
                          {t('platform.api.revoke')}
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle as={sec.heading}>{t('platform.api.clientsTitle')}</CardTitle>
        <p className="mt-2 text-footnote text-text-secondary">{t('platform.api.clientsBody')}</p>
        <div className="mt-4">
          {clients.data && clients.data.data.length === 0 ? (
            <EmptyState
              level={sec.level}
              icon={<KeyRound aria-hidden />}
              title={t('platform.api.noClients')}
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>{t('platform.api.name')}</TH>
                  <TH>{t('platform.api.clientId')}</TH>
                  <TH>{t('platform.api.scopes')}</TH>
                  <TH>{t('platform.api.lastUsed')}</TH>
                  <TH>{t('common.status')}</TH>
                  <TH>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TH>
                </tr>
              </THead>
              <tbody>
                {(clients.data?.data ?? []).map((c) => (
                  <TR key={c.id}>
                    <TD>{c.name}</TD>
                    <TD>
                      <code className="break-all text-footnote">{c.clientId}</code>
                    </TD>
                    <TD className="text-footnote">{c.scopes.join(', ')}</TD>
                    <TD className="text-footnote">{when(c.lastUsedAt)}</TD>
                    <TD>
                      <StatusBadge status={c.revokedAt ? 'revoked' : 'active'} />
                    </TD>
                    <TD className="flex flex-wrap gap-2">
                      {!c.revokedAt ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => rotate(c)}
                            aria-label={t('platform.api.rotateNamed', { name: c.name })}
                          >
                            {t('platform.api.rotate')}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() =>
                              revoke(`/v1/settings/oauth-clients/${c.id}/revoke`, clients.reload)
                            }
                            aria-label={t('platform.api.revokeNamed', { name: c.name })}
                          >
                            {t('platform.api.revoke')}
                          </Button>
                        </>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Card>
    </div>
  );
}
