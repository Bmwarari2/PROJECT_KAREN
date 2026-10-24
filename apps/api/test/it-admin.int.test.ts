import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ownerUrl, TEST_DBS } from '@thapsus/db/testing';
import { addDays, today } from '@thapsus/core/time';
import { BUILT_IN_ROLES } from '@thapsus/core/roles';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { phase6Company, type Phase6Company } from './phase6-fixtures';

/**
 * PROGRESS 16.3 (ADR-0189): the built-in IT admin role holds the asset register, asset returns, the IT
 * integrations and SCIM, and nothing about pay, contracts or sensitive records. Device and access tasks
 * go to IT admins, or to the fallback role chosen in Settings → Workflows while there is none.
 * Migration 0028 gives existing workspaces the same role as new ones. All people are fictional.
 */
let ctx: TestContext;
let c: Phase6Company;
let itAdmin: string;
let hr: string;
let manager: string;

const IT_TASKS = [
  {
    key: 'kit',
    title: 'Order laptop, phone or site access card',
    assignee: { type: 'role', value: 'it_admin' },
    dueOffsetDays: -5,
  },
  {
    key: 'access',
    title: 'Remove system and building access',
    assignee: { type: 'role', value: 'it_admin' },
    dueOffsetDays: 0,
  },
];

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  c = await phase6Company(ctx);
  hr = await c.login(await c.hire(), 'hr_admin');
  manager = await c.login(await c.hire(), 'manager');
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

/** Starts a custom workflow with the two IT tasks for a new fictional person and returns its tasks. */
async function startItWorkflow() {
  const tpl = await c.api('POST', '/v1/workflow-templates', {
    kind: 'custom',
    name: `Fictional IT steps ${Math.random().toString(36).slice(2, 6)}`,
    tasks: IT_TASKS,
    autoStart: false,
  });
  expect(tpl.statusCode, tpl.body).toBe(201);
  const person = await c.hire();
  const wf = await c.api('POST', '/v1/workflows', {
    templateId: tpl.json().id,
    employeeId: person,
    anchorDate: addDays(today('Europe/London'), 10),
  });
  expect(wf.statusCode, wf.body).toBe(201);
  return c.tx((t) =>
    t.query<{ title: string; assignee_role: string }>(
      `SELECT title, assignee_role FROM app.tasks WHERE source_id = $1 ORDER BY title`,
      [wf.json().id],
    ),
  );
}

describe('device and access tasks (ADR-0189)', () => {
  it('go to the company owner while no one is an IT admin, and to the role chosen in Settings → Workflows', async () => {
    expect((await c.api('GET', '/v1/settings/task-routing', undefined, hr)).json()).toEqual({
      itFallbackRole: 'owner',
      itAdmins: 0,
    });
    expect((await startItWorkflow()).map((t) => t.assignee_role)).toEqual(['owner', 'owner']);

    // HR admins manage workflows, so they choose the fallback; managers cannot
    expect(
      (await c.api('PUT', '/v1/settings/task-routing', { itFallbackRole: 'hr_admin' }, manager)).statusCode,
    ).toBe(403);
    for (const bad of ['it_admin', 'no_such_role'])
      expect(
        (await c.api('PUT', '/v1/settings/task-routing', { itFallbackRole: bad }, hr)).statusCode,
        bad,
      ).toBe(422);
    const set = await c.api('PUT', '/v1/settings/task-routing', { itFallbackRole: 'hr_admin' }, hr);
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toEqual({ itFallbackRole: 'hr_admin', itAdmins: 0 });
    expect((await startItWorkflow()).map((t) => t.assignee_role)).toEqual(['hr_admin', 'hr_admin']);
    const audit = await c.tx((t) =>
      t.query<{ diff: unknown }>(
        `SELECT diff FROM audit.events WHERE action = 'settings.task_routing_updated'`,
      ),
    );
    expect(audit).toEqual([
      { diff: { before: { itFallbackRole: 'owner' }, after: { itFallbackRole: 'hr_admin' } } },
    ]);
  });

  it('go to the IT admins once someone holds the role, asset returns included', async () => {
    itAdmin = await c.login(await c.hire(), 'it_admin');
    expect((await c.api('GET', '/v1/settings/task-routing', undefined, hr)).json().itAdmins).toBe(1);
    expect((await startItWorkflow()).map((t) => t.assignee_role)).toEqual(['it_admin', 'it_admin']);

    // a leaver's equipment: the return task is in the IT admins' queue, not HR's
    const leaver = await c.hire();
    const asset = await c.api(
      'POST',
      '/v1/assets',
      { assetTag: 'IT-0001', type: 'laptop', name: 'Fictional Laptop 13' },
      itAdmin,
    );
    expect(asset.statusCode, asset.body).toBe(201);
    const assigned = await c.api(
      'POST',
      `/v1/assets/${asset.json().id}/assign`,
      { employeeId: leaver, assignedOn: '2026-01-05' },
      itAdmin,
    );
    expect(assigned.statusCode, assigned.body).toBe(201);
    await c.api('POST', '/v1/workflow-templates', {
      kind: 'offboarding',
      name: 'Fictional offboarding',
      tasks: [
        {
          key: 'exit',
          title: 'Exit interview',
          assignee: { type: 'role', value: 'hr_admin' },
          dueOffsetDays: -3,
        },
      ],
    });
    const end = addDays(today('Europe/London'), 20);
    expect(
      (await c.api('POST', `/v1/employees/${leaver}/terminate`, { endDate: end, reason: 'Fictional move' }))
        .statusCode,
    ).toBe(200);
    await c.drain();
    const ret = await c.tx((t) =>
      t.one<{ id: string; assignee_role: string }>(
        `SELECT id, assignee_role FROM app.tasks WHERE dedupe_key = $1`,
        [`asset-return:${assigned.json().id}`],
      ),
    );
    expect(ret.assignee_role).toBe('it_admin');
    const queue = async (cookie: string) =>
      (await c.api('GET', '/v1/tasks', undefined, cookie)).json().map((x: { id: string }) => x.id);
    expect(await queue(itAdmin)).toContain(ret.id);
    expect(await queue(hr)).not.toContain(ret.id);
    // HR still sees what the leaver holds, read-only
    const held = await c.api(
      'GET',
      `/v1/asset-assignments?employeeId=${leaver}&status=active`,
      undefined,
      hr,
    );
    expect(held.statusCode).toBe(200);
    expect(held.json().map((a: { assetTag: string }) => a.assetTag)).toEqual(['IT-0001']);
    // the IT admin records the return, which closes the task
    const back = await c.api(
      'POST',
      `/v1/asset-assignments/${assigned.json().id}/return`,
      {
        returnedOn: end,
        checklist: ['device', 'charger', 'dataWiped'].map((key) => ({ key, done: true })),
      },
      itAdmin,
    );
    expect(back.statusCode, back.body).toBe(200);
    expect(
      (await c.tx((t) => t.one<{ status: string }>('SELECT status FROM app.tasks WHERE id = $1', [ret.id])))
        .status,
    ).toBe('done');
  });
});

describe('the IT admin role (ADR-0189)', () => {
  it('runs the IT integrations and SCIM provisioning without the rest of the workspace settings', async () => {
    expect((await c.api('GET', '/v1/integrations/it', undefined, itAdmin)).statusCode).toBe(200);
    const token = await c.api('POST', '/v1/settings/scim-tokens', { name: 'Fictional directory' }, itAdmin);
    expect(token.statusCode, token.body).toBe(201);
    expect((await c.api('GET', '/v1/settings/scim-tokens', undefined, itAdmin)).json()).toHaveLength(1);
    expect(
      (await c.api('DELETE', `/v1/settings/scim-tokens/${token.json().id}`, undefined, itAdmin)).statusCode,
    ).toBe(204);
    // HR admins read the SCIM page but do not hold tokens
    expect((await c.api('GET', '/v1/settings/scim-tokens', undefined, hr)).statusCode).toBe(200);
    expect(
      (await c.api('POST', '/v1/settings/scim-tokens', { name: 'Fictional HR token' }, hr)).statusCode,
    ).toBe(403);
    for (const url of ['/v1/settings/security', '/v1/settings/sso-connections', '/v1/settings/features'])
      expect((await c.api('GET', url, undefined, itAdmin)).statusCode, url).toBe(403);
  });

  it('sees who joins and leaves and their work details, never pay, contracts or sensitive records', async () => {
    const person = await c.hire({ legalFirstName: 'Robin', legalLastName: 'Fictional' });
    const list = await c.api('GET', '/v1/employees?limit=200', undefined, itAdmin);
    expect(list.statusCode).toBe(200);
    const row = list.json().data.find((e: { id: string }) => e.id === person);
    expect(row).toBeDefined();
    const res = (await c.api('GET', `/v1/employees/${person}`, undefined, itAdmin)).json();
    expect(res.employee).toMatchObject({ id: person, jobTitle: 'Analyst', startDate: '2024-01-08' });
    for (const hidden of ['payAmountMinor', 'payCurrency', 'contractType', 'dateOfBirth', 'personalEmail']) {
      expect(res.employee, hidden).not.toHaveProperty(hidden);
      expect(res.access[hidden], hidden).toBe('none');
    }
    for (const [method, url] of [
      ['GET', '/v1/payroll/periods'],
      ['GET', '/v1/payslips/batches'],
      ['GET', '/v1/compliance/right-to-work'],
      ['GET', '/v1/privacy/requests'],
      ['GET', `/v1/employees/${person}/history`],
      ['POST', `/v1/employees/${person}/changes`],
    ] as const)
      expect(
        (
          await c.api(
            method,
            url,
            method === 'POST' ? { effectiveDate: '2026-10-01', jobTitle: 'X' } : undefined,
            itAdmin,
          )
        ).statusCode,
        `${method} ${url}`,
      ).toBe(403);
  });

  it('is the same in existing workspaces (migration 0028) as in new ones', async () => {
    const code = BUILT_IN_ROLES.find((r) => r.key === 'it_admin')!;
    const owner = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
    await owner.connect();
    try {
      const tenant = c.owner.tenantId;
      // a workspace as it was before 0028: no IT admin role, HR admins managing assets
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE app.roles NO FORCE ROW LEVEL SECURITY');
      await owner.query(
        `DELETE FROM app.role_assignments WHERE tenant_id = $1 AND role_id IN (SELECT id FROM app.roles WHERE tenant_id = $1 AND key = 'it_admin')`,
        [tenant],
      );
      await owner.query(`DELETE FROM app.roles WHERE tenant_id = $1 AND key = 'it_admin'`, [tenant]);
      await owner.query(
        `UPDATE app.roles SET permissions = array_replace(permissions, 'assets.read', 'assets.*') WHERE tenant_id = $1 AND key IN ('hr_admin', 'entity_hr_admin')`,
        [tenant],
      );
      await owner.query('ALTER TABLE app.roles FORCE ROW LEVEL SECURITY');
      await owner.query('COMMIT');
      // the migration, as the migrator runs it
      const sql = readFileSync(
        join(import.meta.dirname, '..', '..', '..', 'packages', 'db', 'migrations', '0028_it_admin_role.sql'),
        'utf8',
      );
      await owner.query('BEGIN');
      await owner.query(sql);
      await owner.query('COMMIT');
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE app.roles NO FORCE ROW LEVEL SECURITY');
      const rows = (
        await owner.query<{
          key: string;
          name: string;
          built_in: boolean;
          is_admin: boolean;
          permissions: string[];
          field_access: Record<string, string>;
        }>(
          `SELECT key, name, built_in, is_admin, permissions, field_access FROM app.roles WHERE tenant_id = $1 AND key IN ('it_admin', 'hr_admin', 'entity_hr_admin') ORDER BY key`,
          [tenant],
        )
      ).rows;
      await owner.query('ROLLBACK');
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
      expect(byKey.it_admin).toEqual({
        key: 'it_admin',
        name: code.name,
        built_in: true,
        is_admin: code.isAdmin,
        permissions: code.permissions,
        field_access: code.fieldAccess,
      });
      for (const k of ['hr_admin', 'entity_hr_admin']) {
        expect(byKey[k]!.permissions, k).toContain('assets.read');
        expect(byKey[k]!.permissions, k).not.toContain('assets.*');
        expect(byKey[k]!.permissions.sort(), k).toEqual(
          [...BUILT_IN_ROLES.find((r) => r.key === k)!.permissions].sort(),
        );
      }
    } finally {
      await owner.end();
    }
  });
});
