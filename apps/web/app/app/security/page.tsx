'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { startRegistration } from '@simplewebauthn/browser';
import { Button, Card, CardTitle, Field, Input, useToast } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useSession } from '../shell';

export default function SecurityPage() {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const session = useSession();
  const [enrol, setEnrol] = React.useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const needsMfa = !!session?.isAdmin && !session.mfaVerified;

  async function startTotp() {
    setError(null);
    try {
      setEnrol(await api('/v1/auth/mfa/totp/enroll', { method: 'POST' }));
    } catch (err) {
      setError(err instanceof ApiProblem ? err.title : t('common.error'));
    }
  }

  async function confirmTotp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(session?.hasMfaFactor && !enrol ? '/v1/auth/mfa/totp/verify' : '/v1/auth/mfa/totp/confirm', { method: 'POST', json: { code } });
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
      const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('/v1/auth/passkeys/register/options', { method: 'POST' });
      const response = await startRegistration({ optionsJSON: options });
      await api('/v1/auth/passkeys/register/verify', { method: 'POST', json: { challengeId, response } });
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
              {(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />}
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
    </div>
  );
}
