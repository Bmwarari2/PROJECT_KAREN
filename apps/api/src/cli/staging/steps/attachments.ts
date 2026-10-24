import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { addDays, addYears, compareDates } from '@thapsus/core/time';
import { writeAudit } from '@thapsus/db';
import { renderTextPdf } from '../../../modules/documents/pdf';
import { parseFields, storeAttachment } from '../../../modules/documents/attachments';
import { loadTarget } from '../../../modules/employees/service';
import { bump, seedUuid, type SeedCtx } from '../context';
import type { PlanPerson } from '../plan';

/** A fictional licence card drawn as a one-page PDF (no real design, no real data). */
async function licenceCard(p: PlanPerson, issued: string, expires: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle('Driving licence copy (fictional sample)');
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([420, 270]);
  page.drawRectangle({ x: 10, y: 10, width: 400, height: 250, color: rgb(0.93, 0.95, 0.98) });
  page.drawRectangle({ x: 10, y: 225, width: 400, height: 35, color: rgb(0.2, 0.35, 0.6) });
  page.drawText('FICTIONAL SAMPLE - NOT A REAL LICENCE', {
    x: 24,
    y: 238,
    size: 12,
    font: bold,
    color: rgb(1, 1, 1),
  });
  page.drawRectangle({ x: 24, y: 60, width: 100, height: 130, color: rgb(0.8, 0.82, 0.86) });
  page.drawText('photo', { x: 58, y: 120, size: 10, font, color: rgb(0.4, 0.4, 0.45) });
  const rows: Array<[string, string]> = [
    ['1.', p.last.toUpperCase()],
    ['2.', p.first],
    ['4a.', issued],
    ['4b.', expires],
    ['5.', `SAMPLE${String(100000 + p.idx)}`],
    ['9.', 'B'],
  ];
  rows.forEach(([k, v], i) => {
    page.drawText(k, { x: 140, y: 185 - i * 22, size: 10, font, color: rgb(0.3, 0.3, 0.35) });
    page.drawText(v, { x: 170, y: 185 - i * 22, size: 11, font: bold, color: rgb(0.1, 0.1, 0.12) });
  });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * Documents HR attached to people (ADR-0165, ADR-0166), stored by the same service as the attach route:
 *  - right-to-work evidence (sealed, in the vault) for several UK people with a recorded check, including one whose
 *    permission ends soon and one whose permission has expired;
 *  - for the employee login: a copy of their contract and of their driving licence shared with them, and a
 *    background check HR keeps to itself (so they see only what was shared);
 *  - qualifications for a few warehouse staff.
 */
export async function seedAttachments(ctx: SeedCtx) {
  const { tx, plan, ids, anchor } = ctx;
  const hr = ids.user.hr_admin;
  const deps = { objects: ctx.objects, keys: ctx.keys };
  let n = 0;
  const attach = async (
    p: PlanPerson,
    key: string,
    fields: Record<string, string>,
    file: { bytes: Buffer; name: string },
    daysAgo: number,
  ) => {
    const employeeId = ids.employee[p.idx]!;
    const f = parseFields(fields);
    const row = await storeAttachment(deps, tx, ctx.vault, {
      actor: ctx.system,
      tenantId: ctx.tenantId,
      userId: hr,
      target: await loadTarget(tx, employeeId),
      fields: f,
      file: {
        bytes: file.bytes,
        type: 'application/pdf',
        fileName: file.name,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
      },
      scan: 'not_scanned',
      id: seedUuid('attachment', `${p.number}:${key}`),
      uploadedAt: `${addDays(anchor, -daysAgo)}T10:30:00Z`,
    });
    await writeAudit(tx, {
      actorType: 'system',
      action: 'document.attached',
      targetType: 'document',
      targetId: row.id,
      diff: {
        employeeId,
        attachmentType: f.attachmentType,
        visibility: f.visibility,
        source: 'staging_seed',
      },
      sensitive: f.attachmentType === 'right_to_work',
    });
    n++;
  };

  // ---- right-to-work evidence, linked to the recorded checks -----------------------------------------------------
  const checks = await tx.query<{
    id: string;
    employee_id: string;
    list_type: string;
    checked_on: string;
    permission_expires_on: string | null;
  }>(
    `SELECT id, employee_id, list_type, checked_on::text AS checked_on, permission_expires_on::text AS permission_expires_on
       FROM app.rtw_checks WHERE superseded_by IS NULL ORDER BY permission_expires_on NULLS LAST, employee_id`,
  );
  const byEmployee = new Map(plan.people.map((p) => [ids.employee[p.idx]!, p]));
  const expired = checks.find(
    (c) => c.permission_expires_on && compareDates(c.permission_expires_on, anchor) < 0,
  );
  const soon = checks.find(
    (c) =>
      c.permission_expires_on &&
      compareDates(c.permission_expires_on, anchor) >= 0 &&
      compareDates(c.permission_expires_on, addDays(anchor, 60)) <= 0,
  );
  const later = checks.filter(
    (c) => c.permission_expires_on && compareDates(c.permission_expires_on, addDays(anchor, 60)) > 0,
  );
  const passports = checks.filter((c) => c.list_type === 'list_a');
  const evidence = [
    ...(expired ? [{ c: expired, type: 'brp_evisa' }] : []),
    ...(soon ? [{ c: soon, type: 'share_code_result' }] : []),
    ...later.slice(0, 2).map((c) => ({ c, type: 'share_code_result' })),
    ...passports.slice(0, 3).map((c) => ({ c, type: 'passport' })),
  ];
  for (const [i, { c, type }] of evidence.entries()) {
    const p = byEmployee.get(c.employee_id);
    if (!p) continue;
    const pdf = await renderTextPdf(
      'Right-to-work evidence (fictional sample)',
      [
        `Fictional evidence generated for the Thapsus-HR staging environment. It is not a real ${type === 'passport' ? 'passport' : 'immigration document'}.`,
        `Employee number: ${p.number}`,
        `Checked on: ${c.checked_on}`,
        c.permission_expires_on ? `Permission to work until: ${c.permission_expires_on}` : 'No time limit',
      ].join('\n'),
    );
    await attach(
      p,
      `rtw:${c.id}`,
      {
        attachmentType: 'right_to_work',
        evidenceType: type,
        visibility: 'hr',
        rtwCheckId: c.id,
        ...(c.permission_expires_on ? { expiresOn: c.permission_expires_on } : {}),
        issuedOn: c.checked_on,
        note: 'Copy checked against the original (fictional).',
      },
      { bytes: Buffer.from(pdf), name: `${type}-${p.number}.pdf` },
      30 + i,
    );
  }

  // ---- the employee login: shared documents and one HR keeps to itself -------------------------------------------
  const emp = plan.people[plan.logins.employee]!;
  const contract = await renderTextPdf(
    'Contract of employment (fictional sample)',
    `Employer: Kestrel Fictional Group Ltd\nEmployee: ${emp.first} ${emp.last} (${emp.number})\nStart date: ${emp.startDate}\n\nThis copy of the signed paper contract was scanned by HR. Fictional sample for the staging environment.`,
  );
  await attach(
    emp,
    'contract',
    {
      attachmentType: 'contract',
      visibility: 'employee',
      title: 'Contract of employment (scanned copy)',
      issuedOn: emp.startDate,
    },
    { bytes: Buffer.from(contract), name: 'contract-of-employment.pdf' },
    90,
  );
  const issued = addYears(anchor, -2);
  const expires = addYears(anchor, 8);
  await attach(
    emp,
    'licence',
    {
      attachmentType: 'driving_licence',
      visibility: 'employee',
      title: 'Driving licence (copy)',
      issuedOn: issued,
      expiresOn: expires,
      note: 'Checked for forklift and yard vehicle duties (fictional).',
    },
    { bytes: await licenceCard(emp, issued, expires), name: 'driving-licence.pdf' },
    40,
  );
  const dbs = await renderTextPdf(
    'Basic criminal record check result (fictional sample)',
    `Employee number: ${emp.number}\nResult: no information recorded (fictional).\n\nFictional sample for the staging environment.`,
  );
  await attach(
    emp,
    'background',
    {
      attachmentType: 'background_check',
      visibility: 'hr',
      title: 'Basic criminal record check',
      issuedOn: addDays(emp.startDate, -10),
    },
    { bytes: Buffer.from(dbs), name: 'background-check.pdf' },
    60,
  );

  // ---- qualifications for some of the warehouse team (one expiring within the reminder window) -----------------
  const team = plan.people
    .filter((p) => p.managerIdx === plan.logins.manager && p.idx !== emp.idx)
    .slice(0, 3);
  for (const [i, p] of team.entries()) {
    const pdf = await renderTextPdf(
      'Counterbalance forklift certificate (fictional sample)',
      `Holder: ${p.first} ${p.last} (${p.number})\nFictional training certificate for the staging environment.`,
    );
    await attach(
      p,
      'forklift',
      {
        attachmentType: 'qualification',
        visibility: 'employee',
        title: 'Forklift certificate',
        issuedOn: addYears(anchor, -3),
        expiresOn: i === 0 ? addDays(anchor, 25) : addYears(anchor, 1 + i),
      },
      { bytes: Buffer.from(pdf), name: `forklift-certificate-${p.number}.pdf` },
      120 + i,
    );
  }
  bump(ctx, 'attachedDocuments', n);
}
