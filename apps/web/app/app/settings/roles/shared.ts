import { actionMatches } from '@thapsus/core/permissions';
import { ApiProblem } from '@/lib/api';

/** Shapes returned by /v1/roles and /v1/users (see the published OpenAPI document). */
export type FieldLevel = 'none' | 'read' | 'write';
export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  builtIn: boolean;
  isAdmin: boolean;
  permissions: string[];
  fieldAccess: Record<string, FieldLevel>;
  assignmentCount: number;
  updatedAt: string;
}
export interface Catalogue {
  areas: Array<{ area: string; permissions: Array<{ key: string; admin: boolean }> }>;
  fields: Array<{ key: string; section: string }>;
  fieldGroups: string[];
  customFields: Array<{ key: string; label: Record<string, string> }>;
  scopeTypes: string[];
}
export interface Assignment {
  id: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  builtIn: boolean;
  isAdmin: boolean;
  scope: { type: string; values: string[] };
  scopeLabels: string[];
  createdAt: string;
  createdBy: string | null;
  canRevoke: boolean;
}
export interface UserSummary {
  id: string;
  displayName: string;
  email: string;
  employeeId: string | null;
  status: string;
  hasMfa: boolean;
  roles: string[];
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Built-in roles are named from the catalogue (localised); custom roles by the customer. */
export function roleName(t: T, r: { key: string; name: string; builtIn: boolean }) {
  if (!r.builtIn) return r.name;
  const label = t(`roles.${r.key}`);
  return label === `roles.${r.key}` ? r.name : label;
}

/** Localised label for a permission string (area wildcards and `*` included). */
export function permissionLabel(t: T, perm: string) {
  if (perm === '*') return t('access.roles.allPermissions');
  if (perm.endsWith('.*'))
    return t('access.editor.allInArea', { area: t(`access.area.${perm.slice(0, -2)}`) });
  const label = t(`access.perm.${perm}`);
  return label === `access.perm.${perm}` ? perm : label;
}

export function scopeSummary(t: T, a: Pick<Assignment, 'scope' | 'scopeLabels'>) {
  const type = t(`access.scope.${a.scope.type}`);
  return a.scopeLabels.length
    ? t('access.users.scopeSummary', { type, values: a.scopeLabels.join(', ') })
    : type;
}

/** A readable message for a refused change (reason codes from the API), including what was not held. */
export function problemMessage(t: T, err: unknown) {
  if (!(err instanceof ApiProblem)) return t('common.error');
  const reason = typeof err.body.reason === 'string' ? err.body.reason : undefined;
  if (!reason) return err.title;
  const base = t(`access.errors.${reason}`, { count: Number(err.body.assignments ?? 0) });
  const missing = [
    ...((err.body.permissions as string[] | undefined) ?? []).map((p) => permissionLabel(t, p)),
    ...((err.body.fields as string[] | undefined) ?? []).map((f) => fieldLabel(t, f)),
  ];
  return missing.length ? `${base} ${t('access.errors.notHeld', { list: missing.join(', ') })}` : base;
}

/** Same rule as the API's: a role holding an admin-grade key (or a wildcard over one) is an admin role. */
export function adminGrade(cat: Catalogue | undefined, perms: Iterable<string>) {
  if (!cat) return false;
  const admin = cat.areas.flatMap((a) => a.permissions.filter((p) => p.admin).map((p) => p.key));
  return [...perms].some((p) => p === '*' || admin.some((k) => actionMatches(p, k)));
}

/** Localised label for a field-access key such as `employee.pay.amount` or `employee.pay.*`. */
export function fieldLabel(t: T, key: string, custom: Catalogue['customFields'] = [], locale = 'en-GB') {
  if (key === 'employee.*') return t('access.editor.allFields');
  const k = key.replace(/^employee\./, '');
  if (k.endsWith('.*'))
    return t('access.editor.allInGroup', { group: t(`access.section.${k.slice(0, -2)}`) });
  if (k.startsWith('custom.')) {
    const def = custom.find((c) => c.key === k.slice(7));
    return def ? (def.label[locale] ?? def.label['en-GB'] ?? Object.values(def.label)[0] ?? def.key) : k;
  }
  const label = t(`access.field.${k}`);
  return label === `access.field.${k}` ? key : label;
}
