'use client';
import * as React from 'react';
import { Button, Field, Input, Skeleton, useToast } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import {
  Checkbox,
  ConfirmAction,
  FormError,
  PageHeader,
  ReadOnlyNote,
  SettingsCard,
  useAction,
  usePermission,
} from '../kit';
import { useStepUp } from '../../step-up';

interface Security {
  ssoEnforced: boolean;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  lockoutThreshold: number;
  lockoutMinutes: number;
  trustIdpMfa: boolean;
  requireMfaForEveryone: boolean;
}
type NumberKey = 'sessionIdleMinutes' | 'sessionAbsoluteHours' | 'lockoutThreshold' | 'lockoutMinutes';

/** Limits the API accepts (PATCH /v1/settings/security). */
const LIMITS: Record<NumberKey, [number, number]> = {
  sessionIdleMinutes: [5, 720],
  sessionAbsoluteHours: [1, 720],
  lockoutThreshold: [3, 20],
  lockoutMinutes: [1, 1440],
};

function PolicyForm({
  initial,
  canManage,
  onSaved,
}: {
  initial: Security;
  canManage: boolean;
  onSaved: () => void;
}) {
  const t = useT();
  const action = useAction();
  const toast = useToast();
  const stepUp = useStepUp();
  const [v, setV] = React.useState<Record<NumberKey, string>>({
    sessionIdleMinutes: String(initial.sessionIdleMinutes),
    sessionAbsoluteHours: String(initial.sessionAbsoluteHours),
    lockoutThreshold: String(initial.lockoutThreshold),
    lockoutMinutes: String(initial.lockoutMinutes),
  });
  const [trustIdpMfa, setTrust] = React.useState(initial.trustIdpMfa);
  const [everyone, setEveryone] = React.useState(initial.requireMfaForEveryone);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Number(x)])),
      trustIdpMfa,
      requireMfaForEveryone: everyone,
    };
    // turning two-step verification off for everyone (or trusting the IdP) asks the admin to confirm it is them
    let saved = false;
    if (
      await action.run(async () => {
        saved = await stepUp.run(() => api('/v1/settings/security', { method: 'PATCH', json: body }));
      }, undefined)
    )
      if (saved) {
        toast({ title: t('admin.saved'), tone: 'success' });
        onSaved();
      }
  }

  const number = (k: NumberKey) => (
    <Field
      key={k}
      id={`policy-${k}`}
      label={t(`admin.policy.${k}`)}
      hint={t('admin.policy.range', { min: LIMITS[k][0], max: LIMITS[k][1] })}
    >
      {(p) => (
        <Input
          {...p}
          type="number"
          inputMode="numeric"
          required
          min={LIMITS[k][0]}
          max={LIMITS[k][1]}
          step={1}
          value={v[k]}
          onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))}
        />
      )}
    </Field>
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <fieldset disabled={!canManage} className="flex flex-col gap-6">
        <SettingsCard
          id="policy-sessions"
          title={t('admin.policy.sessionsTitle')}
          description={t('admin.policy.sessionsBody')}
        >
          <div className="grid gap-4 md:grid-cols-2">
            {(['sessionIdleMinutes', 'sessionAbsoluteHours'] as const).map(number)}
          </div>
        </SettingsCard>
        <SettingsCard
          id="policy-lockout"
          title={t('admin.policy.lockoutTitle')}
          description={t('admin.policy.lockoutBody')}
        >
          <div className="grid gap-4 md:grid-cols-2">
            {(['lockoutThreshold', 'lockoutMinutes'] as const).map(number)}
          </div>
        </SettingsCard>
        <SettingsCard
          id="policy-mfa"
          title={t('admin.policy.mfaTitle')}
          description={t('admin.policy.mfaBody')}
        >
          <Checkbox
            id="policy-mfa-everyone"
            label={t('admin.policy.requireMfaForEveryone')}
            hint={t('admin.policy.requireMfaForEveryoneHint')}
            checked={everyone}
            onChange={setEveryone}
          />
          <Checkbox
            id="policy-trust-idp"
            label={t('admin.policy.trustIdpMfa')}
            hint={t('admin.policy.trustIdpMfaHint')}
            checked={trustIdpMfa}
            onChange={setTrust}
          />
        </SettingsCard>
      </fieldset>
      <FormError message={action.error} />
      {stepUp.dialog}
      {canManage ? (
        <Button type="submit" className="self-start" loading={action.busy}>
          {t('common.save')}
        </Button>
      ) : (
        <ReadOnlyNote />
      )}
    </form>
  );
}

/** Sign everyone in the workspace out (ASVS V7.4.5), for example after a suspected compromise. */
function EndAllSessions() {
  const t = useT();
  const toast = useToast();
  const stepUp = useStepUp();
  return (
    <SettingsCard
      id="policy-end-all"
      title={t('admin.policy.endAllTitle')}
      description={t('admin.policy.endAllBody')}
    >
      <div>
        <ConfirmAction
          label={t('admin.policy.endAll')}
          title={t('admin.policy.endAllTitle')}
          body={t('admin.policy.endAllConfirm')}
          confirmLabel={t('admin.policy.endAll')}
          onConfirm={async () => {
            void stepUp
              .run(async () => {
                const r = await api<{ ended: number }>('/v1/settings/sessions/end-all', { method: 'POST' });
                toast({ title: t('admin.policy.endAllDone', { count: r.ended }), tone: 'success' });
              })
              .catch(() => toast({ title: t('common.error'), tone: 'danger' }));
          }}
        />
      </div>
      {stepUp.dialog}
    </SettingsCard>
  );
}

export default function SignInPolicyPage() {
  const t = useT();
  const has = usePermission();
  const security = useApi<Security>('/v1/settings/security');
  return (
    <>
      <PageHeader title={t('admin.section.signInPolicy.title')} lead={t('admin.policy.lead')} />
      {security.data ? (
        <PolicyForm initial={security.data} canManage={has('settings.manage')} onSaved={security.reload} />
      ) : (
        <Skeleton className="h-64" />
      )}
      {has('settings.manage') ? <EndAllSessions /> : null}
    </>
  );
}
