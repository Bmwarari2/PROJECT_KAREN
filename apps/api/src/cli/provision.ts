import { REGIONS, type HomeRegion } from '@thapsus/core';
import { withRegistry, withTenant, writeAudit, type TenantRouter, type Tx } from '@thapsus/db';
import { hashPassword } from '../modules/auth/tokens';
import { assignRole, seedBuiltInRoles } from '../modules/authz/principal';
import type { TenantDirectory } from '../lib/directory';

/** Creates a tenant exactly as sign-up does (registry, tenant row, roles, owner). Idempotent by slug. */
export async function provisionTenant(
  router: TenantRouter,
  directory: TenantDirectory | undefined,
  opts: { slug: string; name: string; region: HomeRegion; ownerEmail: string; ownerName: string; password: string },
): Promise<{ tenantId: string; ownerId: string; created: boolean }> {
  const existing = await router.lookupSlug(opts.slug);
  if (existing) {
    const ownerId = await withTenant(router, existing.tenant_id, async (tx) => (await tx.one<{ id: string }>('SELECT id FROM app.users WHERE email = $1', [opts.ownerEmail])).id);
    return { tenantId: existing.tenant_id, ownerId, created: false };
  }
  const spec = REGIONS[opts.region];
  const tenantId = crypto.randomUUID();
  await directory?.register({ tenantId, slug: opts.slug, homeRegion: opts.region, status: 'active', planRef: 'demo', verifiedDomains: [] }).catch(() => undefined);
  await withRegistry(router, (tx) => tx.exec('INSERT INTO registry.tenants (tenant_id, slug, home_region) VALUES ($1, $2, $3)', [tenantId, opts.slug, opts.region]));
  router.invalidate(tenantId);
  const hash = await hashPassword(opts.password);
  const ownerId = await withTenant(router, tenantId, async (tx) => {
    await tx.exec(
      `INSERT INTO app.tenants (tenant_id, slug, name, home_region, default_locale, default_currency, default_time_zone) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, opts.slug, opts.name, opts.region, spec.defaultLocale, spec.defaultCurrency, spec.defaultTimeZone],
    );
    await seedBuiltInRoles(tx);
    const u = await tx.one<{ id: string }>(`INSERT INTO app.users (tenant_id, email, display_name) VALUES ($1, $2, $3) RETURNING id`, [tenantId, opts.ownerEmail, opts.ownerName]);
    await tx.exec('INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES ($1, $2, $3)', [tenantId, u.id, hash]);
    await assignRole(tx, u.id, 'owner', { type: 'all' });
    await writeAudit(tx, { actorType: 'system', action: 'tenant.seeded', targetType: 'tenant', targetId: tenantId });
    return u.id;
  });
  return { tenantId, ownerId, created: true };
}

/** Creates a user with a password and role(s), linked to an employee. */
export async function createUser(tx: Tx, opts: { email: string; name: string; passwordHash: string; employeeId?: string; roles: Array<[string, { type: 'all' | 'self' | 'own_team' | 'entity' | 'country'; values?: string[] }]> }) {
  const u = await tx.one<{ id: string }>(
    `INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, $2, $3) RETURNING id`,
    [opts.email, opts.name, opts.employeeId ?? null],
  );
  await tx.exec('INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)', [u.id, opts.passwordHash]);
  for (const [role, scope] of opts.roles) await assignRole(tx, u.id, role, scope);
  return u.id;
}
