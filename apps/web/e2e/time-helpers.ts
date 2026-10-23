import { expect, type Page } from '@playwright/test';
import pg from 'pg';
import { E2E_DB } from './env';
import { signUpAndEnrol } from './helpers';

const OWNER = process.env.TEST_PG_OWNER_URL ?? 'postgres://thapsus_owner:owner_dev_password@127.0.0.1:5432';

/** Direct SQL against the throwaway e2e database (fixture setup and assertions only). */
export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: `${OWNER}/${E2E_DB}` });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

export const STAFF = ['Ada Fictional', 'Ben Fictional', 'Cleo Fictional'];

/**
 * A fictional UK company with a London store and staff. The owner's account is linked to the first
 * employee (Ada) so the same browser session can manage the rota and clock in.
 */
export async function companyWithStaff(page: Page, count = 2) {
  const owner = await signUpAndEnrol(page);
  const post = async (url: string, data: unknown) => {
    const r = await page.request.post(url, { data });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()).id as string;
  };
  const entity = await post('/v1/org/legal-entities', {
    name: 'Fictional Shops Ltd',
    country: 'GB',
    regionCode: 'GB-ENG',
    currency: 'GBP',
    timeZone: 'Europe/London',
  });
  const location = await post('/v1/org/locations', {
    name: 'Fictional Store London',
    country: 'GB',
    regionCode: 'GB-ENG',
    timeZone: 'Europe/London',
    entityId: entity,
  });
  const staff: string[] = [];
  for (const name of STAFF.slice(0, count)) {
    const [first, last] = name.split(' ');
    staff.push(
      await post('/v1/employees', {
        startDate: '2025-01-06',
        legalFirstName: first,
        legalLastName: last,
        jobTitle: 'Store associate',
        entityId: entity,
        locationId: location,
        weeklyHours: 40,
        payAmountMinor: 1500,
        payCurrency: 'GBP',
        payFrequency: 'hourly',
        contractType: 'permanent',
      }),
    );
  }
  await sql(`UPDATE app.users SET employee_id = $1 WHERE lower(email) = lower($2)`, [staff[0], owner.email]);
  const number = (
    await sql<{ employee_number: string }>('SELECT employee_number FROM app.employees WHERE id = $1', [
      staff[0],
    ])
  )[0]!.employee_number;
  return { ...owner, entity, location, staff, employeeNumber: number };
}
