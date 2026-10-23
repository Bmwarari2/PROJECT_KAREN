'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { KeyRound, Mail } from 'lucide-react';
import { startAuthentication } from '@simplewebauthn/browser';
import { Button, Field, Input } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';

type Step = 'credentials' | 'totp' | 'sso' | 'magicSent';

export function SignInForm({ initialWorkspace }: { initialWorkspace: string }) {
  const t = useT();
  const router = useRouter();
  const [step, setStep] = React.useState<Step>('credentials');
  const [workspace, setWorkspace] = React.useState(initialWorkspace);
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const handleProblem = (err: unknown) => {
    if (err instanceof ApiProblem) {
      if (err.code === 'wrongRegion' && typeof err.body.appUrl === 'string') {
        window.location.assign(`${err.body.appUrl}/signin?workspace=${encodeURIComponent(workspace)}`);
        return;
      }
      if (err.code === 'ssoRequired') {
        setStep('sso');
        return;
      }
      setError(err.title);
    } else setError(t('common.error'));
  };

  const after = (r: { mfaRequired?: boolean; mfaEnrollmentRequired?: boolean }) => {
    if (r.mfaRequired) setStep('totp');
    else if (r.mfaEnrollmentRequired) router.push('/app/security?setup=1');
    else router.push('/app');
  };

  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      after(
        await api('/v1/auth/login', {
          method: 'POST',
          json: { tenant: workspace.trim().toLowerCase(), email, password },
        }),
      );
    } catch (err) {
      handleProblem(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/mfa/totp/verify', { method: 'POST', json: { code } });
      router.push('/app');
    } catch (err) {
      handleProblem(err);
    } finally {
      setBusy(false);
    }
  }

  async function magicLink() {
    if (!workspace || !email) {
      setError(t('auth.signIn.needWorkspaceAndEmail'));
      return;
    }
    setBusy(true);
    try {
      await api('/v1/auth/magic-link', {
        method: 'POST',
        json: { tenant: workspace.trim().toLowerCase(), email },
      });
      setStep('magicSent');
    } catch (err) {
      handleProblem(err);
    } finally {
      setBusy(false);
    }
  }

  async function passkey() {
    if (!workspace) {
      setError(t('auth.signIn.needWorkspace'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await api<{
        challengeId: string;
        options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
      }>('/v1/auth/passkeys/login/options', {
        method: 'POST',
        json: { tenant: workspace.trim().toLowerCase() },
      });
      const response = await startAuthentication({ optionsJSON: options });
      await api('/v1/auth/passkeys/login/verify', { method: 'POST', json: { challengeId, response } });
      router.push('/app');
    } catch (err) {
      handleProblem(err);
    } finally {
      setBusy(false);
    }
  }

  const ssoHref = `/v1/auth/sso/start?tenant=${encodeURIComponent(workspace.trim().toLowerCase())}${email ? `&login_hint=${encodeURIComponent(email)}` : ''}`;

  return (
    <div>
      <h1 className="text-title-2">{t('auth.signIn.title')}</h1>
      <p className="mt-2 text-callout text-text-secondary">{t('auth.signIn.lead')}</p>
      {error ? (
        <p role="alert" className="mt-4 rounded-md bg-surface p-3 text-callout text-danger">
          {error}
        </p>
      ) : null}

      {step === 'credentials' || step === 'sso' ? (
        <form onSubmit={submitCredentials} className="mt-6 flex flex-col gap-4" noValidate>
          <Field id="workspace" label={t('auth.fields.workspace')} hint={t('auth.fields.workspaceHint')}>
            {(p) => (
              <Input
                {...p}
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
                name="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </Field>
          {step === 'sso' ? (
            <div className="flex flex-col gap-3">
              <p className="text-callout text-text-secondary">{t('errors.ssoRequired')}</p>
              <a
                href={ssoHref}
                className="inline-flex h-10 items-center justify-center rounded-pill bg-accent px-5 text-callout font-semibold text-on-accent no-underline hover:bg-accent-hover"
              >
                {t('auth.signIn.continueSso')}
              </a>
            </div>
          ) : (
            <>
              <Field id="password" label={t('auth.fields.password')}>
                {(p) => (
                  <Input
                    {...p}
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )}
              </Field>
              <Button type="submit" loading={busy}>
                {t('auth.signIn.submit')}
              </Button>
              <div className="flex items-center gap-3 text-footnote text-text-secondary">
                <span className="h-px flex-1 bg-border" />
                {t('auth.signIn.or')}
                <span className="h-px flex-1 bg-border" />
              </div>
              <div className="grid gap-2">
                <a
                  href={ssoHref}
                  className="inline-flex h-10 items-center justify-center rounded-pill border border-border px-5 text-callout font-semibold text-text no-underline hover:bg-surface"
                >
                  {t('auth.signIn.continueSso')}
                </a>
                <Button type="button" variant="secondary" onClick={passkey} disabled={busy}>
                  <KeyRound aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('auth.signIn.passkey')}
                </Button>
                <Button type="button" variant="ghost" onClick={magicLink} disabled={busy}>
                  <Mail aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('auth.signIn.magicLink')}
                </Button>
              </div>
            </>
          )}
        </form>
      ) : null}

      {step === 'totp' ? (
        <form onSubmit={submitTotp} className="mt-6 flex flex-col gap-4">
          <Field id="code" label={t('auth.mfa.codeLabel')} hint={t('auth.mfa.codeHint')}>
            {(p) => (
              <Input
                {...p}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            )}
          </Field>
          <Button type="submit" loading={busy}>
            {t('auth.mfa.verify')}
          </Button>
        </form>
      ) : null}

      {step === 'magicSent' ? <p className="mt-6 text-callout">{t('auth.signIn.magicSent')}</p> : null}

      <p className="mt-8 text-footnote text-text-secondary">
        <Link href="/find-workspace">{t('auth.signIn.findWorkspace')}</Link>
        {' · '}
        <Link href="/signup">{t('auth.signIn.createWorkspace')}</Link>
      </p>
    </div>
  );
}
