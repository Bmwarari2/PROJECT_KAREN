import { closeAllPools, TenantRouter, withTenant } from '@thapsus/db';
import { directoryFromEnv } from '../lib/directory';
import { hashPassword } from '../modules/auth/tokens';
import { createUser, provisionTenant } from './provision';
import { DEPARTMENTS, isoDate, personName, prng } from './fixtures';

/**
 * `pnpm db:seed` — a small fictional UK demo company (25 employees, one legal entity).
 * Sign in at /signin with workspace "demo" and the printed credentials (local development only).
 */
const PASSWORD = process.env.SEED_PASSWORD ?? 'Demo-Password-2026';
const router = TenantRouter.fromEnv();
const directory = await directoryFromEnv();
const r = prng(20261018);

const { tenantId, created } = await provisionTenant(router, directory, {
  slug: 'demo',
  name: 'Northwind Fictional Ltd',
  region: 'uk',
  ownerEmail: 'owner@demo.example.test',
  ownerName: 'Olive Owner',
  password: PASSWORD,
});

if (!created) {
  console.log('demo tenant already seeded');
} else {
  const hash = await hashPassword(PASSWORD);
  await withTenant(router, tenantId, async (tx) => {
    const entity = await tx.one<{ id: string }>(
      `INSERT INTO app.legal_entities (tenant_id, name, country, region_code, registration_number, currency, time_zone)
       VALUES (app.current_tenant(), 'Northwind Fictional Ltd', 'GB', 'GB-ENG', '00000000', 'GBP', 'Europe/London') RETURNING id`,
    );
    const london = await tx.one<{ id: string }>(
      `INSERT INTO app.locations (tenant_id, name, entity_id, country, region_code, time_zone) VALUES (app.current_tenant(), 'London office', $1, 'GB', 'GB-ENG', 'Europe/London') RETURNING id`,
      [entity.id],
    );
    const edinburgh = await tx.one<{ id: string }>(
      `INSERT INTO app.locations (tenant_id, name, entity_id, country, region_code, time_zone) VALUES (app.current_tenant(), 'Edinburgh studio', $1, 'GB', 'GB-SCT', 'Europe/London') RETURNING id`,
      [entity.id],
    );
    const depts: Record<string, string> = {};
    for (const d of DEPARTMENTS.slice(0, 6))
      depts[d] = (
        await tx.one<{ id: string }>(
          `INSERT INTO app.departments (tenant_id, name) VALUES (app.current_tenant(), $1) RETURNING id`,
          [d],
        )
      ).id;

    const people: Array<{ id: string; dept: string; manager?: string }> = [];
    const roster: Array<[string, string, number]> = [
      ['Leadership', 'Chief executive', 0],
      ['Engineering', 'Head of engineering', 1],
      ['Operations', 'Head of operations', 1],
      ['People', 'Head of people', 1],
      ['Sales', 'Head of sales', 1],
      ['Product', 'Head of product', 1],
    ];
    for (let i = 0; i < 19; i++) {
      const d = ['Engineering', 'Operations', 'Sales', 'People', 'Product'][i % 5]!;
      roster.push([
        d,
        [
          'Software engineer',
          'Operations coordinator',
          'Account executive',
          'HR business partner',
          'Product designer',
        ][i % 5]!,
        2,
      ]);
    }
    for (const [i, [dept, title, level]] of roster.entries()) {
      const { first, last } = personName(r);
      const start = new Date(
        Date.UTC(2019 + Math.floor(r() * 6), Math.floor(r() * 12), 1 + Math.floor(r() * 27)),
      );
      const number = `NW${String(i + 1).padStart(4, '0')}`;
      const email = `${first}.${last}.${i + 1}@demo.example.test`.toLowerCase();
      const e = await tx.one<{ id: string }>(
        `INSERT INTO app.employees (tenant_id, employee_number, start_date, work_email, display_name) VALUES (app.current_tenant(), $1, $2, $3, $4) RETURNING id`,
        [number, isoDate(start), email, `${first} ${last}`],
      );
      await tx.exec(
        `INSERT INTO app.employee_personal (tenant_id, employee_id, valid_from, legal_first_name, legal_last_name, date_of_birth, personal_email)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6)`,
        [
          e.id,
          isoDate(start),
          first,
          last,
          `${1970 + Math.floor(r() * 30)}-0${1 + Math.floor(r() * 9)}-1${Math.floor(r() * 9)}`,
          `${first}.${i}@personal.example.test`.toLowerCase(),
        ],
      );
      await tx.exec(
        `INSERT INTO app.employee_jobs (tenant_id, employee_id, valid_from, job_title, department_id, location_id, entity_id, weekly_hours, employment_type, fte)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          e.id,
          isoDate(start),
          title,
          depts[dept],
          i % 4 === 3 ? edinburgh.id : london.id,
          entity.id,
          i % 6 === 5 ? 22.5 : 37.5,
          i % 6 === 5 ? 'part_time' : 'full_time',
          i % 6 === 5 ? 0.6 : 1,
        ],
      );
      await tx.exec(
        `INSERT INTO app.employee_pay (tenant_id, employee_id, valid_from, amount_minor, currency, frequency) VALUES (app.current_tenant(), $1, $2, $3, 'GBP', 'annual')`,
        [
          e.id,
          isoDate(start),
          (level === 0 ? 150000 : level === 1 ? 95000 : 35000 + Math.floor(r() * 30000)) * 100,
        ],
      );
      await tx.exec(
        `INSERT INTO app.employee_contracts (tenant_id, employee_id, valid_from, contract_type, notice_period_days) VALUES (app.current_tenant(), $1, $2, 'permanent', $3)`,
        [e.id, isoDate(start), level === 2 ? 30 : 90],
      );
      people.push({ id: e.id, dept });
    }
    const ceo = people[0]!;
    const heads = new Map(people.slice(1, 6).map((p) => [p.dept, p.id]));
    for (const [i, p] of people.entries()) {
      if (i === 0) continue;
      const manager = i < 6 ? ceo.id : (heads.get(p.dept) ?? ceo.id);
      await tx.exec(
        `INSERT INTO app.reporting_lines (tenant_id, employee_id, manager_id, kind, valid_from) VALUES (app.current_tenant(), $1, $2, 'solid', '2019-01-01')`,
        [p.id, manager],
      );
    }
    await tx.query('SELECT app.refresh_employee_current(NULL)');
    // Users for each built-in persona (all fictional).
    await createUser(tx, {
      email: 'hr@demo.example.test',
      name: 'Hana HR',
      passwordHash: hash,
      employeeId: people[3]!.id,
      roles: [
        ['hr_admin', { type: 'all' }],
        ['employee', { type: 'self' }],
      ],
    });
    await createUser(tx, {
      email: 'manager@demo.example.test',
      name: 'Max Manager',
      passwordHash: hash,
      employeeId: people[1]!.id,
      roles: [
        ['manager', { type: 'own_team' }],
        ['employee', { type: 'self' }],
      ],
    });
    await createUser(tx, {
      email: 'employee@demo.example.test',
      name: 'Emma Employee',
      passwordHash: hash,
      employeeId: people[6]!.id,
      roles: [['employee', { type: 'self' }]],
    });
    await createUser(tx, {
      email: 'payroll@demo.example.test',
      name: 'Pat Payroll',
      passwordHash: hash,
      roles: [['payroll_admin', { type: 'all' }]],
    });
    await tx.exec(`UPDATE app.users SET employee_id = $1 WHERE email = 'owner@demo.example.test'`, [ceo.id]);
  });
  console.log('seeded demo tenant (25 fictional employees, 1 legal entity)');
}
console.log(
  `sign in: workspace "demo", owner@demo.example.test / ${PASSWORD} (also hr@, manager@, employee@, payroll@)`,
);
await closeAllPools();
process.exit(0);
