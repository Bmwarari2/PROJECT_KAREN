'use client';
import * as React from 'react';
import Link from 'next/link';
import { Globe } from 'lucide-react';
import { Badge, Button, Card, CardTitle, EmptyState, Field, Input, Table, TD, TH, THead, TR, useToast } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { hasPermission, useSession } from '../shell';
import { PlatformSettingsLinks } from './platform-links';

interface Domain {
  id: string;
  domain: string;
  txtName: string;
  txtValue: string;
  verifiedAt: string | null;
}

export default function SettingsPage() {
  const t = useT();
  const toast = useToast();
  const session = useSession();
  const canSettings = hasPermission(session, 'settings.read');
  const [domains, setDomains] = React.useState<Domain[] | null>(null);
  const [domain, setDomain] = React.useState('');
  const load = React.useCallback(() => api<Domain[]>('/v1/settings/domains').then(setDomains).catch(() => setDomains([])), []);
  React.useEffect(() => {
    if (canSettings) void load();
  }, [load, canSettings]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/v1/settings/domains', { method: 'POST', json: { domain: domain.trim().toLowerCase() } });
      setDomain('');
      await load();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    }
  }
  async function verify(id: string) {
    try {
      await api(`/v1/settings/domains/${id}/verify`, { method: 'POST' });
      toast({ title: t('app.settings.domainVerified'), tone: 'success' });
      await load();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title-2">{t('app.settings.title')}</h1>
      <nav aria-label={t('app.settings.title')} className="flex flex-wrap gap-x-6 gap-y-2">
        {canSettings ? (
          <Link href="/app/settings/organisation" className="text-callout">
            {t('app.settings.organisationLink')}
          </Link>
        ) : null}
        {hasPermission(session, 'roles.read') ? (
          <>
            <Link href="/app/settings/roles" className="text-callout">
              {t('app.settings.rolesLink')}
            </Link>
            <Link href="/app/settings/users" className="text-callout">
              {t('app.settings.usersLink')}
            </Link>
          </>
        ) : null}
      </nav>
      <PlatformSettingsLinks />
      {/* Workspace settings need settings.read; a role-management-only role sees just the links above. */}
      <Card hidden={!canSettings}>
        <CardTitle>{t('app.settings.domainsTitle')}</CardTitle>
        <p className="mt-2 text-callout text-text-secondary">{t('app.settings.domainsBody')}</p>
        <form onSubmit={add} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field id="domain" label={t('app.settings.domainLabel')} className="flex-1">
            {(p) => <Input {...p} required value={domain} onChange={(e) => setDomain(e.target.value)} />}
          </Field>
          <Button type="submit">{t('common.add')}</Button>
        </form>
        <div className="mt-6">
          {domains && domains.length === 0 ? (
            <EmptyState icon={<Globe aria-hidden />} title={t('app.settings.noDomains')} />
          ) : (
            <Table>
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
                {(domains ?? []).map((d) => (
                  <TR key={d.id}>
                    <TD>{d.domain}</TD>
                    <TD className="break-all text-footnote text-text-secondary">
                      {d.txtName} → {d.txtValue}
                    </TD>
                    <TD>{d.verifiedAt ? <Badge tone="success">{t('app.settings.verified')}</Badge> : <Badge tone="warning">{t('app.settings.pending')}</Badge>}</TD>
                    <TD>
                      {!d.verifiedAt ? (
                        <Button size="sm" variant="secondary" onClick={() => verify(d.id)}>
                          {t('app.settings.verify')}
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
    </div>
  );
}
