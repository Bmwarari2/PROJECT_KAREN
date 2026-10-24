'use client';
import * as React from 'react';
import Link from 'next/link';
import { CircleCheck, LinkIcon } from 'lucide-react';
import { Button, Field, Input } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';

const PROBLEMS = ['tooShort', 'tooLong', 'tooCommon', 'contextSpecific'];

/**
 * Sets a new password from an emailed reset link (ADR-0171). The token is taken out of the address bar
 * and history at once. The link never signs anyone in: the page ends at "sign in with your new password".
 */
export default function ResetPasswordPage() {
  const t = useT();
  const [token, setToken] = React.useState<string | null>(null);
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [state, setState] = React.useState<'form' | 'invalid' | { workspace: string }>('form');

  React.useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('token');
    window.history.replaceState(null, '', '/auth/reset');
    if (value) setToken(value);
    else setState('invalid');
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ workspace: string }>('/v1/auth/password-reset/complete', {
        method: 'POST',
        json: { token, newPassword: password },
      });
      setPassword('');
      setState({ workspace: r.workspace });
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 401) {
        setState('invalid');
        return;
      }
      const problem =
        err instanceof ApiProblem
          ? (err.body.errors as Array<{ message?: string }> | undefined)?.[0]?.message
          : undefined;
      setError(
        problem && PROBLEMS.includes(problem)
          ? t(`auth.reset.problem.${problem}`)
          : err instanceof ApiProblem
            ? err.title
            : t('common.error'),
      );
    } finally {
      setBusy(false);
    }
  }

  if (state === 'invalid')
    return (
      <div className="flex flex-col gap-4">
        <LinkIcon aria-hidden className="h-8 w-8 stroke-[1.5] text-text-secondary" />
        <h1 className="text-large-title">{t('auth.reset.invalidTitle')}</h1>
        <p className="text-callout text-text-secondary">{t('auth.reset.invalid')}</p>
        <Link
          href="/forgot-password"
          className="inline-flex h-11 items-center justify-center rounded-pill bg-accent px-5 text-callout font-semibold text-on-accent no-underline hover:bg-accent-hover"
        >
          {t('auth.reset.requestNew')}
        </Link>
      </div>
    );

  if (typeof state === 'object')
    return (
      <div role="status" className="flex flex-col gap-4">
        <CircleCheck aria-hidden className="h-8 w-8 stroke-[1.5] text-success" />
        <h1 className="text-large-title">{t('auth.reset.doneTitle')}</h1>
        <p className="text-callout text-text-secondary">{t('auth.reset.done')}</p>
        <p className="text-callout text-text-secondary">{t('auth.reset.mfaNote')}</p>
        <Link
          href={`/signin?workspace=${encodeURIComponent(state.workspace)}`}
          className="inline-flex h-11 items-center justify-center rounded-pill bg-accent px-5 text-callout font-semibold text-on-accent no-underline hover:bg-accent-hover"
        >
          {t('auth.reset.signIn')}
        </Link>
      </div>
    );

  return (
    <div>
      <h1 className="text-large-title">{t('auth.reset.title')}</h1>
      <p className="mt-2 text-callout text-text-secondary">{t('auth.reset.lead')}</p>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
        <Field id="new-password" label={t('auth.reset.newPassword')} hint={t('auth.reset.hint')}>
          {(p) => (
            <Input
              {...p}
              className="h-11"
              name="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        {error ? (
          <p role="alert" className="text-callout text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="h-11" loading={busy} disabled={!token}>
          {t('auth.reset.submit')}
        </Button>
      </form>
      <p className="mt-4 text-footnote text-text-secondary">{t('auth.reset.mfaNote')}</p>
    </div>
  );
}
