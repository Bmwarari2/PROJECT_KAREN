import { afterAll, describe, expect, it } from 'vitest';
import { regionPairs } from '@thapsus/core';
import { withTenant } from '@thapsus/db';
import { closeDb, ownerSession, startTestApp } from './helpers';
import type { MemoryObjectStore } from '../src/lib/object-store';
import { isSealedFile } from '../src/lib/sealed-file';

/**
 * Residency of the documents HR attaches to a person (ADR-0165), of right-to-work evidence sealed in the vault
 * (ADR-0166) and of payslip statements with the provider's PDF (ADR-0167), for every region pair: the files land
 * only in the home cell's object store, evidence is stored as ciphertext only, and the other region's cell
 * neither holds any of it nor serves it. Fictional people and files only.
 */
afterAll(closeDb);

const PDF = (text: string) =>
  Buffer.from(`%PDF-1.4\n% fictional: ${text}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);

function multipart(
  fields: Record<string, string>,
  files: Array<{ field: string; name: string; body: Buffer; type: string }>,
) {
  const boundary = `----res${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files)
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`,
      ),
      f.body,
      Buffer.from('\r\n'),
    );
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe.each(regionPairs())('attached documents and payslips stay home (%s → %s)', (home, other) => {
  it(`files of a ${home} tenant never reach the ${other} cell`, async () => {
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
          employeeNumber: 'RES-1',
        })
      ).json().id;
      const attach = (fields: Record<string, string>, name: string, body: Buffer) => {
        const m = multipart(fields, [{ field: 'file', name, body, type: 'application/pdf' }]);
        return api(homeCell, 'POST', `/v1/employees/${emp}/documents`, m.payload, m.headers);
      };
      const contract = await attach(
        { attachmentType: 'contract', visibility: 'employee' },
        'contract.pdf',
        PDF('fictional contract'),
      );
      expect(contract.statusCode, contract.body).toBe(201);
      const evidence = await attach(
        {
          attachmentType: 'right_to_work',
          evidenceType: 'passport',
          visibility: 'hr',
          note: 'FICT-NOTE-RES',
        },
        'evidence.pdf',
        PDF('FICT-PASSPORT-RES'),
      );
      expect(evidence.statusCode, evidence.body).toBe(201);
      const m = multipart({ kind: 'payslip', label: 'September 2026' }, [
        {
          field: 'files',
          name: 'RES-1_2026-09.pdf',
          body: PDF('fictional payslip'),
          type: 'application/pdf',
        },
        {
          field: 'statements',
          name: 'statements.json',
          type: 'application/json',
          body: Buffer.from(
            JSON.stringify({
              provider: { name: 'Fictional Payroll Bureau' },
              statements: [
                {
                  employeeNumber: 'RES-1',
                  currency: 'GBP',
                  employer: { name: 'Fictional Employer Ltd' },
                  employee: { name: 'Fictional Resident' },
                  period: {
                    start: '2026-09-01',
                    end: '2026-09-30',
                    payDate: '2026-09-30',
                    frequency: 'monthly',
                  },
                  payment: { method: 'bank_transfer' },
                  payments: [{ kind: 'basic', label: 'Basic salary', amountMinor: 200_000 }],
                  deductions: [{ kind: 'income_tax', label: 'Income tax', amountMinor: 20_000 }],
                  totals: { grossMinor: 200_000, deductionsMinor: 20_000, netMinor: 180_000 },
                },
              ],
            }),
          ),
        },
      ]);
      const batch = await api(homeCell, 'POST', '/v1/payslips/batches', m.payload, m.headers);
      expect(batch.statusCode, batch.body).toBe(201);
      const payslip = batch.json().items[0].id as string;

      const homeObjects = (homeCell.deps.objects as MemoryObjectStore).objects;
      const keys = [...homeObjects.keys()].filter((k) => k.startsWith(`${s.tenantId}/`));
      expect(keys.some((k) => k.startsWith(`${s.tenantId}/employees/${emp}/`))).toBe(true);
      const sealedKey = keys.find((k) => k.startsWith(`${s.tenantId}/vault/immigration/${emp}/`));
      expect(sealedKey).toBeDefined();
      // the evidence is ciphertext only, under the home cell's keys
      const sealed = homeObjects.get(sealedKey!)!.body;
      expect(isSealedFile(sealed)).toBe(true);
      expect(sealed.toString('latin1')).not.toContain('FICT-PASSPORT-RES');
      await withTenant(homeCell.deps.router, s.tenantId, async (tx) => {
        const rows = await tx.query<{ envelope: unknown }>(
          `SELECT envelope FROM vault.records WHERE category = 'immigration'`,
        );
        expect(rows.length).toBe(1);
        expect(JSON.stringify(rows)).not.toContain('FICT-NOTE-RES');
      });
      // the other region's store holds nothing of the tenant's
      expect(
        [...(otherCell.deps.objects as MemoryObjectStore).objects.keys()].filter((k) =>
          k.startsWith(s.tenantId),
        ),
      ).toEqual([]);
      expect((await homeCell.deps.router.lookup(s.tenantId)).home_region).toBe(home);
      // and the other region's cell serves none of it
      for (const url of [
        `/v1/documents/${contract.json().id}`,
        `/v1/documents/${contract.json().id}/content`,
        `/v1/documents/${contract.json().id}/download`,
        `/v1/documents/${evidence.json().id}/content`,
        `/v1/documents?employeeId=${emp}`,
        `/v1/payslips/${payslip}`,
        `/v1/payslips/${payslip}/file`,
        `/v1/payslips/${payslip}/pdf`,
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
