import { REGIONS } from '@thapsus/core';
import { TRUST, templateForRegion } from '@thapsus/core/trust';
import { withRegistry, withTenant, writeAudit, type TenantRouter, type Tx } from '@thapsus/db';
import type { TenantDirectory } from '../../lib/directory';
import { hashPassword, verifyPassword } from '../../modules/auth/tokens';
import { assignRole, seedBuiltInRoles } from '../../modules/authz/principal';
import { CURRENT_SECURITY_DEFAULTS_VERSION, NEW_WORKSPACE_SECURITY } from '../../modules/auth/sessions';
import type { LoginRole, StagingLogin } from './config';

const HOME = 'uk' as const;

/**
 * Creates the workspace exactly as sign-up does (directory entry, regional registry, tenant row, built-in
 * roles, the owner with the DPA accepted, `tenant.created` on the outbox so the worker starts the trial),
 * or returns the existing one. When the global directory already holds the slug (a staging database that
 * was reset), its tenant id is reused so the directory and the cell stay consistent.
 */
export async function ensureTenant(
  router: TenantRouter,
  directory: TenantDirectory,
  opts: { slug: string; name: string; owner: StagingLogin },
): Promise<{ tenantId: string; created: boolean }> {
  const listed = await directory.bySlug(opts.slug);
  if (listed && listed.homeRegion !== HOME)
    throw new Error(`Workspace "${opts.slug}" is registered in the ${listed.homeRegion} region, not ${HOME}`);
  const existing = await router.lookupSlug(opts.slug);
  if (existing) {
    if (listed && listed.tenantId !== existing.tenant_id)
      throw new Error(`Workspace "${opts.slug}" belongs to another tenant in the directory`);
    if (!listed) await directory.register(directoryEntry(existing.tenant_id, opts.slug));
    return { tenantId: existing.tenant_id, created: false };
  }
  const tenantId = listed?.tenantId ?? crypto.randomUUID();
  if (!listed) await directory.register(directoryEntry(tenantId, opts.slug));
  await withRegistry(router, (tx) =>
    tx.exec('INSERT INTO registry.tenants (tenant_id, slug, home_region) VALUES ($1, $2, $3)', [
      tenantId,
      opts.slug,
      HOME,
    ]),
  );
  router.invalidate(tenantId);
  const spec = REGIONS[HOME];
  const passwordHash = await hashPassword(opts.owner.password);
  await withTenant(router, tenantId, async (tx) => {
    await tx.exec(
      `INSERT INTO app.tenants (tenant_id, slug, name, home_region, default_locale, default_currency, default_time_zone, features, security, security_defaults_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        tenantId,
        opts.slug,
        opts.name,
        HOME,
        spec.defaultLocale,
        spec.defaultCurrency,
        spec.defaultTimeZone,
        // as sign-up; plus the company's own absence policy (fit note after 7 calendar days)
        JSON.stringify({ aiAssistant: false, absence: { fitNoteAfterCalendarDays: 7 } }),
        // as sign-up: two-step verification for everyone, so every login enrols an authenticator at its
        // first sign-in (ADR-0170; HUMAN_TODO 9.7)
        JSON.stringify(NEW_WORKSPACE_SECURITY),
        CURRENT_SECURITY_DEFAULTS_VERSION,
      ],
    );
    await seedBuiltInRoles(tx);
    const u = await tx.one<{ id: string }>(
      `INSERT INTO app.users (tenant_id, email, display_name, locale, time_zone) VALUES ($1, $2, 'Company owner', $3, $4) RETURNING id`,
      [tenantId, opts.owner.email, spec.defaultLocale, spec.defaultTimeZone],
    );
    await tx.exec(
      'INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES ($1, $2, $3)',
      [tenantId, u.id, passwordHash],
    );
    await assignRole(tx, u.id, 'owner', { type: 'all' });
    await assignRole(tx, u.id, 'employee', { type: 'self' });
    const dpa = TRUST.dpa[templateForRegion(HOME)];
    await tx.exec(
      `INSERT INTO app.dpa_acceptances (tenant_id, dpa_version, template, accepted_by, accepted_by_name, document_sha256) VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, dpa.version, templateForRegion(HOME), u.id, 'Company owner', dpa.sha256],
    );
    await writeAudit(tx, {
      actorType: 'system',
      action: 'tenant.created',
      targetType: 'tenant',
      targetId: tenantId,
      diff: {
        region: HOME,
        slug: opts.slug,
        dpaAccepted: true,
        dpaVersion: dpa.version,
        source: 'staging_seed',
      },
    });
    await tx.exec(
      `INSERT INTO app.outbox (tenant_id, topic, aggregate_type, aggregate_id, payload) VALUES ($1::uuid, 'tenant.created', 'tenant', $1::text, '{}')`,
      [tenantId],
    );
  });
  return { tenantId, created: true };
}

const directoryEntry = (tenantId: string, slug: string) => ({
  tenantId,
  slug,
  homeRegion: HOME,
  status: 'active' as const,
  planRef: 'trial',
  verifiedDomains: [],
});

/** Built-in roles and scopes each login holds (packages/core/src/roles.ts). */
export const LOGIN_GRANTS: Record<LoginRole, Array<[string, { type: 'all' | 'own_team' | 'self' }]>> = {
  owner: [
    ['owner', { type: 'all' }],
    ['employee', { type: 'self' }],
  ],
  hr_admin: [
    ['hr_admin', { type: 'all' }],
    ['employee', { type: 'self' }],
  ],
  payroll_admin: [
    ['payroll_admin', { type: 'all' }],
    ['employee', { type: 'self' }],
  ],
  manager: [
    ['manager', { type: 'own_team' }],
    ['employee', { type: 'self' }],
  ],
  employee: [['employee', { type: 'self' }]],
};

/**
 * Makes each login exist with exactly the given email and password, linked to its employee and holding its
 * built-in roles. Idempotent: an unchanged password is left alone; a changed one (a rotated secret) is
 * re-hashed, any lockout is cleared and the user's existing sessions are revoked. Roles a customer added are
 * kept. Admin roles enrol MFA at first sign-in (the app enforces it); no factor is created here.
 */
export async function ensureLogins(
  tx: Tx,
  logins: StagingLogin[],
  employeeNumbers: Record<LoginRole, string>,
): Promise<{ users: Record<LoginRole, string>; passwordsSet: LoginRole[] }> {
  const users = {} as Record<LoginRole, string>;
  const passwordsSet: LoginRole[] = [];
  for (const l of logins) {
    const emp = await tx.one<{ id: string; display_name: string; time_zone: string | null }>(
      'SELECT id, display_name, time_zone FROM app.employees WHERE employee_number = $1',
      [employeeNumbers[l.role]],
    );
    let user = await tx.maybe<{ id: string; employee_id: string | null }>(
      'SELECT id, employee_id FROM app.users WHERE email = $1',
      [l.email],
    );
    if (!user) {
      // the login's email changed in the secret: move the seeded user linked to the same employee
      user = await tx.maybe<{ id: string; employee_id: string | null }>(
        `SELECT u.id, u.employee_id FROM app.users u WHERE u.employee_id = $1 ORDER BY u.created_at LIMIT 1`,
        [emp.id],
      );
      if (!user && l.role === 'owner')
        user = await tx.maybe(
          `SELECT u.id, u.employee_id FROM app.users u JOIN app.role_assignments a ON a.tenant_id = u.tenant_id AND a.user_id = u.id
             JOIN app.roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id WHERE r.key = 'owner' AND u.employee_id IS NULL ORDER BY u.created_at LIMIT 1`,
        );
      if (user) await tx.exec('UPDATE app.users SET email = $2 WHERE id = $1', [user.id, l.email]);
    }
    if (!user)
      user = await tx.one<{ id: string; employee_id: string | null }>(
        `INSERT INTO app.users (tenant_id, email, display_name, employee_id, locale, time_zone) VALUES (app.current_tenant(), $1, $2, $3, 'en-GB', $4) RETURNING id, employee_id`,
        [l.email, emp.display_name, emp.id, emp.time_zone ?? 'Europe/London'],
      );
    await tx.exec(
      `UPDATE app.users SET employee_id = coalesce(employee_id, $2), display_name = CASE WHEN employee_id IS NULL THEN $3 ELSE display_name END,
              status = 'active' WHERE id = $1`,
      [user.id, emp.id, emp.display_name],
    );
    const cred = await tx.maybe<{ password_hash: string }>(
      'SELECT password_hash FROM app.password_credentials WHERE user_id = $1',
      [user.id],
    );
    if (!cred || !(await verifyPassword(cred.password_hash, l.password))) {
      const hash = await hashPassword(l.password);
      await tx.exec(
        `INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
        [user.id, hash],
      );
      if (cred) {
        await tx.exec('UPDATE app.users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [
          user.id,
        ]);
        await tx.exec(
          'UPDATE app.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
          [user.id],
        );
        await writeAudit(tx, {
          actorType: 'system',
          action: 'auth.password_reset',
          targetType: 'user',
          targetId: user.id,
          diff: { source: 'staging_seed', sessionsRevoked: true },
        });
      }
      passwordsSet.push(l.role);
    }
    for (const [role, scope] of LOGIN_GRANTS[l.role]) await assignRole(tx, user.id, role, scope);
    users[l.role] = user.id;
  }
  return { users, passwordsSet };
}
