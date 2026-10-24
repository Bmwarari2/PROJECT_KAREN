'use client';
import * as React from 'react';
import { Button, Dialog, DialogContent, Field, Input } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useSession } from './shell';

/**
 * Step-up re-authentication (ASVS V7.5.1). `run(action)` performs a sensitive action; when the API
 * answers `reauthenticationRequired`, a dialog asks for the password or an authenticator code, calls
 * POST /v1/auth/reauth and retries the action once. People with neither (SSO or passkey only) are told
 * to sign in again, which counts as a fresh authentication.
 */
export function useStepUp() {
  const t = useT();
  const session = useSession();
  const [pending, setPending] = React.useState<{
    action: () => Promise<unknown>;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [secret, setSecret] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const factor: 'password' | 'code' | null = session?.hasPassword
    ? 'password'
    : session?.hasMfaFactor
      ? 'code'
      : null;

  const run = React.useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (err) {
      if (!(err instanceof ApiProblem) || err.code !== 'reauthenticationRequired') throw err;
      setSecret('');
      setError(null);
      return new Promise<boolean>((resolve) => setPending({ action, resolve }));
    }
  }, []);

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/reauth', {
        method: 'POST',
        json: factor === 'password' ? { password: secret } : { code: secret },
        capability: 'me.security',
      });
      await pending.action();
      close(true);
    } catch (err) {
      setError(err instanceof ApiProblem ? err.title : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <Dialog open={!!pending} onOpenChange={(o) => (o ? undefined : close(false))}>
      <DialogContent
        title={t('app.security.stepUp.title')}
        description={factor ? t(`app.security.stepUp.${factor}Lead`) : t('app.security.stepUp.signInAgain')}
        closeLabel={t('common.close')}
      >
        {factor ? (
          <form onSubmit={confirm} className="flex flex-col gap-4">
            {factor === 'password' ? (
              <Field id="step-up-password" label={t('auth.fields.password')}>
                {(p) => (
                  <Input
                    {...p}
                    type="password"
                    autoComplete="current-password"
                    required
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                )}
              </Field>
            ) : (
              <Field id="step-up-code" label={t('auth.mfa.codeLabel')} hint={t('auth.mfa.codeHint')}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    required
                    value={secret}
                    onChange={(e) => setSecret(e.target.value.replace(/\D/g, ''))}
                  />
                )}
              </Field>
            )}
            {error ? (
              <p role="alert" className="text-callout text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => close(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={busy}>
                {t('app.security.stepUp.confirm')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={() => close(false)}>
              {t('common.close')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
  return { run, dialog };
}
