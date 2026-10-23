'use client';
import * as React from 'react';
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
  Textarea,
  useToast,
} from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { useT } from '@/lib/i18n-client';
import { PageTitle, selectClass } from '../ui';

interface Catalogue {
  jurisdictions: Array<{
    code: string;
    name: string;
    parent: string | null;
    version: number;
    keys: string[];
  }>;
  keys: Array<{ key: string; description: string }>;
}
interface Version {
  effectiveFrom: string;
  effectiveTo: string | null;
  value: unknown;
  source: { url: string; title: string };
  verifiedOn: string;
  reviewer?: string;
  origin: 'pack' | 'backoffice';
}

/** Jurisdiction rule data: append-only back-office versions over the packs (existing rules API). */
export default function RulesAdmin() {
  const t = useT();
  const toast = useToast();
  const cat = useApi<Catalogue>('/v1/backoffice/rules/catalogue');
  const [j, setJ] = React.useState('GB');
  const [key, setKey] = React.useState('minimum_wage.rates');
  const versions = useApi<Version[]>(`/v1/backoffice/rules/${j}/${key}/versions`);
  const [f, setF] = React.useState({
    effectiveFrom: '',
    effectiveTo: '',
    value: '{}',
    url: '',
    title: '',
    verifiedOn: '',
    notes: '',
  });
  const [busy, setBusy] = React.useState(false);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    let value: unknown;
    try {
      value = JSON.parse(f.value);
    } catch {
      toast({ title: t('backoffice.rules.badJson'), tone: 'danger' });
      return;
    }
    setBusy(true);
    try {
      await api(`/v1/backoffice/rules/${j}/${key}/versions`, {
        method: 'POST',
        json: {
          effectiveFrom: f.effectiveFrom,
          effectiveTo: f.effectiveTo || null,
          value,
          source: { url: f.url, title: f.title },
          verifiedOn: f.verifiedOn,
          notes: f.notes || undefined,
        },
      });
      toast({ title: t('backoffice.rules.added'), tone: 'success' });
      versions.reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }
  const pack = cat.data?.jurisdictions.find((x) => x.code === j);
  return (
    <div className="flex flex-col gap-6">
      <PageTitle title={t('backoffice.rules.title')} lead={t('backoffice.rules.lead')} />
      <div className="flex flex-wrap gap-4">
        <Field id="r-j" label={t('backoffice.rules.jurisdiction')}>
          {(p) => (
            <select
              {...p}
              className={`${selectClass} w-auto`}
              value={j}
              onChange={(e) => setJ(e.target.value)}
            >
              {(cat.data?.jurisdictions ?? []).map((x) => (
                <option key={x.code} value={x.code}>
                  {x.code} — {x.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="r-k" label={t('backoffice.rules.key')}>
          {(p) => (
            <select
              {...p}
              className={`${selectClass} w-auto`}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            >
              {(cat.data?.keys ?? []).map((x) => (
                <option key={x.key} value={x.key}>
                  {x.key}
                  {pack && !pack.keys.includes(x.key) ? ` (${t('backoffice.rules.inherited')})` : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Table dense>
        <caption className="sr-only">{t('backoffice.rules.versions')}</caption>
        <THead>
          <tr>
            <TH>{t('backoffice.rules.effective')}</TH>
            <TH>{t('backoffice.rules.value')}</TH>
            <TH>{t('backoffice.rules.source')}</TH>
            <TH>{t('backoffice.rules.verified')}</TH>
            <TH>{t('backoffice.rules.origin')}</TH>
          </tr>
        </THead>
        <tbody>
          {(versions.data ?? []).map((v, i) => (
            <TR key={i}>
              <TD className="text-footnote">
                {v.effectiveFrom} – {v.effectiveTo ?? '…'}
              </TD>
              <TD className="max-w-[40ch] truncate font-mono text-footnote" title={JSON.stringify(v.value)}>
                {JSON.stringify(v.value)}
              </TD>
              <TD className="text-footnote">
                <a href={v.source.url} rel="noopener noreferrer" target="_blank">
                  {v.source.title}
                </a>
              </TD>
              <TD className="text-footnote">
                {v.verifiedOn}
                {v.reviewer ? ` · ${v.reviewer}` : ''}
              </TD>
              <TD>
                <Badge tone={v.origin === 'backoffice' ? 'accent' : 'neutral'}>
                  {t(`backoffice.rules.origins.${v.origin}`)}
                </Badge>
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
      <Card>
        <CardTitle>{t('backoffice.rules.addTitle')}</CardTitle>
        <p className="mt-1 text-callout text-text-secondary">{t('backoffice.rules.addLead')}</p>
        <form onSubmit={add} className="mt-4 grid gap-4 md:grid-cols-2">
          <Field id="r-from" label={t('backoffice.rules.from')}>
            {(p) => (
              <Input
                {...p}
                type="date"
                required
                value={f.effectiveFrom}
                onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })}
              />
            )}
          </Field>
          <Field id="r-to" label={t('backoffice.rules.to')}>
            {(p) => (
              <Input
                {...p}
                type="date"
                value={f.effectiveTo}
                onChange={(e) => setF({ ...f, effectiveTo: e.target.value })}
              />
            )}
          </Field>
          <Field id="r-value" label={t('backoffice.rules.valueJson')} className="md:col-span-2">
            {(p) => (
              <Textarea
                {...p}
                required
                className="font-mono"
                value={f.value}
                onChange={(e) => setF({ ...f, value: e.target.value })}
              />
            )}
          </Field>
          <Field id="r-url" label={t('backoffice.rules.sourceUrl')}>
            {(p) => (
              <Input
                {...p}
                type="url"
                required
                pattern="https://.*"
                value={f.url}
                onChange={(e) => setF({ ...f, url: e.target.value })}
              />
            )}
          </Field>
          <Field id="r-title" label={t('backoffice.rules.sourceTitle')}>
            {(p) => (
              <Input
                {...p}
                required
                minLength={3}
                value={f.title}
                onChange={(e) => setF({ ...f, title: e.target.value })}
              />
            )}
          </Field>
          <Field id="r-verified" label={t('backoffice.rules.verifiedOn')}>
            {(p) => (
              <Input
                {...p}
                type="date"
                required
                value={f.verifiedOn}
                onChange={(e) => setF({ ...f, verifiedOn: e.target.value })}
              />
            )}
          </Field>
          <Field id="r-notes" label={t('backoffice.rules.notes')}>
            {(p) => <Input {...p} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}
          </Field>
          <div className="md:col-span-2">
            <Button type="submit" loading={busy}>
              {t('backoffice.rules.add')}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
