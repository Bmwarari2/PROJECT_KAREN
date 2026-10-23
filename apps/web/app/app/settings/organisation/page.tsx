'use client';
import * as React from 'react';
import { Button, Card, CardTitle, Field, Input, Table, TD, TH, THead, TR, useToast } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';

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

function Section({ kind }: { kind: Kind }) {
  const t = useT();
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
  return (
    <Card className="flex flex-col gap-4">
      <CardTitle>{t(`orgSettings.${kind}`)}</CardTitle>
      <form onSubmit={add} className="grid gap-3 sm:grid-cols-5 sm:items-end">
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
        <Button type="submit">{t('common.add')}</Button>
      </form>
      {data?.length ? (
        <Table dense scrollLabel={t(`orgSettings.${kind}`)}>
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
                {FIELDS[kind].map((f) => (
                  <TD key={f.key}>{r[f.key]}</TD>
                ))}
              </TR>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Card>
  );
}

export default function OrganisationSettingsPage() {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title-2">{t('orgSettings.title')}</h1>
      <Section kind="legal-entities" />
      <Section kind="departments" />
      <Section kind="locations" />
    </div>
  );
}
