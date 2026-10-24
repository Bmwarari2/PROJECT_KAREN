'use client';
import * as React from 'react';
import Link from 'next/link';
import { BellRing, FileSignature, Save, Send } from 'lucide-react';
import { Badge, Button, Card, Field, Input, Skeleton, Textarea, useToast, PageSection } from '@thapsus/ui';
import { formatDate } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { SELECT_CLASS } from '../types';

interface Dpa {
  template: string;
  currentVersion: string;
  acceptances: Array<{ version: string; acceptedByName: string | null; acceptedAt: string }>;
  reacceptanceRequired: boolean;
}
interface Subs {
  region: string;
  noticeDays: number;
  changes: Array<{ id: string; type: string; announced: string; effectiveFrom: string; change: string }>;
  subscribed: boolean;
}
interface Notice {
  template: 'uk' | 'eu' | 'us';
  templateVersion: string;
  title: string;
  body: string;
  tenantCopy: {
    title: string;
    body: string;
    status: string;
    publishedAt: string | null;
    outdated: boolean;
  } | null;
}

export default function LegalPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const dpa = useApi<Dpa>('/v1/privacy/dpa');
  const subs = useApi<Subs>('/v1/privacy/subprocessors');
  const notices = useApi<Notice[]>('/v1/privacy/notices');
  const [template, setTemplate] = React.useState<Notice['template']>('uk');
  const [draft, setDraft] = React.useState<{ title: string; body: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const current = notices.data?.find((n) => n.template === template);
  React.useEffect(() => {
    if (current)
      setDraft({
        title: current.tenantCopy?.title ?? current.title,
        body: current.tenantCopy?.body ?? current.body,
      });
  }, [current]);

  async function act(name: string, fn: () => Promise<unknown>, ok: string, reload: () => void) {
    setBusy(name);
    try {
      await fn();
      toast({ title: ok, tone: 'success' });
      reload();
    } catch (err) {
      toast({
        title:
          err instanceof ApiProblem
            ? err.status === 403
              ? t('privacy.ui.legal.ownerOnly')
              : ((err.body.detail as string) ?? err.title)
            : t('common.error'),
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageSection headingLevel={2} title={t('privacy.ui.legal.dpaTitle')}>
        <Card>
          {!dpa.data ? (
            <Skeleton className="mt-3 h-16" />
          ) : (
            <div className="mt-2 grid gap-3 text-callout">
              <p>
                {t('privacy.ui.legal.dpaCurrent', {
                  version: formatDate(dpa.data.currentVersion, locale),
                  template: t(`privacy.ui.legal.template.${dpa.data.template}`),
                })}{' '}
                <Badge tone="warning">{t('privacy.ui.retention.legalReview')}</Badge>
              </p>
              {dpa.data.acceptances.map((a) => (
                <p key={a.version} className="text-text-secondary">
                  {t('privacy.ui.legal.accepted', {
                    version: formatDate(a.version, locale),
                    name: a.acceptedByName ?? '—',
                    date: formatDate(a.acceptedAt.slice(0, 10), locale),
                  })}
                </p>
              ))}
              {dpa.data.reacceptanceRequired ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone="danger">{t('privacy.ui.legal.reaccept')}</Badge>
                  <Button
                    size="sm"
                    loading={busy === 'dpa'}
                    onClick={() =>
                      act(
                        'dpa',
                        () =>
                          api('/v1/privacy/dpa/accept', {
                            method: 'POST',
                            json: { version: dpa.data!.currentVersion },
                          }),
                        t('privacy.ui.legal.acceptedToast'),
                        dpa.reload,
                      )
                    }
                  >
                    <FileSignature aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    {t('privacy.ui.legal.accept')}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </Card>
      </PageSection>

      <PageSection headingLevel={2} title={t('privacy.ui.legal.subTitle')}>
        <Card>
          {!subs.data ? (
            <Skeleton className="mt-3 h-16" />
          ) : (
            <div className="mt-2 grid gap-3 text-callout">
              <p className="text-text-secondary">
                {t('privacy.ui.legal.subLead', {
                  days: subs.data.noticeDays,
                  count: subs.data.noticeDays,
                  region: t(`regions.${subs.data.region}`),
                })}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Link href={`/trust/subprocessors?region=${subs.data.region}`}>
                  {t('privacy.ui.legal.subList')}
                </Link>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'sub'}
                  onClick={() =>
                    act(
                      'sub',
                      () =>
                        api('/v1/privacy/subprocessors/subscription', {
                          method: 'PUT',
                          json: { subscribed: !subs.data!.subscribed },
                        }),
                      t(
                        subs.data!.subscribed
                          ? 'privacy.ui.legal.unsubscribed'
                          : 'privacy.ui.legal.subscribedToast',
                      ),
                      subs.reload,
                    )
                  }
                >
                  <BellRing aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t(subs.data.subscribed ? 'privacy.ui.legal.unsubscribe' : 'privacy.ui.legal.subscribe')}
                </Button>
              </div>
              <ul className="grid gap-1">
                {subs.data.changes.map((c) => (
                  <li key={c.id}>
                    {t('privacy.ui.legal.changeLine', {
                      date: formatDate(c.effectiveFrom, locale),
                      change: c.change,
                    })}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </PageSection>

      <PageSection
        headingLevel={2}
        title={t('privacy.ui.legal.noticesTitle')}
        description={t('privacy.ui.legal.noticesLead')}
      >
        <Card>
          {!notices.data || !draft ? (
            <Skeleton className="mt-3 h-40" />
          ) : (
            <form
              className="mt-4 grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                const publish = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'publish';
                void act(
                  'notice',
                  () =>
                    api(`/v1/privacy/notices/${template}`, { method: 'PUT', json: { ...draft, publish } }),
                  t(publish ? 'privacy.ui.legal.published' : 'privacy.ui.legal.savedDraft'),
                  notices.reload,
                );
              }}
            >
              <div className="grid gap-3 md:grid-cols-2">
                <Field id="notice-template" label={t('privacy.ui.legal.templateLabel')}>
                  {(p) => (
                    <select
                      {...p}
                      className={`${SELECT_CLASS} w-full`}
                      value={template}
                      onChange={(e) => setTemplate(e.target.value as Notice['template'])}
                    >
                      {notices.data!.map((n) => (
                        <option key={n.template} value={n.template}>
                          {t(`privacy.ui.legal.template.${n.template}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <div className="flex items-end gap-2 text-callout">
                  {current?.tenantCopy ? (
                    <Badge tone={current.tenantCopy.status === 'published' ? 'success' : 'neutral'}>
                      {t(`privacy.ui.legal.noticeStatus.${current.tenantCopy.status}`)}
                    </Badge>
                  ) : (
                    <Badge>{t('privacy.ui.legal.notStarted')}</Badge>
                  )}
                  {current?.tenantCopy?.outdated ? (
                    <Badge tone="warning">{t('privacy.ui.legal.outdated')}</Badge>
                  ) : null}
                </div>
              </div>
              <Field id="notice-title" label={t('privacy.ui.legal.noticeTitle')}>
                {(p) => (
                  <Input
                    {...p}
                    required
                    maxLength={200}
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  />
                )}
              </Field>
              <Field
                id="notice-body"
                label={t('privacy.ui.legal.noticeBody')}
                hint={t('privacy.ui.legal.noticeHint')}
              >
                {(p) => (
                  <Textarea
                    {...p}
                    rows={14}
                    required
                    className="font-mono text-footnote"
                    value={draft.body}
                    onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  />
                )}
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  name="action"
                  value="draft"
                  variant="secondary"
                  loading={busy === 'notice'}
                >
                  <Save aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('privacy.ui.legal.saveDraft')}
                </Button>
                <Button type="submit" name="action" value="publish" loading={busy === 'notice'}>
                  <Send aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('privacy.ui.legal.publish')}
                </Button>
              </div>
            </form>
          )}
        </Card>
      </PageSection>
    </div>
  );
}
