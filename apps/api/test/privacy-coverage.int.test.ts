import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeAllPools, Tx, type PoolClient } from '@thapsus/db';
import { ownerUrl, TEST_DBS } from '@thapsus/db/testing';
import { coverageProblems, personColumns, SUBJECT_TABLES } from '../src/modules/privacy/subject-map';

/**
 * Export completeness: every column in every tenant table that references an employee or a user
 * (foreign keys, or uuid columns named like *employee_id, *user_id, *_by) must be mapped for the
 * access export and the erasure workflow. A new table that references people fails here until it
 * is added to SUBJECT_TABLES with what export and erasure should do with it.
 */
let owner: pg.Client;
afterAll(async () => {
  await owner?.end();
  await closeAllPools();
});

const asTx = (c: pg.Client) => new Tx(c as unknown as PoolClient);

describe('privacy table coverage', () => {
  it('maps every person reference in the live catalog', async () => {
    owner = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
    await owner.connect();
    expect(await coverageProblems(asTx(owner))).toEqual([]);
    const cols = await personColumns(asTx(owner));
    expect(cols.length).toBeGreaterThan(40);
    expect(Object.keys(SUBJECT_TABLES)).toEqual(
      expect.arrayContaining(['app.employees', 'app.users', 'vault.records', 'audit.events']),
    );
  });

  it('fails when a new table references employees without an entry in the map', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query(
        `CREATE TABLE app.zz_fictional_new_feature (tenant_id uuid NOT NULL, id uuid NOT NULL, employee_id uuid NOT NULL, approved_by uuid, PRIMARY KEY (tenant_id, id), FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id))`,
      );
      const problems = await coverageProblems(asTx(owner));
      expect(problems).toEqual(
        expect.arrayContaining([
          expect.stringContaining('app.zz_fictional_new_feature.employee_id'),
          expect.stringContaining('app.zz_fictional_new_feature.approved_by'),
        ]),
      );
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('fails when a mapped table gains an unmapped person column', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query(`ALTER TABLE app.leave_requests ADD COLUMN reviewer_user_id uuid`);
      expect(await coverageProblems(asTx(owner))).toEqual([
        expect.stringContaining('app.leave_requests.reviewer_user_id'),
      ]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
