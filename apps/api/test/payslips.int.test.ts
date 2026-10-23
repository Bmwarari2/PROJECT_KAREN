import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { phase6Company, type Phase6Company } from './phase6-fixtures';
import type { MemoryObjectStore } from '../src/lib/object-store';

/**
 * PROGRESS 6.3: bulk upload of payslips and year-end documents (PDFs or a zip) with employee matching by
 * employee number or file-name pattern, a preview of matched and unmatched files, restricted storage in
 * the home-region object store, employee self-service (own documents only) and notifications.
 */
let ctx: TestContext;
let c: Phase6Company;
const emp: Record<string, string> = {};
const num: Record<string, string> = {};
let payroll: string;
const cookies: Record<string, string> = {};
const pdf = (text: string) =>
  Buffer.from(`%PDF-1.4\n% fictional payslip: ${text}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);

function multipart(
  fields: Record<string, string>,
  files: Array<{ name: string; body: Buffer; type?: string }>,
) {
  const boundary = `----thapsus${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files)
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'application/pdf'}\r\n\r\n`,
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
const upload = async (
  fields: Record<string, string>,
  files: Array<{ name: string; body: Buffer; type?: string }>,
  cookie = payroll,
) => {
  const m = multipart(fields, files);
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/payslips/batches',
    payload: m.payload,
    headers: { ...m.headers, cookie },
  });
};
const objects = () => (ctx.deps.objects as MemoryObjectStore).objects;

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  c = await phase6Company(ctx);
  const mgr = await c.hire({ legalFirstName: 'Mina', legalLastName: 'Manager' });
  emp.ada = await c.hire({
    legalFirstName: 'Ada',
    legalLastName: 'Fictional',
    managerId: mgr,
    employeeNumber: 'PAY-1001',
  });
  emp.bo = await c.hire({
    legalFirstName: 'Bo',
    legalLastName: 'Fictional',
    managerId: mgr,
    employeeNumber: 'PAY-1002',
  });
  emp.cy = await c.hire({ legalFirstName: 'Cy', legalLastName: 'Fictional', employeeNumber: '200300' });
  num.ada = 'PAY-1001';
  num.bo = 'PAY-1002';
  payroll = await c.login(null, 'payroll_admin');
  cookies.ada = await c.login(emp.ada);
  cookies.bo = await c.login(emp.bo);
  cookies.mgr = await c.login(mgr, 'manager');
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

let batchId: string;
let unmatchedItem: string;

describe('bulk upload with matching preview', () => {
  it('matches files in a zip and loose PDFs by employee number; shows unmatched and rejected files', async () => {
    const zip = new JSZip();
    zip.file('May 2026/PAY-1001_2026-05.pdf', pdf('ada may'));
    zip.file('May 2026/payslip-pay-1002-may.pdf', pdf('bo may'));
    zip.file('May 2026/someone-else.pdf', pdf('unknown'));
    zip.file('May 2026/readme.txt', 'not a payslip');
    zip.file('__MACOSX/._PAY-1001_2026-05.pdf', 'resource fork');
    const body = await zip.generateAsync({ type: 'nodebuffer' });
    const r = await upload(
      { kind: 'payslip', docType: 'payslip', label: 'May 2026', payDate: '2026-05-29' },
      [
        { name: 'may-2026.zip', body, type: 'application/zip' },
        { name: '200300 May 2026.pdf', body: pdf('cy may') },
        { name: 'dup-PAY-1001.pdf', body: pdf('ada may') },
      ],
    );
    expect(r.statusCode, r.body).toBe(201);
    const b = r.json();
    batchId = b.id;
    expect(b).toMatchObject({
      kind: 'payslip',
      label: 'May 2026',
      status: 'draft',
      fileCount: 4,
      matchedCount: 3,
    });
    const by = Object.fromEntries(b.items.map((i: { fileName: string }) => [i.fileName, i]));
    expect(by['PAY-1001_2026-05.pdf']).toMatchObject({
      matchStatus: 'matched',
      employeeId: emp.ada,
      employeeNumber: 'PAY-1001',
    });
    expect(by['payslip-pay-1002-may.pdf']).toMatchObject({ matchStatus: 'matched', employeeId: emp.bo }); // case-insensitive token match
    expect(by['200300 May 2026.pdf']).toMatchObject({ matchStatus: 'matched', employeeId: emp.cy });
    expect(by['someone-else.pdf']).toMatchObject({
      matchStatus: 'unmatched',
      employeeId: null,
      detail: { reason: 'noEmployeeNumber' },
    });
    unmatchedItem = by['someone-else.pdf'].id;
    expect(b.rejected).toEqual(
      expect.arrayContaining([
        { name: 'readme.txt', reason: 'notPdf' },
        { name: 'dup-PAY-1001.pdf', reason: 'duplicate' },
      ]),
    );
    // stored in the home-region bucket under the tenant's prefix
    const keys = await c.tx((t) =>
      t.query<{ file_key: string }>('SELECT file_key FROM app.payslips WHERE batch_id = $1', [batchId]),
    );
    expect(
      keys.every(
        (k) => k.file_key.startsWith(`${c.owner.tenantId}/payslips/${batchId}/`) && objects().has(k.file_key),
      ),
    ).toBe(true);
  });

  it('matches year-end documents with a file-name pattern and flags ambiguous names', async () => {
    const r = await upload(
      {
        kind: 'year_end',
        docType: 'p60',
        label: '2025-26',
        taxYear: '2025-26',
        matchBy: 'pattern',
        pattern: '^P60_(?<employeeNumber>[A-Z]+-\\d+)_',
      },
      [
        { name: 'P60_PAY-1001_2025-26.pdf', body: pdf('ada p60') },
        { name: 'P60_PAY-9999_2025-26.pdf', body: pdf('nobody p60') },
      ],
    );
    expect(r.statusCode, r.body).toBe(201);
    expect(
      r
        .json()
        .items.map((i: { matchStatus: string }) => i.matchStatus)
        .sort(),
    ).toEqual(['matched', 'unmatched']);
    const amb = await upload({ kind: 'payslip', label: 'Ambiguous' }, [
      { name: 'PAY-1001 and PAY-1002.pdf', body: pdf('both') },
    ]);
    expect(amb.json().items[0]).toMatchObject({
      matchStatus: 'ambiguous',
      detail: { reason: 'severalEmployees', candidates: 2 },
    });
    const badPattern = await upload({ kind: 'payslip', label: 'x', matchBy: 'pattern', pattern: '([' }, [
      { name: 'a.pdf', body: pdf('a') },
    ]);
    expect(badPattern.statusCode).toBe(400);
    const noPdf = await upload({ kind: 'payslip', label: 'x' }, [
      { name: 'a.txt', body: Buffer.from('plain'), type: 'text/plain' },
    ]);
    expect(noPdf.statusCode).toBe(400);
  });

  it('only payroll roles can upload; HR admins, managers and employees cannot', async () => {
    const hr = await c.login(await c.hire(), 'hr_admin');
    for (const cookie of [hr, cookies.mgr!, cookies.ada!])
      expect(
        (await upload({ kind: 'payslip', label: 'x' }, [{ name: 'PAY-1001.pdf', body: pdf('x') }], cookie))
          .statusCode,
      ).toBe(403);
  });
});

describe('publish, notify and self-service', () => {
  it('a file can be matched by hand; publishing notifies each employee once', async () => {
    const m = await c.api(
      'PUT',
      `/v1/payslips/batches/${batchId}/items/${unmatchedItem}`,
      { employeeId: emp.bo },
      payroll,
    );
    expect(m.statusCode, m.body).toBe(200);
    expect(m.json()).toMatchObject({ matchStatus: 'manual', employeeId: emp.bo });
    // employees see nothing before publication
    expect((await c.api('GET', '/v1/me/payslips', undefined, cookies.ada)).json()).toEqual([]);
    const p = await c.api('POST', `/v1/payslips/batches/${batchId}/publish`, undefined, payroll);
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toEqual({ published: 4, notified: 3, unmatched: 0 }); // Cy has no login; Bo gets one notification per document
    const notes = await c.tx((t) =>
      t.query<{ title_key: string; link: string; params: { label: string } }>(
        `SELECT n.title_key, n.link, n.params FROM app.notifications n JOIN app.users u ON u.tenant_id = n.tenant_id AND u.id = n.user_id WHERE u.employee_id = $1 AND n.kind = 'payslip.published'`,
        [emp.ada],
      ),
    );
    expect(notes).toEqual([
      { title_key: 'notify.payslipAvailable', link: '/app/payslips', params: { label: 'May 2026' } },
    ]);
    // publishing again sends nothing new
    expect(
      (await c.api('POST', `/v1/payslips/batches/${batchId}/publish`, undefined, payroll)).json(),
    ).toMatchObject({ published: 0, notified: 0 });
    expect(
      (
        await c.api(
          'PUT',
          `/v1/payslips/batches/${batchId}/items/${unmatchedItem}`,
          { employeeId: emp.ada },
          payroll,
        )
      ).statusCode,
    ).toBe(409);
  });

  it('employees list and download only their own payslips; every download is audited', async () => {
    const mine = (await c.api('GET', '/v1/me/payslips', undefined, cookies.ada)).json();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      kind: 'payslip',
      docType: 'payslip',
      label: 'May 2026',
      payDate: '2026-05-29',
      fileName: 'PAY-1001_2026-05.pdf',
      viewed: false,
    });
    const bos = (await c.api('GET', '/v1/me/payslips', undefined, cookies.bo)).json();
    expect(bos).toHaveLength(2);
    const dl = await c.api('GET', `/v1/payslips/${mine[0].id}/download`, undefined, cookies.ada);
    expect(dl.statusCode, dl.body).toBe(200);
    const key = decodeURIComponent(dl.json().url.replace('memory://get/', ''));
    expect(objects().get(key)!.body.toString()).toContain('ada may');
    expect((await c.api('GET', '/v1/me/payslips', undefined, cookies.ada)).json()[0].viewed).toBe(true);
    // a colleague, and the manager, cannot fetch it (indistinguishable from a missing document)
    expect(
      (await c.api('GET', `/v1/payslips/${mine[0].id}/download`, undefined, cookies.bo)).statusCode,
    ).toBe(404);
    expect(
      (await c.api('GET', `/v1/payslips/${mine[0].id}/download`, undefined, cookies.mgr)).statusCode,
    ).toBe(404);
    expect((await c.api('GET', `/v1/employees/${emp.ada}/payslips`, undefined, cookies.mgr)).statusCode).toBe(
      403,
    );
    // payroll can
    expect((await c.api('GET', `/v1/payslips/${mine[0].id}/download`, undefined, payroll)).statusCode).toBe(
      200,
    );
    expect((await c.api('GET', `/v1/employees/${emp.ada}/payslips`, undefined, payroll)).json()).toHaveLength(
      1,
    );
    const audits = await c.tx((t) =>
      t.query<{ sensitive: boolean; diff: { own: boolean } }>(
        `SELECT sensitive, diff FROM audit.events WHERE action = 'payslip.downloaded' AND target_id = $1 ORDER BY id`,
        [mine[0].id],
      ),
    );
    expect(audits.map((a) => [a.sensitive, a.diff.own])).toEqual([
      [true, true],
      [true, false],
    ]);
    // payslips never appear in the general document library
    expect(
      (await c.api('GET', `/v1/documents?employeeId=${emp.ada}`, undefined, cookies.ada)).json(),
    ).toEqual([]);
  });

  it('a document sent in error can be withdrawn; discarding a draft batch deletes its files', async () => {
    const mine = (await c.api('GET', '/v1/me/payslips', undefined, cookies.ada)).json();
    expect(
      (await c.api('POST', `/v1/payslips/${mine[0].id}/withdraw`, { reason: 'Wrong month' }, payroll))
        .statusCode,
    ).toBe(200);
    expect((await c.api('GET', '/v1/me/payslips', undefined, cookies.ada)).json()).toHaveLength(0);
    const r = await upload({ kind: 'payslip', label: 'Draft to discard' }, [
      { name: 'PAY-1001-june.pdf', body: pdf('june') },
    ]);
    const keys = await c.tx((t) =>
      t.query<{ file_key: string }>('SELECT file_key FROM app.payslips WHERE batch_id = $1', [r.json().id]),
    );
    expect((await c.api('DELETE', `/v1/payslips/batches/${r.json().id}`, undefined, payroll)).json()).toEqual(
      { discarded: 1 },
    );
    expect(keys.every((k) => !objects().has(k.file_key))).toBe(true);
    expect(
      (await c.api('GET', '/v1/payslips/batches', undefined, payroll))
        .json()
        .some((b: { id: string }) => b.id === r.json().id),
    ).toBe(false);
  });
});
