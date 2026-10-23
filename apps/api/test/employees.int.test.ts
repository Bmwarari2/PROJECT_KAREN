import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@thapsus/db';
import { closeDb, cookieFrom, ownerSession, PASSWORD, startTestApp, type TestContext } from './helpers';
import { assignRole } from '../src/modules/authz/principal';
import { hashPassword } from '../src/modules/auth/tokens';
import { jobHandlers } from '../src/worker';

let ctx: TestContext;
let owner: Awaited<ReturnType<typeof ownerSession>>;
let entityUk: string;
let entityDe: string;
let dept: string;
let h: { cookie: string };

const api = (method: string, url: string, payload?: unknown, cookie = h.cookie) =>
  ctx.app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });

async function hire(values: Record<string, unknown>) {
  const res = await api('POST', '/v1/employees', {
    startDate: '2026-01-05',
    legalFirstName: 'Avery',
    legalLastName: 'Example',
    jobTitle: 'Analyst',
    entityId: entityUk,
    departmentId: dept,
    payAmountMinor: 4_000_000,
    payCurrency: 'GBP',
    payFrequency: 'annual',
    contractType: 'permanent',
    ...values,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function userFor(
  employeeId: string,
  role: string,
  scope: { type: 'all' | 'self' | 'own_team' | 'entity'; values?: string[] },
) {
  const email = `${role}.${Math.random().toString(36).slice(2, 7)}@${owner.slug}.example.test`;
  await withTenant(ctx.deps.router, owner.tenantId, async (tx) => {
    const u = await tx.one<{ id: string }>(
      `INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, 'Fictional User', $2) RETURNING id`,
      [email, employeeId],
    );
    await tx.exec(
      'INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)',
      [u.id, await hashPassword(PASSWORD)],
    );
    await assignRole(tx, u.id, role, scope);
    if (role !== 'employee') await assignRole(tx, u.id, 'employee', { type: 'self' });
  });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { tenant: owner.slug, email, password: PASSWORD },
    remoteAddress: `10.60.${Math.floor(Math.random() * 250)}.1`,
  });
  return cookieFrom(res);
}

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  owner = await ownerSession(ctx);
  h = { cookie: owner.cookie };
  entityUk = (
    await api('POST', '/v1/org/legal-entities', {
      name: 'Fictional UK Ltd',
      country: 'GB',
      currency: 'GBP',
      timeZone: 'Europe/London',
    })
  ).json().id;
  entityDe = (
    await api('POST', '/v1/org/legal-entities', {
      name: 'Fictional GmbH',
      country: 'DE',
      currency: 'EUR',
      timeZone: 'Europe/Berlin',
    })
  ).json().id;
  dept = (await api('POST', '/v1/org/departments', { name: 'Engineering' })).json().id;
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('effective-dated employee records', () => {
  it('hires with personal, job, pay and contract records and answers as-of queries', async () => {
    const id = await hire({ startDate: '2026-01-05' });
    const before = await api('GET', `/v1/employees/${id}?asOf=2026-01-04`);
    expect(before.json().employee.jobTitle).toBeNull();
    const now = await api('GET', `/v1/employees/${id}?asOf=2026-02-01`);
    expect(now.json().employee).toMatchObject({
      jobTitle: 'Analyst',
      payAmountMinor: '4000000',
      payCurrency: 'GBP',
      contractType: 'permanent',
      status: 'active',
    });
  });

  it('supports past, present and future-dated changes, keeping full history', async () => {
    const id = await hire({});
    expect(
      (
        await api('POST', `/v1/employees/${id}/changes`, {
          effectiveDate: '2026-04-01',
          jobTitle: 'Senior analyst',
          payAmountMinor: 4_800_000,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await api('POST', `/v1/employees/${id}/changes`, {
          effectiveDate: '2027-01-01',
          jobTitle: 'Lead analyst',
        })
      ).statusCode,
    ).toBe(200);
    // a change in between the two keeps the later future-dated record intact
    expect(
      (await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2026-09-01', weeklyHours: 30 }))
        .statusCode,
    ).toBe(200);
    const at = async (d: string) => (await api('GET', `/v1/employees/${id}?asOf=${d}`)).json().employee;
    expect(await at('2026-03-31')).toMatchObject({ jobTitle: 'Analyst', payAmountMinor: '4000000' });
    expect(await at('2026-04-01')).toMatchObject({ jobTitle: 'Senior analyst', payAmountMinor: '4800000' });
    expect(await at('2026-09-01')).toMatchObject({ jobTitle: 'Senior analyst', weeklyHours: '30.00' });
    expect(await at('2027-01-01')).toMatchObject({ jobTitle: 'Lead analyst', weeklyHours: '30.00' });
    const hist = (await api('GET', `/v1/employees/${id}/history`)).json();
    expect(hist.job.map((j: { job_title: string }) => j.job_title)).toEqual([
      'Analyst',
      'Senior analyst',
      'Senior analyst',
      'Lead analyst',
    ]);
    expect(hist.pay).toHaveLength(2);
  });

  it('a correction on the record start date updates in place', async () => {
    const id = await hire({});
    await api('POST', `/v1/employees/${id}/changes`, {
      effectiveDate: '2026-01-05',
      jobTitle: 'Data analyst',
    });
    const hist = (await api('GET', `/v1/employees/${id}/history`)).json();
    expect(hist.job).toHaveLength(1);
    expect(hist.job[0].job_title).toBe('Data analyst');
  });

  it('overlapping periods are rejected by the database', async () => {
    const id = await hire({});
    await expect(
      withTenant(ctx.deps.router, owner.tenantId, (tx) =>
        tx.exec(
          `INSERT INTO app.employee_jobs (tenant_id, employee_id, valid_from, job_title, entity_id) VALUES (app.current_tenant(), $1, '2026-03-01', 'Overlap', $2)`,
          [id, entityUk],
        ),
      ),
    ).rejects.toThrow(/conflicting key value violates exclusion constraint/);
  });

  it('future-dated changes take effect on their date via an idempotent daily job', async () => {
    const id = await hire({});
    await api('POST', `/v1/employees/${id}/changes`, {
      effectiveDate: '2030-06-01',
      jobTitle: 'Principal analyst',
    });
    const listed = async () =>
      (
        await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
          tx.one<{ job_title: string }>('SELECT job_title FROM app.employees WHERE id = $1', [id]),
        )
      ).job_title;
    expect(await listed()).toBe('Analyst');
    const run = (date: string) =>
      jobHandlers['employees.refresh_effective']!({
        tenantId: owner.tenantId,
        job: {
          id: 'x',
          tenant_id: owner.tenantId,
          kind: 'employees.refresh_effective',
          idempotency_key: date,
          input: { date },
          attempts: 1,
          created_by: null,
        },
        deps: ctx.deps,
        tx: (fn) => withTenant(ctx.deps.router, owner.tenantId, fn),
        progress: async () => undefined,
      });
    await run('2030-06-01');
    expect(await listed()).toBe('Principal analyst');
    await run('2030-06-01'); // idempotent
    expect(await listed()).toBe('Principal analyst');
  });
});

describe('reporting lines and org chart', () => {
  it('rejects cycles and requires reassignment when terminating a manager with reports', async () => {
    const boss = await hire({ legalFirstName: 'Blake', jobTitle: 'Head' });
    const mid = await hire({ legalFirstName: 'Casey', managerId: boss });
    const leaf = await hire({ legalFirstName: 'Devon', managerId: mid });
    const cyc = await api('POST', `/v1/employees/${boss}/changes`, {
      effectiveDate: '2026-03-01',
      managerId: leaf,
    });
    expect(cyc.statusCode).toBe(422);
    const term = await api('POST', `/v1/employees/${mid}/terminate`, {
      endDate: '2027-06-30',
      reason: 'Resignation',
    });
    expect(term.statusCode).toBe(422);
    expect(term.json().reports).toBe(1);
    const ok = await api('POST', `/v1/employees/${mid}/terminate`, {
      endDate: '2027-06-30',
      reason: 'Resignation',
      reassignReportsTo: boss,
    });
    expect(ok.statusCode).toBe(200);
    const after = (await api('GET', `/v1/employees/${leaf}?asOf=2027-07-01`)).json().employee;
    expect(after.managerId).toBe(boss);
    const children = (await api('GET', `/v1/org-chart/${boss}/children`)).json();
    expect(children.map((c: { id: string }) => c.id)).toContain(mid); // still active until end date passes
    const focus = (await api('GET', `/v1/org-chart/${leaf}/focus`)).json();
    expect(focus.node.id).toBe(leaf);
  });

  it('supports dotted and matrix lines alongside one solid line', async () => {
    const a = await hire({});
    const b = await hire({});
    const c = await hire({ managerId: a });
    expect(
      (
        await api('POST', `/v1/employees/${c}/reporting-lines`, {
          managerId: b,
          kind: 'dotted',
          effectiveDate: '2026-02-01',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await api('POST', `/v1/employees/${c}/reporting-lines`, {
          managerId: b,
          kind: 'dotted',
          effectiveDate: '2026-02-01',
        })
      ).statusCode,
    ).toBe(409);
  });
});

describe('field-level permissions and scope', () => {
  it('managers see their team with limited fields and cannot see pay; employees see themselves', async () => {
    const mgrEmp = await hire({ legalFirstName: 'Morgan', jobTitle: 'Manager' });
    const report = await hire({ legalFirstName: 'Reese', managerId: mgrEmp, dateOfBirth: '1990-02-03' });
    const outsider = await hire({ legalFirstName: 'Sage' });
    const mgr = await userFor(mgrEmp, 'manager', { type: 'own_team' });
    const r = (await api('GET', `/v1/employees/${report}`, undefined, mgr)).json();
    expect(r.employee.jobTitle).toBe('Analyst');
    expect(r.employee.payAmountMinor).toBeUndefined();
    expect(r.employee.dateOfBirth).toBeUndefined();
    expect(r.access.payAmountMinor).toBe('none'); // the UI renders exactly what the API allows
    expect((await api('GET', `/v1/employees/${outsider}`, undefined, mgr)).statusCode).toBe(403);
    const list = (await api('GET', '/v1/employees', undefined, mgr))
      .json()
      .data.map((e: { id: string }) => e.id);
    expect(list).toContain(report);
    expect(list).not.toContain(outsider);
    expect(
      (
        await api(
          'POST',
          `/v1/employees/${report}/changes`,
          { effectiveDate: '2026-05-01', jobTitle: 'Hacked' },
          mgr,
        )
      ).statusCode,
    ).toBe(403);

    const self = await userFor(report, 'employee', { type: 'self' });
    const me = (await api('GET', `/v1/employees/${report}`, undefined, self)).json();
    expect(me.employee.payAmountMinor).toBe('4000000');
    expect(
      (
        await api(
          'POST',
          `/v1/employees/${report}/changes`,
          { effectiveDate: '2026-05-01', personalEmail: 'reese@personal.example.test' },
          self,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await api(
          'POST',
          `/v1/employees/${report}/changes`,
          { effectiveDate: '2026-05-01', payAmountMinor: 9_000_000 },
          self,
        )
      ).statusCode,
    ).toBe(403);
    expect((await api('GET', `/v1/employees/${outsider}`, undefined, self)).statusCode).toBe(403);
  });

  it('entity-scoped HR admins only see and change their entity', async () => {
    const de = await hire({ entityId: entityDe, payCurrency: 'EUR' });
    const uk = await hire({});
    const hr = await userFor(uk, 'entity_hr_admin', { type: 'entity', values: [entityDe] });
    // admins must pass MFA before admin routes: enrol TOTP for this session
    const { enrolTotp } = await import('./helpers');
    await enrolTotp(ctx, hr);
    const list = (await api('GET', '/v1/employees?status=all', undefined, hr))
      .json()
      .data.map((e: { id: string }) => e.id);
    expect(list).toContain(de);
    expect(list).not.toContain(uk);
    expect(
      (await api('POST', `/v1/employees/${uk}/changes`, { effectiveDate: '2026-05-01', jobTitle: 'X' }, hr))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await api(
          'POST',
          `/v1/employees/${de}/changes`,
          { effectiveDate: '2026-05-01', jobTitle: 'Ingenieur' },
          hr,
        )
      ).statusCode,
    ).toBe(200);
  });

  it('searches by name, number and email', async () => {
    const id = await hire({
      legalFirstName: 'Quillon',
      legalLastName: 'Searchable',
      workEmail: 'quillon@x.example.test',
    });
    for (const q of ['Quillon', 'searchable', 'quillon@x.example.test']) {
      const ids = (await api('GET', `/v1/employees?q=${encodeURIComponent(q)}`))
        .json()
        .data.map((e: { id: string }) => e.id);
      expect(ids, q).toContain(id);
    }
  });

  it('paginates with a stable cursor', async () => {
    const first = (await api('GET', '/v1/employees?limit=3')).json();
    const second = (await api('GET', `/v1/employees?limit=3&cursor=${first.nextCursor}`)).json();
    expect(first.data).toHaveLength(3);
    expect(new Set([...first.data, ...second.data].map((e: { id: string }) => e.id)).size).toBe(
      first.data.length + second.data.length,
    );
  });
});

describe('custom fields and objects', () => {
  it('validates custom field values by type and stores them (with audit)', async () => {
    await api('POST', '/v1/settings/custom-fields', {
      key: 'tshirtSize',
      label: { 'en-GB': 'T-shirt size' },
      fieldType: 'select',
      options: [
        { value: 'M', label: { 'en-GB': 'M' } },
        { value: 'L', label: { 'en-GB': 'L' } },
      ],
    });
    await api('POST', '/v1/settings/custom-fields', {
      key: 'badgeNumber',
      label: { 'en-GB': 'Badge' },
      fieldType: 'number',
      validation: { min: 1, max: 9999 },
    });
    const id = await hire({ custom: { tshirtSize: 'M', badgeNumber: 42 } });
    expect((await api('GET', `/v1/employees/${id}`)).json().employee.custom).toEqual({
      tshirtSize: 'M',
      badgeNumber: 42,
    });
    expect(
      (
        await api('POST', `/v1/employees/${id}/changes`, {
          effectiveDate: '2026-02-01',
          custom: { tshirtSize: 'XXL' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api('POST', `/v1/employees/${id}/changes`, {
          effectiveDate: '2026-02-01',
          custom: { badgeNumber: 0 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2026-02-01', custom: { nope: 1 } }))
        .statusCode,
    ).toBe(400);
  });

  it('custom objects validate against their field definitions', async () => {
    await api('POST', '/v1/settings/custom-objects', {
      key: 'certifications',
      label: { 'en-GB': 'Certifications' },
      fields: [
        { key: 'name', label: { 'en-GB': 'Name' }, fieldType: 'text', required: true },
        { key: 'expires', label: { 'en-GB': 'Expires' }, fieldType: 'date' },
      ],
    });
    const id = await hire({});
    expect(
      (
        await api('POST', `/v1/employees/${id}/custom-objects/certifications`, {
          data: { name: 'First aid', expires: '2027-01-01' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await api('POST', `/v1/employees/${id}/custom-objects/certifications`, {
          data: { expires: '2027-01-01' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('every change is audited with a before/after diff', async () => {
    const id = await hire({});
    await api('POST', `/v1/employees/${id}/changes`, {
      effectiveDate: '2026-02-01',
      jobTitle: 'Audited title',
    });
    const rows = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ diff: { changes: Record<string, unknown> } }>(
        `SELECT diff FROM audit.events WHERE action = 'employee.changed' AND target_id = $1`,
        [id],
      ),
    );
    expect(rows[0]!.diff.changes).toEqual({ jobTitle: { from: 'Analyst', to: 'Audited title' } });
  });
});

describe('every effective-dated section rejects overlapping periods', () => {
  const sections: Array<[table: string, insert: (emp: string) => [string, unknown[]]]> = [
    [
      'app.employee_personal',
      (emp) => [
        `INSERT INTO app.employee_personal (tenant_id, employee_id, valid_from, legal_first_name, legal_last_name) VALUES (app.current_tenant(), $1, '2026-03-01', 'Overlap', 'Person')`,
        [emp],
      ],
    ],
    [
      'app.employee_jobs',
      (emp) => [
        `INSERT INTO app.employee_jobs (tenant_id, employee_id, valid_from, job_title, entity_id) VALUES (app.current_tenant(), $1, '2026-03-01', 'Overlap', $2)`,
        [emp, entityUk],
      ],
    ],
    [
      'app.employee_pay',
      (emp) => [
        `INSERT INTO app.employee_pay (tenant_id, employee_id, valid_from, amount_minor, currency, frequency) VALUES (app.current_tenant(), $1, '2026-03-01', 1, 'GBP', 'annual')`,
        [emp],
      ],
    ],
    [
      'app.employee_contracts',
      (emp) => [
        `INSERT INTO app.employee_contracts (tenant_id, employee_id, valid_from, contract_type) VALUES (app.current_tenant(), $1, '2026-03-01', 'permanent')`,
        [emp],
      ],
    ],
    [
      'app.emergency_contacts',
      (emp) => [
        `INSERT INTO app.emergency_contacts (tenant_id, employee_id, name, priority, valid_from) VALUES (app.current_tenant(), $1, 'Overlap Contact', 1, '2026-03-01')`,
        [emp],
      ],
    ],
  ];
  for (const [table, insert] of sections) {
    it(table, async () => {
      const id = await hire({});
      // emergency contacts are not created on hire: give the employee a first list
      if (table === 'app.emergency_contacts')
        expect(
          (
            await api('PUT', `/v1/employees/${id}/emergency-contacts?effectiveDate=2026-01-05`, [
              { name: 'First Contact' },
            ])
          ).statusCode,
        ).toBe(200);
      const [sql, params] = insert(id);
      await expect(withTenant(ctx.deps.router, owner.tenantId, (tx) => tx.exec(sql, params))).rejects.toThrow(
        /conflicting key value violates exclusion constraint/,
      );
    });
  }
});

describe('emergency contacts are effective-dated', () => {
  it('keeps each list for its period, answers as-of queries and preserves future-dated lists', async () => {
    const id = await hire({});
    const put = (date: string, body: unknown) =>
      api('PUT', `/v1/employees/${id}/emergency-contacts?effectiveDate=${date}`, body);
    expect(
      (
        await put('2026-02-01', [
          { name: 'Robin Fictional', relationship: 'Partner', phone: '+44 7700 900001' },
          { name: 'Sam Fictional', relationship: 'Sibling' },
        ])
      ).statusCode,
    ).toBe(200);
    expect((await put('2027-01-01', [{ name: 'Robin Fictional', relationship: 'Spouse' }])).statusCode).toBe(
      200,
    );
    // a change in between closes the first list and runs until the future-dated one
    const mid = await put('2026-08-01', [
      { name: 'Robin Fictional', relationship: 'Partner' },
      { name: 'Alex Fictional', relationship: 'Friend', priority: 2 },
    ]);
    expect(mid.statusCode).toBe(200);
    expect(mid.json()).toEqual([
      expect.objectContaining({
        name: 'Robin Fictional',
        priority: 1,
        validFrom: '2026-08-01',
        validTo: '2027-01-01',
      }),
      expect.objectContaining({
        name: 'Alex Fictional',
        priority: 2,
        validFrom: '2026-08-01',
        validTo: '2027-01-01',
      }),
    ]);
    const asOf = async (d: string) =>
      (await api('GET', `/v1/employees/${id}/emergency-contacts?asOf=${d}`))
        .json()
        .map((c: { name: string }) => c.name);
    expect(await asOf('2026-01-31')).toEqual([]);
    expect(await asOf('2026-05-01')).toEqual(['Robin Fictional', 'Sam Fictional']);
    expect(await asOf('2026-09-01')).toEqual(['Robin Fictional', 'Alex Fictional']);
    expect(await asOf('2027-02-01')).toEqual(['Robin Fictional']);
    const hist = (await api('GET', `/v1/employees/${id}/history`)).json();
    expect(hist.emergencyContacts).toHaveLength(5);
    expect(
      (
        await put('2026-08-01', [
          { name: 'A', priority: 1 },
          { name: 'B', priority: 1 },
        ])
      ).statusCode,
    ).toBe(400);
    const audit = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ diff: { effectiveDate: string } }>(
        `SELECT diff FROM audit.events WHERE action = 'employee.emergency_contacts_updated' AND target_id = $1 ORDER BY id`,
        [id],
      ),
    );
    expect(audit.map((a) => a.diff.effectiveDate)).toEqual(['2026-02-01', '2027-01-01', '2026-08-01']);
  });
});

describe('positions, grades and cost centres on job records', () => {
  it('links effective-dated jobs to reference data by foreign key and shows names as of a date', async () => {
    const grade = (
      await api('POST', '/v1/org/grades', {
        code: `G${Math.floor(Math.random() * 1e6)}`,
        name: 'Grade 7',
        currency: 'GBP',
        minMinor: 3_500_000,
        maxMinor: 5_500_000,
      })
    ).json().id;
    const position = (
      await api('POST', '/v1/org/positions', {
        title: 'Data analyst (permanent)',
        departmentId: dept,
        gradeId: grade,
        entityId: entityUk,
        headcount: 2,
      })
    ).json().id;
    const cc1 = (
      await api('POST', '/v1/org/cost-centres', {
        code: `CC${Math.floor(Math.random() * 1e6)}`,
        name: 'Analytics',
        entityId: entityUk,
      })
    ).json().id;
    const cc2 = (
      await api('POST', '/v1/org/cost-centres', {
        code: `CC${Math.floor(Math.random() * 1e6)}`,
        name: 'Platform',
        entityId: entityUk,
      })
    ).json().id;
    const id = await hire({ positionId: position, gradeId: grade, costCentreId: cc1 });
    expect(
      (await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2026-07-01', costCentreId: cc2 }))
        .statusCode,
    ).toBe(200);
    const at = async (d: string) => (await api('GET', `/v1/employees/${id}?asOf=${d}`)).json().employee;
    expect(await at('2026-03-01')).toMatchObject({
      positionId: position,
      position: 'Data analyst (permanent)',
      gradeId: grade,
      grade: 'Grade 7',
      costCentreId: cc1,
      costCentre: 'Analytics',
    });
    expect(await at('2026-07-01')).toMatchObject({
      costCentreId: cc2,
      costCentre: 'Platform',
      position: 'Data analyst (permanent)',
    });
    // references must exist (FK), in this tenant
    const unknown = '00000000-0000-4000-8000-00000000abcd';
    for (const field of ['positionId', 'gradeId', 'costCentreId']) {
      expect(
        (await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2026-09-01', [field]: unknown }))
          .statusCode,
        field,
      ).toBe(422);
    }
    const fks = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'app.employee_jobs'::regclass AND contype = 'f' ORDER BY conname`,
      ),
    );
    expect(
      fks.filter((f) => /position|grade|cost_centre/.test(f.conname)).map((f) => [f.conname, f.convalidated]),
    ).toEqual([
      ['employee_jobs_cost_centre_fk', true],
      ['employee_jobs_grade_fk', true],
      ['employee_jobs_position_fk', true],
    ]);
    // a manager sees the position but not the grade (pay.grade) of a report
    const mgrEmp = await hire({ legalFirstName: 'Gradeless' });
    await api('POST', `/v1/employees/${id}/changes`, { effectiveDate: '2026-01-05', managerId: mgrEmp });
    const mgr = await userFor(mgrEmp, 'manager', { type: 'own_team' });
    const seen = (await api('GET', `/v1/employees/${id}?asOf=2026-03-01`, undefined, mgr)).json().employee;
    expect(seen.grade).toBeUndefined();
    expect(seen.gradeId).toBeUndefined();
  });
});

describe('custom fields: every type, validation, field-level permissions and audit', () => {
  const key = (k: string) => `${k}${Math.random().toString(36).slice(2, 6)}`;
  async function uploadDoc(employeeId: string) {
    const created = await api('POST', '/v1/documents', {
      title: 'Certificate',
      fileName: 'cert.pdf',
      contentType: 'application/pdf',
      sizeBytes: 12,
      employeeId,
    });
    const store = ctx.deps.objects as unknown as { put(k: string, b: Buffer, t: string): Promise<void> };
    await store.put(
      decodeURIComponent(created.json().uploadUrl.replace('memory://put/', '')),
      Buffer.from('%PDF-1.7 ok'),
      'application/pdf',
    );
    expect((await api('POST', `/v1/documents/${created.json().id}/complete`)).statusCode).toBe(200);
    return created.json().id as string;
  }

  it('stores valid values of all eight types and rejects invalid ones with a validation error', async () => {
    const k = {
      text: key('cfText'),
      number: key('cfNumber'),
      date: key('cfDate'),
      select: key('cfSelect'),
      multi: key('cfMulti'),
      bool: key('cfBool'),
      money: key('cfMoney'),
      file: key('cfFile'),
    };
    const define = (body: Record<string, unknown>) =>
      api('POST', '/v1/settings/custom-fields', { label: { 'en-GB': 'Field', 'en-US': 'Field' }, ...body });
    const opts = [
      { value: 'a', label: { 'en-GB': 'A' } },
      { value: 'b', label: { 'en-GB': 'B' } },
      { value: 'c', label: { 'en-GB': 'C' } },
    ];
    for (const r of await Promise.all([
      define({ key: k.text, fieldType: 'text', validation: { pattern: '^[A-Z]{2}\\d{3}$' } }),
      define({ key: k.number, fieldType: 'number', validation: { min: 0, max: 100 } }),
      define({ key: k.date, fieldType: 'date' }),
      define({ key: k.select, fieldType: 'select', options: opts }),
      define({ key: k.multi, fieldType: 'multi_select', options: opts }),
      define({ key: k.bool, fieldType: 'boolean' }),
      define({ key: k.money, fieldType: 'currency', effectiveDated: true }),
      define({ key: k.file, fieldType: 'file' }),
    ]))
      expect(r.statusCode, r.body).toBe(201);
    const id = await hire({});
    const docId = await uploadDoc(id);
    const valid = {
      [k.text]: 'AB123',
      [k.number]: 42.5,
      [k.date]: '2026-04-01',
      [k.select]: 'b',
      [k.multi]: ['a', 'c'],
      [k.bool]: true,
      [k.money]: { amountMinor: 125_000, currency: 'GBP' },
      [k.file]: { documentId: docId },
    };
    const ok = await api('POST', `/v1/employees/${id}/changes`, {
      effectiveDate: '2026-03-01',
      custom: valid,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await api('GET', `/v1/employees/${id}?asOf=2026-03-01`)).json().employee.custom).toEqual(valid);
    // effective-dated currency field: the earlier date has no value, the later date has the new one
    await api('POST', `/v1/employees/${id}/changes`, {
      effectiveDate: '2026-06-01',
      custom: { [k.money]: { amountMinor: 150_000, currency: 'GBP' } },
    });
    expect(
      (await api('GET', `/v1/employees/${id}?asOf=2026-02-01`)).json().employee.custom?.[k.money],
    ).toBeUndefined();
    expect((await api('GET', `/v1/employees/${id}?asOf=2026-04-01`)).json().employee.custom[k.money]).toEqual(
      { amountMinor: 125_000, currency: 'GBP' },
    );
    expect((await api('GET', `/v1/employees/${id}?asOf=2026-06-01`)).json().employee.custom[k.money]).toEqual(
      { amountMinor: 150_000, currency: 'GBP' },
    );

    const invalid: Array<[string, unknown]> = [
      [k.text, 'ab123'],
      [k.text, 7],
      [k.number, 101],
      [k.number, '42'],
      [k.date, '01/04/2026'],
      [k.select, 'z'],
      [k.multi, ['a', 'z']],
      [k.multi, 'a'],
      [k.bool, 'yes'],
      [k.money, { amountMinor: 1.5, currency: 'GBP' }],
      [k.money, { amountMinor: 100, currency: 'pounds' }],
      [k.file, { documentId: 'not-a-uuid' }],
      [k.file, { documentId: '00000000-0000-4000-8000-000000000123' }],
    ];
    for (const [field, value] of invalid) {
      const res = await api('POST', `/v1/employees/${id}/changes`, {
        effectiveDate: '2026-03-01',
        custom: { [field]: value },
      });
      expect(res.statusCode, `${field}=${JSON.stringify(value)}`).toBe(400);
      expect(res.json().detail).toBe(`Invalid value for ${field}`);
    }
    // a document about someone else cannot be attached
    const other = await hire({});
    const othersDoc = await uploadDoc(other);
    expect(
      (
        await api('POST', `/v1/employees/${id}/changes`, {
          effectiveDate: '2026-03-01',
          custom: { [k.file]: { documentId: othersDoc } },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('field-level permissions hide and protect custom fields, and changes are audited', async () => {
    const open = key('cfBadge');
    const secret = key('cfSecret');
    await api('POST', '/v1/settings/custom-fields', {
      key: open,
      label: { 'en-GB': 'Badge' },
      fieldType: 'number',
    });
    await api('POST', '/v1/settings/custom-fields', {
      key: secret,
      label: { 'en-GB': 'Vetting level' },
      fieldType: 'text',
    });
    const mgrEmp = await hire({ legalFirstName: 'Custodian' });
    const id = await hire({ managerId: mgrEmp, custom: { [open]: 7, [secret]: 'SC' } });

    // built-in manager: no access to custom fields at all
    const mgr = await userFor(mgrEmp, 'manager', { type: 'own_team' });
    const seen = (await api('GET', `/v1/employees/${id}`, undefined, mgr)).json();
    expect(seen.employee.custom).toBeUndefined();
    expect(seen.access[`custom.${open}`]).toBe('none');
    expect(
      (
        await api(
          'POST',
          `/v1/employees/${id}/changes`,
          { effectiveDate: '2026-05-01', custom: { [open]: 8 } },
          mgr,
        )
      ).statusCode,
    ).toBe(403);

    // a custom role that can edit people but not the secret field
    const roleKey = key('people_editor');
    await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.exec(
        `INSERT INTO app.roles (tenant_id, key, name, permissions, field_access) VALUES (app.current_tenant(), $1, 'People editor', '{employees.read,employees.update}', $2)`,
        [roleKey, JSON.stringify({ 'employee.*': 'write', [`employee.custom.${secret}`]: 'none' })],
      ),
    );
    const editorEmp = await hire({ legalFirstName: 'Editor' });
    const editor = await userFor(editorEmp, roleKey, { type: 'all' });
    const view = (await api('GET', `/v1/employees/${id}`, undefined, editor)).json();
    expect(view.employee.custom).toEqual({ [open]: 7 });
    expect(view.access).toMatchObject({ [`custom.${open}`]: 'write', [`custom.${secret}`]: 'none' });
    expect(
      (
        await api(
          'POST',
          `/v1/employees/${id}/changes`,
          { effectiveDate: '2026-05-01', custom: { [secret]: 'DV' } },
          editor,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await api(
          'POST',
          `/v1/employees/${id}/changes`,
          { effectiveDate: '2026-05-01', custom: { [open]: 8 } },
          editor,
        )
      ).statusCode,
    ).toBe(200);
    // the owner still sees the untouched secret value
    expect((await api('GET', `/v1/employees/${id}`)).json().employee.custom).toEqual({
      [open]: 8,
      [secret]: 'SC',
    });

    const rows = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ diff: { changes: Record<string, unknown> }; actor_id: string }>(
        `SELECT diff, actor_id FROM audit.events WHERE action = 'employee.changed' AND target_id = $1 ORDER BY id`,
        [id],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.diff.changes).toEqual({ [`custom.${open}`]: { from: 7, to: 8 } });
  });
});

describe('fuzzy search', () => {
  it('finds a person by a misspelt name (trigram word similarity) and not by an unrelated term', async () => {
    const id = await hire({ legalFirstName: 'Bartholomew', legalLastName: 'Fictitious' });
    for (const q of ['Bartholomeu', 'Fictitous', 'bartolomew']) {
      const ids = (await api('GET', `/v1/employees?q=${encodeURIComponent(q)}`))
        .json()
        .data.map((e: { id: string }) => e.id);
      expect(ids, q).toContain(id);
    }
    const none = (await api('GET', `/v1/employees?q=Zzyzxq`)).json().data.map((e: { id: string }) => e.id);
    expect(none).not.toContain(id);
  });
});

describe('organisation: cost centres, matrix reporting and org-chart search', () => {
  it('cost centres are managed reference data with unique codes, audit and permission checks', async () => {
    const code = `CC-${Math.random().toString(36).slice(2, 7)}`;
    const created = await api('POST', '/v1/org/cost-centres', {
      code,
      name: 'People operations',
      entityId: entityUk,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ code, name: 'People operations', entityId: entityUk });
    const id = created.json().id;
    expect((await api('POST', '/v1/org/cost-centres', { code, name: 'Duplicate' })).statusCode).toBe(409);
    expect(
      (
        await api('POST', '/v1/org/cost-centres', {
          code: `${code}x`,
          name: 'Bad entity',
          entityId: '00000000-0000-4000-8000-0000000000ee',
        })
      ).statusCode,
    ).toBe(422);
    const renamed = await api('PATCH', `/v1/org/cost-centres/${id}`, { name: 'People ops' });
    expect(renamed.json()).toMatchObject({ id, name: 'People ops' });
    const listed = (await api('GET', '/v1/org/cost-centres')).json() as Array<{ id: string; name: string }>;
    expect(listed.find((c) => c.id === id)?.name).toBe('People ops');
    const audit = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ action: string }>(`SELECT action FROM audit.events WHERE target_id = $1 ORDER BY id`, [id]),
    );
    expect(audit.map((a) => a.action)).toEqual(['org.cost-centres.created', 'org.cost-centres.updated']);
    // managers can read reference data but not change it
    const mgrEmp = await hire({ legalFirstName: 'Costless' });
    const mgr = await userFor(mgrEmp, 'manager', { type: 'own_team' });
    expect((await api('GET', '/v1/org/cost-centres', undefined, mgr)).statusCode).toBe(200);
    expect(
      (await api('POST', '/v1/org/cost-centres', { code: `${code}m`, name: 'Nope' }, mgr)).statusCode,
    ).toBe(403);
  });

  it('matrix and dotted lines are effective-dated and give the matrix manager team read access only while in force', async () => {
    const lineMgr = await hire({ legalFirstName: 'Solid' });
    const matrixMgr = await hire({ legalFirstName: 'Matrix' });
    const laterMgr = await hire({ legalFirstName: 'Later' });
    const emp = await hire({ legalFirstName: 'Dual', managerId: lineMgr });
    expect(
      (
        await api('POST', `/v1/employees/${emp}/reporting-lines`, {
          managerId: matrixMgr,
          kind: 'matrix',
          effectiveDate: '2026-02-01',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await api('POST', `/v1/employees/${emp}/reporting-lines`, {
          managerId: laterMgr,
          kind: 'matrix',
          effectiveDate: '2030-01-01',
        })
      ).statusCode,
    ).toBe(201);
    // overlapping identical matrix line is rejected by the exclusion constraint
    expect(
      (
        await api('POST', `/v1/employees/${emp}/reporting-lines`, {
          managerId: matrixMgr,
          kind: 'matrix',
          effectiveDate: '2026-06-01',
        })
      ).statusCode,
    ).toBe(409);
    const hist = (await api('GET', `/v1/employees/${emp}/history`)).json();
    expect(
      hist.reporting.map((r: { kind: string; manager_id: string }) => `${r.kind}:${r.manager_id}`).sort(),
    ).toEqual([`matrix:${laterMgr}`, `matrix:${matrixMgr}`, `solid:${lineMgr}`].sort());
    // the solid line is unchanged and the org chart (solid lines) still places them under the line manager
    expect((await api('GET', `/v1/employees/${emp}`)).json().employee.managerId).toBe(lineMgr);
    expect(
      (await api('GET', `/v1/org-chart/${lineMgr}/children`)).json().map((c: { id: string }) => c.id),
    ).toContain(emp);
    expect(
      (await api('GET', `/v1/org-chart/${matrixMgr}/children`)).json().map((c: { id: string }) => c.id),
    ).not.toContain(emp);
    const matrix = await userFor(matrixMgr, 'manager', { type: 'own_team' });
    const later = await userFor(laterMgr, 'manager', { type: 'own_team' });
    const seen = await api('GET', `/v1/employees/${emp}`, undefined, matrix);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().employee.payAmountMinor).toBeUndefined();
    expect(
      (await api('GET', '/v1/employees', undefined, matrix)).json().data.map((e: { id: string }) => e.id),
    ).toContain(emp);
    expect(
      (
        await api(
          'POST',
          `/v1/employees/${emp}/changes`,
          { effectiveDate: '2026-11-01', jobTitle: 'Matrixed' },
          matrix,
        )
      ).statusCode,
    ).toBe(403);
    // a matrix line that starts in the future grants nothing yet
    expect((await api('GET', `/v1/employees/${emp}`, undefined, later)).statusCode).toBe(403);
  });

  it('org-chart search finds active people by name, misspelling, number and title, with report counts', async () => {
    const boss = await hire({
      legalFirstName: 'Philippa',
      legalLastName: 'Orgsearch',
      jobTitle: 'Chief cartographer',
      employeeNumber: `ORG${Math.floor(Math.random() * 1e6)}`,
    });
    await hire({ legalFirstName: 'Report', managerId: boss });
    await hire({ legalFirstName: 'Report', managerId: boss });
    const leaver = await hire({
      legalFirstName: 'Philippa',
      legalLastName: 'Orgsearchleft',
      startDate: '2024-01-08',
    });
    expect(
      (
        await api('POST', `/v1/employees/${leaver}/terminate`, {
          endDate: '2025-03-31',
          reason: 'Resignation',
        })
      ).statusCode,
    ).toBe(200);
    const search = async (q: string) =>
      (await api('GET', `/v1/org-chart/search?q=${encodeURIComponent(q)}`)).json() as Array<{
        id: string;
        directReports: number;
        jobTitle: string;
      }>;
    for (const q of ['Orgsearch', 'Philipa Orgserch', 'cartographer'])
      expect(
        (await search(q)).map((n) => n.id),
        q,
      ).toContain(boss);
    const hit = (await search('Orgsearch')).find((n) => n.id === boss)!;
    expect(hit).toMatchObject({ directReports: 2, jobTitle: 'Chief cartographer' });
    expect((await search('Orgsearch')).map((n) => n.id)).not.toContain(leaver);
    // every signed-in person may search the chart; anonymous callers may not
    const self = await userFor(boss, 'employee', { type: 'self' });
    expect((await api('GET', '/v1/org-chart/search?q=Orgsearch', undefined, self)).statusCode).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/org-chart/search?q=Orgsearch' })).statusCode,
    ).toBe(401);
  });
});
