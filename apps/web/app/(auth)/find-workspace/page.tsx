'use client';
import * as React from 'react';
import { Button, Field, Input } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';

export default function FindWorkspacePage() {
  const t = useT();
  const locale = useLocale();
  const [email, setEmail] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return (
    <div>
      <h1 className="text-title-2">{t('auth.find.title')}</h1>
      <p className="mt-2 text-callout text-text-secondary">{t('auth.find.lead')}</p>
      {sent ? (
        <p role="status" className="mt-6 text-callout">
          {t('auth.find.sent')}
        </p>
      ) : (
        <form
          className="mt-6 flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            await api('/global/v1/find-workspace', { method: 'POST', json: { email, locale } }).catch(() => undefined);
            setBusy(false);
            setSent(true);
          }}
        >
          <Field id="email" label={t('auth.fields.workEmail')}>
            {(p) => <Input {...p} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Button type="submit" loading={busy}>
            {t('auth.find.submit')}
          </Button>
        </form>
      )}
    </div>
  );
}
