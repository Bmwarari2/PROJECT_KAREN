'use client';
import * as React from 'react';
import { Button, Card, colors, Field, Input, Skeleton, useToast, PageSection } from '@thapsus/ui';
import { api, apiFetch, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { errorText, FeatureOff, PageHeader } from '@/components/platform';
import { DetailList } from '@/components/detail-list';
import { useCan, useExperience, useFeature } from '../../shell';
import { ReadOnlyNote } from '../kit';
import { useSectionLevel } from '@/components/module-page';

interface Palette {
  accent: string;
  accentHover: string;
  onAccent: string;
  accentSubtle: string;
}
interface Branding {
  accentLight: string | null;
  accentDark: string | null;
  palette: { light: Palette; dark: Palette } | null;
  logo: { url: string; contentType: string; bytes: number; updatedAt: string } | null;
}
interface Failure {
  mode: 'light' | 'dark';
  pair: string;
  ratio: number;
  required: number;
}
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Preview swatch: the customer's validated colours shown on the token surfaces of one mode. */
function Preview({ mode, p }: { mode: 'light' | 'dark'; p: Palette }) {
  const t = useT();
  return (
    <div
      className="rounded-lg border border-border bg-bg p-4 text-text"
      style={{
        // token surfaces of the previewed mode, plus the validated brand palette
        ['--color-bg' as string]: colors.bg[mode],
        ['--color-text' as string]: colors.text[mode],
        ['--color-border' as string]: colors.border[mode],
        ['--color-accent' as string]: p.accent,
        ['--color-accent-hover' as string]: p.accentHover,
        ['--color-on-accent' as string]: p.onAccent,
        ['--color-accent-subtle' as string]: p.accentSubtle,
      }}
    >
      <p className="text-footnote font-semibold">{t(`platform.branding.preview_${mode}`)}</p>
      <p className="mt-2 text-callout">
        <span className="text-accent underline">{t('platform.branding.sampleLink')}</span>
      </p>
      <span className="mt-3 inline-flex h-8 items-center rounded-pill bg-accent px-3 text-callout font-semibold text-on-accent">
        {t('platform.branding.sampleButton')}
      </span>
      <p className="mt-3 rounded-sm bg-accent-subtle px-2 py-1 text-footnote">
        {t('platform.branding.sampleSelected')}
      </p>
    </div>
  );
}

export default function BrandingPage() {
  const t = useT();
  const sec = useSectionLevel();
  const toast = useToast();
  const enabled = useFeature('customBranding');
  // an HR admin may look (settings.read) but only workspace settings admins change it (ADR-0188)
  const can = useCan();
  const canManage = can('settings.branding.manage');
  const { reload } = useExperience();
  const branding = useApi<Branding>(enabled ? '/v1/settings/branding' : null);
  const [light, setLight] = React.useState('');
  const [dark, setDark] = React.useState('');
  const [separateDark, setSeparateDark] = React.useState(false);
  const [failures, setFailures] = React.useState<Failure[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const initialised = React.useRef(false);
  React.useEffect(() => {
    // Fill the form from the saved branding once; never overwrite what the admin is typing.
    if (!branding.data || initialised.current) return;
    initialised.current = true;
    setLight(branding.data.accentLight ?? '');
    setDark(branding.data.accentDark ?? '');
    setSeparateDark(!!branding.data.accentDark);
  }, [branding.data]);

  if (!enabled)
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('platform.branding.title')} />
        <FeatureOff />
      </div>
    );

  async function save(e: React.FormEvent | null, reset = false) {
    e?.preventDefault();
    setBusy(true);
    setFailures(null);
    try {
      const next = await api<Branding>('/v1/settings/branding', {
        method: 'PUT',
        json: reset
          ? { accentLight: null }
          : { accentLight: light, accentDark: separateDark && dark ? dark : null },
        capability: 'settings.branding.manage',
      });
      branding.setData(next);
      reload();
      toast({ title: t(reset ? 'platform.branding.resetDone' : 'platform.branding.saved'), tone: 'success' });
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 422 && Array.isArray(err.body.failures))
        setFailures(err.body.failures as Failure[]);
      else toast({ title: errorText(t, err), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const body = new FormData();
    body.append('file', file);
    const res = await apiFetch('/v1/settings/branding/logo', {
      method: 'POST',
      body,
      capability: 'settings.branding.manage',
    });
    if (res.ok) {
      branding.setData(await res.json());
      reload();
      toast({ title: t('platform.branding.logoSaved'), tone: 'success' });
    } else {
      toast({
        title: t(res.status === 400 ? 'platform.branding.logoInvalid' : 'common.error'),
        tone: 'danger',
      });
    }
  }
  async function removeLogo() {
    branding.setData(
      await api<Branding>('/v1/settings/branding/logo', {
        method: 'DELETE',
        capability: 'settings.branding.manage',
      }),
    );
    reload();
  }

  const valid = HEX.test(light) && (!separateDark || !dark || HEX.test(dark));
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('platform.branding.title')} lead={t('platform.branding.lead')} />
      <PageSection
        headingLevel={sec.level}
        title={t('platform.branding.accentTitle')}
        description={t('platform.branding.accentBody')}
      >
        <Card>
          {!branding.data ? <Skeleton className="h-24" /> : null}
          {branding.data && !canManage ? (
            <div className="flex flex-col gap-4">
              <ReadOnlyNote />
              <DetailList
                items={[
                  {
                    key: 'light',
                    label: t('platform.branding.accentLight'),
                    value: branding.data.accentLight ?? t('visibility.branding.defaultAccent'),
                  },
                  {
                    key: 'dark',
                    label: t('platform.branding.accentDark'),
                    value:
                      branding.data.accentDark ??
                      (branding.data.accentLight
                        ? t('visibility.branding.sameAsLight')
                        : t('visibility.branding.defaultAccent')),
                  },
                ]}
              />
            </div>
          ) : null}
          <form
            onSubmit={save}
            className={branding.data && canManage ? 'mt-4 flex flex-col gap-4' : 'hidden'}
            noValidate
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                id="accent-light"
                label={t('platform.branding.accentLight')}
                hint={t('platform.branding.hexHint')}
              >
                {(p) => (
                  <Input
                    {...p}
                    value={light}
                    onChange={(e) => setLight(e.target.value.trim())}
                    maxLength={7}
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
              </Field>
              {separateDark ? (
                <Field
                  id="accent-dark"
                  label={t('platform.branding.accentDark')}
                  hint={t('platform.branding.hexHint')}
                >
                  {(p) => (
                    <Input
                      {...p}
                      value={dark}
                      onChange={(e) => setDark(e.target.value.trim())}
                      maxLength={7}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  )}
                </Field>
              ) : null}
            </div>
            <label className="flex items-center gap-2 text-callout">
              <input
                type="checkbox"
                className="h-5 w-5 accent-[var(--color-accent)]"
                checked={separateDark}
                onChange={(e) => setSeparateDark(e.target.checked)}
              />
              {t('platform.branding.separateDark')}
            </label>
            {failures ? (
              <div role="alert" className="rounded-md border border-danger p-3">
                <p className="text-callout font-semibold text-danger">{t('platform.branding.rejected')}</p>
                <ul className="mt-2 list-disc pl-5 text-footnote">
                  {failures.map((f) => (
                    <li key={`${f.mode}-${f.pair}`}>
                      {t('platform.branding.failure', {
                        mode: t(`platform.branding.mode_${f.mode}`),
                        pair: f.pair,
                        ratio: f.ratio.toFixed(2),
                        required: f.required,
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={busy} disabled={!valid}>
                {t('platform.branding.save')}
              </Button>
              {branding.data?.accentLight ? (
                <Button type="button" variant="secondary" onClick={() => save(null, true)}>
                  {t('platform.branding.reset')}
                </Button>
              ) : null}
            </div>
          </form>
          {branding.data?.palette ? (
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <Preview mode="light" p={branding.data.palette.light} />
              <Preview mode="dark" p={branding.data.palette.dark} />
            </div>
          ) : null}
        </Card>
      </PageSection>

      <PageSection
        headingLevel={sec.level}
        title={t('platform.branding.logoTitle')}
        description={t('platform.branding.logoBody')}
      >
        <Card>
          {branding.data?.logo ? (
            <div className="mt-4 flex items-center gap-4">
              <img
                src={branding.data.logo.url}
                alt={t('platform.branding.logoAlt')}
                className="h-12 max-w-[200px] object-contain"
              />
              {canManage ? (
                <Button size="sm" variant="secondary" onClick={removeLogo}>
                  {t('platform.branding.removeLogo')}
                </Button>
              ) : null}
            </div>
          ) : !canManage ? (
            <p className="text-callout text-text-secondary">{t('visibility.branding.noLogo')}</p>
          ) : null}
          {canManage ? (
            <form onSubmit={upload} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field
                id="logo-file"
                label={t('platform.branding.logoFile')}
                hint={t('platform.branding.logoHint')}
              >
                {(p) => (
                  <input
                    {...p}
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="text-callout"
                  />
                )}
              </Field>
              <Button type="submit" variant="secondary">
                {t('platform.branding.upload')}
              </Button>
            </form>
          ) : null}
        </Card>
      </PageSection>
    </div>
  );
}
