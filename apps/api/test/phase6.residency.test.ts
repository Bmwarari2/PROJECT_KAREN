import { afterAll, describe, expect, it } from 'vitest';
import { regionPairs } from '@thapsus/core';
import { closeDb, startTestApp } from './helpers';
import { phase6Company } from './phase6-fixtures';
import type { MemoryObjectStore } from '../src/lib/object-store';

/**
 * Residency for Phase 6, for every region pair: payroll exports and payslip files are written only to
 * the home cell's object store, the other cell's store never receives them, and the other cell refuses
 * to serve the tenant's payroll or payslip endpoints at all.
 */
afterAll(closeDb);

const pdf = Buffer.from('%PDF-1.4\n% fictional\n%%EOF\n');

describe.each(regionPairs())('payroll files stay home (%s → %s)', (home, other) => {
  it(`a ${home} tenant's exports and payslips exist only in the ${home} store; the ${other} cell refuses them`, async () => {
    const homeCell = await startTestApp({ cell: home, listen: false });
    const otherCell = await startTestApp({ cell: other, listen: false, directory: homeCell.directory });
    try {
      const c = await phase6Company(homeCell);
      const emp = await c.hire({ employeeNumber: `RES-${home}`, startDate: '2026-03-02' });
      const period = (await c.api('POST', '/v1/payroll/periods', { name: 'March 2026', frequency: 'monthly', startDate: '2026-03-01', endDate: '2026-03-31' })).json().id;
      const conn = (await c.api('POST', '/v1/payroll/connectors', { name: 'Residency CSV', kind: 'csv' })).json().id;
      const ex = await c.api('POST', `/v1/payroll/periods/${period}/exports`, { connectorId: conn });
      expect(ex.statusCode, ex.body).toBe(201);
      const boundary = 'residency';
      const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="label"\r\n\r\nMarch\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="RES-${home}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), pdf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const up = await homeCell.app.inject({ method: 'POST', url: '/v1/payslips/batches', payload, headers: { cookie: c.owner.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } });
      expect(up.statusCode, up.body).toBe(201);
      expect(up.json().items[0].employeeId).toBe(emp);

      const homeKeys = [...(homeCell.deps.objects as MemoryObjectStore).objects.keys()].filter((k) => k.startsWith(`${c.owner.tenantId}/`));
      expect(homeKeys.some((k) => k.includes('/payroll/exports/'))).toBe(true);
      expect(homeKeys.some((k) => k.includes('/payslips/'))).toBe(true);
      expect([...(otherCell.deps.objects as MemoryObjectStore).objects.keys()].filter((k) => k.startsWith(`${c.owner.tenantId}/`))).toEqual([]);

      // the other region's cell does not know the tenant: no session, no exports, no payslips
      for (const url of [`/v1/payroll/exports/${ex.json().id}/download`, '/v1/payroll/connectors', `/v1/payslips/batches/${up.json().id}`, '/v1/integrations/it', '/v1/assets']) {
        const res = await otherCell.app.inject({ method: 'GET', url, headers: { cookie: c.owner.cookie } });
        expect(res.statusCode, `${other} ${url}`).toBeGreaterThanOrEqual(400);
      }
      expect([...(otherCell.deps.objects as MemoryObjectStore).objects.keys()]).toEqual([]);
    } finally {
      await homeCell.close();
      await otherCell.close();
    }
  });
});
