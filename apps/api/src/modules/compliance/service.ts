import type { FastifyRequest } from 'fastify';
import type { Tx } from '@thapsus/db';
import type { Principal, RoleGrant, Target } from '@thapsus/core/permissions';
import { isLocale, t, type Locale } from '@thapsus/core/i18n';
import { requireAuth } from '../../http/context';
import { usersWithRole } from '../../lib/notify';
import type { VaultActor } from '../vault/service';

/**
 * Tenant compliance settings (app.tenants.features->'compliance'). These are product settings, not
 * law: reminder lead times, the small-cell threshold for sensitive aggregates, business weekdays for
 * I-9 deadlines and the sector used for gender pay gap dates. Statutory values always come from the
 * packs. Defaults are documented in ADR-0051.
 */
export interface ComplianceSettings {
  rtwReminderDays: number[];
  i9ReminderDays: number[];
  matrixReminderDays: number[];
  probationReminderDays: number[];
  serviceReminderDays: number[];
  /** Days before a document's expiry date to remind (library documents, and documents HR attached to a person other than right-to-work evidence, which uses rtwReminderDays). ADR-0169. */
  documentReminderDays: number[];
  smallCellThreshold: number;
  businessWeekdays: number[];
  gpgSector: 'privateAndVoluntary' | 'publicAuthority';
}

export const COMPLIANCE_DEFAULTS: ComplianceSettings = {
  rtwReminderDays: [90, 30, 7, 0],
  i9ReminderDays: [90, 30, 7, 0],
  matrixReminderDays: [60, 30, 7, 0],
  probationReminderDays: [14, 0],
  serviceReminderDays: [30, 0],
  documentReminderDays: [60, 30, 7, 0],
  smallCellThreshold: 5,
  businessWeekdays: [1, 2, 3, 4, 5],
  gpgSector: 'privateAndVoluntary',
};

export async function complianceSettings(tx: Tx): Promise<ComplianceSettings> {
  const row = await tx.one<{ c: Partial<ComplianceSettings> | null }>(
    `SELECT features->'compliance' AS c FROM app.tenants`,
  );
  return { ...COMPLIANCE_DEFAULTS, ...(row.c ?? {}) };
}

export async function tenantLocale(tx: Tx): Promise<Locale> {
  const row = await tx.one<{ default_locale: string }>('SELECT default_locale FROM app.tenants');
  return isLocale(row.default_locale) ? row.default_locale : 'en-GB';
}
export const text = (locale: Locale, key: string, params: Record<string, string | number> = {}) =>
  t(locale, key, params);

/** Employee row with the most specific jurisdiction code known (location region, else entity region, else country). */
export interface EmployeeRow {
  id: string;
  display_name: string;
  status: string;
  start_date: string;
  end_date: string | null;
  job_title: string | null;
  entity_id: string | null;
  location_id: string | null;
  department_id: string | null;
  country: string | null;
  region_code: string | null;
  manager_id: string | null;
}
/**
 * Current denormalised values, falling back to the first job record for people who have not started
 * yet (right-to-work and I-9 checks happen before the first day, when the current values are empty).
 */
export const EMPLOYEE_COLUMNS = `e.id, e.display_name, e.status, e.start_date::text AS start_date, e.end_date::text AS end_date,
  coalesce(e.job_title, fj.job_title) AS job_title, coalesce(e.entity_id, fj.entity_id) AS entity_id, coalesce(e.location_id, fj.location_id) AS location_id,
  coalesce(e.department_id, fj.department_id) AS department_id, coalesce(e.country, fl.country, le.country) AS country,
  coalesce(e.region_code, fl.region_code, le.region_code) AS region_code, e.manager_id`;
export const EMPLOYEE_FROM = `app.employees e
  LEFT JOIN LATERAL (SELECT j.job_title, j.entity_id, j.location_id, j.department_id FROM app.employee_jobs j WHERE j.tenant_id = e.tenant_id AND j.employee_id = e.id ORDER BY j.valid_from LIMIT 1) fj ON e.entity_id IS NULL
  LEFT JOIN app.locations fl ON fl.tenant_id = e.tenant_id AND fl.id = coalesce(e.location_id, fj.location_id)
  LEFT JOIN app.legal_entities le ON le.tenant_id = e.tenant_id AND le.id = coalesce(e.entity_id, fj.entity_id)`;

export function jurisdictionOf(e: { country: string | null; region_code: string | null }): string | null {
  if (e.region_code && e.country && e.region_code.startsWith(`${e.country}-`)) return e.region_code;
  return e.country;
}

export function targetOf(e: EmployeeRow): Target & { employeeId: string } {
  return {
    employeeId: e.id,
    entityId: e.entity_id,
    country: e.country,
    departmentId: e.department_id,
    locationId: e.location_id,
    managerChain: e.manager_id ? [e.manager_id] : [],
  };
}

export function vaultActor(req: FastifyRequest, principal?: Principal): VaultActor {
  const auth = requireAuth(req);
  return {
    principal: principal ?? auth.principal,
    actorType: auth.method === 'support' ? 'support' : 'user',
    requestId: req.id,
    ip: req.ctx.ip,
  };
}

/** An employee may disclose their own sensitive data (e.g. EEO-1 self-identification) without holding the HR vault permission. */
export function withSelfDisclosure(p: Principal, permissions: string[]): Principal {
  const grant: RoleGrant = {
    roleKey: 'self-disclosure',
    isAdmin: false,
    permissions,
    fieldAccess: {},
    scope: { type: 'self' },
  };
  return { ...p, grants: [...p.grants, grant] };
}

/** HR admins, falling back to the owner when a small company has no HR admin (same as absence alerts). */
export async function complianceRecipients(tx: Tx): Promise<string[]> {
  const hr = await usersWithRole(tx, 'hr_admin');
  return hr.length ? hr : usersWithRole(tx, 'owner');
}

/** Distinct jurisdiction codes the tenant operates in: entities, locations and employees. */
export async function tenantJurisdictionCodes(tx: Tx): Promise<string[]> {
  const rows = await tx.query<{ code: string | null }>(
    `SELECT coalesce(region_code, country) AS code FROM app.legal_entities
     UNION SELECT country FROM app.legal_entities
     UNION SELECT coalesce(region_code, country) FROM app.locations
     UNION SELECT country FROM app.locations
     UNION SELECT DISTINCT coalesce(region_code, country) FROM app.employees WHERE status <> 'leaver'`,
  );
  return [...new Set(rows.map((r) => r.code).filter((c): c is string => !!c))];
}
