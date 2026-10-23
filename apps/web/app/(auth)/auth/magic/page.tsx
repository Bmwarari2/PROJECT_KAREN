'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';

export default function MagicLinkPage() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = React.useState<string | null>(null);
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = params.get('token') ?? '';
    // Remove the token from the address bar and history straight away.
    window.history.replaceState(null, '', '/auth/magic');
    api<{ mfaEnrollmentRequired: boolean; mfaRequired: boolean }>('/v1/auth/magic-link/consume', {
      method: 'POST',
      json: { token },
    })
      .then((r) =>
        router.replace(
          r.mfaEnrollmentRequired ? '/app/security?setup=1' : r.mfaRequired ? '/signin?mfa=1' : '/app',
        ),
      )
      .catch((err) => setError(err instanceof ApiProblem ? t('auth.magic.invalid') : t('common.error')));
  }, [params, router, t]);
  return (
    <div role="status">
      <h1 className="text-title-2">{t('auth.magic.title')}</h1>
      <p className="mt-2 text-callout text-text-secondary">{error ?? t('common.loading')}</p>
    </div>
  );
}
