'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { startRegistration } from '@simplewebauthn/browser';
import { Button, Card, Field, Input } from '@thapsus/ui';
import { Logo } from '@/components/logo';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';

/**
 * One-time staff enrolment (ADR-0174). The link from the operator CLI carries its token in the fragment,
 * which never reaches a server log; it is read here and removed from the address bar at once.
 */
export default function StaffEnrol() {
  const t = useT();
  const router = useRouter();
  const [token, setToken] = React.useState<string | null | undefined>(undefined);
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('token');
    window.history.replaceState(null, '', '/backoffice/enrol');
    setToken(value && /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : null);
  }, []);

  async function register(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await api<{
        challengeId: string;
        options: Parameters<typeof startRegistration>[0]['optionsJSON'];
      }>('/v1/backoffice/auth/enrol/options', { method: 'POST', json: { token } });
      const response = await startRegistration({ optionsJSON: options });
      await api('/v1/backoffice/auth/enrol/verify', {
        method: 'POST',
        json: { token, challengeId, response, ...(name.trim() ? { name: name.trim() } : {}) },
      });
      router.replace('/backoffice');
    } catch (err) {
      setError(
        err instanceof ApiProblem && err.status === 401 ? t('backoffice.enrol.invalid') : t('common.error'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-5 p-8">
      <Logo label={t('common.appName')} />
      <div>
        <h1 className="text-large-title">{t('backoffice.enrol.title')}</h1>
        <p className="mt-2 text-callout text-text-secondary">{t('backoffice.enrol.lead')}</p>
      </div>
      {token === null ? (
        <p role="alert" className="text-callout text-danger">
          {t('backoffice.enrol.missing')}
        </p>
      ) : (
        <form onSubmit={register} className="flex flex-col gap-4">
          <Field id="key-name" label={t('backoffice.enrol.keyName')}>
            {(p) => (
              <Input
                {...p}
                className="h-11"
                maxLength={80}
                autoComplete="off"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          {error ? (
            <p role="alert" className="text-callout text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="h-11" loading={busy} disabled={!token}>
            <KeyRound aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('backoffice.enrol.submit')}
          </Button>
        </form>
      )}
    </Card>
  );
}
