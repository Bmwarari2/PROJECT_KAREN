'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Copy, Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Dialog, DialogClose, DialogContent, DialogTrigger, Field, Input, Skeleton, Table, TD, TH, THead, TR, Textarea, buttonVariants, useToast } from '@thapsus/ui';
import { actionMatches } from '@thapsus/core/permissions';
import { api } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { adminGrade, fieldLabel, permissionLabel, problemMessage, roleName, type Catalogue, type FieldLevel, type Role } from './shared';

const LEVELS: FieldLevel[] = ['none', 'read', 'write'];
const checkbox = 'h-5 w-5 shrink-0 accent-[var(--color-accent)]';

/** Derives an identifier from a name: lower-case letters, digits and underscores, starting with a letter. */
function keyFrom(name: string) {
  const k = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 41);
  return k.length >= 2 ? k : '';
}

interface Props {
  /** Existing role to view (built-in) or edit (custom). */
  role?: Role;
  /** Built-in or custom role to start a new role from. */
  copyFrom?: Role;
  canManage: boolean;
}

export function RoleEditor({ role, copyFrom, canManage }: Props) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const router = useRouter();
  const catalogue = useApi<Catalogue>('/v1/roles/catalogue');
  const source = role ?? copyFrom;
  const readOnly = !canManage || !!role?.builtIn;
  const creating = !role;
  const [name, setName] = React.useState(role ? role.name : copyFrom ? t('access.editor.copyOf', { name: roleName(t, copyFrom) }) : '');
  const [key, setKey] = React.useState(role?.key ?? '');
  const [keyEdited, setKeyEdited] = React.useState(false);
  const [description, setDescription] = React.useState(source?.description ?? '');
  const [isAdmin, setIsAdmin] = React.useState(source?.isAdmin ?? false);
  const [perms, setPerms] = React.useState<Set<string>>(new Set((source?.permissions ?? []).filter((p) => p !== '*')));
  const [fields, setFields] = React.useState<Record<string, FieldLevel>>(Object.fromEntries(Object.entries(source?.fieldAccess ?? {}).filter(([k]) => k !== '*')));
  const [saving, setSaving] = React.useState(false);
  const autoKey = creating && !keyEdited ? keyFrom(name) : key;
  const forcedAdmin = adminGrade(catalogue.data, perms);

  if (!catalogue.data) return <Skeleton className="h-96 w-full" />;
  const cat = catalogue.data;
  const coveredByWildcard = (k: string) => [...perms].some((p) => p !== k && actionMatches(p, k));

  function toggle(p: string, on: boolean) {
    setPerms((prev) => {
      const next = new Set(prev);
      if (on) next.add(p);
      else next.delete(p);
      return next;
    });
  }
  function setLevel(k: string, level: FieldLevel | 'default') {
    setFields((prev) => {
      const next = { ...prev };
      if (level === 'default') delete next[k];
      else next[k] = level;
      return next;
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      // a wildcard already grants its keys: keep the definition minimal
      const list = [...perms].filter((p) => !coveredByWildcard(p)).sort();
      const body = { name: name.trim(), description: description.trim() || null, permissions: list, fieldAccess: fields, isAdmin: isAdmin || forcedAdmin };
      if (creating) {
        const created = await api<Role>('/v1/roles', { method: 'POST', json: { ...body, key: autoKey } });
        toast({ title: t('access.editor.created'), tone: 'success' });
        router.push(`/app/settings/roles/${created.id}`);
      } else {
        await api<Role>(`/v1/roles/${role!.id}`, { method: 'PATCH', json: body });
        toast({ title: t('access.editor.saved'), tone: 'success' });
      }
    } catch (err) {
      toast({ title: problemMessage(t, err), tone: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await api(`/v1/roles/${role!.id}`, { method: 'DELETE' });
      toast({ title: t('access.editor.deleted'), tone: 'success' });
      router.push('/app/settings/roles');
    } catch (err) {
      toast({ title: problemMessage(t, err), tone: 'danger' });
    }
  }

  // Field matrix: the All fields row, then one row group per section (with its group wildcard where one exists).
  type Row = { key: string; label: string; group?: boolean };
  const groups: Array<{ section: string | null; rows: Row[] }> = [{ section: null, rows: [{ key: 'employee.*', label: t('access.editor.allFields'), group: true }] }];
  for (const s of [...new Set(cat.fields.map((f) => f.section))]) {
    const rows: Row[] = cat.fieldGroups.includes(s) ? [{ key: `employee.${s}.*`, label: fieldLabel(t, `employee.${s}.*`), group: true }] : [];
    for (const f of cat.fields.filter((x) => x.section === s)) rows.push({ key: `employee.${f.key}`, label: fieldLabel(t, `employee.${f.key}`) });
    groups.push({ section: s, rows });
  }
  if (cat.customFields.length) {
    groups.push({
      section: 'custom',
      rows: [{ key: 'employee.custom.*', label: fieldLabel(t, 'employee.custom.*'), group: true }, ...cat.customFields.map((c) => ({ key: `employee.custom.${c.key}`, label: fieldLabel(t, `employee.custom.${c.key}`, cat.customFields, locale) }))],
    });
  }
  const shown = new Set(groups.flatMap((g) => g.rows.map((r) => r.key)));
  const otherRules = Object.entries(source?.fieldAccess ?? {}).filter(([k]) => !shown.has(k));

  const title = role ? roleName(t, role) : t('access.editor.createTitle');
  return (
    <form onSubmit={save} className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-title-2">{title}</h1>
        {role?.builtIn ? <Badge>{t('access.roles.builtIn')}</Badge> : null}
        {role && canManage && !role.permissions.includes('*') ? (
          <Link href={`/app/settings/roles/new?copy=${role.id}`} className={buttonVariants({ size: 'sm', variant: 'secondary' }) + ' no-underline'}>
            <Copy aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('access.roles.copy')}
          </Link>
        ) : null}
        {role && !readOnly ? (
          <Dialog>
            <DialogTrigger asChild>
              <Button type="button" size="sm" variant="secondary">
                <Trash2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
                {t('access.editor.delete')}
              </Button>
            </DialogTrigger>
            <DialogContent title={t('access.editor.deleteTitle')} description={t('access.editor.deleteBody')} closeLabel={t('common.close')}>
              <div className="flex justify-end gap-3">
                <DialogClose asChild>
                  <Button type="button" variant="secondary">
                    {t('common.cancel')}
                  </Button>
                </DialogClose>
                <Button type="button" variant="danger" onClick={remove}>
                  {t('access.editor.delete')}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>
      <Link href="/app/settings/roles" className="text-callout">
        {t('access.roles.back')}
      </Link>
      {role?.builtIn ? <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">{t('access.roles.readOnly')}</p> : null}

      <Card className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="role-name" label={t('access.editor.name')}>
            {(p) => <Input {...p} required maxLength={120} disabled={readOnly} value={role?.builtIn ? roleName(t, role) : name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field id="role-key" label={t('access.editor.key')} hint={creating ? t('access.editor.keyHint') : undefined}>
            {(p) => (
              <Input
                {...p}
                required
                pattern="[a-z][a-z0-9_]{1,40}"
                disabled={!creating || readOnly}
                value={autoKey}
                onChange={(e) => {
                  setKeyEdited(true);
                  setKey(e.target.value);
                }}
              />
            )}
          </Field>
        </div>
        <Field id="role-description" label={t('access.editor.description')}>
          {(p) => <Textarea {...p} rows={2} maxLength={500} disabled={readOnly} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <div className="flex items-start gap-3">
          <input id="role-admin" type="checkbox" className={`${checkbox} mt-0.5`} disabled={readOnly || forcedAdmin} checked={isAdmin || forcedAdmin} onChange={(e) => setIsAdmin(e.target.checked)} aria-describedby="role-admin-hint" />
          <div>
            <label htmlFor="role-admin" className="text-callout font-semibold">
              {t('access.editor.isAdmin')}
            </label>
            <p id="role-admin-hint" className="text-footnote text-text-secondary">
              {forcedAdmin ? t('access.editor.isAdminForced') : t('access.editor.isAdminHint')}
            </p>
          </div>
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <CardTitle>{t('access.editor.permissionsTitle')}</CardTitle>
        <p className="text-callout text-text-secondary">{t('access.editor.permissionsBody')}</p>
        {source?.permissions.includes('*') ? <p className="text-callout font-semibold">{t('access.roles.allPermissions')}</p> : null}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cat.areas.map((a) => {
            const wildcard = `${a.area}.*`;
            const all = source?.permissions.includes('*') || perms.has(wildcard);
            return (
              <fieldset key={a.area} className="flex flex-col gap-2 rounded-md border border-border p-4">
                <legend className="px-1 text-callout font-semibold">{t(`access.area.${a.area}`)}</legend>
                <label className="flex items-start gap-3 text-footnote text-text-secondary">
                  <input type="checkbox" className={checkbox} disabled={readOnly} checked={!!all} onChange={(e) => toggle(wildcard, e.target.checked)} />
                  <span>{t('access.editor.allInArea', { area: t(`access.area.${a.area}`) })}</span>
                </label>
                {a.permissions.map((perm) => {
                  const covered = !!source?.permissions.includes('*') || coveredByWildcard(perm.key);
                  return (
                    <label key={perm.key} className="flex items-start gap-3 text-callout">
                      <input type="checkbox" className={checkbox} disabled={readOnly || covered} checked={covered || perms.has(perm.key)} onChange={(e) => toggle(perm.key, e.target.checked)} />
                      <span className="flex flex-wrap items-center gap-2">
                        {permissionLabel(t, perm.key)}
                        {perm.admin ? <Badge tone="warning">{t('access.editor.adminPermission')}</Badge> : null}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            );
          })}
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <CardTitle>{t('access.editor.fieldsTitle')}</CardTitle>
        <p className="text-callout text-text-secondary">{t('access.editor.fieldsBody')}</p>
        <div className="overflow-x-auto">
          <Table dense>
            <THead>
              <tr>
                <TH>{t('access.editor.fieldCol')}</TH>
                <TH className="text-center">{t('access.editor.level.default')}</TH>
                {LEVELS.map((l) => (
                  <TH key={l} className="text-center">
                    {t(`access.editor.level.${l}`)}
                  </TH>
                ))}
              </tr>
            </THead>
            {groups.map((g) => (
              <tbody key={g.section ?? 'all'}>
                {g.section ? (
                  <tr>
                    <th scope="rowgroup" colSpan={5} className="px-4 pb-1 pt-4 text-left text-footnote font-semibold text-text-secondary">
                      {t(`access.section.${g.section}`)}
                    </th>
                  </tr>
                ) : null}
                {g.rows.map((r) => {
                  const current = fields[r.key] ?? 'default';
                  return (
                    <TR key={r.key}>
                      <TH scope="row" className={r.group ? 'font-semibold' : 'font-normal'}>
                        {r.label}
                      </TH>
                      {(['default', ...LEVELS] as const).map((l) => (
                        <TD key={l} className="text-center">
                          <input
                            type="radio"
                            className={checkbox}
                            name={`fa-${r.key}`}
                            value={l}
                            disabled={readOnly}
                            checked={current === l}
                            onChange={() => setLevel(r.key, l)}
                            aria-label={t('access.editor.fieldLevelLabel', { field: r.label, level: t(`access.editor.level.${l}`) })}
                          />
                        </TD>
                      ))}
                    </TR>
                  );
                })}
              </tbody>
            ))}
          </Table>
        </div>
        {otherRules.length ? (
          <div>
            <h4 className="text-callout font-semibold">{t('access.editor.otherRules')}</h4>
            <ul className="mt-2 flex flex-col gap-1 text-callout text-text-secondary">
              {otherRules.map(([k, v]) => (
                <li key={k}>
                  {k === '*' ? t('access.editor.allFields') : fieldLabel(t, k, cat.customFields, locale)}: {t(`access.editor.level.${v}`)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      {!readOnly ? (
        <div className="flex justify-end">
          <Button type="submit" loading={saving}>
            {creating ? t('access.editor.create') : t('access.editor.save')}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
