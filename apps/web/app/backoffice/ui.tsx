'use client';
import * as React from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';

/** Shared back-office bits. Staff sessions are separate from tenant sessions (cookie scoped to /v1/backoffice). */
export interface StaffElevation {
  id: string;
  scope: 'super_admin' | 'rules_publish' | 'support_grant';
  subjectTenantId: string | null;
  expiresAt: string;
}
export interface StaffSession {
  staffId: string;
  email: string;
  displayName: string;
  role: 'super_admin' | 'support' | 'rules_editor' | 'billing';
  cell: string;
  elevations?: StaffElevation[];
}

/** Proves the staff member's identity again with their key (destructive actions need it within 5 minutes). */
export async function staffReauthenticate() {
  const { challengeId, options } = await api<{
    challengeId: string;
    options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
  }>('/v1/backoffice/auth/reauth/options', { method: 'POST' });
  const response = await startAuthentication({ optionsJSON: options });
  await api('/v1/backoffice/auth/reauth/verify', { method: 'POST', json: { challengeId, response } });
}

/**
 * The back office's API call (ADR-0173): when the API asks for a fresh key assertion, the browser's passkey
 * prompt appears and the call is retried once; a missing elevation gets a message that says where to ask.
 */
export function useStaffApi() {
  const t = useT();
  return React.useCallback(
    async <T = unknown,>(path: string, init: Parameters<typeof api>[1] = {}): Promise<T> => {
      const explain = (err: unknown) =>
        err instanceof ApiProblem && err.body.reason === 'elevationRequired'
          ? new ApiProblem(
              err.status,
              err.code,
              t('backoffice.elevation.problem.elevationRequired'),
              err.body,
            )
          : err;
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (!(err instanceof ApiProblem) || err.code !== 'reauthenticationRequired') throw explain(err);
        try {
          await staffReauthenticate();
        } catch (e) {
          if (e instanceof ApiProblem) throw e;
          throw new ApiProblem(401, 'invalidCredentials', t('backoffice.stepUp.failed'), {});
        }
        return api<T>(path, init).catch((e: unknown) => Promise.reject(explain(e)));
      }
    },
    [t],
  );
}
export const StaffContext = React.createContext<StaffSession | null>(null);
export const useStaff = () => React.useContext(StaffContext);
export const staffCan = (s: StaffSession | null, ...roles: string[]) =>
  !!s && (s.role === 'super_admin' || roles.includes(s.role));

export const selectClass =
  'h-10 w-full rounded-sm border border-border-strong bg-surface-raised px-2 text-callout text-text';

export function PageTitle({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-large-title">{title}</h1>
        {lead ? (
          <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">{lead}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function slaTone(flag: string): 'success' | 'warning' | 'danger' | 'neutral' {
  return flag === 'breached'
    ? 'danger'
    : flag === 'at_risk'
      ? 'warning'
      : flag === 'met'
        ? 'success'
        : 'neutral';
}
