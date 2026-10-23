'use client';
import * as React from 'react';
import { FlaskConical } from 'lucide-react';
import { Button, Card, CardTitle, EmptyState, Field, Input, useToast } from '@thapsus/ui';
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
import { useFeature, useExperience } from '../../shell';
import { useSectionLevel } from '@/components/module-page';

interface Sandbox {
  id: string;
  slug: string;
  name: string;
  syntheticPeople: number;
  status: 'creating' | 'ready' | 'failed';
  report: { copied: Record<string, number>; syntheticPeople: number } | null;
  error: string | null;
  createdAt: string;
  readyAt: string | null;
}

export default function SandboxPage() {
  const t = useT();
  const sec = useSectionLevel();
  const toast = useToast();
  const when = useDateTime();
  const enabled = useFeature('sandboxes');
  const { experience } = useExperience();
  const isSandbox = experience?.kind === 'sandbox';
  const list = useApi<Sandbox[]>(enabled && !isSandbox ? '/v1/sandboxes' : null);
  const [people, setPeople] = React.useState(25);
  const [busy, setBusy] = React.useState(false);
  const [link, setLink] = React.useState<{ url: string; email: string } | null>(null);
  const creating = list.data?.some((s) => s.status === 'creating');
  const { reload } = list;
  React.useEffect(() => {
    if (!creating) return;
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
  }, [creating, reload]);

  if (!enabled || isSandbox)
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('platform.sandbox.title')} />
        <FeatureOff />
      </div>
    );

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/v1/sandboxes', { method: 'POST', json: { syntheticPeople: people } });
      toast({ title: t('platform.sandbox.queued'), tone: 'success' });
      list.reload();
    } catch (err) {
      toast({ title: errorText(t, err), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }
  async function signIn(s: Sandbox) {
    try {
      const r = await api<{ url: string; email: string }>(`/v1/sandboxes/${s.id}/sign-in-link`, {
        method: 'POST',
      });
      setLink(r);
    } catch (err) {
      toast({ title: errorText(t, err), tone: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('platform.sandbox.title')} lead={t('platform.sandbox.lead')} />
      <Card>
        <CardTitle as={sec.heading}>{t('platform.sandbox.whatTitle')}</CardTitle>
        <ul className="mt-3 list-disc pl-5 text-callout text-text-secondary">
          <li>{t('platform.sandbox.copied')}</li>
          <li>{t('platform.sandbox.notCopied')}</li>
          <li>{t('platform.sandbox.synthetic')}</li>
          <li>{t('platform.sandbox.region')}</li>
        </ul>
        <form onSubmit={create} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field id="sb-people" label={t('platform.sandbox.people')} hint={t('platform.sandbox.peopleHint')}>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                max={200}
                required
                value={people}
                onChange={(e) => setPeople(Number(e.target.value))}
                className="w-32"
              />
            )}
          </Field>
          <Button type="submit" loading={busy}>
            {t('platform.sandbox.create')}
          </Button>
        </form>
      </Card>
      {link ? (
        <div className="flex flex-col gap-2">
          <SecretOnce
            title={t('platform.sandbox.linkTitle')}
            items={[
              { label: t('platform.sandbox.linkLabel'), value: link.url },
              { label: t('platform.sandbox.ownerLabel'), value: link.email },
            ]}
            onDone={() => setLink(null)}
          />
          <p className="text-footnote text-text-secondary">{t('platform.sandbox.linkNote')}</p>
        </div>
      ) : null}
      {list.data && !list.data.length ? (
        <EmptyState
          level={sec.level}
          icon={<FlaskConical aria-hidden />}
          title={t('platform.sandbox.none')}
        />
      ) : null}
      {(list.data ?? []).map((s) => (
        <Card key={s.id}>
          <div className="flex flex-wrap items-start gap-3">
            <div className="mr-auto">
              <CardTitle as={sec.heading}>{s.name}</CardTitle>
              <p className="mt-1 text-footnote text-text-secondary">
                {t('platform.sandbox.meta', {
                  slug: s.slug,
                  people: s.report?.syntheticPeople ?? s.syntheticPeople,
                  count: s.report?.syntheticPeople ?? s.syntheticPeople,
                  created: when(s.createdAt),
                })}
              </p>
              {s.error ? <p className="mt-1 text-footnote text-danger">{s.error}</p> : null}
            </div>
            <StatusBadge status={s.status} />
          </div>
          {s.status === 'ready' ? (
            <div className="mt-4">
              <Button size="sm" variant="secondary" onClick={() => signIn(s)}>
                {t('platform.sandbox.signIn')}
              </Button>
            </div>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
