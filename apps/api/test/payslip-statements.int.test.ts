import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, randomIp, startTestApp, type TestContext } from './helpers';
import { phase6Company, type Phase6Company } from './phase6-fixtures';
import { pdfPageTexts } from './pdf-text';

/**
 * Payslips as the payroll provider supplies them (ADR-0167): structured statements imported through the payslip
 * batch upload (with or without the provider's PDF), checked so their lines add up, published, listed by year and
 * shown in the app, with a PDF of the statement when the provider sent none. Nothing is calculated here. Every
 * name, number and amount is fictional.
 */
let ctx: TestContext;
let c: Phase6Company;
const emp: Record<string, string> = {};
const cookie: Record<string, string> = {};
const pdf = (text: string) =>
  Buffer.from(`%PDF-1.4\n% fictional provider payslip: ${text}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);

function statement(employeeNumber: string, month: string, over: Record<string, unknown> = {}) {
  return {
    employeeNumber,
    currency: 'GBP',
    employer: { name: 'Fictional Payroll UK Ltd', address: ['1 Example Street'], taxReference: 'SAMPLE/001' },
    employee: { name: 'Ada Fictional', taxCode: 'SAMPLE1', nationalId: 'QQ 12 34 56 C' },
    period: {
      start: `${month}-01`,
      end: `${month}-28`,
      payDate: `${month}-28`,
      frequency: 'monthly',
      number: 'Month 6',
      taxYear: '2026-27',
    },
    payment: { method: 'bank_transfer', account: '12345678' },
    payments: [
      { kind: 'basic', label: 'Basic salary', amountMinor: 250_000 },
      { kind: 'overtime', label: 'Overtime', quantity: '4.00', rateMinor: 2_250, amountMinor: 9_000 },
    ],
    deductions: [
      { kind: 'income_tax', label: 'Income tax', amountMinor: 31_000 },
      { kind: 'social_security', label: 'National Insurance', amountMinor: 12_500 },
      { kind: 'pension', label: 'Pension', amountMinor: 7_500 },
    ],
    employerContributions: [{ kind: 'pension', label: 'Employer pension', amountMinor: 4_500 }],
    totals: { grossMinor: 259_000, deductionsMinor: 51_000, netMinor: 208_000 },
    ytd: [
      { key: 'gross', label: 'Gross pay to date', amountMinor: 1_554_000 },
      { key: 'net', label: 'Net pay to date', amountMinor: 1_248_000 },
    ],
    notes: ['Fictional provider message.'],
    ...over,
  };
}

function multipart(
  fields: Record<string, string>,
  files: Array<{ field?: string; name: string; body: Buffer; type?: string }>,
) {
  const boundary = `----thapsus${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files)
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'files'}"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'application/pdf'}\r\n\r\n`,
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
const upload = (
  fields: Record<string, string>,
  statements: unknown,
  files: Array<{ name: string; body: Buffer }> = [],
  as = cookie.payroll!,
) => {
  const m = multipart(fields, [
    ...files,
    ...(statements === undefined
      ? []
      : [
          {
            field: 'statements',
            name: 'statements.json',
            body: Buffer.from(JSON.stringify(statements)),
            type: 'application/json',
          },
        ]),
  ]);
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/payslips/batches',
    payload: m.payload,
    headers: { ...m.headers, cookie: as },
    remoteAddress: randomIp(),
  });
};
const get = (url: string, as: string) => c.api('GET', url, undefined, as);

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  c = await phase6Company(ctx);
  const mgr = await c.hire({ legalFirstName: 'Mina', legalLastName: 'Manager' });
  emp.ada = await c.hire({
    legalFirstName: 'Ada',
    legalLastName: 'Fictional',
    managerId: mgr,
    employeeNumber: 'STM-1',
  });
  emp.bo = await c.hire({
    legalFirstName: 'Bo',
    legalLastName: 'Fictional',
    managerId: mgr,
    employeeNumber: 'STM-2',
  });
  cookie.payroll = await c.login(null, 'payroll_admin');
  cookie.ada = await c.login(emp.ada);
  cookie.bo = await c.login(emp.bo);
  cookie.mgr = await c.login(mgr, 'manager');
  cookie.hr = await c.login(await c.hire(), 'hr_admin');
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

let septemberBatch: string;

describe('importing the provider’s statements', () => {
  it('matches statements by employee number, attaches the provider’s PDF to the same person and refuses statements that do not add up', async () => {
    const bad = statement('STM-2', '2026-09', {
      totals: { grossMinor: 259_000, deductionsMinor: 51_000, netMinor: 208_100 },
    });
    const r = await upload(
      { kind: 'payslip', label: 'September 2026' },
      {
        provider: { name: 'Fictional Payroll Bureau' },
        statements: [statement('STM-1', '2026-09'), bad, statement('NOPE-9', '2026-09')],
      },
      [{ name: 'STM-1_2026-09.pdf', body: pdf('ada september') }],
    );
    expect(r.statusCode, r.body).toBe(201);
    const b = r.json();
    septemberBatch = b.id;
    expect(b).toMatchObject({
      source: 'provider_statements',
      providerName: 'Fictional Payroll Bureau',
      sample: false,
    });
    const ada = b.items.find((i: { employeeId: string | null }) => i.employeeId === emp.ada);
    expect(ada).toMatchObject({
      hasStatement: true,
      fileName: 'STM-1_2026-09.pdf',
      netMinor: '208000',
      currency: 'GBP',
    });
    expect(b.items.find((i: { matchStatus: string }) => i.matchStatus === 'unmatched')).toMatchObject({
      hasStatement: true,
      fileName: null,
    });
    expect(b.rejected).toEqual([{ name: 'STM-2', reason: 'netDoesNotAddUp' }]);
    // only a masked national identifier and the last digits of the account are stored
    const stored = await c.tx((t) =>
      t.one<{ statement: { employee: { nationalId: string }; payment: { account: string } } }>(
        'SELECT statement FROM app.payslips WHERE batch_id = $1 AND employee_id = $2',
        [b.id, emp.ada],
      ),
    );
    expect(stored.statement.employee.nationalId).toBe('•••• 456C');
    expect(stored.statement.payment.account).toBe('•••• 5678');
    expect(JSON.stringify(stored)).not.toContain('123456');
  });

  it('refuses a statements file in the wrong shape, and statements for year-end documents', async () => {
    const r = await upload(
      { kind: 'payslip', label: 'Broken' },
      { provider: { name: 'x' }, statements: [{ employeeNumber: 'STM-1' }] },
    );
    expect(r.statusCode).toBe(400);
    expect(
      (
        await upload(
          { kind: 'year_end', docType: 'p60', label: 'P60' },
          { provider: { name: 'x' }, statements: [statement('STM-1', '2026-09')] },
        )
      ).statusCode,
    ).toBe(400);
  });

  it('only payroll roles import statements', async () => {
    for (const who of [cookie.hr!, cookie.mgr!, cookie.ada!])
      expect(
        (
          await upload(
            { kind: 'payslip', label: 'x' },
            { provider: { name: 'x' }, statements: [statement('STM-1', '2026-09')] },
            [],
            who,
          )
        ).statusCode,
      ).toBe(403);
  });
});

describe('publishing, listing and viewing', () => {
  it('publishes and notifies with the period, formatted in each reader’s locale', async () => {
    const p = await c.api(
      'POST',
      `/v1/payslips/batches/${septemberBatch}/publish`,
      undefined,
      cookie.payroll,
    );
    expect(p.statusCode, p.body).toBe(200);
    const notes = (await get('/v1/me/notifications', cookie.ada!)).json().data as Array<{
      title: string;
      link: string;
    }>;
    expect(notes.find((n) => n.title.startsWith('Your payslip'))).toMatchObject({
      title: 'Your payslip for September 2026 is ready',
      link: expect.stringMatching(/^\/app\/payslips\/[0-9a-f-]{36}$/),
    });
  });

  it('lists the employee’s payslips by year with the provider’s figures, and a statement without a PDF too', async () => {
    const r = await upload(
      { kind: 'payslip', label: 'August 2025' },
      {
        provider: { name: 'Fictional Payroll Bureau' },
        sample: true,
        statements: [statement('STM-1', '2025-08', { illustrative: true })],
      },
    );
    expect(r.statusCode, r.body).toBe(201);
    await c.api('POST', `/v1/payslips/batches/${r.json().id}/publish`, undefined, cookie.payroll);
    const all = (await get('/v1/me/payslips', cookie.ada!)).json();
    expect(all.map((p: { payDate: string }) => p.payDate)).toEqual(['2026-09-28', '2025-08-28']);
    expect(all[0]).toMatchObject({
      hasStatement: true,
      hasFile: true,
      netMinor: '208000',
      grossMinor: '259000',
      currency: 'GBP',
      periodStart: '2026-09-01',
      providerName: 'Fictional Payroll Bureau',
      sample: false,
      ytdTaxYear: '2026-27',
      ytd: [
        { key: 'gross', label: 'Gross pay to date', amountMinor: '1554000' },
        { key: 'net', label: 'Net pay to date', amountMinor: '1248000' },
      ],
    });
    expect(all[1]).toMatchObject({ hasFile: false, sample: true });
    const y2025 = (await get('/v1/me/payslips?year=2025', cookie.ada!)).json();
    expect(y2025).toHaveLength(1);
    expect((await get('/v1/me/payslips?year=2024', cookie.ada!)).json()).toEqual([]);
  });

  it('shows one payslip with its statement to its employee and to payroll, never to a manager or a colleague, and audits each view', async () => {
    const [sept, aug] = (await get('/v1/me/payslips', cookie.ada!)).json() as Array<{ id: string }>;
    const view = await get(`/v1/payslips/${sept!.id}`, cookie.ada!);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({
      employeeId: emp.ada,
      viewed: true,
      statement: {
        totals: { netMinor: 208_000 },
        payments: [{ label: 'Basic salary' }, { label: 'Overtime', quantity: '4.00' }],
      },
    });
    expect((await get(`/v1/payslips/${sept!.id}`, cookie.payroll!)).statusCode).toBe(200);
    for (const who of [cookie.mgr!, cookie.bo!, cookie.hr!])
      expect((await get(`/v1/payslips/${sept!.id}`, who)).statusCode).toBe(404);
    const audits = await c.tx((t) =>
      t.query<{ sensitive: boolean; diff: { own: boolean } }>(
        `SELECT sensitive, diff FROM audit.events WHERE action = 'payslip.viewed' AND target_id = $1 ORDER BY id`,
        [sept!.id],
      ),
    );
    expect(audits.map((a) => [a.sensitive, a.diff.own])).toEqual([
      [true, true],
      [true, false],
    ]);
    // the provider's PDF, inline for the viewer and as a download
    const file = await get(`/v1/payslips/${sept!.id}/file`, cookie.ada!);
    expect(file.headers['content-disposition']).toMatch(/^inline/);
    expect(file.rawPayload.toString()).toContain('ada september');
    expect((await get(`/v1/payslips/${sept!.id}/download`, cookie.ada!)).json().url).not.toContain('/pdf');
    // without the provider's PDF: a PDF of the statement, with the provider and the sample marker on it
    expect((await get(`/v1/payslips/${aug!.id}/file`, cookie.ada!)).statusCode).toBe(404);
    expect((await get(`/v1/payslips/${aug!.id}/download`, cookie.ada!)).json().url).toBe(
      `/v1/payslips/${aug!.id}/pdf`,
    );
    const generated = await get(`/v1/payslips/${aug!.id}/pdf`, cookie.ada!);
    expect(generated.statusCode).toBe(200);
    expect(generated.headers['content-disposition']).toMatch(
      /^attachment; filename="payslip-STM-1-2025-08-28.pdf"/,
    );
    const text = (await pdfPageTexts(generated.rawPayload)).join('\n');
    for (const s of [
      'Fictional Payroll UK Ltd',
      'Basic salary',
      '£2,080.00',
      'Issued by Fictional Payroll Bureau',
      'Sample data',
    ])
      expect(text, s).toContain(s);
    const downloads = await c.tx((t) =>
      t.query<{ diff: { file: string } }>(
        `SELECT diff FROM audit.events WHERE action = 'payslip.downloaded' AND target_id = $1`,
        [aug!.id],
      ),
    );
    expect(downloads.map((d) => d.diff.file)).toEqual(['generated']);
  });
});
