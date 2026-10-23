'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { Button, Card, Field, Input } from '@thapsus/ui';
import { Logo } from '@/components/logo';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';

/** Thapsus staff sign-in: password, then the mandatory authenticator code (ADR-0011). */
export default function StaffSignIn() {
  const t = useT();
  const router = useRouter();
  const [step, setStep] = React.useState<'password' | 'totp'>('password');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const codeRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (step === 'totp') codeRef.current?.focus();
  }, [step]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === 'password') {
        await api('/v1/backoffice/auth/login', { method: 'POST', json: { email, password } });
        setStep('totp');
      } else {
        await api('/v1/backoffice/auth/totp', { method: 'POST', json: { code } });
        router.replace('/backoffice');
      }
    } catch (err) {
      setError(err instanceof ApiProblem ? err.title : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-5 p-8">
      <Logo label={t('common.appName')} />
      <div>
        <h1 className="text-title-2">{t('backoffice.signin.title')}</h1>
        <p className="mt-1 text-callout text-text-secondary">
          {step === 'password' ? t('backoffice.signin.lead') : t('backoffice.signin.totpLead')}
        </p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate={false}>
        {step === 'password' ? (
          <>
            <Field id="staff-email" label={t('backoffice.signin.email')}>
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>
            <Field id="staff-password" label={t('backoffice.signin.password')}>
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
            </Field>
          </>
        ) : (
          <Field id="staff-code" label={t('backoffice.signin.code')} hint={t('backoffice.signin.codeHint')}>
            {(p) => (
              <Input
                {...p}
                ref={codeRef}
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
        )}
        {error ? (
          <p role="alert" className="text-callout text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" loading={busy}>
          {step === 'password' ? t('backoffice.signin.continue') : t('backoffice.signin.verify')}
        </Button>
      </form>
      <p className="flex items-center gap-2 text-footnote text-text-secondary">
        <ShieldCheck aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('backoffice.signin.note')}
      </p>
    </Card>
  );
}
