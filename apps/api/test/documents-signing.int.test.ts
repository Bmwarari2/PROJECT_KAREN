import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { addDays, today } from '@thapsus/core/time';
import { closeDb, cookieFrom, randomIp, startTestApp, PASSWORD, type TestContext } from './helpers';
import { phase6Company, type Phase6Company } from './phase6-fixtures';
import { pdfPageTexts, pdfText } from './pdf-text';
import type { MemoryObjectStore } from '../src/lib/object-store';
import { renderTextPdf, sha256 } from '../src/modules/documents/pdf';
import { startWorkflow } from '../src/modules/workflows/service';

/**
 * Phase 16 part C, documents (16.9–16.14, ADR-0194 to ADR-0197): templates with versions, archive and samples; merge
 * fields from the person's record; sending blocked while values are missing; the signing order; the company's
 * signature by authorised signatories after step-up, never on their own document; signatures stamped into the PDF
 * with every version kept and hashed; remind, void and send again; uploaded PDFs; and the task that closes when the
 * document is complete. Fictional people, companies and files only.
 */
let ctx: TestContext;
let c: Phase6Company;
const objects = () => (ctx.deps.objects as MemoryObjectStore).objects;
const cookie = {} as { hr: string; ada: string; bo: string; emp: string };
const emp = {} as { ada: string; bo: string; hrPerson: string };
const D = today('UTC');

const get = (url: string, as: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { cookie: as }, remoteAddress: randomIp() });
const call = (method: string, url: string, payload: unknown, as: string) =>
  ctx.app.inject({
    method: method as 'POST',
    url,
    payload: payload as object,
    headers: { cookie: as },
    remoteAddress: randomIp(),
  });
const audits = (action: string, targetId?: string) =>
  c.tx((t) =>
    t.query<{ diff: Record<string, unknown> }>(
      `SELECT diff FROM audit.events WHERE action = $1 AND ($2::text IS NULL OR target_id = $2::text) ORDER BY id`,
      [action, targetId ?? null],
    ),
  );
const userOf = (employeeId: string) =>
  c.tx((t) => t.one<{ id: string }>('SELECT id FROM app.users WHERE employee_id = $1 LIMIT 1', [employeeId]));
const fileOf = async (documentId: string, as = cookie.hr) =>
  (await get(`/v1/documents/${documentId}/content`, as)).rawPayload;

/** A small, valid PNG: a fictional "drawn signature" (a dark stroke on transparent). */
function tinyPng(w = 40, h = 12) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (y === Math.floor(h / 2)) rows.set([13, 31, 89, 255], y * (w * 4 + 1) + 1 + x * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const FULL_BODY = `# Your terms

Employer: **{{entity.name}}** ({{entity.address}})
Employee: {{employee.displayName}}

## Work

- Hours: {{employee.workPattern}}
- Notice: {{contract.noticePeriod}}
- Probation ends: {{contract.probationEndDate}}
- Pay: {{pay.rate}}, paid {{pay.schedule}}; next pay day {{pay.nextPayDate}}
- Holiday: {{leave.annualEntitlement}}, the year starts on {{leave.yearStart}}
- Contract: {{contract.type}} ({{employee.employmentType}})
- Manager: {{manager.name}}

Continuous employment began on {{ask.continuousEmployment}}.`;

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  c = await phase6Company(ctx);
  // the employer's address, a pay calendar and an annual leave policy for the merge fields (16.10)
  await c.tx(async (t) => {
    await t.exec(`UPDATE app.legal_entities SET address = $2 WHERE id = $1`, [
      c.entity,
      JSON.stringify({ line1: '1 Specimen Square', city: 'London', postcode: 'ZZ1 1AA', country: 'GB' }),
    ]);
    await t.exec(
      `INSERT INTO app.pay_periods (tenant_id, entity_id, name, frequency, start_date, end_date, pay_date) VALUES (app.current_tenant(), $1, 'Fictional period', 'monthly', $2, $3, $4)`,
      [c.entity, addDays(D, 20), addDays(D, 50), addDays(D, 48)],
    );
    await t.exec(
      `INSERT INTO app.leave_types (tenant_id, key, name, category) VALUES (app.current_tenant(), 'fictional_annual', '{"en-GB":"Annual leave"}', 'annual') ON CONFLICT DO NOTHING`,
    );
  });
  const manager = await c.hire({
    legalFirstName: 'Mina',
    legalLastName: 'Manager',
    jobTitle: 'Operations manager',
  });
  emp.ada = await c.hire({
    legalFirstName: 'Ada',
    legalLastName: 'Fictional',
    managerId: manager,
    noticePeriodDays: 28,
    probationEndDate: '2024-07-08',
    workPattern: { 1: 8, 2: 8, 3: 8, 4: 8, 5: 8 },
  });
  emp.bo = await c.hire({ legalFirstName: 'Bo', legalLastName: 'Fictional' });
  emp.hrPerson = await c.hire({ legalFirstName: 'Hana', legalLastName: 'Hr', jobTitle: 'HR adviser' });
  await c.tx(async (t) => {
    const type = await t.one<{ id: string }>(`SELECT id FROM app.leave_types WHERE key = 'fictional_annual'`);
    const pol = await t.one<{ id: string }>(
      `INSERT INTO app.leave_policies (tenant_id, name, leave_type_id, config) VALUES (app.current_tenant(), 'Fictional annual leave', $1, $2) RETURNING id`,
      [
        type.id,
        JSON.stringify({
          accrual: { method: 'annual_upfront', days: 25 },
          unit: 'days',
          yearStart: '04-01',
          proRata: true,
          includesPublicHolidays: false,
          waitingDays: 0,
          allowNegativeDays: 0,
          rounding: 'none',
        }),
      ],
    );
    await t.exec(
      `INSERT INTO app.leave_policy_assignments (tenant_id, employee_id, policy_id, leave_type_id, valid_from) VALUES (app.current_tenant(), $1, $2, $3, '2024-01-08')`,
      [emp.ada, pol.id, type.id],
    );
  });
  cookie.hr = await c.login(emp.hrPerson, 'hr_admin');
  cookie.ada = await c.login(emp.ada);
  cookie.bo = await c.login(emp.bo);
  cookie.emp = cookie.bo;
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('templates in Settings (16.9)', () => {
  it('creates, edits as new versions, archives and restores; documents keep the version they were made from', async () => {
    const created = await call(
      'POST',
      '/v1/document-templates',
      {
        name: 'Fictional letter',
        body: 'Dear {{employee.firstName}},\nFirst wording. {{ask.note}} {{employee.nope}}',
        category: 'letter',
        askFields: [{ key: 'note', label: 'A note', required: false }],
      },
      cookie.hr,
    );
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ version: 1, unknownFields: ['employee.nope'] });
    const id = created.json().id as string;
    // the person's own employee login cannot manage templates
    expect((await get('/v1/document-templates', cookie.bo)).statusCode).toBe(403);
    expect(
      (await call('POST', '/v1/document-templates', { name: 'x', body: 'y' }, cookie.bo)).statusCode,
    ).toBe(403);

    const fixed = await call(
      'PUT',
      `/v1/document-templates/${id}`,
      { name: 'Fictional letter', body: 'Dear {{employee.firstName}},\nFirst wording.', category: 'letter' },
      cookie.hr,
    );
    expect(fixed.json()).toMatchObject({ version: 2, unknownFields: [] });
    const v2 = await call(
      'POST',
      '/v1/signature-requests',
      {
        employeeId: emp.bo,
        templateId: id,
        employeeSigns: true,
        companySigns: false,
        signingOrder: 'employee_first',
      },
      cookie.hr,
    );
    expect(v2.statusCode, v2.body).toBe(201);
    const edited = await call(
      'PUT',
      `/v1/document-templates/${id}`,
      { name: 'Fictional letter', body: 'Dear {{employee.firstName}},\nSecond wording.' },
      cookie.hr,
    );
    expect(edited.json().version).toBe(3);
    const v3 = await call(
      'POST',
      '/v1/signature-requests',
      {
        employeeId: emp.bo,
        templateId: id,
        employeeSigns: true,
        companySigns: false,
        signingOrder: 'employee_first',
      },
      cookie.hr,
    );
    const versions = await c.tx((t) =>
      t.query<{ id: string; version: number }>(
        `SELECT d.id, v.version FROM app.documents d JOIN app.document_template_versions v ON v.tenant_id = d.tenant_id AND v.id = d.template_version_id WHERE d.template_id = $1 ORDER BY v.version`,
        [id],
      ),
    );
    expect(versions.map((v) => [v.id, v.version])).toEqual([
      [v2.json().documentId, 2],
      [v3.json().documentId, 3],
    ]);
    // the document made from version 2 still says what version 2 said
    expect(await pdfText(await fileOf(v2.json().documentId))).toContain('First wording.');
    expect(await pdfText(await fileOf(v3.json().documentId))).toContain('Second wording.');
    const detail = (await get(`/v1/document-templates/${id}`, cookie.hr)).json();
    expect(detail).toMatchObject({ version: 3, status: 'active', documents: 2 });
    expect(detail.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);

    expect((await call('POST', `/v1/document-templates/${id}/archive`, {}, cookie.hr)).json().status).toBe(
      'archived',
    );
    expect(
      (await get('/v1/document-templates', cookie.hr)).json().some((x: { id: string }) => x.id === id),
    ).toBe(false);
    expect(
      (await get('/v1/document-templates?status=archived', cookie.hr))
        .json()
        .some((x: { id: string }) => x.id === id),
    ).toBe(true);
    const blocked = await call(
      'POST',
      '/v1/signature-requests',
      {
        employeeId: emp.bo,
        templateId: id,
        employeeSigns: true,
        companySigns: false,
        signingOrder: 'employee_first',
      },
      cookie.hr,
    );
    expect(blocked.statusCode).toBe(409);
    expect(
      (await call('PUT', `/v1/document-templates/${id}`, { name: 'x', body: 'y' }, cookie.hr)).statusCode,
    ).toBe(409);
    expect((await call('POST', `/v1/document-templates/${id}/restore`, {}, cookie.hr)).json().status).toBe(
      'active',
    );
    for (const action of [
      'document_template.created',
      'document_template.updated',
      'document_template.archived',
      'document_template.restored',
    ])
      expect((await audits(action, id)).length, action).toBeGreaterThan(0);
  });

  it('offers UK, Ireland and US starter samples, copied in as samples once', async () => {
    const samples = (await get('/v1/document-templates/samples', cookie.hr)).json();
    expect(samples.map((s: { country: string }) => s.country).sort()).toEqual(['GB', 'IE', 'US']);
    const uk = await call('POST', '/v1/document-templates/samples/uk_statement', {}, cookie.hr);
    expect(uk.statusCode, uk.body).toBe(201);
    const tpl = (await get(`/v1/document-templates/${uk.json().id}`, cookie.hr)).json();
    expect(tpl).toMatchObject({
      sampleKey: 'uk_statement',
      name: 'Statement of main terms (UK)',
      requiresCountersign: true,
      signingOrder: 'employee_first',
      unknownFields: [],
      askFields: [{ key: 'continuousEmployment', label: 'Date continuous employment began', required: true }],
    });
    expect(
      (await call('POST', '/v1/document-templates/samples/uk_statement', {}, cookie.hr)).statusCode,
    ).toBe(409);
    expect(
      (await get('/v1/document-templates/samples', cookie.hr))
        .json()
        .find((s: { key: string }) => s.key === 'uk_statement').templateId,
    ).toBe(uk.json().id);
  });
});

describe('fields, preview and sending (16.10, 16.11)', () => {
  let tpl: string;
  beforeAll(async () => {
    tpl = (
      await call(
        'POST',
        '/v1/document-templates',
        {
          name: 'Fictional statement of terms',
          body: FULL_BODY,
          category: 'contract',
          askFields: [{ key: 'continuousEmployment', label: 'Continuous employment began', required: true }],
        },
        cookie.hr,
      )
    ).json().id;
  });

  it('fills every new field from the record, and lists what is missing for someone whose record lacks it', async () => {
    const ada = (
      await call(
        'POST',
        `/v1/document-templates/${tpl}/prepare`,
        { employeeId: emp.ada, values: { continuousEmployment: '8 January 2024' } },
        cookie.hr,
      )
    ).json();
    expect(ada.missing).toEqual([]);
    expect(ada).toMatchObject({ requiresCountersign: true, signingOrder: 'employee_first' });
    const bo = (
      await call('POST', `/v1/document-templates/${tpl}/prepare`, { employeeId: emp.bo }, cookie.hr)
    ).json();
    expect(bo.missing).toEqual(
      expect.arrayContaining([
        { key: 'contract.noticePeriod', reason: 'empty' },
        { key: 'contract.probationEndDate', reason: 'empty' },
        { key: 'manager.name', reason: 'empty' },
        { key: 'ask.continuousEmployment', reason: 'required', label: 'Continuous employment began' },
      ]),
    );
    // sending is blocked while anything is missing, and nothing is stored
    const before = objects().size;
    const blocked = await call(
      'POST',
      '/v1/signature-requests',
      {
        employeeId: emp.bo,
        templateId: tpl,
        employeeSigns: true,
        companySigns: true,
        signingOrder: 'employee_first',
      },
      cookie.hr,
    );
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().missing.length).toBe(bo.missing.length);
    expect(objects().size).toBe(before);

    // the preview is the filled PDF, for the viewer, and is audited
    const preview = await call(
      'POST',
      `/v1/document-templates/${tpl}/preview`,
      { employeeId: emp.ada, values: { continuousEmployment: '8 January 2024' } },
      cookie.hr,
    );
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('application/pdf');
    expect(preview.headers['cache-control']).toBe('private, no-store');
    const text = await pdfText(preview.rawPayload);
    for (const value of [
      'Fictional statement of terms',
      'Fictional Payroll UK Ltd (1 Specimen Square, London, ZZ1 1AA)',
      'Monday, Tuesday, Wednesday, Thursday and Friday (40 hours a week)',
      'Notice: 4 weeks',
      'Probation ends: 8 July 2024',
      '£30,000.00 a year, paid monthly',
      'Holiday: 25 days a year, the year starts on 1 April',
      'Contract: Permanent (Full time)',
      'Manager: Mina Manager',
      'Continuous employment began on 8 January 2024.',
      'Signatures',
      'The employee',
      'The company',
      'Page 1 of',
    ])
      expect(text, value).toContain(value);
    expect(text).not.toContain('{{');
    expect(await audits('document_template.previewed', tpl)).toHaveLength(1);
    // an employee cannot preview someone else's document
    expect(
      (await call('POST', `/v1/document-templates/${tpl}/preview`, { employeeId: emp.ada }, cookie.bo))
        .statusCode,
    ).toBe(403);
  });

  it('bulk send counts first, then skips and counts people whose records lack a value', async () => {
    const dept = (
      await call('POST', '/v1/org/departments', { name: 'Fictional bulk team' }, c.owner.cookie)
    ).json().id;
    await c.hire({ departmentId: dept });
    await c.hire({ departmentId: dept, managerId: emp.ada });
    const body = {
      templateId: (
        await call(
          'POST',
          '/v1/document-templates',
          { name: 'Fictional manager note', body: 'Your manager is {{manager.name}}.' },
          cookie.hr,
        )
      ).json().id,
      requireSignature: true,
      filter: { departmentId: dept },
    };
    const dry = await call('POST', '/v1/documents/bulk-send', { ...body, dryRun: true }, cookie.hr);
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toEqual({ jobId: null, recipients: 2 });
    const res = await call('POST', '/v1/documents/bulk-send', body, cookie.hr);
    expect(res.statusCode).toBe(202);
    await c.drain();
    const job = (await get(`/v1/jobs/${res.json().jobId}`, cookie.hr)).json();
    expect(job).toMatchObject({ status: 'succeeded', result: { sent: 1, skipped: 1, missing: 1 } });
  });
});

describe('signing in either order, with the company signature (16.12, 16.13)', () => {
  let contract: string;
  beforeAll(async () => {
    contract = (
      await call(
        'POST',
        '/v1/document-templates',
        {
          name: 'Fictional contract',
          body: 'Employee: {{employee.displayName}}\nFictional sample contract.',
          category: 'contract',
        },
        cookie.hr,
      )
    ).json().id;
  });

  it('company first: the employee waits, HR signs for the company, then the employee; both signatures are in the PDF', async () => {
    const sent = await call(
      'POST',
      '/v1/signature-requests',
      {
        employeeId: emp.ada,
        templateId: contract,
        employeeSigns: true,
        companySigns: true,
        signingOrder: 'company_first',
        dueOn: addDays(D, 7),
        message: 'Please read and sign (fictional).',
      },
      cookie.hr,
    );
    expect(sent.statusCode, sent.body).toBe(201);
    const { documentId, signatureRequestId: sr } = sent.json();
    const mine = (await get(`/v1/documents/${documentId}`, cookie.ada)).json();
    expect(mine.signature).toMatchObject({
      id: sr,
      myTurn: false,
      signingOrder: 'company_first',
      message: 'Please read and sign (fictional).',
    });
    expect(mine.signing).toMatchObject({
      stage: 'company',
      employeeName: 'Ada Fictional',
      dueOn: addDays(D, 7),
    });
    // not their turn yet, and no signing task for them yet
    expect(
      (
        await call(
          'POST',
          `/v1/signature-requests/${sr}/sign`,
          { consent: true, typedName: 'Ada Fictional' },
          cookie.ada,
        )
      ).statusCode,
    ).toBe(409);
    const adaUser = await userOf(emp.ada);
    expect(
      await c.tx((t) => t.query(`SELECT 1 FROM app.tasks WHERE dedupe_key = $1`, [`sign:${sr}`])),
    ).toHaveLength(0);
    // HR (an authorised signatory by default) sees it to sign for the company, and signs
    const review = (await get(`/v1/documents/${documentId}`, cookie.hr)).json();
    expect(review.countersign).toMatchObject({ signatureRequestId: sr, companyFirst: true });
    const cs = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signature-requests/${sr}/countersign`,
      payload: { decision: 'approve', consent: true, typedName: 'Hana Hr' },
      headers: { cookie: cookie.hr, 'user-agent': 'FictionalLaptop/3.1' },
      remoteAddress: '10.77.9.9',
    });
    expect(cs.statusCode, cs.body).toBe(200);
    expect(cs.json()).toEqual({ status: 'awaiting_employee', signedDocumentId: null });
    // now it is Ada's turn: a task and the viewer show it, with the company's signature already in the copy
    expect(
      await c.tx((t) =>
        t.query(
          `SELECT 1 FROM app.tasks WHERE dedupe_key = $1 AND assignee_user_id = $2 AND status = 'open'`,
          [`sign:${sr}`, adaUser.id],
        ),
      ),
    ).toHaveLength(1);
    expect((await get(`/v1/documents/${documentId}`, cookie.ada)).json().signature.myTurn).toBe(true);
    const working = await pdfText(await fileOf(documentId, cookie.ada));
    expect(working).toContain('For and on behalf of Fictional Payroll UK Ltd');
    expect(working).toContain('Countersignature certificate');
    const signed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signature-requests/${sr}/sign`,
      payload: { consent: true, typedName: 'Ada Fictional' },
      headers: { cookie: cookie.ada, 'user-agent': 'FictionalPhone/2.0' },
      remoteAddress: '10.77.4.5',
    });
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json().status).toBe('completed');
    const copy = signed.json().signedDocumentId as string;
    const bytes = await fileOf(copy, cookie.ada);
    const pages = (await pdfPageTexts(bytes)).map((p) => p.replace(/\s+/g, ' '));
    // the signature block carries both printed names, dates and the reference; then both certificates
    expect(pages[0]).toContain('Ada Fictional');
    expect(pages[0]).toContain('Hana Hr');
    expect(pages[0]).toContain('For and on behalf of Fictional Payroll UK Ltd');
    expect(pages[0]).toContain(`Ref. ${sr}`);
    expect(pages.at(-2)).toContain('Countersignature certificate');
    expect(pages.at(-1)).toContain('Signature certificate');
    expect(pages.at(-1)).toContain('the typed name, shown in a handwriting font');
    // the typed signature is drawn in the bundled open-licence handwriting font
    expect(Buffer.from(bytes).toString('latin1')).toMatch(/AlexBrush/);
    // every version is kept with its hash: sent, company signed, employee signed, completed
    const status = (await get(`/v1/documents/${documentId}`, cookie.hr)).json().signing;
    expect(status.stage).toBe('completed');
    expect(status.events.map((e: { kind: string }) => e.kind)).toEqual([
      'sent',
      'company_signed',
      'employee_signed',
      'completed',
    ]);
    const keys = await c.tx((t) =>
      t.query<{ file_key: string; sha256: string }>(
        `SELECT file_key, sha256 FROM app.signature_events WHERE signature_request_id = $1 AND file_key IS NOT NULL ORDER BY at, seq`,
        [sr],
      ),
    );
    expect(keys).toHaveLength(4);
    for (const k of keys) expect(sha256(objects().get(k.file_key)!.body)).toBe(k.sha256);
    expect(new Set(keys.slice(0, 3).map((k) => k.sha256)).size).toBe(3);
    const verify = (await get(`/v1/signature-requests/${sr}/verify`, cookie.ada)).json();
    expect(verify).toMatchObject({ valid: true, signerName: 'Ada Fictional', countersignerName: 'Hana Hr' });
    for (const action of ['document.sent', 'document.countersigned', 'document.signed', 'document.completed'])
      expect(await audits(action, sr), action).toHaveLength(1);
  });

  it('either order: both are asked at once; a drawn signature is stamped as an image and kept', async () => {
    const sent = await call(
      'POST',
      '/v1/signature-requests',
      {
        employeeId: emp.bo,
        templateId: contract,
        employeeSigns: true,
        companySigns: true,
        signingOrder: 'any',
      },
      cookie.hr,
    );
    const { documentId, signatureRequestId: sr } = sent.json();
    expect((await get(`/v1/documents/${documentId}`, cookie.bo)).json().signature.myTurn).toBe(true);
    expect((await get(`/v1/documents/${documentId}`, cookie.hr)).json().signing.stage).toBe('both');
    expect(
      (
        await call(
          'POST',
          `/v1/signature-requests/${sr}/sign`,
          {
            consent: true,
            typedName: 'Bo Fictional',
            method: 'drawn',
            drawing: 'data:image/png;base64,AAAA',
          },
          cookie.bo,
        )
      ).statusCode,
    ).toBe(400);
    const png = `data:image/png;base64,${tinyPng().toString('base64')}`;
    const s = await call(
      'POST',
      `/v1/signature-requests/${sr}/sign`,
      { consent: true, typedName: 'Bo Fictional', method: 'drawn', drawing: png },
      cookie.bo,
    );
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().status).toBe('awaiting_approval');
    const row = await c.tx((t) =>
      t.one<{ signature_method: string; signature_drawing_key: string }>(
        'SELECT signature_method, signature_drawing_key FROM app.signature_requests WHERE id = $1',
        [sr],
      ),
    );
    expect(row.signature_method).toBe('drawn');
    expect(objects().get(row.signature_drawing_key)!.body.subarray(1, 4).toString()).toBe('PNG');
    const cs = await call(
      'POST',
      `/v1/signature-requests/${sr}/countersign`,
      { decision: 'approve', consent: true, typedName: 'Hana Hr' },
      cookie.hr,
    );
    expect(cs.json().status).toBe('completed');
    const done = await PDFDocument.load(await fileOf(cs.json().signedDocumentId));
    const xobjects = done.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'));
    expect(xobjects?.toString()).toMatch(/Image|\/I/);
  });

  it('only authorised signatories sign for the company, after step-up, and never on their own document', async () => {
    // HR's own contract: HR may not sign it for the company; the owner (also a default signatory) may
    const own = await call(
      'POST',
      '/v1/signature-requests',
      {
        employeeId: emp.hrPerson,
        templateId: contract,
        employeeSigns: false,
        companySigns: true,
        signingOrder: 'company_first',
      },
      c.owner.cookie,
    );
    expect(own.statusCode, own.body).toBe(201);
    const ownDoc = own.json().documentId as string;
    expect((await get(`/v1/documents/${ownDoc}`, cookie.hr)).json().countersign).toBeNull();
    expect(
      (
        await call(
          'POST',
          `/v1/signature-requests/${own.json().signatureRequestId}/countersign`,
          { decision: 'approve', consent: true, typedName: 'Hana Hr' },
          cookie.hr,
        )
      ).statusCode,
    ).toBe(403);
    expect((await get(`/v1/documents/${ownDoc}`, c.owner.cookie)).json().countersign).not.toBeNull();

    // the signatories list: default HR admins and owners; changing it needs company-wide rights
    const list = (await get('/v1/document-signatories', cookie.hr)).json();
    expect(list).toMatchObject({
      isDefault: true,
      entries: [
        { kind: 'role', roleKey: 'hr_admin' },
        { kind: 'role', roleKey: 'owner' },
      ],
    });
    expect(
      (
        await call(
          'PUT',
          '/v1/document-signatories',
          { entries: [{ kind: 'role', roleKey: 'owner' }] },
          cookie.bo,
        )
      ).statusCode,
    ).toBe(403);
    const onlyOwners = await call(
      'PUT',
      '/v1/document-signatories',
      { entries: [{ kind: 'role', roleKey: 'owner' }] },
      cookie.hr,
    );
    expect(onlyOwners.statusCode, onlyOwners.body).toBe(200);
    expect(onlyOwners.json().isDefault).toBe(false);
    expect(await audits('document_signatories.updated')).toHaveLength(1);
    // HR is no longer a signatory: a new contract goes to the owner only, and HR cannot sign it
    const sent = await call(
      'POST',
      '/v1/signature-requests',
      {
        employeeId: emp.bo,
        templateId: contract,
        employeeSigns: false,
        companySigns: true,
        signingOrder: 'company_first',
      },
      cookie.hr,
    );
    const sr = sent.json().signatureRequestId as string;
    expect((await get(`/v1/documents/${sent.json().documentId}`, cookie.hr)).json().countersign).toBeNull();
    expect(
      (
        await call(
          'POST',
          `/v1/signature-requests/${sr}/countersign`,
          { decision: 'approve', consent: true, typedName: 'Hana Hr' },
          cookie.hr,
        )
      ).statusCode,
    ).toBe(403);
    const owner = await c.tx((t) =>
      t.one<{ id: string }>(`SELECT id FROM app.users WHERE id = $1`, [c.owner.userId]),
    );
    const step = await c.tx((t) =>
      t.one<{ approver_user_ids: string[] }>(
        `SELECT st.approver_user_ids FROM app.approval_steps st JOIN app.signature_requests s ON s.approval_request_id = st.request_id WHERE s.id = $1`,
        [sr],
      ),
    );
    expect(step.approver_user_ids).toEqual([owner.id]);
    // a signature for the company needs a recent sign-in, in the viewer and on the Approvals page
    ctx.clock.advanceMinutes(11);
    const stale = await call(
      'POST',
      `/v1/signature-requests/${sr}/countersign`,
      { decision: 'approve', consent: true, typedName: 'Olive Owner' },
      c.owner.cookie,
    );
    expect(stale.statusCode).toBe(403);
    expect(stale.json().code).toBe('reauthenticationRequired');
    const approval = await c.tx((t) =>
      t.one<{ approval_request_id: string }>(
        'SELECT approval_request_id FROM app.signature_requests WHERE id = $1',
        [sr],
      ),
    );
    const viaApprovals = await call(
      'POST',
      `/v1/approvals/${approval.approval_request_id}/decide`,
      { decision: 'approve' },
      c.owner.cookie,
    );
    expect(viaApprovals.json().code).toBe('reauthenticationRequired');
    const reauth = await call('POST', '/v1/auth/reauth', { password: PASSWORD }, c.owner.cookie);
    expect(reauth.statusCode, reauth.body).toBeLessThan(300);
    const fresh = cookieFrom(reauth) || c.owner.cookie;
    const ok = await call(
      'POST',
      `/v1/signature-requests/${sr}/countersign`,
      { decision: 'approve', consent: true, typedName: 'Olive Owner' },
      fresh,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe('completed');
    // back to the default for the rest of the suite, and HR proves who they are again after the clock moved on
    await c.tx((t) => t.exec('DELETE FROM app.document_signatories'));
    const hrAgain = await call('POST', '/v1/auth/reauth', { password: PASSWORD }, cookie.hr);
    expect(hrAgain.statusCode, hrAgain.body).toBeLessThan(300);
    cookie.hr = cookieFrom(hrAgain) || cookie.hr;
  });
});

describe('follow-up, uploaded PDFs and the task (16.12–16.14)', () => {
  it('reminds whoever is next, voids (with a link to replace it) and sends a voided request again', async () => {
    const tpl = (
      await call(
        'POST',
        '/v1/document-templates',
        { name: 'Fictional reminder letter', body: 'Hello {{employee.firstName}}.' },
        cookie.hr,
      )
    ).json().id;
    const sent = (
      await call(
        'POST',
        '/v1/signature-requests',
        {
          employeeId: emp.bo,
          templateId: tpl,
          employeeSigns: true,
          companySigns: false,
          signingOrder: 'employee_first',
        },
        cookie.hr,
      )
    ).json();
    const r = await call('POST', `/v1/signature-requests/${sent.signatureRequestId}/remind`, {}, cookie.hr);
    expect(r.json()).toEqual({ told: ['employee'] });
    expect(
      await c.tx((t) =>
        t.query(
          `SELECT 1 FROM app.notifications WHERE kind = 'document.signature_reminder' AND dedupe_key = $1`,
          [`remind:${sent.signatureRequestId}:1`],
        ),
      ),
    ).toHaveLength(1);
    expect(
      (await call('POST', `/v1/signature-requests/${sent.signatureRequestId}/remind`, {}, cookie.bo))
        .statusCode,
    ).toBe(403);
    const voided = await call(
      'POST',
      `/v1/signature-requests/${sent.signatureRequestId}/void`,
      { reason: 'Wrong letter (fictional)', replace: true },
      cookie.hr,
    );
    expect(voided.json()).toEqual({
      id: sent.signatureRequestId,
      status: 'voided',
      replaceHref: `/app/people/${emp.bo}/documents/new?template=${tpl}`,
    });
    expect(
      await c.tx((t) =>
        t.query(`SELECT status FROM app.tasks WHERE dedupe_key = $1`, [`sign:${sent.signatureRequestId}`]),
      ),
    ).toEqual([{ status: 'cancelled' }]);
    expect(
      (
        await call(
          'POST',
          `/v1/signature-requests/${sent.signatureRequestId}/sign`,
          { consent: true, typedName: 'Bo Fictional' },
          cookie.bo,
        )
      ).statusCode,
    ).toBe(409);
    const again = await call(
      'POST',
      `/v1/signature-requests/${sent.signatureRequestId}/resend`,
      {},
      cookie.hr,
    );
    expect(again.statusCode, again.body).toBe(201);
    const status = (await get(`/v1/documents/${sent.documentId}`, cookie.hr)).json().signing;
    expect(status).toMatchObject({ id: again.json().signatureRequestId, stage: 'employee' });
    const old = await c.tx((t) =>
      t.query<{ kind: string }>(
        `SELECT kind FROM app.signature_events WHERE signature_request_id = $1 ORDER BY at, seq`,
        [sent.signatureRequestId],
      ),
    );
    expect(old.map((e) => e.kind)).toEqual(['sent', 'reminded', 'voided', 'resent']);
    for (const action of ['document.reminded', 'document.voided'])
      expect(await audits(action, sent.signatureRequestId)).toHaveLength(1);
    expect(await audits('document.resent', again.json().signatureRequestId)).toHaveLength(1);
  });

  it('an uploaded PDF gets HR’s placed boxes, or a signature page when none are placed', async () => {
    const upload = async (title: string) => {
      const pdf = Buffer.from(await renderTextPdf(title, 'A fictional policy uploaded by HR.'));
      const key = `${c.owner.tenantId}/employees/${emp.bo}/${title.replace(/\W+/g, '-')}.pdf`;
      await ctx.deps.objects.put(key, pdf, 'application/pdf');
      return c.tx(
        async (t) =>
          (
            await t.one<{ id: string }>(
              `INSERT INTO app.documents (tenant_id, employee_id, title, category, file_key, file_name, content_type, size_bytes, sha256, status)
             VALUES (app.current_tenant(), $1, $2, 'policy', $3, 'policy.pdf', 'application/pdf', $4, $5, 'ready') RETURNING id`,
              [emp.bo, title, key, pdf.length, sha256(pdf)],
            )
          ).id,
      );
    };
    const placedDoc = await upload('Fictional placed policy');
    const placed = await call(
      'POST',
      '/v1/signature-requests',
      {
        employeeId: emp.bo,
        documentId: placedDoc,
        employeeSigns: true,
        companySigns: false,
        signingOrder: 'employee_first',
        fields: [
          { party: 'employee', kind: 'signature', page: 1, position: 'bottom_left' },
          { party: 'employee', kind: 'date', page: 1, position: 'bottom_right' },
        ],
      },
      cookie.hr,
    );
    expect(placed.statusCode, placed.body).toBe(201);
    expect(
      (
        await call(
          'POST',
          '/v1/signature-requests',
          {
            employeeId: emp.bo,
            documentId: placedDoc,
            employeeSigns: true,
            companySigns: false,
            signingOrder: 'employee_first',
          },
          cookie.hr,
        )
      ).statusCode,
    ).toBe(409); // already out for signature
    const signed = await call(
      'POST',
      `/v1/signature-requests/${placed.json().signatureRequestId}/sign`,
      { consent: true, typedName: 'Bo Fictional' },
      cookie.bo,
    );
    const pages = await pdfPageTexts(await fileOf(signed.json().signedDocumentId, cookie.bo));
    expect(pages).toHaveLength(2); // the page itself, then the certificate
    expect(pages[0]).toContain('Bo Fictional');

    const plainDoc = await upload('Fictional plain policy');
    expect(
      (
        await call(
          'POST',
          '/v1/signature-requests',
          {
            employeeId: emp.bo,
            documentId: plainDoc,
            employeeSigns: true,
            companySigns: false,
            signingOrder: 'employee_first',
            fields: [{ party: 'employee', kind: 'signature', page: 4, position: 'top_left' }],
          },
          cookie.hr,
        )
      ).statusCode,
    ).toBe(400);
    const plain = await call(
      'POST',
      '/v1/signature-requests',
      {
        employeeId: emp.bo,
        documentId: plainDoc,
        employeeSigns: true,
        companySigns: true,
        signingOrder: 'employee_first',
      },
      cookie.hr,
    );
    expect(plain.statusCode, plain.body).toBe(201);
    // the employee reads (and signs) the copy with its added signature page
    const working = await pdfPageTexts(await fileOf(plainDoc, cookie.bo));
    expect(working).toHaveLength(2);
    expect(working[1]).toContain('Signatures');
    const sr = await c.tx((t) =>
      t.one<{ original_file_key: string; file_key: string }>(
        `SELECT s.original_file_key, d.file_key FROM app.signature_requests s JOIN app.documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id WHERE s.id = $1`,
        [plain.json().signatureRequestId],
      ),
    );
    expect(sr.original_file_key).not.toBe(sr.file_key); // the upload itself is kept as it was
  });

  it('a workflow step with the send_document action links to the send page and closes when the document is complete', async () => {
    const statement = (
      await call(
        'POST',
        '/v1/document-templates',
        { name: 'Fictional statement', body: 'Employee: {{employee.displayName}}', category: 'contract' },
        cookie.hr,
      )
    ).json().id;
    const instance = await c.tx(async (t) => {
      const wf = await t.one<{ id: string }>(
        `INSERT INTO app.workflow_templates (tenant_id, kind, name, tasks, auto_start) VALUES (app.current_tenant(), 'onboarding', 'Fictional onboarding', $1, false) RETURNING id`,
        [
          JSON.stringify([
            {
              key: 'contract',
              title: 'Send the statement of main terms',
              assignee: { type: 'role', value: 'hr_admin' },
              dueOffsetDays: -7,
              action: { kind: 'send_document', params: { templateId: statement } },
            },
          ]),
        ],
      );
      return startWorkflow(t, wf.id, emp.bo, D, null);
    });
    const task = await c.tx((t) =>
      t.one<{ id: string; link: string }>(
        `SELECT id, link FROM app.tasks WHERE source = 'workflow' AND source_id = $1`,
        [instance],
      ),
    );
    expect(task.link).toBe(`/app/people/${emp.bo}/documents/new?template=${statement}&task=${task.id}`);
    const sent = (
      await call(
        'POST',
        '/v1/signature-requests',
        {
          employeeId: emp.bo,
          templateId: statement,
          employeeSigns: true,
          companySigns: true,
          signingOrder: 'employee_first',
          taskId: task.id,
        },
        cookie.hr,
      )
    ).json();
    // a task about someone else cannot be attached
    expect(
      (
        await call(
          'POST',
          '/v1/signature-requests',
          {
            employeeId: emp.ada,
            templateId: statement,
            employeeSigns: true,
            companySigns: false,
            signingOrder: 'employee_first',
            taskId: task.id,
          },
          cookie.hr,
        )
      ).statusCode,
    ).toBe(400);
    await call(
      'POST',
      `/v1/signature-requests/${sent.signatureRequestId}/sign`,
      { consent: true, typedName: 'Bo Fictional' },
      cookie.bo,
    );
    // signed by the employee only: still open until the company has signed too
    expect(
      (await c.tx((t) => t.one<{ status: string }>('SELECT status FROM app.tasks WHERE id = $1', [task.id])))
        .status,
    ).toBe('open');
    const cs = await call(
      'POST',
      `/v1/signature-requests/${sent.signatureRequestId}/countersign`,
      { decision: 'approve', consent: true, typedName: 'Hana Hr' },
      cookie.hr,
    );
    expect(cs.json().status).toBe('completed');
    expect(
      (await c.tx((t) => t.one<{ status: string }>('SELECT status FROM app.tasks WHERE id = $1', [task.id])))
        .status,
    ).toBe('done');
    expect((await audits('task.completed', task.id))[0]!.diff).toMatchObject({
      by: 'document.completed',
      signatureRequestId: sent.signatureRequestId,
    });
    expect(
      (
        await c.tx((t) =>
          t.one<{ status: string }>('SELECT status FROM app.workflow_instances WHERE id = $1', [instance]),
        )
      ).status,
    ).toBe('completed');
  });
});
