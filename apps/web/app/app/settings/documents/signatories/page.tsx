'use client';
import * as React from 'react';
import { PenLine, Trash2, UserRound } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  ListItem,
  ListSection,
  PageSection,
  Skeleton,
  useToast,
} from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { useStepUp } from '../../../step-up';
import {
  Checkbox,
  FormError,
  PageHeader,
  ReadOnlyNote,
  ROLE_KEYS,
  UserPicker,
  usePermission,
  useRoleName,
} from '../../kit';

interface Signatories {
  isDefault: boolean;
  entries: Array<{
    kind: 'role' | 'user';
    roleKey: string | null;
    userId: string | null;
    name: string | null;
  }>;
  people: Array<{ userId: string; name: string }>;
}

/**
 * Settings → Documents → Authorised signatories (16.12, ADR-0196): who may sign documents for the company, by role
 * or by name. Until a list is saved, HR admins and owners sign (ADR-0187). Whoever is listed signs in the document
 * viewer after a step-up re-authentication, and never on their own document. Changing the list needs a recent
 * sign-in too, and is audited.
 */
export default function SignatoriesPage() {
  const t = useT();
  const toast = useToast();
  const has = usePermission();
  const roleName = useRoleName();
  const stepUp = useStepUp();
  const canManage = has('documents.manage');
  const { data, reload, setData } = useApi<Signatories>(canManage ? '/v1/document-signatories' : null);
  const [roles, setRoles] = React.useState<string[] | null>(null);
  const [users, setUsers] = React.useState<Array<{ userId: string; name: string }> | null>(null);
  const [pick, setPick] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  if (!canManage) return <ReadOnlyNote />;
  if (!data) return <Skeleton className="h-64 w-full" />;
  const shownRoles = roles ?? data.entries.filter((e) => e.kind === 'role').map((e) => e.roleKey!);
  const shownUsers =
    users ??
    data.entries.filter((e) => e.kind === 'user').map((e) => ({ userId: e.userId!, name: e.name ?? '' }));
  const changed = roles !== null || users !== null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const entries = [
        ...shownRoles.map((roleKey) => ({ kind: 'role' as const, roleKey })),
        ...shownUsers.map((u) => ({ kind: 'user' as const, userId: u.userId })),
      ];
      const ok = await stepUp.run(async () => {
        const r = await api<Signatories>('/v1/document-signatories', { method: 'PUT', json: { entries } });
        setData(r);
      });
      if (!ok) return;
      setRoles(null);
      setUsers(null);
      toast({ title: t('docSignatories.saved'), tone: 'success' });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.title : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('admin.section.signatories.title')} lead={t('docSignatories.lead')} />
      {data.isDefault ? (
        <p className="rounded-md bg-surface p-3 text-callout text-text-secondary" role="note">
          {t('docSignatories.default')}
        </p>
      ) : null}
      <PageSection
        title={t('docSignatories.roles')}
        description={t('docSignatories.rolesLead')}
        headingLevel={3}
      >
        <Card className="flex flex-col gap-3">
          {ROLE_KEYS.map((k) => (
            <Checkbox
              key={k}
              id={`signatory-role-${k}`}
              label={roleName(k)}
              checked={shownRoles.includes(k)}
              onChange={(on) => setRoles(on ? [...shownRoles, k] : shownRoles.filter((r) => r !== k))}
            />
          ))}
        </Card>
      </PageSection>
      <PageSection
        title={t('docSignatories.people')}
        description={t('docSignatories.peopleLead')}
        headingLevel={3}
      >
        <Card className="flex flex-col gap-4">
          {shownUsers.length ? (
            <ul className="flex flex-col">
              {shownUsers.map((u) => (
                <li
                  key={u.userId}
                  className="flex min-h-11 items-center gap-3 border-b border-border py-2 last:border-b-0"
                >
                  <UserRound aria-hidden className="h-5 w-5 shrink-0 stroke-[1.5] text-accent" />
                  <span className="min-w-0 flex-1 text-callout wrap-anywhere">{u.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11"
                    aria-label={t('docSignatories.remove', { name: u.name })}
                    onClick={() => setUsers(shownUsers.filter((x) => x.userId !== u.userId))}
                  >
                    <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-callout text-text-secondary">{t('docSignatories.noPeople')}</p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1">
              <UserPicker
                id="signatory-user"
                label={t('docSignatories.add')}
                value={pick}
                onChange={setPick}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              disabled={!pick || shownUsers.some((u) => u.userId === pick)}
              onClick={async () => {
                const label =
                  document.querySelector<HTMLSelectElement>('#signatory-user')?.selectedOptions[0]?.text ??
                  '';
                setUsers([...shownUsers, { userId: pick, name: label.split(' · ')[0] ?? label }]);
                setPick('');
              }}
            >
              {t('docSignatories.addButton')}
            </Button>
          </div>
        </Card>
      </PageSection>
      <FormError message={error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          className="min-h-11"
          loading={busy}
          disabled={!changed || (!shownRoles.length && !shownUsers.length)}
          onClick={save}
        >
          {t('docSignatories.save')}
        </Button>
        {changed ? (
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => {
              setRoles(null);
              setUsers(null);
              reload();
            }}
          >
            {t('common.cancel')}
          </Button>
        ) : null}
      </div>
      {data.people.length ? (
        <ListSection
          title={t('docSignatories.now')}
          description={t('docSignatories.nowLead')}
          headingLevel={3}
          id="signatories-now"
        >
          {data.people.map((p) => (
            <ListItem key={p.userId} leading={<PenLine />} title={p.name} />
          ))}
        </ListSection>
      ) : (
        <EmptyState level={3} icon={<PenLine aria-hidden />} title={t('docSignatories.nobody')} />
      )}
      {stepUp.dialog}
    </div>
  );
}
