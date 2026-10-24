'use client';
import * as React from 'react';
import { Button, Card, Field, Input, PageSection, Table, TD, TH, THead, TR, useToast } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useSectionLevel } from '@/components/module-page';
import { PageTitle } from '../../shell';

type Kind = 'legal-entities' | 'departments' | 'locations';
const FIELDS: Record<Kind, Array<{ key: string; type?: string; placeholder?: string }>> = {
  'legal-entities': [
    { key: 'name' },
    { key: 'country', placeholder: 'GB' },
    { key: 'currency', placeholder: 'GBP' },
    { key: 'timeZone', placeholder: 'Europe/London' },
  ],
  departments: [{ key: 'name' }, { key: 'code' }],
  locations: [
    { key: 'name' },
    { key: 'country', placeholder: 'GB' },
    { key: 'regionCode', placeholder: 'GB-ENG' },
    { key: 'timeZone', placeholder: 'Europe/London' },
  ],
};

function OrgSection({ kind }: { kind: Kind }) {
  const t = useT();
  const sec = useSectionLevel();
  const toast = useToast();
  const { data, reload } = useApi<Array<Record<string, string>>>(`/v1/org/${kind}`);
  const [v, setV] = React.useState<Record<string, string>>({});
  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/v1/org/${kind}`, {
        method: 'POST',
        json: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '')),
      });
      setV({});
      reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    }
  }
  const [first, ...rest] = FIELDS[kind];
  return (
    <PageSection headingLevel={sec.level} title={t(`orgSettings.${kind}`)} className="gap-3">
      {data?.length ? (
        <Table dense scrollLabel={t('admin.tableScroll', { name: t(`orgSettings.${kind}`) })}>
          <THead>
            <tr>
              {FIELDS[kind].map((f) => (
                <TH key={f.key}>{t(`orgSettings.field.${f.key}`)}</TH>
              ))}
            </tr>
          </THead>
          <tbody>
            {data.map((r) => (
              <TR key={r.id}>
                <TD className="font-semibold">{r[first!.key]}</TD>
                {rest.map((f) => (
                  <TD key={f.key} phone="inline" label={t(`orgSettings.field.${f.key}`)}>
                    {r[f.key]}
                  </TD>
                ))}
              </TR>
            ))}
          </tbody>
        </Table>
      ) : null}
      <Card>
        <form onSubmit={add} className="flex flex-col gap-4">
          <sec.sub className="text-callout font-semibold">{t(`orgSettings.add.${kind}`)}</sec.sub>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {FIELDS[kind].map((f) => (
              <Field key={f.key} id={`${kind}-${f.key}`} label={t(`orgSettings.field.${f.key}`)}>
                {(p) => (
                  <Input
                    {...p}
                    required={
                      f.key === 'name' || f.key === 'country' || f.key === 'currency' || f.key === 'timeZone'
                    }
                    placeholder={f.placeholder}
                    value={v[f.key] ?? ''}
                    onChange={(e) => setV((x) => ({ ...x, [f.key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
          <Button type="submit" className="self-start">
            {t('common.add')}
          </Button>
        </form>
      </Card>
    </PageSection>
  );
}

export default function OrganisationSettingsPage() {
  const t = useT();
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <PageTitle>{t('admin.section.organisation.title')}</PageTitle>
        <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">
          {t('admin.section.organisation.body')}
        </p>
      </div>
      <OrgSection kind="legal-entities" />
      <OrgSection kind="departments" />
      <OrgSection kind="locations" />
    </div>
  );
}
