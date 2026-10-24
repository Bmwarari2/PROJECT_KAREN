'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { startAuthentication } from '@simplewebauthn/browser';
import { Button, Card } from '@thapsus/ui';
import { Logo } from '@/components/logo';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';

/**
 * Thapsus staff sign-in (ADR-0174): a passkey or a hardware security key only, with user verification.
 * There is no staff password; the first key is registered from a one-time enrolment link.
 */
export default function StaffSignIn() {
  const t = useT();
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await api<{
        challengeId: string;
        options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
      }>('/v1/backoffice/auth/passkey/options', { method: 'POST' });
      const response = await startAuthentication({ optionsJSON: options });
      await api('/v1/backoffice/auth/passkey/verify', { method: 'POST', json: { challengeId, response } });
      router.replace('/backoffice');
    } catch (err) {
      setError(err instanceof ApiProblem && err.status !== 401 ? err.title : t('backoffice.signin.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-5 p-8">
      <Logo label={t('common.appName')} />
      <div>
        <h1 className="text-large-title">{t('backoffice.signin.title')}</h1>
        <p className="mt-2 text-callout text-text-secondary">{t('backoffice.signin.lead')}</p>
      </div>
      {error ? (
        <p role="alert" className="text-callout text-danger">
          {error}
        </p>
      ) : null}
      <Button type="button" className="h-11" loading={busy} onClick={signIn}>
        <KeyRound aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('backoffice.signin.passkey')}
      </Button>
      <p className="flex items-start gap-2 text-footnote text-text-secondary">
        <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 stroke-[1.5]" />
        {t('backoffice.signin.note')}
      </p>
    </Card>
  );
}
