'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { KeyRound, Link2Off, LogOut, ShieldCheck, ShieldOff, UserMinus } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  PageSection,
  EmptyState,
  Field,
  ListItem,
  ListSection,
  Skeleton,
  Table,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@thapsus/ui';
import { formatDateTime } from '@thapsus/core/i18n';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useInModule, useSectionLevel } from '@/components/module-page';
import { PageTitle, useCan, useSession } from '../../../shell';
import {
  problemMessage,
  roleName,
  scopeSummary,
  type Assignment,
  type Role,
  type UserSummary,
} from '../../roles/shared';
import { ConfirmAction } from '../../kit';
import { useStepUp } from '../../../step-up';

const SCOPES = ['all', 'entity', 'country', 'department', 'location', 'own_team', 'self'] as const;
type ScopeType = (typeof SCOPES)[number];
const VALUED: ScopeType[] = ['entity', 'country', 'department', 'location'];
const selectClass = 'h-10 w-full rounded-sm border border-border-strong bg-surface-raised px-2 text-callout';

interface OrgUnit {
  id: string;
  name: string;
  country?: string;
}

/** Choices for a valued scope, from the organisation's reference data (visible to everyone signed in). */
function useScopeOptions(type: ScopeType) {
  const entities = useApi<OrgUnit[]>(
    type === 'entity' || type === 'country' ? '/v1/org/legal-entities' : null,
  );
  const departments = useApi<OrgUnit[]>(type === 'department' ? '/v1/org/departments' : null);
  const locations = useApi<OrgUnit[]>(type === 'location' || type === 'country' ? '/v1/org/locations' : null);
  if (type === 'entity') return entities.data?.map((e) => ({ value: e.id, label: e.name }));
  if (type === 'department') return departments.data?.map((d) => ({ value: d.id, label: d.name }));
  if (type === 'location') return locations.data?.map((l) => ({ value: l.id, label: l.name }));
  if (type === 'country') {
    if (!entities.data || !locations.data) return undefined;
    const codes = [
      ...new Set([...entities.data, ...locations.data].map((x) => x.country).filter((c): c is string => !!c)),
    ].sort();
    return codes.map((c) => ({ value: c, label: c }));
  }
  return [];
}

/**
 * Who can reset someone's sign-in (ADR-0171): an admin whose company-wide role manages settings and covers
 * every permission the person holds, after re-authenticating, never for themselves. They can sign the person
 * out everywhere, email them a password reset link (never seeing or setting the password), reset a lost
 * second factor after confirming who they are, and unlink a replaced SSO account. The API enforces all of it.
 */
function SignInControls({ user, onChanged }: { user: UserSummary; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const stepUp = useStepUp();
  const identities = useApi<Array<{ connectionId: string; connectionName: string }>>(
    `/v1/users/${user.id}/sso-identities`,
  );
  const done = (title: string) => (toast({ title, tone: 'success' }), onChanged());
  const fail = (err: unknown) => toast({ title: problemMessage(t, err), tone: 'danger' });
  // the confirmation closes first; a re-authentication prompt may follow
  const guarded = (call: () => Promise<unknown>, message: string) => async () => {
    void stepUp
      .run(call)
      .then((ok) => ok && done(message))
      .catch(fail);
  };
  const button = 'h-11 sm:h-8';
  const linked = identities.data ?? [];
  return (
    <ListSection
      id="user-sign-in"
      title={t('access.users.signIn.title')}
      description={t('access.users.signIn.body')}
      footer={t('access.users.signIn.whoCan')}
    >
      <ListItem
        leading={<LogOut />}
        title={t('access.users.signIn.endSessions')}
        subtitle={t('access.users.signIn.endSessionsLead')}
        actions={
          <ConfirmAction
            label={t('access.users.signIn.endSessions')}
            title={t('access.users.signIn.endSessionsTitle', { name: user.displayName })}
            body={t('access.users.signIn.endSessionsBody')}
            confirmLabel={t('access.users.signIn.endSessions')}
            triggerVariant="secondary"
            triggerClassName={button}
            onConfirm={() =>
              api(`/v1/users/${user.id}/sessions/end`, {
                method: 'POST',
                capability: 'settings.users.manage',
              }).then(() => done(t('access.users.signIn.sessionsEnded')))
            }
          />
        }
      />
      {user.status === 'active' ? (
        <ListItem
          leading={<KeyRound />}
          title={t('access.users.signIn.sendReset')}
          subtitle={t('access.users.signIn.sendResetLead')}
          actions={
            <ConfirmAction
              label={t('access.users.signIn.sendReset')}
              title={t('access.users.signIn.sendResetTitle', { name: user.displayName })}
              body={t('access.users.signIn.sendResetBody')}
              confirmLabel={t('access.users.signIn.sendResetConfirm')}
              triggerVariant="secondary"
              triggerClassName={button}
              onConfirm={guarded(
                () =>
                  api(`/v1/users/${user.id}/password-reset`, {
                    method: 'POST',
                    capability: 'settings.users.manage',
                  }),
                t('access.users.signIn.resetSent'),
              )}
            />
          }
        />
      ) : null}
      {user.hasMfa ? (
        <ListItem
          leading={<ShieldOff />}
          title={t('access.users.signIn.resetMfa')}
          subtitle={t('access.users.signIn.resetMfaLead')}
          actions={
            <ConfirmAction
              label={t('access.users.signIn.resetMfa')}
              title={t('access.users.signIn.resetMfaTitle', { name: user.displayName })}
              body={t('access.users.signIn.resetMfaBody')}
              confirmLabel={t('access.users.signIn.resetMfaConfirm')}
              triggerVariant="secondary"
              triggerClassName={button}
              onConfirm={guarded(
                () =>
                  api(`/v1/users/${user.id}/mfa/reset`, {
                    method: 'POST',
                    json: { identityConfirmed: true },
                    capability: 'settings.users.manage',
                  }),
                t('access.users.signIn.mfaReset'),
              )}
            />
          }
        />
      ) : null}
      {linked.length ? (
        <ListItem
          leading={<Link2Off />}
          title={t('access.users.signIn.unlinkSso')}
          subtitle={linked
            .map((l) => t('access.users.signIn.linkedTo', { connection: l.connectionName }))
            .join(' · ')}
          actions={
            <ConfirmAction
              label={t('access.users.signIn.unlinkSso')}
              title={t('access.users.signIn.unlinkSsoTitle', { name: user.displayName })}
              body={t('access.users.signIn.unlinkSsoBody')}
              confirmLabel={t('access.users.signIn.unlinkSso')}
              triggerVariant="secondary"
              triggerClassName={button}
              onConfirm={guarded(async () => {
                await api(`/v1/users/${user.id}/sso-identities`, {
                  method: 'DELETE',
                  capability: 'settings.users.manage',
                });
                identities.reload();
              }, t('access.users.signIn.unlinked'))}
            />
          }
        />
      ) : null}
      {stepUp.dialog}
    </ListSection>
  );
}

export default function UserAccessPage() {
  const t = useT();
  const inModule = useInModule();
  const sec = useSectionLevel();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<{ user: UserSummary; assignments: Assignment[] }>(
    `/v1/users/${id}/role-assignments`,
  );
  const roles = useApi<Role[]>('/v1/roles');
  const can = useCan();
  const canAssign = can('settings.users.assign');
  const [roleId, setRoleId] = React.useState('');
  const [scopeType, setScopeType] = React.useState<ScopeType>('all');
  const [values, setValues] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const options = useScopeOptions(scopeType);
  const zone = session?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (error)
    return (
      <EmptyState
        level={inModule ? 2 : 1}
        title={error.status === 403 ? t('errors.forbidden') : t('errors.notFound')}
      />
    );
  if (!data) return <Skeleton className="h-96 w-full" />;
  const { user, assignments } = data;
  const chosen = roles.data?.find((r) => r.id === roleId);

  async function assign(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/v1/users/${id}/role-assignments`, {
        method: 'POST',
        json: { roleId, scope: { type: scopeType, values: VALUED.includes(scopeType) ? values : [] } },
        capability: 'settings.users.assign',
      });
      toast({ title: t('access.users.assigned'), tone: 'success' });
      setRoleId('');
      setValues([]);
      reload();
    } catch (err) {
      toast({ title: problemMessage(t, err), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }
  async function revoke(a: Assignment) {
    try {
      await api(`/v1/users/${id}/role-assignments/${a.id}`, {
        method: 'DELETE',
        capability: 'settings.users.assign',
      });
      toast({ title: t('access.users.revoked'), tone: 'success' });
      reload();
    } catch (err) {
      toast({ title: problemMessage(t, err), tone: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-4">
        <span
          aria-hidden
          className="flex h-14 w-14 items-center justify-center rounded-pill bg-accent-subtle text-title-3 text-accent"
        >
          {user.displayName
            .split(' ')
            .map((p) => p[0])
            .slice(0, 2)
            .join('')}
        </span>
        <div className="mr-auto">
          <PageTitle>{user.displayName}</PageTitle>
          <p className="break-all text-callout text-text-secondary">{user.email}</p>
          <span className="mt-2 flex flex-wrap gap-2">
            {user.hasMfa ? (
              <Badge tone="success">{t('access.users.mfaOn')}</Badge>
            ) : (
              <Badge tone="warning">{t('access.users.mfaOff')}</Badge>
            )}
            {user.status !== 'active' ? <Badge>{t(`access.users.status.${user.status}`)}</Badge> : null}
          </span>
        </div>
      </div>

      {can('settings.users.manage') && user.id !== session?.userId ? (
        <SignInControls user={user} onChanged={reload} />
      ) : null}

      <PageSection headingLevel={sec.level} title={t('access.users.assignmentsTitle')}>
        {assignments.length === 0 ? (
          <Card>
            <EmptyState
              level={sec.level}
              icon={<ShieldCheck aria-hidden />}
              title={t('access.users.noAssignments')}
            />
          </Card>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>{t('access.users.colRole')}</TH>
                <TH>{t('access.users.colScope')}</TH>
                <TH className="hidden md:table-cell">{t('access.users.colAdded')}</TH>
                <TH>
                  <span className="sr-only">{t('common.actions')}</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {assignments.map((a) => {
                const name = roleName(t, { key: a.roleKey, name: a.roleName, builtIn: a.builtIn });
                return (
                  <TR key={a.id}>
                    <TD>
                      <span className="flex flex-wrap items-center gap-2">
                        <Link href={`/app/settings/roles/${a.roleId}`}>{name}</Link>
                        {a.isAdmin ? <Badge tone="warning">{t('access.roles.admin')}</Badge> : null}
                      </span>
                    </TD>
                    <TD label={t('access.users.colScope')}>{scopeSummary(t, a)}</TD>
                    <TD className="hidden text-text-secondary md:table-cell" phone="hide">
                      {formatDateTime(a.createdAt, locale, zone)}
                    </TD>
                    <TD className="text-right">
                      {canAssign && a.canRevoke ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => revoke(a)}
                          aria-label={t('access.users.revokeLabel', {
                            role: name,
                            scope: scopeSummary(t, a),
                          })}
                        >
                          <UserMinus aria-hidden className="h-4 w-4 stroke-[1.5]" />
                          {t('access.users.revoke')}
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        )}
      </PageSection>

      {canAssign ? (
        <PageSection headingLevel={sec.level} title={t('access.users.assignTitle')}>
          <Card>
            <form onSubmit={assign} className="flex flex-col gap-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Field id="assign-role" label={t('access.users.role')}>
                  {(p) => (
                    <select
                      {...p}
                      required
                      value={roleId}
                      onChange={(e) => setRoleId(e.target.value)}
                      className={selectClass}
                    >
                      <option value="">{t('access.users.chooseRole')}</option>
                      {(roles.data ?? []).map((r) => (
                        <option key={r.id} value={r.id}>
                          {roleName(t, r)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field id="assign-scope" label={t('access.users.scopeType')}>
                  {(p) => (
                    <select
                      {...p}
                      value={scopeType}
                      onChange={(e) => {
                        setScopeType(e.target.value as ScopeType);
                        setValues([]);
                      }}
                      className={selectClass}
                    >
                      {SCOPES.map((s) => (
                        <option key={s} value={s}>
                          {t(`access.scope.${s}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </div>
              {VALUED.includes(scopeType) ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-callout font-semibold">{t('access.users.scopeValues')}</legend>
                  {!options ? (
                    <Skeleton className="h-10 w-64" />
                  ) : options.length === 0 ? (
                    <p className="text-callout text-text-secondary">{t('access.users.noScopeValues')}</p>
                  ) : (
                    <div className="flex flex-wrap gap-x-6 gap-y-2">
                      {options.map((o) => (
                        <label key={o.value} className="flex items-center gap-2 text-callout">
                          <input
                            type="checkbox"
                            className="h-5 w-5 accent-[var(--color-accent)]"
                            checked={values.includes(o.value)}
                            onChange={(e) =>
                              setValues((v) =>
                                e.target.checked ? [...v, o.value] : v.filter((x) => x !== o.value),
                              )
                            }
                          />
                          {o.label}
                        </label>
                      ))}
                    </div>
                  )}
                </fieldset>
              ) : null}
              {chosen?.isAdmin && !user.hasMfa ? (
                <p role="status" className="max-w-[var(--prose-width)] text-callout text-warning">
                  {t('access.users.adminNoMfa')}
                </p>
              ) : null}
              <div>
                <Button
                  type="submit"
                  loading={busy}
                  disabled={!roleId || (VALUED.includes(scopeType) && values.length === 0)}
                >
                  {t('access.users.assign')}
                </Button>
              </div>
            </form>
          </Card>
        </PageSection>
      ) : null}
    </div>
  );
}
