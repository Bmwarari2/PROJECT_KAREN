import { t } from '@thapsus/core/i18n';
import { addDays, compareDates } from '@thapsus/core/time';
import { writeAudit } from '@thapsus/db';
import type { Deps } from '../../../deps';
import { appendCertificate, renderTextPdf, sha256 } from '../../../modules/documents/pdf';
import { generateFromTemplate } from '../../../modules/documents/routes';
import { bump, insertRows, mapLimit, seedUuid, type SeedCtx } from '../context';
import { currentJob, type PlanPerson } from '../plan';

const POLICIES: Array<[title: string, folder: string, body: string]> = [
  [
    'Employee handbook',
    'policies',
    'Welcome to Kestrel Fictional Group. This handbook explains how we work: hours, leave, expenses, conduct and wellbeing. It is a fictional sample document for the staging environment.',
  ],
  [
    'Hybrid working policy',
    'policies',
    'Office-based teams spend at least two days a week in the office. Requests for other patterns go through the flexible working process. Fictional sample.',
  ],
  [
    'Annual leave and absence policy',
    'policies',
    'How to book leave, how sickness is reported and when a fit note is needed (after seven calendar days of sickness). Fictional sample.',
  ],
  [
    'Grievance and disciplinary procedure',
    'policies',
    'The steps we follow, who to talk to and your right to be accompanied. Fictional sample.',
  ],
  [
    'Data protection notice for staff',
    'policies',
    'What personal data the company holds about you, why, and for how long. Fictional sample.',
  ],
  [
    'Warehouse health and safety rules',
    'safety',
    'Hi-vis in the yard, pedestrian walkways, forklift exclusion zones and manual handling. Fictional sample.',
  ],
  [
    'Fire evacuation plan: Manchester distribution centre',
    'safety',
    'Assembly point: north car park. Fire marshals on every shift. Fictional sample.',
  ],
  [
    'Return-to-work conversation guide',
    'managers',
    'A short structure for return-to-work conversations after sickness. Fictional sample.',
  ],
  [
    'Probation review template',
    'managers',
    'Objectives, evidence and the outcome of a probation review. Fictional sample.',
  ],
  [
    'Pay review guidance 2026',
    'hr',
    'Budget, timeline and approval steps for the April pay review. Fictional sample.',
  ],
];

const TEMPLATES: Array<{ key: string; name: string; locale: string; category: string; body: string }> = [
  {
    key: 'offer_uk',
    name: 'Offer letter (UK)',
    locale: 'en-GB',
    category: 'offer',
    body: 'Dear {{employee.firstName}},\n\nWe are delighted to offer you the role of {{employee.jobTitle}} in {{employee.department}} at {{entity.name}}, based at {{employee.location}}, starting on {{employee.startDate}}.\n\nYour salary will be {{employee.salary}} ({{employee.payFrequency}}).\n\nThis is a fictional sample letter generated for the staging environment.\n\n{{company.name}}\n{{today}}',
  },
  {
    key: 'contract_uk',
    name: 'Statement of main terms (UK)',
    locale: 'en-GB',
    category: 'contract',
    body: 'Employer: {{entity.name}}\nEmployee: {{employee.displayName}} ({{employee.employeeNumber}})\nJob title: {{employee.jobTitle}}\nPlace of work: {{employee.location}}\nStart date: {{employee.startDate}}\nPay: {{employee.salary}} ({{employee.payFrequency}})\n\nThis is a fictional sample contract generated for the staging environment.',
  },
  {
    key: 'variation',
    name: 'Change of terms letter',
    locale: 'en-GB',
    category: 'letter',
    body: 'Dear {{employee.firstName}},\n\nThis letter confirms a change to your terms: your role is {{employee.jobTitle}} and your pay is {{employee.salary}} ({{employee.payFrequency}}). Please sign to confirm you agree.\n\nFictional sample letter.\n\n{{company.name}}, {{today}}',
  },
  {
    key: 'offer_us',
    name: 'Offer letter (US)',
    locale: 'en-US',
    category: 'offer',
    body: 'Dear {{employee.firstName}},\n\nWe are pleased to offer you the position of {{employee.jobTitle}} at {{entity.name}} in {{employee.location}}, starting {{employee.startDate}}, at {{employee.salary}} ({{employee.payFrequency}}). Employment is at will.\n\nThis is a fictional sample letter generated for the staging environment.\n\n{{company.name}}',
  },
];

/**
 * Documents and e-signature: folders, company policies (small generated PDFs stored through the object
 * store), letter templates, offer letters and contracts generated from those templates by the documents
 * service (with signature requests), signed copies with their signature certificate, and a few expiring
 * documents for the expiry reminders.
 */
export async function seedDocuments(ctx: SeedCtx) {
  const { tx, plan, ids, anchor } = ctx;
  const folders: Record<string, string> = {
    policies: seedUuid('folder', 'policies'),
    safety: seedUuid('folder', 'safety'),
    managers: seedUuid('folder', 'managers'),
    hr: seedUuid('folder', 'hr'),
  };
  await insertRows(tx, 'app.document_folders', [
    { id: folders.policies, name: 'Company policies', parent_id: null, visibility: 'everyone' },
    { id: folders.managers, name: 'Manager toolkit', parent_id: null, visibility: 'managers' },
    { id: folders.hr, name: 'HR only', parent_id: null, visibility: 'hr' },
  ]);
  await insertRows(tx, 'app.document_folders', [
    { id: folders.safety, name: 'Health and safety', parent_id: folders.policies, visibility: 'everyone' },
  ]);
  // company documents
  const files = await mapLimit(POLICIES, 8, async ([title, folder, body], i) => {
    const pdf = Buffer.from(await renderTextPdf(title, body));
    const id = seedUuid('document', `policy:${i}`);
    const key = `${ctx.tenantId}/documents/${id}.pdf`;
    await ctx.objects.put(key, pdf, 'application/pdf');
    return {
      id,
      folder_id: folders[folder],
      employee_id: null,
      title,
      category: folder === 'safety' ? 'health_and_safety' : 'policy',
      file_key: key,
      file_name: `${title.replace(/[^\w.-]+/g, '_')}.pdf`,
      content_type: 'application/pdf',
      size_bytes: pdf.length,
      sha256: sha256(pdf),
      status: 'ready',
      created_by: ids.user.hr_admin,
      uploaded_at: `${addDays(anchor, -200 + i * 12)}T09:00:00Z`,
      created_at: `${addDays(anchor, -200 + i * 12)}T09:00:00Z`,
    };
  });
  await insertRows(tx, 'app.documents', files);
  // expiring documents: driving licence checks for the delivery drivers (one is due within the month)
  const drivers = plan.people
    .filter((p) => p.kind === 'roster' && currentJob(p, anchor).title === 'Delivery driver')
    .slice(0, 5);
  const licences = await mapLimit(drivers, 8, async (p, i) => {
    const pdf = Buffer.from(
      await renderTextPdf(
        'Driving licence check (fictional)',
        `Licence check summary for ${p.number}. Fictional sample.`,
      ),
    );
    const id = seedUuid('document', `licence:${p.number}`);
    const key = `${ctx.tenantId}/documents/${id}.pdf`;
    await ctx.objects.put(key, pdf, 'application/pdf');
    return {
      id,
      folder_id: null,
      employee_id: ids.employee[p.idx],
      title: 'Driving licence check',
      category: 'licence',
      file_key: key,
      file_name: `driving-licence-check-${p.number}.pdf`,
      content_type: 'application/pdf',
      size_bytes: pdf.length,
      sha256: sha256(pdf),
      status: 'ready',
      expires_on: addDays(anchor, i === 0 ? 21 : 120 + i * 60),
      created_by: ids.user.hr_admin,
      uploaded_at: `${addDays(anchor, -150 + i)}T10:00:00Z`,
      created_at: `${addDays(anchor, -150 + i)}T10:00:00Z`,
    };
  });
  await insertRows(tx, 'app.documents', licences);
  // letter templates
  const tpl: Record<string, string> = {};
  for (const x of TEMPLATES) tpl[x.key] = seedUuid('template', x.key);
  await insertRows(
    tx,
    'app.document_templates',
    TEMPLATES.map((x) => ({
      id: tpl[x.key],
      name: x.name,
      locale: x.locale,
      body: x.body,
      category: x.category,
    })),
  );
  // documents generated by the documents service (merge fields from the employee record) with signatures
  const deps = { objects: ctx.objects } as Pick<Deps, 'objects'> as Deps;
  const hr = ids.user.hr_admin;
  const generate = async (p: PlanPerson, key: string, sign: boolean, title?: string) =>
    generateFromTemplate(deps, tx, tpl[key]!, ids.employee[p.idx]!, hr, {
      requireSignature: sign,
      ...(title ? { title } : {}),
    });
  const starters = plan.people.filter((p) => p.kind === 'upcoming_starter');
  for (const p of starters) {
    await generate(p, p.entity === 'us' ? 'offer_us' : 'offer_uk', true);
    if (p.entity === 'uk') await generate(p, 'contract_uk', true);
  }
  const signedPeople = plan.people.filter(
    (p) =>
      p.kind === 'roster' &&
      p.entity === 'uk' &&
      (p.recentStarter || p.managerIdx === plan.logins.manager || p.login),
  );
  let signed = 0;
  for (const p of signedPeople) {
    const docId = await generate(p, 'contract_uk', true);
    await signRequest(
      ctx,
      docId,
      p,
      compareDates(p.startDate, addDays(anchor, -60)) > 0 ? addDays(p.startDate, -5) : addDays(anchor, -45),
    );
    signed++;
  }
  // a change of terms waiting for the employee login's signature (task and notification for them)
  const emp = plan.people[plan.logins.employee]!;
  await generate(emp, 'variation', true, 'Change of terms: shift allowance');
  const mgr = plan.people[plan.logins.manager]!;
  const v = await generate(mgr, 'variation', true, 'Change of terms: team leader allowance');
  await signRequest(ctx, v, mgr, addDays(anchor, -20));
  ctx.counts.documents = files.length + licences.length + starters.length + signedPeople.length * 2 + 3;
  ctx.counts.signedDocuments = signed + 1;
  bump(ctx, 'documentTemplates', TEMPLATES.length);
}

/** Signs a pending signature request as the signature route does (certificate page appended, signed copy kept). */
async function signRequest(ctx: SeedCtx, documentId: string, p: PlanPerson, on: string) {
  const { tx, ids } = ctx;
  const sr = await tx.one<{ id: string; file_key: string; title: string }>(
    `SELECT s.id, d.file_key, d.title FROM app.signature_requests s JOIN app.documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id WHERE s.document_id = $1`,
    [documentId],
  );
  const original = await ctx.objects.get(sr.file_key);
  const documentSha256 = sha256(original);
  const signedAt = `${on}T11:20:00Z`;
  const labels = Object.fromEntries(
    ['title', 'signer', 'signedAt', 'ip', 'userAgent', 'hash', 'reference', 'statement'].map((k) => [
      k,
      t('en-GB', `documents.certificate.${k}`),
    ]),
  );
  const name = `${p.preferred ?? p.first} ${p.last}`;
  const signedPdf = Buffer.from(
    await appendCertificate(original, {
      signerName: name,
      signerEmail: p.workEmail,
      signedAtUtc: signedAt,
      ip: '192.0.2.10', // documentation address range (RFC 5737), not a real client
      userAgent: 'Thapsus-HR staging seed',
      documentSha256,
      requestId: sr.id,
      labels,
    }),
  );
  const signedKey = `${ctx.tenantId}/employees/${ids.employee[p.idx]}/${seedUuid('signed', sr.id)}.pdf`;
  await ctx.objects.put(signedKey, signedPdf, 'application/pdf');
  const signedSha256 = sha256(signedPdf);
  await tx.exec(
    `INSERT INTO app.documents (tenant_id, employee_id, title, category, file_key, file_name, content_type, size_bytes, sha256, status, uploaded_at, created_at)
     VALUES (app.current_tenant(), $1, $2, 'signed', $3, $4, 'application/pdf', $5, $6, 'ready', $7, $7)`,
    [
      ids.employee[p.idx],
      `${sr.title} (signed)`,
      signedKey,
      `${sr.title.replace(/[^\w.-]+/g, '_')}_signed.pdf`,
      signedPdf.length,
      signedSha256,
      signedAt,
    ],
  );
  const user = p.login ? ids.user[p.login] : null;
  await tx.exec(
    `UPDATE app.signature_requests SET status = 'signed', signed_at = $2, signer_user_id = $3, signer_name = $4, signer_ip = '192.0.2.10', signer_user_agent = 'Thapsus-HR staging seed', document_sha256 = $5, signed_file_key = $6, signed_sha256 = $7, requested_at = $8 WHERE id = $1`,
    [sr.id, signedAt, user, name, documentSha256, signedKey, signedSha256, `${addDays(on, -3)}T09:00:00Z`],
  );
  await tx.exec(
    `UPDATE app.tasks SET status = 'done', completed_at = $2, completed_by = $3 WHERE dedupe_key = $1`,
    [`sign:${sr.id}`, signedAt, user],
  );
  await tx.exec(`UPDATE app.notifications SET read_at = $2 WHERE dedupe_key = $1`, [
    `sign:${sr.id}`,
    signedAt,
  ]);
  await writeAudit(tx, {
    actorType: 'system',
    action: 'document.signed',
    targetType: 'signature_request',
    targetId: sr.id,
    diff: { documentSha256, signedSha256, source: 'staging_seed' },
  });
}
