'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Laptop, LockKeyhole, ShieldCheck } from 'lucide-react';
import { startRegistration } from '@simplewebauthn/browser';
import { Badge, Button, Card, CardTitle, Field, Input, useToast } from '@thapsus/ui';
import { formatDateTime } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { viewerZone } from '@/lib/week';
import { needsSecondFactor, useSession } from '../shell';
import { useStepUp } from '../step-up';

interface ActiveSession {
  id: string;
  method: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
  device: string | null;
}

const METHODS = ['password', 'passkey', 'magic_link', 'oidc', 'saml'];
const PASSWORD_PROBLEMS = ['tooShort', 'tooLong', 'tooCommon', 'contextSpecific'];

/** A short, recognisable device name from a user agent (browser and platform names are product names). */
function deviceOf(ua: string | null): { browser: string; os: string } | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return browser && os ? { browser, os } : null;
}

/** Your active sessions; end one or all of the others (ASVS V7.5.2). */
function SessionsCard() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const zone = viewerZone(session?.timeZone);
  const stepUp = useStepUp();
  const sessions = useApi<{ data: ActiveSession[] }>('/v1/auth/sessions');
  const list = sessions.data?.data ?? [];
  const others = list.filter((s) => !s.current);
  const label = (s: ActiveSession) => {
    const d = deviceOf(s.device);
    return d ? t('app.security.sessions.device', d) : t('app.security.sessions.unknownDevice');
  };

  async function act(action: () => Promise<unknown>, done: string) {
    try {
      if (await stepUp.run(action)) toast({ title: done, tone: 'success' });
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      sessions.reload();
    }
  }

  return (
    <Card>
      <div className="flex items-center gap-3">
        <Laptop aria-hidden className="h-6 w-6 stroke-[1.5] text-accent" />
        <CardTitle>{t('app.security.sessions.title')}</CardTitle>
      </div>
      <p className="mt-2 text-callout text-text-secondary">{t('app.security.sessions.body')}</p>
      <ul className="mt-4 flex flex-col divide-y divide-border" aria-label={t('app.security.sessions.title')}>
        {list.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="mr-auto flex min-w-0 flex-col">
              <span className="flex flex-wrap items-center gap-2 text-callout font-semibold">
                {label(s)}
                {s.current ? <Badge tone="success">{t('app.security.sessions.current')}</Badge> : null}
              </span>
              <span className="text-footnote text-text-secondary">
                {t('app.security.sessions.signedIn', {
                  when: formatDateTime(s.createdAt, locale, zone),
                  method: METHODS.includes(s.method)
                    ? t(`app.security.sessions.method.${s.method}`)
                    : s.method,
                })}
              </span>
              <span className="text-footnote text-text-secondary">
                {t('app.security.sessions.lastActive', { when: formatDateTime(s.lastSeenAt, locale, zone) })}
              </span>
            </div>
            {s.current ? null : (
              <Button
                size="sm"
                variant="secondary"
                aria-label={t('app.security.sessions.endOneLabel', { device: label(s) })}
                onClick={() =>
                  act(
                    () => api(`/v1/auth/sessions/${s.id}`, { method: 'DELETE' }),
                    t('app.security.sessions.ended'),
                  )
                }
              >
                {t('app.security.sessions.endOne')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {others.length ? (
        <Button
          className="mt-4"
          variant="secondary"
          onClick={() =>
            act(
              () => api('/v1/auth/sessions/end-others', { method: 'POST' }),
              t('app.security.sessions.endedOthers'),
            )
          }
        >
          {t('app.security.sessions.endOthers')}
        </Button>
      ) : sessions.data ? (
        <p className="mt-2 text-footnote text-text-secondary">{t('app.security.sessions.onlyThis')}</p>
      ) : null}
      {stepUp.dialog}
    </Card>
  );
}

/** Change (or set a first) password (ASVS V6.2.2, V6.2.3). */
function PasswordCard() {
  const t = useT();
  const toast = useToast();
  const session = useSession();
  const stepUp = useStepUp();
  const has = !!session?.hasPassword;
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ok = await stepUp.run(() =>
        api('/v1/auth/password', {
          method: 'POST',
          json: has ? { currentPassword: current, newPassword: next } : { newPassword: next },
        }),
      );
      if (ok) {
        setCurrent('');
        setNext('');
        toast({ title: t('app.security.password.changed'), tone: 'success' });
      }
    } catch (err) {
      const problem =
        err instanceof ApiProblem
          ? (err.body.errors as Array<{ message?: string }> | undefined)?.[0]?.message
          : undefined;
      setError(
        problem && PASSWORD_PROBLEMS.includes(problem)
          ? t(`app.security.password.problem.${problem}`)
          : err instanceof ApiProblem
            ? err.title
            : t('common.error'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center gap-3">
        <LockKeyhole aria-hidden className="h-6 w-6 stroke-[1.5] text-accent" />
        <CardTitle>{t('app.security.password.title')}</CardTitle>
      </div>
      <p className="mt-2 text-callout text-text-secondary">
        {has ? t('app.security.password.changeBody') : t('app.security.password.setBody')}
      </p>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
        {has ? (
          <Field id="current-password" label={t('app.security.password.current')}>
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="current-password"
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            )}
          </Field>
        ) : null}
        <Field
          id="new-password"
          label={t('app.security.password.new')}
          hint={t('app.security.password.hint')}
        >
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          )}
        </Field>
        {error ? (
          <p role="alert" className="text-callout text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="secondary" className="self-start" loading={busy}>
          {has ? t('app.security.password.change') : t('app.security.password.set')}
        </Button>
      </form>
      {stepUp.dialog}
    </Card>
  );
}

export default function SecurityPage() {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const session = useSession();
  const stepUp = useStepUp();
  const [enrol, setEnrol] = React.useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const needsMfa = needsSecondFactor(session);

  async function startTotp() {
    setError(null);
    try {
      // replacing an existing authenticator needs a fresh proof of identity (ASVS V7.5.1)
      await stepUp.run(async () => setEnrol(await api('/v1/auth/mfa/totp/enroll', { method: 'POST' })));
    } catch (err) {
      setError(err instanceof ApiProblem ? err.title : t('common.error'));
    }
  }

  async function confirmTotp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(session?.hasMfaFactor && !enrol ? '/v1/auth/mfa/totp/verify' : '/v1/auth/mfa/totp/confirm', {
        method: 'POST',
        json: { code },
      });
      toast({ title: t('app.security.mfaDone'), tone: 'success' });
      router.replace('/app');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiProblem ? err.title : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey() {
    setError(null);
    try {
      const added = await stepUp.run(async () => {
        const { challengeId, options } = await api<{
          challengeId: string;
          options: Parameters<typeof startRegistration>[0]['optionsJSON'];
        }>('/v1/auth/passkeys/register/options', { method: 'POST' });
        const response = await startRegistration({ optionsJSON: options });
        await api('/v1/auth/passkeys/register/verify', { method: 'POST', json: { challengeId, response } });
      });
      if (!added) return;
      toast({ title: t('app.security.passkeyAdded'), tone: 'success' });
      router.replace('/app');
    } catch (err) {
      setError(err instanceof ApiProblem ? err.title : t('app.security.passkeyFailed'));
    }
  }

  return (
    <div className="flex max-w-[var(--prose-width)] flex-col gap-6">
      <h1 className="text-title-2">{t('app.security.title')}</h1>
      {needsMfa ? (
        <p role="status" className="rounded-md bg-accent-subtle p-4 text-callout">
          {session?.hasMfaFactor ? t('app.security.verifyRequired') : t('app.security.setupRequired')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-callout text-danger">
          {error}
        </p>
      ) : null}
      <Card>
        <div className="flex items-center gap-3">
          <ShieldCheck aria-hidden className="h-6 w-6 stroke-[1.5] text-accent" />
          <CardTitle>{t('app.security.totpTitle')}</CardTitle>
        </div>
        <p className="mt-2 text-callout text-text-secondary">{t('app.security.totpBody')}</p>
        {enrol ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-callout">{t('app.security.totpSecret')}</p>
            <code className="break-all rounded-sm bg-surface p-3 text-callout">{enrol.secret}</code>
            <a href={enrol.otpauthUrl} className="text-callout">
              {t('app.security.openAuthenticator')}
            </a>
          </div>
        ) : null}
        {enrol || (session?.hasMfaFactor && !session.mfaVerified) ? (
          <form onSubmit={confirmTotp} className="mt-4 flex flex-col gap-3">
            <Field id="code" label={t('auth.mfa.codeLabel')} hint={t('auth.mfa.codeHint')}>
              {(p) => (
                <Input
                  {...p}
                  inputMode="numeric"
                  autoComplete="one-time-code"
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
        ) : (
          <Button className="mt-4" variant="secondary" onClick={startTotp}>
            {t('app.security.totpStart')}
          </Button>
        )}
      </Card>
      <Card>
        <div className="flex items-center gap-3">
          <KeyRound aria-hidden className="h-6 w-6 stroke-[1.5] text-accent" />
          <CardTitle>{t('app.security.passkeyTitle')}</CardTitle>
        </div>
        <p className="mt-2 text-callout text-text-secondary">{t('app.security.passkeyBody')}</p>
        <Button className="mt-4" variant="secondary" onClick={addPasskey}>
          {t('app.security.passkeyAdd')}
        </Button>
      </Card>
      {session && !needsMfa ? (
        <>
          <PasswordCard />
          <SessionsCard />
        </>
      ) : null}
      {stepUp.dialog}
    </div>
  );
}
