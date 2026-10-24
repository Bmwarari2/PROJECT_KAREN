import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, randomIp, startTestApp, type TestContext } from './helpers';
import { phase6Company, type Phase6Company } from './phase6-fixtures';
import { pdfPageTexts } from './pdf-text';
import type { MemoryObjectStore } from '../src/lib/object-store';
import { isSealedFile } from '../src/lib/sealed-file';
import { setUploadScanner } from '../src/lib/upload-scan';
import { runComplianceDaily } from '../src/modules/compliance/jobs';

/**
 * Documents HR attaches to a person (ADR-0165), right-to-work evidence in the vault (ADR-0166), the in-app viewer
 * with its review-and-sign panel (ADR-0168) and countersignatures through the approvals service (ADR-0169).
 * Fictional people and files only.
 */
let ctx: TestContext;
let c: Phase6Company;
const emp = {} as { ada: string; bo: string };
const cookie = {} as { hr: string; ada: string; bo: string; mgr: string; payroll: string };
const objects = () => (ctx.deps.objects as MemoryObjectStore).objects;

const PDF = (text: string) =>
  Buffer.from(`%PDF-1.4\n% fictional: ${text}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);

function multipart(fields: Record<string, string>, file?: { name: string; body: Buffer; type?: string }) {
  const boundary = `----thapsus${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file)
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/pdf'}\r\n\r\n`,
      ),
      file.body,
      Buffer.from('\r\n'),
    );
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
const attach = (
  employeeId: string,
  fields: Record<string, string>,
  file: { name: string; body: Buffer; type?: string } | undefined,
  as = cookie.hr!,
) => {
  const m = multipart(fields, file);
  return ctx.app.inject({
    method: 'POST',
    url: `/v1/employees/${employeeId}/documents`,
    payload: m.payload,
    headers: { ...m.headers, cookie: as },
    remoteAddress: randomIp(),
  });
};
const get = (url: string, as: string) => c.api('GET', url, undefined, as);
const audits = (action: string, targetId: string) =>
  c.tx((t) =>
    t.query<{ sensitive: boolean; diff: Record<string, unknown> }>(
      'SELECT sensitive, diff FROM audit.events WHERE action = $1 AND target_id = $2',
      [action, targetId],
    ),
  );

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  c = await phase6Company(ctx);
  const mgr = await c.hire({ legalFirstName: 'Mina', legalLastName: 'Manager' });
  emp.ada = await c.hire({ legalFirstName: 'Ada', legalLastName: 'Fictional', managerId: mgr });
  emp.bo = await c.hire({ legalFirstName: 'Bo', legalLastName: 'Fictional', managerId: mgr });
  cookie.hr = await c.login(await c.hire({ legalFirstName: 'Hana', legalLastName: 'Hr' }), 'hr_admin');
  cookie.ada = await c.login(emp.ada);
  cookie.bo = await c.login(emp.bo);
  cookie.mgr = await c.login(mgr, 'manager');
  cookie.payroll = await c.login(null, 'payroll_admin');
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});
afterEach(() => setUploadScanner(undefined));

describe('HR attaches documents to a person', () => {
  let licence: string;
  let background: string;

  it('stores a driving licence shared with the person under their prefix, typed by its content', async () => {
    const r = await attach(
      emp.ada,
      {
        attachmentType: 'driving_licence',
        visibility: 'employee',
        issuedOn: '2024-03-01',
        expiresOn: '2034-02-28',
        note: 'Seen the original (fictional)',
      },
      // the name and the declared type say PDF; the bytes are a PNG, and the bytes decide
      { name: '../../licence.pdf', body: PNG, type: 'application/pdf' },
    );
    expect(r.statusCode, r.body).toBe(201);
    licence = r.json().id;
    expect(r.json()).toMatchObject({
      attachmentType: 'driving_licence',
      visibility: 'employee',
      contentType: 'image/png',
      fileName: 'licence.png',
      issuedOn: '2024-03-01',
      expiresOn: '2034-02-28',
      note: 'Seen the original (fictional)',
      sensitive: false,
      scanStatus: 'not_scanned',
    });
    const row = await c.tx((t) =>
      t.one<{ file_key: string }>('SELECT file_key FROM app.documents WHERE id = $1', [licence]),
    );
    expect(row.file_key.startsWith(`${c.owner.tenantId}/employees/${emp.ada}/`)).toBe(true);
    expect(objects().get(row.file_key)!.body.equals(PNG)).toBe(true);
    // Ada is told it was shared with her, with a link to the viewer
    const n = await c.tx((t) =>
      t.query<{ link: string }>(
        `SELECT link FROM app.notifications WHERE kind = 'document.shared' AND dedupe_key = $1`,
        [`shared:${licence}`],
      ),
    );
    expect(n).toEqual([{ link: `/app/documents/${licence}` }]);
  });

  it('keeps an HR-only background check from the person and from managers', async () => {
    const r = await attach(
      emp.ada,
      { attachmentType: 'background_check', visibility: 'hr', title: 'Basic check' },
      { name: 'check.pdf', body: PDF('background') },
    );
    expect(r.statusCode, r.body).toBe(201);
    background = r.json().id;
    const adaList = (await get(`/v1/documents?employeeId=${emp.ada}`, cookie.ada!)).json();
    expect(adaList.map((d: { id: string }) => d.id)).toContain(licence);
    expect(adaList.map((d: { id: string }) => d.id)).not.toContain(background);
    // the person sees the document they were given, not HR's note on it
    expect(adaList.find((d: { id: string }) => d.id === licence).note).toBeNull();
    expect((await get(`/v1/documents/${background}`, cookie.ada!)).statusCode).toBe(403);
    expect((await get(`/v1/documents/${background}/content`, cookie.ada!)).statusCode).toBe(403);
    // managers see neither attachment, payroll sees nothing of the person's documents
    const mgrList = (await get(`/v1/documents?employeeId=${emp.ada}`, cookie.mgr!)).json();
    expect(mgrList.map((d: { id: string }) => d.id)).not.toContain(licence);
    expect((await get(`/v1/documents/${licence}/content`, cookie.mgr!)).statusCode).toBe(403);
    expect((await get(`/v1/documents/${licence}`, cookie.payroll!)).statusCode).toBe(403);
    // another employee cannot read it either
    expect((await get(`/v1/documents/${licence}/content`, cookie.bo!)).statusCode).toBe(403);
    const hrList = (await get(`/v1/documents?employeeId=${emp.ada}`, cookie.hr!)).json();
    expect(hrList.map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining([licence, background]));
  });

  it('opens a shared document in the viewer and audits every view and download', async () => {
    const meta = await get(`/v1/documents/${licence}`, cookie.ada!);
    expect(meta.statusCode, meta.body).toBe(200);
    expect(meta.json()).toMatchObject({ viewable: true, canManage: false, evidence: null, signature: null });
    const view = await get(`/v1/documents/${licence}/content`, cookie.ada!);
    expect(view.statusCode).toBe(200);
    expect(view.headers['content-type']).toBe('image/png');
    expect(view.headers['content-disposition']).toMatch(/^inline; filename="licence.png"/);
    expect(view.headers['cache-control']).toBe('private, no-store');
    expect(view.rawPayload.equals(PNG)).toBe(true);
    const dl = await get(`/v1/documents/${licence}/content?download=true`, cookie.ada!);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="licence.png"/);
    expect((await audits('document.viewed', licence)).map((a) => a.diff)).toEqual([{ own: true }]);
    expect(await audits('document.downloaded', licence)).toHaveLength(1);
  });

  it('refuses what it cannot accept: unknown content, the wrong type for right-to-work evidence, no file, too large', async () => {
    const html = await attach(
      emp.ada,
      { attachmentType: 'contract', visibility: 'hr' },
      { name: 'contract.pdf', body: Buffer.from('<html><script>alert(1)</script></html>') },
    );
    expect(html.statusCode).toBe(400);
    const docx = await attach(
      emp.ada,
      { attachmentType: 'right_to_work', visibility: 'hr' },
      { name: 'x.docx', body: Buffer.concat([Buffer.from('PK\x03\x04[Content_Types].xml word/', 'latin1')]) },
    );
    expect(docx.statusCode).toBe(400);
    expect(
      (await attach(emp.ada, { attachmentType: 'contract', visibility: 'hr' }, undefined)).statusCode,
    ).toBe(400);
    expect(
      (
        await attach(
          emp.ada,
          { attachmentType: 'passport', visibility: 'hr' },
          { name: 'a.pdf', body: PDF('a') },
        )
      ).statusCode,
    ).toBe(400);
    const big = await attach(
      emp.ada,
      { attachmentType: 'other', visibility: 'hr' },
      { name: 'big.pdf', body: Buffer.concat([PDF('big'), Buffer.alloc(21 * 1024 * 1024)]) },
    );
    expect(big.statusCode).toBe(400);
  });

  it('runs the scan hook before storing: an infected verdict stores nothing', async () => {
    setUploadScanner({ scan: async () => 'infected' });
    const before = objects().size;
    const r = await attach(
      emp.bo,
      { attachmentType: 'other', visibility: 'hr' },
      { name: 'x.pdf', body: PDF('eicar') },
    );
    expect(r.statusCode).toBe(422);
    expect(objects().size).toBe(before);
    setUploadScanner({ scan: async () => 'clean' });
    const ok = await attach(
      emp.bo,
      { attachmentType: 'other', visibility: 'hr' },
      { name: 'x.pdf', body: PDF('clean') },
    );
    expect(ok.json().scanStatus).toBe('clean');
  });

  it('only people who manage the person’s documents can attach', async () => {
    for (const who of [cookie.mgr!, cookie.ada!, cookie.payroll!])
      expect(
        (
          await attach(
            emp.bo,
            { attachmentType: 'other', visibility: 'hr' },
            { name: 'x.pdf', body: PDF('x') },
            who,
          )
        ).statusCode,
      ).toBe(403);
  });
});

describe('right-to-work evidence is kept in the vault', () => {
  let rtw: string;
  let shared: string;

  it('seals the file with the regional key and keeps every detail in the vault, not in the document row', async () => {
    const r = await attach(
      emp.bo,
      {
        attachmentType: 'right_to_work',
        evidenceType: 'brp_evisa',
        visibility: 'hr',
        issuedOn: '2025-01-10',
        expiresOn: '2027-01-09',
        note: 'Share code checked (fictional)',
        title: 'ignored for evidence',
      },
      { name: 'bo-evisa.pdf', body: PDF('fictional evisa') },
    );
    expect(r.statusCode, r.body).toBe(201);
    rtw = r.json().id;
    expect(r.json()).toMatchObject({
      sensitive: true,
      attachmentType: 'right_to_work',
      category: 'immigration',
    });
    const row = await c.tx((t) =>
      t.one<{
        title: string;
        file_name: string;
        note: string | null;
        issued_on: string | null;
        file_key: string;
        vault_record_id: string;
      }>(
        'SELECT title, file_name, note, issued_on, file_key, vault_record_id FROM app.documents WHERE id = $1',
        [rtw],
      ),
    );
    // the row is generic: no evidence type, no file name, no note, no issue date
    expect(row).toMatchObject({
      title: 'Right-to-work evidence',
      file_name: 'evidence.pdf',
      note: null,
      issued_on: null,
    });
    expect(row.file_key.startsWith(`${c.owner.tenantId}/vault/immigration/${emp.bo}/`)).toBe(true);
    const stored = objects().get(row.file_key)!.body;
    expect(isSealedFile(stored)).toBe(true);
    expect(stored.includes(Buffer.from('fictional evisa'))).toBe(false);
    const vault = await c.tx((t) =>
      t.one<{ category: string; field: string; envelope: unknown; file_key: string }>(
        'SELECT category, field, envelope, file_key FROM vault.records WHERE id = $1',
        [row.vault_record_id],
      ),
    );
    expect(vault).toMatchObject({
      category: 'immigration',
      field: `document:${rtw}`,
      file_key: row.file_key,
    });
    expect(JSON.stringify(vault.envelope)).not.toMatch(/brp|bo-evisa|Share code/);
    expect((await audits('vault.write', row.vault_record_id))[0]!.sensitive).toBe(true);
  });

  it('HR reads the details and the file through audited vault reads; the person and managers cannot', async () => {
    const meta = await get(`/v1/documents/${rtw}`, cookie.hr!);
    expect(meta.statusCode, meta.body).toBe(200);
    expect(meta.json().evidence).toEqual({
      evidenceType: 'brp_evisa',
      fileName: 'bo-evisa.pdf',
      note: 'Share code checked (fictional)',
      issuedOn: '2025-01-10',
    });
    const file = await get(`/v1/documents/${rtw}/content?download=true`, cookie.hr!);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.toString()).toContain('fictional evisa');
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="bo-evisa.pdf"/);
    const reads = await c.tx((t) =>
      t.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit.events WHERE action = 'vault.read' AND target_type = 'vault:immigration' AND diff->>'field' = $1`,
        [`document:${rtw}`],
      ),
    );
    expect(reads[0]!.n).toBe(2);
    expect((await audits('document.downloaded', rtw))[0]!.sensitive).toBe(true);
    for (const who of [cookie.bo!, cookie.mgr!, cookie.payroll!]) {
      expect((await get(`/v1/documents/${rtw}`, who)).statusCode).toBe(403);
      expect((await get(`/v1/documents/${rtw}/content`, who)).statusCode).toBe(403);
    }
    // a presigned link would hand out ciphertext: the old download route points at the audited content route
    expect((await get(`/v1/documents/${rtw}/download`, cookie.hr!)).json().url).toBe(
      `/v1/documents/${rtw}/content?download=true`,
    );
  });

  it('evidence shared with the person is readable by them through a self-disclosure grant, still audited', async () => {
    const r = await attach(
      emp.bo,
      { attachmentType: 'right_to_work', evidenceType: 'passport', visibility: 'employee' },
      { name: 'passport.png', body: PNG, type: 'image/png' },
    );
    shared = r.json().id;
    const mine = (await get(`/v1/documents?employeeId=${emp.bo}`, cookie.bo!)).json();
    expect(mine.map((d: { id: string }) => d.id)).toContain(shared);
    expect(mine.map((d: { id: string }) => d.id)).not.toContain(rtw);
    const meta = (await get(`/v1/documents/${shared}`, cookie.bo!)).json();
    expect(meta.evidence).toMatchObject({ evidenceType: 'passport', note: null });
    expect((await get(`/v1/documents/${shared}/content`, cookie.bo!)).rawPayload.equals(PNG)).toBe(true);
    expect((await audits('document.viewed', shared))[0]).toMatchObject({
      sensitive: true,
      diff: { own: true },
    });
  });

  it('the right-to-work list counts the evidence attached to each person', async () => {
    const r = await c.api('POST', '/v1/compliance/right-to-work/checks', {
      employeeId: emp.ada,
      checkMethod: 'manual_document_check',
      listType: 'list_a',
      checkedOn: '2026-10-02',
    });
    expect(r.statusCode, r.body).toBe(201);
    const linked = await attach(
      emp.ada,
      {
        attachmentType: 'right_to_work',
        evidenceType: 'passport',
        visibility: 'hr',
        rtwCheckId: r.json().id,
      },
      { name: 'p.pdf', body: PDF('ada passport') },
    );
    expect(linked.statusCode, linked.body).toBe(201);
    // a check of someone else cannot be linked
    expect(
      (
        await attach(
          emp.bo,
          { attachmentType: 'right_to_work', visibility: 'hr', rtwCheckId: r.json().id },
          { name: 'p.pdf', body: PDF('x') },
        )
      ).statusCode,
    ).toBe(400);
  });
});

describe('expiry reminders from the settings', () => {
  it('reminds HR (and the person when shared) on the offsets in the settings, with a renewal task, once', async () => {
    const r = await attach(
      emp.ada,
      {
        attachmentType: 'qualification',
        visibility: 'employee',
        title: 'Forklift certificate',
        expiresOn: '2027-03-31',
      },
      { name: 'cert.pdf', body: PDF('cert') },
    );
    const id = r.json().id;
    await c.api('PUT', '/v1/settings/compliance', { documentReminderDays: [45, 0] });
    const run = (date: string) => c.tx((t) => runComplianceDaily(ctx.deps, t, date));
    expect((await run('2027-03-01')).documents).toBe(0); // 30 days before: not an offset any more
    const first = await run('2027-02-14'); // 45 days before
    expect(first.documents).toBeGreaterThan(0);
    expect((await run('2027-02-14')).documents).toBe(0);
    const notes = await c.tx((t) =>
      t.query<{ title_key: string; link: string }>(
        `SELECT DISTINCT title_key, link FROM app.notifications WHERE dedupe_key = $1`,
        [`attachment:${id}:45`],
      ),
    );
    expect(notes).toEqual([{ title_key: 'notify.attachmentExpiring', link: `/app/documents/${id}` }]);
    const adaNote = await c.tx((t) =>
      t.query(
        `SELECT 1 FROM app.notifications n JOIN app.users u ON u.tenant_id = n.tenant_id AND u.id = n.user_id WHERE n.dedupe_key = $1 AND u.employee_id = $2`,
        [`attachment:${id}:45`, emp.ada],
      ),
    );
    expect(adaNote).toHaveLength(1);
    const task = await c.tx((t) =>
      t.query<{ assignee_role: string; due_on: string }>(
        `SELECT assignee_role, due_on::text AS due_on FROM app.tasks WHERE dedupe_key = $1`,
        [`attachment:${id}:task`],
      ),
    );
    expect(task).toEqual([{ assignee_role: 'hr_admin', due_on: '2027-03-31' }]);
    expect((await run('2027-04-01')).documents).toBeGreaterThan(0); // the day after: expired
    const list = (await get(`/v1/documents?employeeId=${emp.ada}`, cookie.hr!)).json();
    expect(list.find((d: { id: string }) => d.id === id).expiryStatus).toBeNull(); // years away from today
  });
});

describe('review and sign in the viewer', () => {
  let tplLetter: string;
  let tplContract: string;
  const generate = async (template: string, employeeId: string) => {
    const g = await c.api('POST', `/v1/document-templates/${template}/generate`, {
      employeeId,
      requireSignature: true,
    });
    expect(g.statusCode, g.body).toBe(201);
    return g.json().documentId as string;
  };

  beforeAll(async () => {
    tplLetter = (
      await c.api('POST', '/v1/document-templates', {
        name: 'Change of shift pattern',
        body: 'Dear {{employee.firstName}},\nYour new shift pattern starts next month. Fictional sample.',
      })
    ).json().id;
    tplContract = (
      await c.api('POST', '/v1/document-templates', {
        name: 'Statement of terms',
        category: 'contract',
        body: 'Employee: {{employee.displayName}}\nFictional sample contract.',
      })
    ).json().id;
    const templates = (await c.api('GET', '/v1/document-templates')).json();
    expect(templates.find((x: { id: string }) => x.id === tplContract).requiresCountersign).toBe(true);
    expect(templates.find((x: { id: string }) => x.id === tplLetter).requiresCountersign).toBe(false);
  });

  it('the employee opens the document, signs it from the viewer and gets the signed copy there', async () => {
    const doc = await generate(tplLetter, emp.ada);
    const link = await c.tx((t) =>
      t.query<{ link: string }>(
        `SELECT link FROM app.tasks WHERE source = 'document' AND subject_employee_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [emp.ada],
      ),
    );
    // the viewer, opened at the signature request (ADR-0160)
    expect(link[0]!.link).toMatch(new RegExp(`^/app/documents/${doc}\\?sign=[0-9a-f-]{36}$`));
    const meta = (await get(`/v1/documents/${doc}`, cookie.ada!)).json();
    expect(meta).toMatchObject({
      viewable: true,
      signature: { status: 'pending', requiresCountersign: false },
    });
    expect((await get(`/v1/documents/${doc}/content`, cookie.ada!)).headers['content-type']).toBe(
      'application/pdf',
    );
    const sign = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signature-requests/${meta.signature.id}/sign`,
      payload: { consent: true, typedName: 'Ada Fictional' },
      headers: { cookie: cookie.ada!, 'user-agent': 'FictionalPhone/2.0' },
      remoteAddress: '10.77.4.5',
    });
    expect(sign.statusCode, sign.body).toBe(200);
    expect(sign.json()).toMatchObject({ status: 'completed' });
    const copy = sign.json().signedDocumentId;
    const after = (await get(`/v1/documents/${doc}`, cookie.ada!)).json();
    expect(after.signature).toMatchObject({ status: 'signed', signedDocumentId: copy, approvalStatus: null });
    expect(after.signature.completedAt).not.toBeNull();
    const signed = (await get(`/v1/documents/${copy}`, cookie.ada!)).json();
    expect(signed.signedCopyOf).toMatchObject({ documentId: doc, signerName: 'Ada Fictional' });
    const pdf = await get(`/v1/documents/${copy}/content?download=true`, cookie.ada!);
    const pages = await pdfPageTexts(pdf.rawPayload);
    expect(pages.at(-1)).toContain('Signature certificate');
    expect(pages.at(-1)).toContain('10.77.4.5');
  });

  it('a contract waits for the countersignature: HR sees it in approvals, reviews it in the viewer and countersigns', async () => {
    const doc = await generate(tplContract, emp.ada);
    const sr = (await get(`/v1/documents/${doc}`, cookie.ada!)).json().signature;
    expect(sr.requiresCountersign).toBe(true);
    const sign = await c.api(
      'POST',
      `/v1/signature-requests/${sr.id}/sign`,
      { consent: true, typedName: 'Ada Fictional' },
      cookie.ada!,
    );
    expect(sign.json()).toMatchObject({ status: 'awaiting_approval', signedDocumentId: null });
    expect((await get(`/v1/documents/${doc}`, cookie.ada!)).json().signature).toMatchObject({
      status: 'signed',
      approvalStatus: 'pending',
      completedAt: null,
    });
    // an actionable item in the approver's approvals list and inbox, both leading to the viewer
    const inbox = (await get('/v1/approvals?view=mine', cookie.hr!)).json();
    const item = inbox.find(
      (a: { subject: string; payload: { documentId?: string } }) =>
        a.subject === 'document.countersign' && a.payload.documentId === doc,
    );
    expect(item).toBeTruthy();
    expect(item.payload.link).toBe(`/app/documents/${doc}`);
    const tasks = await c.tx((t) =>
      t.query<{ link: string }>(`SELECT link FROM app.tasks WHERE source = 'approval' AND source_id = $1`, [
        item.id,
      ]),
    );
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.link === `/app/documents/${doc}`)).toBe(true);
    const review = (await get(`/v1/documents/${doc}`, cookie.hr!)).json();
    expect(review.countersign).toMatchObject({ signatureRequestId: sr.id, signerName: 'Ada Fictional' });
    // the signer cannot countersign their own document
    expect(
      (
        await c.api(
          'POST',
          `/v1/signature-requests/${sr.id}/countersign`,
          { decision: 'approve', consent: true, typedName: 'Ada' },
          cookie.ada!,
        )
      ).statusCode,
    ).toBe(403);
    const cs = await ctx.app.inject({
      method: 'POST',
      url: `/v1/signature-requests/${sr.id}/countersign`,
      payload: { decision: 'approve', consent: true, typedName: 'Hana Hr' },
      headers: { cookie: cookie.hr!, 'user-agent': 'FictionalLaptop/3.1' },
      remoteAddress: '10.77.9.9',
    });
    expect(cs.statusCode, cs.body).toBe(200);
    expect(cs.json().status).toBe('completed');
    const copy = cs.json().signedDocumentId;
    const pages = (
      await pdfPageTexts((await get(`/v1/documents/${copy}/content`, cookie.ada!)).rawPayload)
    ).map((p) => p.replace(/\s+/g, ' '));
    // both signatures, each with its time
    expect(pages.at(-2)).toContain('Signature certificate');
    expect(pages.at(-2)).toContain('Ada Fictional');
    expect(pages.at(-1)).toContain('Countersignature certificate');
    expect(pages.at(-1)).toContain('Hana Hr');
    expect(pages.at(-1)).toContain('10.77.9.9');
    const verify = (await get(`/v1/signature-requests/${sr.id}/verify`, cookie.ada!)).json();
    expect(verify).toMatchObject({ valid: true, signerName: 'Ada Fictional', countersignerName: 'Hana Hr' });
    expect(verify.completedAt).not.toBeNull();
    for (const action of ['document.signed', 'document.countersigned'])
      expect(await audits(action, sr.id)).toHaveLength(1);
    expect(
      (await get('/v1/approvals?view=mine', cookie.hr!)).json().some((a: { id: string }) => a.id === item.id),
    ).toBe(false);
    // the signer is told it is complete (and so is whoever sent it, unless they did the last step themselves)
    const done = await c.tx((t) =>
      t.query<{ user_id: string }>(
        `SELECT user_id FROM app.notifications WHERE kind = 'document.completed' AND dedupe_key = $1`,
        [`completed:${sr.id}`],
      ),
    );
    const ada = await c.tx((t) =>
      t.one<{ id: string }>('SELECT id FROM app.users WHERE employee_id = $1', [emp.ada]),
    );
    expect(done.map((d) => d.user_id)).toContain(ada.id);
  });

  it('the approver can return it with a reason; the person reads it and signs again', async () => {
    const doc = await generate(tplContract, emp.bo);
    const sr = (await get(`/v1/documents/${doc}`, cookie.bo!)).json().signature;
    await c.api(
      'POST',
      `/v1/signature-requests/${sr.id}/sign`,
      { consent: true, typedName: 'Bo Fictional' },
      cookie.bo!,
    );
    expect(
      (
        await c.api(
          'POST',
          `/v1/signature-requests/${sr.id}/countersign`,
          { decision: 'return', reason: 'x' },
          cookie.hr!,
        )
      ).statusCode,
    ).toBe(400); // a reason is required
    const back = await c.api(
      'POST',
      `/v1/signature-requests/${sr.id}/countersign`,
      { decision: 'return', reason: 'Please sign with your full legal name (fictional).' },
      cookie.hr!,
    );
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().status).toBe('returned');
    expect((await get(`/v1/documents/${doc}`, cookie.bo!)).json().signature).toMatchObject({
      status: 'pending',
      approvalStatus: 'returned',
      returnedReason: 'Please sign with your full legal name (fictional).',
    });
    expect(await audits('document.returned', sr.id)).toHaveLength(1);
    const again = await c.api(
      'POST',
      `/v1/signature-requests/${sr.id}/sign`,
      { consent: true, typedName: 'Bo Fictional' },
      cookie.bo!,
    );
    expect(again.json().status).toBe('awaiting_approval');
    expect((await get(`/v1/documents/${doc}`, cookie.hr!)).json().countersign).not.toBeNull();
  });

  it('a designated countersigner without document access reads the document only while it waits for them', async () => {
    const mgrUser = await c.tx((t) =>
      t.one<{ id: string }>(
        `SELECT u.id FROM app.users u JOIN app.role_assignments a ON a.tenant_id = u.tenant_id AND a.user_id = u.id JOIN app.roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id WHERE r.key = 'manager' LIMIT 1`,
      ),
    );
    // the customer names an authorised signatory in Settings → Documents (ADR-0196)
    const named = await c.api('PUT', '/v1/document-signatories', {
      entries: [{ kind: 'user', userId: mgrUser.id }],
    });
    expect(named.statusCode, named.body).toBe(200);
    const other = await c.hire({ legalFirstName: 'Cy', legalLastName: 'Fictional' });
    const cy = await c.login(other);
    const doc = await generate(tplContract, other);
    const sr = (await get(`/v1/documents/${doc}`, cy)).json().signature;
    expect((await get(`/v1/documents/${doc}`, cookie.mgr!)).statusCode).toBe(403);
    await c.api(
      'POST',
      `/v1/signature-requests/${sr.id}/sign`,
      { consent: true, typedName: 'Cy Fictional' },
      cy,
    );
    expect((await get(`/v1/documents/${doc}`, cookie.mgr!)).json().countersign).toMatchObject({
      signatureRequestId: sr.id,
    });
    expect((await get(`/v1/documents/${doc}/content`, cookie.mgr!)).statusCode).toBe(200);
    expect(
      (
        await c.api(
          'POST',
          `/v1/signature-requests/${sr.id}/countersign`,
          { decision: 'approve', consent: true, typedName: 'Mina Manager' },
          cookie.mgr!,
        )
      ).json().status,
    ).toBe('completed');
    expect((await get(`/v1/documents/${doc}`, cookie.mgr!)).statusCode).toBe(403);
  });
});
