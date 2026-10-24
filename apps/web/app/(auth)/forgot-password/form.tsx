'use client';
import * as React from 'react';
import Link from 'next/link';
import { MailCheck } from 'lucide-react';
import { Button, Field, Input } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';

/**
 * "Forgot your password?" (ADR-0171). The answer is the same whether or not the account exists, so the
 * page always says "if you have an account" and never confirms an address.
 */
export function ForgotPasswordForm({ initialWorkspace }: { initialWorkspace: string }) {
  const t = useT();
  const [workspace, setWorkspace] = React.useState(initialWorkspace);
  const [email, setEmail] = React.useState('');
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const slug = workspace.trim().toLowerCase();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!slug || !email) {
      setError(t('auth.forgot.needWorkspaceAndEmail'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/password-reset', { method: 'POST', json: { tenant: slug, email } });
      setSentTo(email);
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'wrongRegion' && typeof err.body.appUrl === 'string') {
        window.location.assign(`${err.body.appUrl}/forgot-password?workspace=${encodeURIComponent(slug)}`);
        return;
      }
      setError(
        err instanceof ApiProblem
          ? err.code === 'ssoRequired'
            ? t('auth.forgot.ssoRequired')
            : err.title
          : t('common.error'),
      );
    } finally {
      setBusy(false);
    }
  }

  const back = (
    <Link
      href={`/signin${slug ? `?workspace=${encodeURIComponent(slug)}` : ''}`}
      className="inline-flex min-h-11 items-center text-callout"
    >
      {t('auth.forgot.backToSignIn')}
    </Link>
  );

  if (sentTo)
    return (
      <div role="status" className="flex flex-col gap-4">
        <MailCheck aria-hidden className="h-8 w-8 stroke-[1.5] text-accent" />
        <h1 className="text-large-title">{t('auth.forgot.sentTitle')}</h1>
        <p className="text-callout text-text-secondary">{t('auth.forgot.sent', { email: sentTo })}</p>
        {back}
      </div>
    );

  return (
    <div>
      <h1 className="text-large-title">{t('auth.forgot.title')}</h1>
      <p className="mt-2 text-callout text-text-secondary">{t('auth.forgot.lead')}</p>
      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-surface p-3 text-callout text-danger">
          {error}
        </p>
      ) : null}
      <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate>
        <Field id="workspace" label={t('auth.fields.workspace')} hint={t('auth.fields.workspaceHint')}>
          {(p) => (
            <Input
              {...p}
              className="h-11"
              name="workspace"
              autoComplete="organization"
              required
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
            />
          )}
        </Field>
        <Field id="email" label={t('auth.fields.email')}>
          {(p) => (
            <Input
              {...p}
              className="h-11"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" className="h-11" loading={busy}>
          {t('auth.forgot.submit')}
        </Button>
      </form>
      <p className="mt-6">{back}</p>
    </div>
  );
}
