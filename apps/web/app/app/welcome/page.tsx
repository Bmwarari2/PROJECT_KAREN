'use client';
import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle, FileSignature, ListChecks, UserRound } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  Field,
  Input,
  ListItem,
  ListSection,
  Skeleton,
  useToast,
  PageSection,
} from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useInModule, useSectionLevel } from '@/components/module-page';
import { PageTitle, useSession } from '../shell';

interface Onboarding {
  employee: {
    id: string;
    displayName: string;
    jobTitle: string | null;
    department: string | null;
    location: string | null;
    manager: string | null;
    company: string;
    startDate: string;
    status: string;
    daysUntilStart: number;
  };
  formsEffectiveDate: string;
  documents: Array<{
    id: string;
    documentId: string;
    title: string;
    status: string;
    signedAt: string | null;
  }>;
  forms: {
    personalDetails: {
      complete: boolean;
      values: Record<string, unknown> & { address?: Record<string, string> | null };
    };
    emergencyContacts: {
      complete: boolean;
      contacts: Array<{ name: string; relationship: string | null; phone: string | null }>;
    };
  };
  tasks: Array<{ id: string; title: string; dueOn: string | null; status: string }>;
  progress: { done: number; total: number };
}

const PERSONAL = ['preferredName', 'pronouns', 'personalEmail', 'personalPhone'] as const;
const ADDRESS = ['line1', 'city', 'postcode', 'country'] as const;
const ADDRESS_LABEL: Record<(typeof ADDRESS)[number], string> = {
  line1: 'onboarding.addressLine1',
  city: 'onboarding.addressCity',
  postcode: 'onboarding.addressPostcode',
  country: 'onboarding.addressCountry',
};

function StatusBadge({ complete }: { complete: boolean }) {
  const t = useT();
  return (
    <Badge tone={complete ? 'success' : 'neutral'}>
      {complete ? t('onboarding.complete') : t('onboarding.toDo')}
    </Badge>
  );
}

/** Pre-start portal: what a new joiner can do before (and in the first days after) their start date. */
export default function WelcomePage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const inModule = useInModule();
  const sec = useSectionLevel();
  const { data, error, reload } = useApi<Onboarding>(session?.employeeId ? '/v1/me/onboarding' : null);
  const [personal, setPersonal] = React.useState<Record<string, string>>({});
  const [address, setAddress] = React.useState<Record<string, string>>({});
  const [contact, setContact] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);

  // a link to one step (/app/welcome#task-<id>, ADR-0160) scrolls to it once the checklist has loaded
  React.useEffect(() => {
    if (!data) return;
    const id = window.location.hash.slice(1);
    if (/^task-[0-9a-f-]{36}$/.test(id)) document.getElementById(id)?.scrollIntoView({ block: 'center' });
  }, [data]);

  React.useEffect(() => {
    if (!data) return;
    const v = data.forms.personalDetails.values;
    setPersonal(
      Object.fromEntries(PERSONAL.map((f) => [f, typeof v[f] === 'string' ? (v[f] as string) : ''])),
    );
    setAddress(Object.fromEntries(ADDRESS.map((f) => [f, v.address?.[f] ?? ''])));
    const c = data.forms.emergencyContacts.contacts[0];
    setContact({ name: c?.name ?? '', relationship: c?.relationship ?? '', phone: c?.phone ?? '' });
  }, [data]);

  if (session && !session.employeeId)
    return (
      <EmptyState
        level={inModule ? 2 : 1}
        icon={<UserRound aria-hidden />}
        title={t('onboarding.notLinked')}
      />
    );
  if (error)
    return (
      <EmptyState
        level={inModule ? 2 : 1}
        icon={<UserRound aria-hidden />}
        title={error.status === 404 ? t('onboarding.notLinked') : t('common.error')}
      />
    );
  if (!data) return <Skeleton className="h-96 w-full" />;

  const e = data.employee;
  const firstName = e.displayName.split(' ')[0] ?? e.displayName;
  const pre = e.status === 'pre_start';

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try {
      await fn();
      toast({ title: t('onboarding.saved'), tone: 'success' });
      reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  const savePersonal = (ev: React.FormEvent) => {
    ev.preventDefault();
    const body: Record<string, unknown> = { effectiveDate: data.formsEffectiveDate };
    for (const f of PERSONAL) if (personal[f]) body[f] = personal[f];
    if (ADDRESS.some((f) => address[f]))
      body.address = Object.fromEntries(ADDRESS.filter((f) => address[f]).map((f) => [f, address[f]]));
    void run('personal', () => api(`/v1/employees/${e.id}/changes`, { method: 'POST', json: body }));
  };
  const saveContact = (ev: React.FormEvent) => {
    ev.preventDefault();
    const c = {
      name: contact.name,
      relationship: contact.relationship || null,
      phone: contact.phone || null,
    };
    void run('contact', () =>
      api(`/v1/employees/${e.id}/emergency-contacts?effectiveDate=${data.formsEffectiveDate}`, {
        method: 'PUT',
        json: [c],
      }),
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <PageTitle>{t('onboarding.heading', { company: e.company, name: firstName })}</PageTitle>
        <p className="text-body text-text-secondary">
          {pre
            ? t('onboarding.startsOn', { date: formatDate(e.startDate, locale, 'long') })
            : t('onboarding.started', { date: formatDate(e.startDate, locale, 'long') })}{' '}
          {pre ? t('onboarding.daysToGo', { days: e.daysUntilStart }) : null}
        </p>
        <dl className="grid max-w-xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-callout">
          {e.jobTitle ? (
            <>
              <dt className="text-text-secondary">{t('onboarding.role')}</dt>
              <dd>{[e.jobTitle, e.department, e.location].filter(Boolean).join(' · ')}</dd>
            </>
          ) : null}
          {e.manager ? (
            <>
              <dt className="text-text-secondary">{t('onboarding.manager')}</dt>
              <dd>{e.manager}</dd>
            </>
          ) : null}
        </dl>
        <div className="flex max-w-xl flex-col gap-1.5">
          <label htmlFor="onboarding-progress" className="text-callout font-semibold">
            {t('onboarding.progressLabel')}
          </label>
          <progress
            id="onboarding-progress"
            max={data.progress.total || 1}
            value={data.progress.done}
            className="h-2 w-full accent-[var(--color-accent)]"
            aria-valuetext={t('onboarding.progress', { ...data.progress, count: data.progress.total })}
          />
          <p className="text-footnote text-text-secondary" role="status">
            {t('onboarding.progress', { ...data.progress, count: data.progress.total })}
          </p>
        </div>
      </header>

      <ListSection headingLevel={sec.level} title={t('onboarding.documentsTitle')} id="onboarding-documents">
        {data.documents.length ? (
          data.documents.map((d) => (
            <ListItem
              key={d.id}
              href={`/app/documents/${d.documentId}`}
              linkAs={Link}
              leading={<FileSignature />}
              title={d.title}
              subtitle={
                d.status === 'signed'
                  ? t('onboarding.signedOn', { date: formatDate((d.signedAt ?? '').slice(0, 10), locale) })
                  : undefined
              }
              meta={d.status === 'signed' ? undefined : <Badge tone="accent">{t('documents.sign')}</Badge>}
            />
          ))
        ) : (
          <ListItem leading={<FileSignature />} title={t('onboarding.documentsEmpty')} />
        )}
      </ListSection>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex items-start gap-3">
            <CardTitle as={sec.heading} className="mr-auto">
              {t('onboarding.personalTitle')}
            </CardTitle>
            <StatusBadge complete={data.forms.personalDetails.complete} />
          </div>
          <p className="mt-1 text-callout text-text-secondary">{t('onboarding.personalBody')}</p>
          <form onSubmit={savePersonal} className="mt-4 flex flex-col gap-4">
            {PERSONAL.map((f) => (
              <Field key={f} id={`pd-${f}`} label={t(`people.field.${f}`)}>
                {(p) => (
                  <Input
                    {...p}
                    type={f === 'personalEmail' ? 'email' : f === 'personalPhone' ? 'tel' : 'text'}
                    autoComplete={f === 'personalEmail' ? 'email' : f === 'personalPhone' ? 'tel' : 'off'}
                    value={personal[f] ?? ''}
                    onChange={(ev) => setPersonal((v) => ({ ...v, [f]: ev.target.value }))}
                  />
                )}
              </Field>
            ))}
            {ADDRESS.map((f) => (
              <Field key={f} id={`pd-address-${f}`} label={t(ADDRESS_LABEL[f])}>
                {(p) => (
                  <Input
                    {...p}
                    autoComplete={
                      f === 'line1'
                        ? 'address-line1'
                        : f === 'city'
                          ? 'address-level2'
                          : f === 'postcode'
                            ? 'postal-code'
                            : 'country'
                    }
                    maxLength={f === 'country' ? 2 : 120}
                    value={address[f] ?? ''}
                    onChange={(ev) => setAddress((v) => ({ ...v, [f]: ev.target.value }))}
                  />
                )}
              </Field>
            ))}
            <Button type="submit" className="self-start" loading={busy === 'personal'}>
              {t('common.save')}
            </Button>
          </form>
        </Card>

        <Card>
          <div className="flex items-start gap-3">
            <CardTitle as={sec.heading} className="mr-auto">
              {t('onboarding.contactsTitle')}
            </CardTitle>
            <StatusBadge complete={data.forms.emergencyContacts.complete} />
          </div>
          <p className="mt-1 text-callout text-text-secondary">{t('onboarding.contactsBody')}</p>
          <form onSubmit={saveContact} className="mt-4 flex flex-col gap-4">
            <Field id="ec-name" label={t('onboarding.contactName')}>
              {(p) => (
                <Input
                  {...p}
                  required
                  autoComplete="off"
                  value={contact.name ?? ''}
                  onChange={(ev) => setContact((v) => ({ ...v, name: ev.target.value }))}
                />
              )}
            </Field>
            <Field id="ec-relationship" label={t('onboarding.contactRelationship')}>
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  value={contact.relationship ?? ''}
                  onChange={(ev) => setContact((v) => ({ ...v, relationship: ev.target.value }))}
                />
              )}
            </Field>
            <Field id="ec-phone" label={t('onboarding.contactPhone')}>
              {(p) => (
                <Input
                  {...p}
                  type="tel"
                  autoComplete="off"
                  value={contact.phone ?? ''}
                  onChange={(ev) => setContact((v) => ({ ...v, phone: ev.target.value }))}
                />
              )}
            </Field>
            <Button type="submit" className="self-start" loading={busy === 'contact'}>
              {t('common.save')}
            </Button>
          </form>
        </Card>
      </div>

      {data.tasks.length ? (
        // a grouped list (ADR-0180); tasks and notifications link to a step as #task-<id>
        <ListSection
          id="onboarding-checklist"
          title={t('onboarding.checklistTitle')}
          headingLevel={sec.level}
        >
          {data.tasks.map((k) => (
            <ListItem
              key={k.id}
              leadingTile={false}
              leading={
                k.status === 'done' ? (
                  <CheckCircle2 aria-hidden className="h-6 w-6 stroke-[1.5] text-success" />
                ) : (
                  <Circle aria-hidden className="h-6 w-6 stroke-[1.5] text-text-secondary" />
                )
              }
              title={
                <span id={`task-${k.id}`} className="scroll-mt-24">
                  {k.title}
                </span>
              }
              subtitle={k.dueOn ? t('onboarding.due', { date: formatDate(k.dueOn, locale) }) : undefined}
              accessory={
                k.status === 'done' ? <Badge tone="success">{t('onboarding.done')}</Badge> : undefined
              }
              actions={
                k.status === 'done' ? undefined : (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="min-h-11 sm:min-h-8"
                    loading={busy === k.id}
                    aria-label={t('onboarding.markDone', { title: k.title })}
                    onClick={() =>
                      void run(k.id, () => api(`/v1/tasks/${k.id}/complete`, { method: 'POST' }))
                    }
                  >
                    {t('onboarding.markDoneShort')}
                  </Button>
                )
              }
            />
          ))}
        </ListSection>
      ) : (
        <PageSection headingLevel={sec.level} title={t('onboarding.checklistTitle')}>
          <Card>
            <EmptyState
              level={sec.level}
              icon={<ListChecks aria-hidden />}
              title={t('onboarding.checklistEmpty')}
            />
          </Card>
        </PageSection>
      )}
    </div>
  );
}
