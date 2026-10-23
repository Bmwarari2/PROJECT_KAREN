import { afterAll, describe, expect, it } from 'vitest';
import { regionPairs } from '@thapsus/core';
import { withTenant } from '@thapsus/db';
import { closeDb, ownerSession, startTestApp } from './helpers';
import type { MemoryObjectStore } from '../src/lib/object-store';

/**
 * Residency of compliance data, for every region pair: right-to-work evidence (immigration documents)
 * uploaded to a tenant's home cell is stored only in that cell's object store, encrypted in its vault,
 * and the other region's cell neither holds the file nor serves the tenant's compliance data.
 */
afterAll(closeDb);

describe.each(regionPairs())('compliance evidence stays home (%s → %s)', (home, other) => {
  it(`right-to-work evidence of a ${home} tenant never reaches the ${other} cell`, async () => {
    const homeCell = await startTestApp({ cell: home, listen: false });
    const otherCell = await startTestApp({ cell: other, listen: false, directory: homeCell.directory });
    try {
      const s = await ownerSession(homeCell);
      const api = (
        cell: typeof homeCell,
        method: 'GET' | 'POST',
        url: string,
        payload?: unknown,
        headers: Record<string, string> = {},
      ) =>
        cell.app.inject({
          method,
          url,
          payload: payload as Buffer,
          headers: { cookie: s.cookie, ...headers },
        });
      const ent = (
        await api(homeCell, 'POST', '/v1/org/legal-entities', {
          name: 'Fictional UK branch',
          country: 'GB',
          regionCode: 'GB-ENG',
          currency: 'GBP',
          timeZone: 'Europe/London',
        })
      ).json().id;
      const emp = (
        await api(homeCell, 'POST', '/v1/employees', {
          startDate: '2026-10-05',
          legalFirstName: 'Fictional',
          legalLastName: 'Resident',
          jobTitle: 'Analyst',
          entityId: ent,
          contractType: 'permanent',
        })
      ).json().id;
      const check = await api(homeCell, 'POST', '/v1/compliance/right-to-work/checks', {
        employeeId: emp,
        checkMethod: 'manual_document_check',
        listType: 'list_a',
        checkedOn: '2026-10-02',
        documentReference: 'FICT-RES-1',
      });
      expect(check.statusCode, check.body).toBe(201);
      const boundary = '----res';
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fictional.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        ),
        Buffer.from('%PDF-1.4 fictional'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const up = await api(
        homeCell,
        'POST',
        `/v1/compliance/right-to-work/checks/${check.json().id}/evidence`,
        body,
        { 'content-type': `multipart/form-data; boundary=${boundary}` },
      );
      expect(up.statusCode, up.body).toBe(201);
      const homeObjects = [...(homeCell.deps.objects as MemoryObjectStore).objects.keys()];
      expect(homeObjects.some((k) => k.startsWith(`${s.tenantId}/vault/immigration/`))).toBe(true);
      expect(
        [...(otherCell.deps.objects as MemoryObjectStore).objects.keys()].filter((k) =>
          k.startsWith(s.tenantId),
        ),
      ).toEqual([]);
      // the vault holds ciphertext only; the registry says the tenant lives in the home region
      await withTenant(homeCell.deps.router, s.tenantId, async (tx) => {
        const rows = await tx.query<{ envelope: unknown }>(
          `SELECT envelope FROM vault.records WHERE category = 'immigration'`,
        );
        expect(rows.length).toBe(2);
        expect(JSON.stringify(rows)).not.toContain('FICT-RES-1');
      });
      expect((await homeCell.deps.router.lookup(s.tenantId)).home_region).toBe(home);
      // the other region's cell does not serve the tenant's compliance data
      for (const url of [
        '/v1/compliance/right-to-work',
        `/v1/compliance/right-to-work/checks/${check.json().id}`,
        '/v1/compliance/dashboard',
      ]) {
        const res = await api(otherCell, 'GET', url);
        expect([401, 421], `${other} cell ${url}`).toContain(res.statusCode);
      }
    } finally {
      await homeCell.close();
      await otherCell.close();
    }
  });
});
