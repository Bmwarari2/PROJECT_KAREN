'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, cn, Field, Input } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';

const REGIONS = ['uk', 'eu', 'us'] as const;
type Region = (typeof REGIONS)[number];

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export function SignUpForm({ initialRegion, initialCompany, initialSlug }: { initialRegion?: string; initialCompany?: string; initialSlug?: string }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [region, setRegion] = React.useState<Region | null>(REGIONS.includes(initialRegion as Region) ? (initialRegion as Region) : null);
  const [company, setCompany] = React.useState(initialCompany ?? '');
  const [slug, setSlug] = React.useState(initialSlug ?? '');
  const [slugTouched, setSlugTouched] = React.useState(!!initialSlug);
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [dpa, setDpa] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!region) return;
    if (!dpa) {
      setError(t('auth.signUp.dpaRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/v1/signup', { method: 'POST', json: { companyName: company, slug, region, ownerName: name, ownerEmail: email, password, locale, acceptDpa: true } });
      router.push('/app/security?setup=1');
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'wrongRegion' && typeof err.body.appUrl === 'string') {
        const q = new URLSearchParams({ region, company, slug });
        window.location.assign(`${err.body.appUrl}/signup?${q}`);
        return;
      }
      setError(err instanceof ApiProblem ? (err.code === 'conflict' ? t('auth.signUp.slugTaken') : err.title) : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-title-2">{t('auth.signUp.title')}</h1>
      <p className="mt-2 text-callout text-text-secondary">{t('auth.signUp.lead')}</p>
      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-surface p-3 text-callout text-danger">
          {error}
        </p>
      ) : null}
      <form onSubmit={submit} className="mt-6 flex flex-col gap-5">
        <fieldset>
          <legend className="text-callout font-semibold">{t('auth.signUp.regionLabel')}</legend>
          <p className="mt-1 text-footnote text-text-secondary">{t('auth.signUp.regionHint')}</p>
          <div className="mt-3 grid gap-2">
            {REGIONS.map((r) => (
              <label
                key={r}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors duration-[var(--duration-fast)]',
                  region === r ? 'border-accent bg-accent-subtle' : 'border-border hover:bg-surface',
                )}
              >
                <input type="radio" name="region" value={r} checked={region === r} onChange={() => setRegion(r)} className="mt-1 accent-[var(--color-accent)]" required />
                <span>
                  <span className="block text-callout font-semibold">{t(`regions.${r}`)}</span>
                  <span className="block text-footnote text-text-secondary">{t(`auth.signUp.regionDetail.${r}`)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field id="company" label={t('auth.fields.company')}>
          {(p) => (
            <Input
              {...p}
              required
              minLength={2}
              autoComplete="organization"
              value={company}
              onChange={(e) => {
                setCompany(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
            />
          )}
        </Field>
        <Field id="slug" label={t('auth.fields.workspace')} hint={t('auth.signUp.slugHint')}>
          {(p) => (
            <Input
              {...p}
              required
              pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(slugify(e.target.value));
              }}
            />
          )}
        </Field>
        <Field id="name" label={t('auth.fields.yourName')}>
          {(p) => <Input {...p} required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field id="email" label={t('auth.fields.workEmail')}>
          {(p) => <Input {...p} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field id="password" label={t('auth.fields.password')} hint={t('auth.signUp.passwordHint')}>
          {(p) => <Input {...p} type="password" required minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <label className="flex items-start gap-3 text-footnote text-text-secondary">
          <input type="checkbox" checked={dpa} onChange={(e) => setDpa(e.target.checked)} className="mt-0.5 accent-[var(--color-accent)]" />
          <span>{t('auth.signUp.dpa')}</span>
        </label>
        <Button type="submit" loading={busy} disabled={!region}>
          {t('auth.signUp.submit')}
        </Button>
      </form>
    </div>
  );
}
