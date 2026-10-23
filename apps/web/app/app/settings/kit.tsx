'use client';
import * as React from 'react';
import { Copy } from 'lucide-react';
import { Button, Card, CardTitle, cn, Dialog, DialogContent, DialogTrigger, Input, useToast } from '@thapsus/ui';
import { BUILT_IN_ROLES } from '@thapsus/core/roles';
import { formatDate, formatDateTime } from '@thapsus/core/i18n';
import { instantToDate } from '@thapsus/core/time';
import { ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi, useDebounced } from '@/lib/use-api';
import { viewerZone } from '@/lib/week';
import { hasPermission, useSession } from '../shell';

/** Shared building blocks for the settings screens (tokens and @thapsus/ui components only). */

export const selectClass = 'h-10 w-full rounded-sm border border-border-strong bg-surface-raised px-2 text-callout text-text';
const choiceClass = 'mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-accent)]';

/** `has(permission)` for the signed-in user (the API enforces the same keys and their scope). */
export function usePermission() {
  const session = useSession();
  return React.useCallback((p: string) => hasPermission(session, p), [session]);
}

/** Locale- and zone-aware formatting for the viewer (calendar dates never shift). */
export function useFormat() {
  const locale = useLocale();
  const session = useSession();
  const zone = viewerZone(session?.timeZone);
  return React.useMemo(
    () => ({
      zone,
      locale,
      date: (civil: string) => formatDate(civil, locale),
      instantDate: (instant: string) => formatDate(instantToDate(instant, zone), locale),
      dateTime: (instant: string) => formatDateTime(instant, locale, zone),
    }),
    [locale, zone],
  );
}

/** The API's explanation when it gives one (e.g. why a change was refused), else its title. */
export function problemText(err: unknown, fallback: string): string {
  if (err instanceof ApiProblem) return typeof err.body.detail === 'string' && err.body.detail ? err.body.detail : err.title;
  return fallback;
}

/**
 * Runs an async action with a busy flag. A failure becomes `error`, which callers render with
 * <FormError> (announced by screen readers); success can show a toast.
 */
export function useAction() {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const run = React.useCallback(
    async (fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        if (success) toast({ title: success, tone: 'success' });
        return true;
      } catch (err) {
        setError(problemText(err, t('common.error')));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [t, toast],
  );
  return { busy, error, setError, run };
}

export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-callout text-danger">
      {message}
    </p>
  );
}

export function PageHeader({ title, lead, children }: { title: string; lead?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="mr-auto max-w-[var(--prose-width)]">
        <h1 className="text-title-2">{title}</h1>
        {lead ? <p className="mt-1 text-callout text-text-secondary">{lead}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** A titled card that is also a labelled region, so screen-reader users can jump between sections. */
export function SettingsCard({ id, title, description, actions, children, className }: { id: string; title: string; description?: string; actions?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <section aria-labelledby={`${id}-title`}>
      <Card className={cn('flex flex-col gap-4', className)}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto max-w-[var(--prose-width)]">
            <CardTitle id={`${id}-title`}>{title}</CardTitle>
            {description ? <p className="mt-1 text-callout text-text-secondary">{description}</p> : null}
          </div>
          {actions}
        </div>
        {children}
      </Card>
    </section>
  );
}

/** Shown instead of a form when the user may look but not change. */
export function ReadOnlyNote() {
  const t = useT();
  return <p className="rounded-md bg-surface p-3 text-callout text-text-secondary">{t('admin.readOnly')}</p>;
}

export function Checkbox({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" className={choiceClass} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined} />
      <div className="flex flex-col">
        <label htmlFor={id} className="text-callout font-semibold">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-footnote text-text-secondary">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function RadioGroup<V extends string>({ name, legend, value, options, onChange, disabled, className }: { name: string; legend: string; value: V; options: Array<{ value: V; label: string; hint?: string }>; onChange: (v: V) => void; disabled?: boolean; className?: string }) {
  return (
    <fieldset className={cn('flex flex-col gap-2', className)} disabled={disabled}>
      <legend className="mb-1 text-callout font-semibold">{legend}</legend>
      {options.map((o) => {
        const id = `${name}-${o.value}`;
        return (
          <div key={o.value} className="flex items-start gap-3">
            <input type="radio" id={id} name={name} value={o.value} className={choiceClass} checked={value === o.value} onChange={() => onChange(o.value)} aria-describedby={o.hint ? `${id}-hint` : undefined} />
            <div className="flex flex-col">
              <label htmlFor={id} className="text-callout">
                {o.label}
              </label>
              {o.hint ? (
                <p id={`${id}-hint`} className="text-footnote text-text-secondary">
                  {o.hint}
                </p>
              ) : null}
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}

/** A value to paste into another system (an IdP, a directory), with a copy button. */
export function CopyValue({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const t = useT();
  const toast = useToast();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-footnote font-semibold text-text-secondary">{label}</span>
      <div className="flex items-center gap-2">
        <code data-testid={testId} className="min-w-0 flex-1 break-all rounded-sm bg-surface px-3 py-2 text-footnote">
          {value}
        </code>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t('admin.copyLabel', { label })}
          title={t('admin.copy')}
          onClick={async () => {
            await navigator.clipboard?.writeText(value).catch(() => undefined);
            toast({ title: t('admin.copied') });
          }}
        >
          <Copy aria-hidden className="h-4 w-4 stroke-[1.5]" />
        </Button>
      </div>
    </div>
  );
}

/** A secret shown exactly once, right after it was created; it is never shown again. */
export function OnceSecret({ title, label, value, testId, onDone }: { title: string; label: string; value: string; testId?: string; onDone: () => void }) {
  const t = useT();
  return (
    <div role="status" className="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4">
      <p className="text-callout font-semibold">{title}</p>
      <p className="text-footnote text-text-secondary">{t('admin.secretOnce')}</p>
      <CopyValue label={label} value={value} testId={testId} />
      <Button type="button" size="sm" variant="secondary" className="self-start" onClick={onDone}>
        {t('admin.secretDone')}
      </Button>
    </div>
  );
}

/** A destructive action behind a confirmation dialog (keyboard and screen-reader friendly). */
export function ConfirmAction({ label, ariaLabel, title, body, confirmLabel, onConfirm, disabled }: { label: string; ariaLabel?: string; title: string; body: string; confirmLabel: string; onConfirm: () => Promise<unknown>; disabled?: boolean }) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const action = useAction();
  return (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), action.setError(null))}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="ghost" aria-label={ariaLabel} disabled={disabled}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent title={title} description={body} closeLabel={t('common.close')}>
        <div className="flex flex-col gap-3">
          <FormError message={action.error} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" variant="danger" loading={action.busy} onClick={async () => (await action.run(onConfirm)) && setOpen(false)}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface Candidate {
  userId: string;
  displayName: string;
  jobTitle: string | null;
}

/** Picks a colleague's user account by name (approvers, task assignees, delegates). */
export function UserPicker({ id, label, value, onChange, required }: { id: string; label: string; value: string; onChange: (userId: string) => void; required?: boolean }) {
  const t = useT();
  const [q, setQ] = React.useState('');
  const query = useDebounced(q.trim());
  const { data } = useApi<Candidate[]>(`/v1/delegations/candidates${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  const options = data ?? [];
  const known = !value || options.some((o) => o.userId === value);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-callout font-semibold">{label}</legend>
      <Input type="search" id={`${id}-search`} aria-label={t('admin.userPicker.search', { label })} placeholder={t('admin.userPicker.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
      <select id={id} aria-label={t('admin.userPicker.choose', { label })} required={required} value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
        <option value="">{t('admin.userPicker.none')}</option>
        {!known ? <option value={value}>{t('admin.userPicker.current')}</option> : null}
        {options.map((o) => (
          <option key={o.userId} value={o.userId}>
            {o.jobTitle ? `${o.displayName} · ${o.jobTitle}` : o.displayName}
          </option>
        ))}
      </select>
    </fieldset>
  );
}

export const ROLE_KEYS = BUILT_IN_ROLES.map((r) => r.key);

/** Built-in roles by their translated names; a custom role already in use is kept as its key. */
export function RoleSelect({ id, value, onChange, ...rest }: { id: string; value: string; onChange: (key: string) => void; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) {
  const t = useT();
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={selectClass} aria-describedby={rest['aria-describedby']} aria-invalid={rest['aria-invalid']}>
      {value && !ROLE_KEYS.includes(value) ? <option value={value}>{value}</option> : null}
      {ROLE_KEYS.map((k) => (
        <option key={k} value={k}>
          {t(`roles.${k}`)}
        </option>
      ))}
    </select>
  );
}

/** Reference data used by several forms (visible to everyone signed in). */
export function useOrg<T = { id: string; name: string }>(kind: 'legal-entities' | 'locations' | 'departments') {
  return useApi<Array<T & { id: string; name: string }>>(`/v1/org/${kind}`);
}

/** Converts an optional number input to a number or undefined (empty means "not set"). */
export const numberOrUndefined = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

/** Approver or task-assignee picker: a kind, plus a role or a person where the kind needs one. */
export interface AssigneeDraft {
  type: string;
  value: string;
}
export function AssigneeFields({ id, legend, types, labelKey, value, onChange }: { id: string; legend: string; types: string[]; labelKey: string; value: AssigneeDraft; onChange: (v: AssigneeDraft) => void }) {
  const t = useT();
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-callout font-semibold">{legend}</legend>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-type`} className="text-footnote font-semibold text-text-secondary">
          {t('admin.assignee.kind')}
        </label>
        <select id={`${id}-type`} className={selectClass} value={value.type} onChange={(e) => onChange({ type: e.target.value, value: e.target.value === 'role' ? 'hr_admin' : '' })}>
          {types.map((k) => (
            <option key={k} value={k}>
              {t(`${labelKey}.${k}`)}
            </option>
          ))}
        </select>
      </div>
      {value.type === 'role' ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-role`} className="text-footnote font-semibold text-text-secondary">
            {t('admin.assignee.role')}
          </label>
          <RoleSelect id={`${id}-role`} value={value.value} onChange={(role) => onChange({ ...value, value: role })} />
        </div>
      ) : null}
      {value.type === 'user' ? <UserPicker id={`${id}-user`} label={t('admin.assignee.person')} required value={value.value} onChange={(userId) => onChange({ ...value, value: userId })} /> : null}
    </fieldset>
  );
}

/** A role's display name: built-in roles are translated, custom role keys are shown as they are. */
export function useRoleName() {
  const t = useT();
  return React.useCallback((key: string | undefined) => (key && ROLE_KEYS.includes(key) ? t(`roles.${key}`) : (key ?? '')), [t]);
}
