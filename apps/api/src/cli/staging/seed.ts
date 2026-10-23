import type { FastifyInstance } from 'fastify';
import { today } from '@thapsus/core/time';
import { withTenant, writeAudit, type TenantRouter } from '@thapsus/db';
import type { TenantDirectory } from '../../lib/directory';
import type { KeyProvider } from '../../lib/kms';
import type { ObjectStore } from '../../lib/object-store';
import { ruleBook } from '../../modules/rules/routes';
import { COMPANY_NAME, type LoginRole, type StagingLogin } from './config';
import { newSeedVault, type SeedCtx } from './context';
import { buildPlan } from './plan';
import { ensureLogins, ensureTenant } from './tenant';
import { seedOrganisation, seedPeople } from './steps/people';
import { seedLeave } from './steps/leave';
import { seedTime } from './steps/time';
import { seedCompliance } from './steps/compliance';
import { seedDocuments } from './steps/documents';
import { seedAssets } from './steps/assets';
import { seedWorkflows } from './steps/workflows';
import { seedPayroll } from './steps/payroll';
import { seedApprovalsReportsPrivacy, seedSettings, suppressSeededDeliveries } from './steps/extras';

// Importing these modules registers the approval effects and workflow hooks the seeded flows rely on
// (leave approval → request approved; offboarding → asset return tasks), exactly as in the API process.
import '../../modules/leave/routes';
import '../../modules/assets/routes';
import '../../modules/approvals/routes';
import '../../modules/me/ess-routes';

export const SEED_MARKER = 'staging.seed_completed';

export interface StagingSeedDeps {
  router: TenantRouter;
  directory: TenantDirectory;
  keys: KeyProvider;
  objects: ObjectStore;
}

export interface StagingSeedOptions {
  workspace: string;
  logins: StagingLogin[];
  size: number;
  /** Defaults to today in Europe/London. */
  anchor?: string;
  log?: (message: string) => void;
}

export interface StagingSeedResult {
  tenantId: string;
  tenantCreated: boolean;
  /** False when the workspace already held the seeded data (only the logins were brought up to date). */
  dataSeeded: boolean;
  passwordsSet: LoginRole[];
  counts: Record<string, number>;
  employeesByEntity: Record<string, number>;
  seconds: number;
}

/**
 * Seeds (or brings up to date) the fictional staging workspace. Idempotent: the data is written once, in
 * one tenant transaction that ends with an audit marker, so a failed run leaves nothing behind and a
 * repeated run changes nothing but the logins (emails, passwords and roles from STAGING_LOGINS).
 */
export async function seedStaging(
  deps: StagingSeedDeps,
  opts: StagingSeedOptions,
): Promise<StagingSeedResult> {
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  const book = await ruleBook({ deps: { router: deps.router } } as unknown as FastifyInstance);
  const anchor = opts.anchor ?? today('Europe/London');
  const plan = buildPlan({ book, anchor, size: opts.size });
  const owner = opts.logins.find((l) => l.role === 'owner')!;
  const { tenantId, created } = await ensureTenant(deps.router, deps.directory, {
    slug: opts.workspace,
    name: COMPANY_NAME,
    owner,
  });
  log(created ? `workspace "${opts.workspace}" created` : `workspace "${opts.workspace}" exists`);
  const numbers = Object.fromEntries(
    Object.entries(plan.logins).map(([role, idx]) => [role, plan.people[idx]!.number]),
  ) as Record<LoginRole, string>;
  const already = await withTenant(deps.router, tenantId, (tx) =>
    tx.maybe('SELECT 1 FROM audit.events WHERE action = $1 LIMIT 1', [SEED_MARKER]),
  );
  const counts: Record<string, number> = {};
  // a new workspace's owner password was set when the workspace was created
  const passwordsSet = new Set<LoginRole>(created ? ['owner'] : []);
  if (!already) {
    await withTenant(deps.router, tenantId, async (tx) => {
      const { vault, system } = newSeedVault(deps.keys);
      const ctx: SeedCtx = {
        tx,
        tenantId,
        book,
        keys: deps.keys,
        objects: deps.objects,
        plan,
        anchor,
        vault,
        system,
        ids: {
          entity: {} as SeedCtx['ids']['entity'],
          location: {} as SeedCtx['ids']['location'],
          dept: {} as SeedCtx['ids']['dept'],
          employee: [],
          user: {} as SeedCtx['ids']['user'],
          leaveType: {},
          costCentre: {},
          grade: {},
        },
        counts,
        log,
      };
      const step = async (name: string, fn: (c: SeedCtx) => Promise<void>) => {
        const t0 = Date.now();
        await fn(ctx);
        log(`${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      };
      await step('organisation', seedOrganisation);
      await step('people and history', seedPeople);
      await step('logins', async (c) => {
        const r = await ensureLogins(c.tx, opts.logins, numbers);
        c.ids.user = r.users;
        for (const role of r.passwordsSet) passwordsSet.add(role);
      });
      await step('leave and absence', seedLeave);
      await step('rotas, clocking and timesheets', seedTime);
      await step('compliance', seedCompliance);
      await step('documents and signatures', seedDocuments);
      await step('assets', seedAssets);
      await step('onboarding and offboarding', seedWorkflows);
      await step('payroll and payslips', seedPayroll);
      await step('approvals, reports and privacy', seedApprovalsReportsPrivacy);
      await step('settings and automation', seedSettings);
      await step('notifications', suppressSeededDeliveries);
      await writeAudit(tx, {
        actorType: 'system',
        action: SEED_MARKER,
        targetType: 'tenant',
        targetId: tenantId,
        diff: { anchor, size: opts.size, counts },
      });
    });
  }
  const after = await withTenant(deps.router, tenantId, (tx) => ensureLogins(tx, opts.logins, numbers));
  for (const role of after.passwordsSet) passwordsSet.add(role);
  // seal the audit chain now rather than waiting for the worker's next sweep
  await withTenant(deps.router, tenantId, async (tx) => {
    while ((await tx.one<{ n: number }>('SELECT audit.seal_pending(5000) AS n')).n > 0);
  });
  const byEntity = await withTenant(deps.router, tenantId, (tx) =>
    tx.query<{ name: string; n: number }>(
      `SELECT le.name, count(*)::int AS n FROM app.employees e
         JOIN LATERAL (SELECT j.entity_id FROM app.employee_jobs j WHERE j.employee_id = e.id ORDER BY j.valid_from DESC LIMIT 1) j ON true
         JOIN app.legal_entities le ON le.tenant_id = e.tenant_id AND le.id = j.entity_id
        GROUP BY le.name ORDER BY le.name`,
    ),
  );
  return {
    tenantId,
    tenantCreated: created,
    dataSeeded: !already,
    passwordsSet: [...passwordsSet],
    counts,
    employeesByEntity: Object.fromEntries(byEntity.map((r) => [r.name, r.n])),
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}
