import { formatDate, t } from '@thapsus/core/i18n';
import { addDays, compareDates } from '@thapsus/core/time';
import { writeAudit } from '@thapsus/db';
import type { Deps } from '../../../deps';
import {
  appendCertificate,
  renderTextPdf,
  sha256,
  stampSignature,
  type SignatureField,
} from '../../../modules/documents/pdf';
import { addEvent } from '../../../modules/documents/signing';
import {
  certificateLabels,
  registerCountersignEffects,
  requestCountersign,
} from '../../../modules/documents/countersign';
import { decide } from '../../../modules/approvals/service';
import { generateFromTemplate } from '../../../modules/documents/routes';
import { sampleByKey } from '../../../modules/documents/samples';
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

const HYBRID_SECTIONS = [
  [
    'Purpose',
    'This agreement sets out how hybrid working works for you at Kestrel Fictional Group: where you work, when you are expected in the office or on site, and what the company provides. It is a fictional sample document for the staging environment and has no legal effect.',
  ],
  [
    'Your working pattern',
    'Your contracted hours and place of work do not change. You agree a weekly pattern with your manager, for example two days on site and three days at home. Your manager records the pattern so rotas and cover planning stay accurate.',
  ],
  [
    'Core hours',
    'You are available between 10:00 and 15:00 on working days unless you have agreed something else with your manager. Outside core hours you organise your time to meet the needs of your team.',
  ],
  [
    'Your workspace at home',
    'You work from a safe, quiet space with a reliable internet connection. You complete the display screen equipment self-assessment within two weeks of starting hybrid working and again each year.',
  ],
  [
    'Equipment',
    'The company provides a laptop, a headset and, on request, a monitor and a chair. Equipment remains company property; you look after it and return it when you leave or when hybrid working ends.',
  ],
  [
    'Expenses',
    'Hybrid working is voluntary. The company does not pay home energy or broadband costs. Travel to your usual place of work is not a business expense.',
  ],
  [
    'Information security',
    'You lock your screen when you step away, keep printed documents to a minimum and shred them at the office, and never let anyone else use company equipment. You report a lost or stolen device to the IT service desk straight away.',
  ],
  [
    'Health and safety',
    'You report any accident or injury while working at home in the same way as at work. Your manager checks in regularly about your wellbeing and workload.',
  ],
  [
    'Reviewing the arrangement',
    'You or your manager can ask to review the arrangement at any time. Either side gives four weeks notice of a change, except in an emergency, such as a site closure.',
  ],
  [
    'Ending hybrid working',
    'If hybrid working no longer meets the needs of the role, your manager explains why in writing and you can appeal under the flexible working procedure.',
  ],
  [
    'Data protection',
    'The company processes information about your working pattern and equipment for workforce planning and asset management, as described in the data protection notice for staff.',
  ],
  [
    'Agreement',
    'By signing you confirm that you have read this agreement and agree to work under it. The company countersigns to confirm the arrangement.',
  ],
] as const;
const HYBRID_BODY = HYBRID_SECTIONS.flatMap(([h, body], i) => [`${i + 1}. ${h}`, body, '']).join('\n');

/** A starter sample (16.9) as the staging workspace's own copy, labelled as a sample. */
const fromSample = (key: string, sampleKey: string) => {
  const s = sampleByKey(sampleKey)!;
  return {
    key,
    name: t(s.locale, `docTpl.samples.${s.key}.name`),
    locale: s.locale,
    category: s.category,
    body: s.body,
    countersign: s.requiresCountersign,
    sample: s.key,
    order: s.signingOrder,
  };
};

const TEMPLATES: Array<{
  key: string;
  name: string;
  locale: string;
  category: string;
  body: string;
  /** The company countersigns documents from this template (ADR-0169). */
  countersign: boolean;
  /** A copy of a starter sample (ADR-0194). */
  sample?: string;
  order?: string;
}> = [
  {
    key: 'offer_uk',
    name: 'Offer letter (UK)',
    locale: 'en-GB',
    category: 'offer',
    countersign: true,
    body: 'Dear {{employee.firstName}},\n\nWe are delighted to offer you the role of {{employee.jobTitle}} in {{employee.department}} at {{entity.name}}, based at {{employee.location}}, starting on {{employee.startDate}}.\n\nYour salary will be {{employee.salary}} ({{employee.payFrequency}}).\n\nThis is a fictional sample letter generated for the staging environment.\n\n{{company.name}}\n{{today}}',
  },
  fromSample('contract_uk', 'uk_statement'),
  fromSample('contract_ie', 'ie_statement'),
  {
    key: 'variation',
    name: 'Change of terms letter',
    locale: 'en-GB',
    category: 'letter',
    countersign: false,
    body: 'Dear {{employee.firstName}},\n\nThis letter confirms a change to your terms: your role is {{employee.jobTitle}} and your pay is {{employee.salary}} ({{employee.payFrequency}}). Please sign to confirm you agree.\n\nFictional sample letter.\n\n{{company.name}}, {{today}}',
  },
  fromSample('offer_us', 'us_offer'),
  {
    key: 'hybrid',
    name: 'Hybrid working agreement',
    locale: 'en-GB',
    category: 'policy',
    countersign: true,
    body: `Employee: {{employee.displayName}} ({{employee.employeeNumber}})\nRole: {{employee.jobTitle}}, {{employee.department}}\nPlace of work: {{employee.location}}\n\n${HYBRID_BODY}\n{{company.name}}, {{today}}`,
  },
  {
    key: 'ppe',
    name: 'Personal protective equipment acknowledgement',
    locale: 'en-GB',
    category: 'policy',
    countersign: true,
    body: 'I, {{employee.displayName}}, confirm that I have received safety boots, a hi-vis vest and gloves, that I have been shown how to use them, and that I will wear them in the yard and the warehouse.\n\nThe company countersigns to confirm the issue.\n\nFictional sample document for the staging environment.\n\n{{company.name}}, {{today}}',
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
      requires_countersign: x.countersign,
      sample_key: x.sample ?? null,
      signing_order: x.order ?? 'employee_first',
    })),
  );
  // the samples' ask-when-sending fields are part of their first version (labels in the workspace's language)
  for (const x of TEMPLATES.filter((y) => y.sample)) {
    const s = sampleByKey(x.sample!)!;
    await tx.exec(
      `INSERT INTO app.document_template_versions (tenant_id, template_id, version, name, locale, category, body, ask_fields, requires_countersign, signing_order)
       VALUES (app.current_tenant(), $1, 1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [
        tpl[x.key],
        x.name,
        x.locale,
        x.category,
        x.body,
        JSON.stringify(
          s.askFields.map((a) => ({ ...a, label: t(s.locale, `docTpl.samples.${s.key}.ask.${a.key}`) })),
        ),
        x.countersign,
        x.order ?? 'employee_first',
      ],
    );
  }
  // documents generated by the documents service (merge fields from the employee record) with signatures
  const deps = { objects: ctx.objects } as Pick<Deps, 'objects'> as Deps;
  const hr = ids.user.hr_admin;
  // the values HR types in when sending a sample (fictional)
  const askValues = (p: PlanPerson) => ({
    continuousEmployment: formatDate(p.startDate, 'en-GB', 'long'),
    normalHours: '09:00 to 17:30, Monday to Friday',
    respondBy: formatDate(addDays(p.startDate, -14), 'en-US', 'long'),
  });
  const generate = async (p: PlanPerson, key: string, sign: boolean, title?: string) =>
    generateFromTemplate(deps, tx, tpl[key]!, ids.employee[p.idx]!, hr, {
      requireSignature: sign,
      values: askValues(p),
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
    // contracts need the company's signature: HR countersigned them a day later (completed, both signatures)
    await signRequest(
      ctx,
      docId,
      p,
      compareDates(p.startDate, addDays(anchor, -60)) > 0 ? addDays(p.startDate, -5) : addDays(anchor, -45),
      { countersignBy: hr },
    );
    signed++;
  }
  // The employee login sees a document in every state: two waiting for their signature (a one-page letter and a
  // multi-page agreement), one they signed that waits for HR's countersignature, and their completed contract.
  const emp = plan.people[plan.logins.employee]!;
  await generate(emp, 'variation', true, 'Change of terms: shift allowance');
  await generate(emp, 'hybrid', true);
  const ppe = await generate(emp, 'ppe', true);
  await signRequest(ctx, ppe, emp, addDays(anchor, -2));
  const mgr = plan.people[plan.logins.manager]!;
  const v = await generate(mgr, 'variation', true, 'Change of terms: team leader allowance');
  await signRequest(ctx, v, mgr, addDays(anchor, -20));
  ctx.counts.documents = files.length + licences.length + starters.length + signedPeople.length * 2 + 6;
  ctx.counts.signedDocuments = signed + 1;
  ctx.counts.awaitingCountersignature = 1;
  bump(ctx, 'documentTemplates', TEMPLATES.length);
}

/**
 * Signs a pending signature request as the signature route does (certificate page appended). A document without a
 * countersignature is complete at once; one with a countersignature goes to HR through the approvals service, and
 * with `countersignBy` HR countersigns it a day later (second certificate, completed copy).
 */
async function signRequest(
  ctx: SeedCtx,
  documentId: string,
  p: PlanPerson,
  on: string,
  opts: { countersignBy?: string } = {},
) {
  const { tx, ids } = ctx;
  const sr = await tx.one<{
    id: string;
    file_key: string;
    title: string;
    requires_countersign: boolean;
    fields: SignatureField[] | null;
  }>(
    `SELECT s.id, coalesce(s.original_file_key, d.file_key) AS file_key, d.title, s.requires_countersign, s.fields FROM app.signature_requests s JOIN app.documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id WHERE s.document_id = $1`,
    [documentId],
  );
  const original = await ctx.objects.get(sr.file_key);
  const documentSha256 = sha256(original);
  const signedAt = `${on}T11:20:00Z`;
  const name = `${p.preferred ?? p.first} ${p.last}`;
  // the signature goes into the document's signature block, as the signing route stamps it (ADR-0197)
  const stamped = sr.fields?.length
    ? await stampSignature(original, sr.fields, 'employee', {
        method: 'typed',
        name,
        date: formatDate(on, 'en-GB', 'long'),
        reference: t('en-GB', 'docPdf.ref', { id: sr.id }),
      })
    : original;
  const signedPdf = Buffer.from(
    await appendCertificate(stamped, {
      signerName: name,
      signerEmail: p.workEmail,
      signedAtUtc: signedAt,
      ip: '192.0.2.10', // documentation address range (RFC 5737), not a real client
      userAgent: 'Thapsus-HR staging seed',
      documentSha256,
      requestId: sr.id,
      labels: certificateLabels('en-GB', 'certificate'),
    }),
  );
  const signedKey = `${ctx.tenantId}/employees/${ids.employee[p.idx]}/${seedUuid('signed', sr.id)}.pdf`;
  await ctx.objects.put(signedKey, signedPdf, 'application/pdf');
  const signedSha256 = sha256(signedPdf);
  const signedDoc = sr.requires_countersign
    ? null
    : await tx.one<{ id: string }>(
        `INSERT INTO app.documents (tenant_id, employee_id, title, category, file_key, file_name, content_type, size_bytes, sha256, status, uploaded_at, created_at)
         VALUES (app.current_tenant(), $1, $2, 'signed', $3, $4, 'application/pdf', $5, $6, 'ready', $7, $7) RETURNING id`,
        [
          ids.employee[p.idx],
          t('en-GB', 'docSign.signedTitle', { title: sr.title }),
          signedKey,
          `${sr.title.replace(/[^\w.-]+/g, '_')}_signed.pdf`,
          signedPdf.length,
          signedSha256,
          signedAt,
        ],
      );
  const user = p.login ? ids.user[p.login] : null;
  await addEvent(tx, {
    requestId: sr.id,
    employeeId: ids.employee[p.idx]!,
    kind: 'employee_signed',
    actorUserId: p.login ? ids.user[p.login] : null,
    actorName: name,
    fileKey: signedKey,
    sha256: signedSha256,
    detail: { method: 'typed', documentSha256, source: 'staging_seed' },
    at: signedAt,
  });
  if (signedDoc)
    await addEvent(tx, {
      requestId: sr.id,
      employeeId: ids.employee[p.idx]!,
      kind: 'completed',
      fileKey: signedKey,
      sha256: signedSha256,
      at: signedAt,
    });
  await tx.exec(`UPDATE app.signature_events SET at = $2 WHERE signature_request_id = $1 AND kind = 'sent'`, [
    sr.id,
    `${addDays(on, -3)}T09:00:00Z`,
  ]);
  await tx.exec(
    `UPDATE app.signature_requests SET status = 'signed', signed_at = $2, signer_user_id = $3, signer_name = $4, signer_ip = '192.0.2.10', signer_user_agent = 'Thapsus-HR staging seed',
            document_sha256 = $5, signed_file_key = $6, signed_sha256 = $7, requested_at = $8, completed_at = $9, signed_document_id = $10,
            employee_signed_file_key = $6, employee_signed_sha256 = $7, signature_method = 'typed' WHERE id = $1`,
    [
      sr.id,
      signedAt,
      user,
      name,
      documentSha256,
      signedKey,
      signedSha256,
      `${addDays(on, -3)}T09:00:00Z`,
      signedDoc ? signedAt : null,
      signedDoc?.id ?? null,
    ],
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
    diff: { documentSha256, signedSha256, source: 'staging_seed', countersign: sr.requires_countersign },
  });
  if (!sr.requires_countersign) return;
  const approvalId = await requestCountersign(
    tx,
    { id: sr.id, document_id: documentId, title: sr.title, signer_employee_id: ids.employee[p.idx]! },
    user,
  );
  await tx.exec(`UPDATE app.approval_requests SET created_at = $2 WHERE id = $1`, [approvalId, signedAt]);
  if (!opts.countersignBy) return;
  // HR countersigns the next day, as the countersign route records it
  const at = `${addDays(on, 1)}T10:05:00Z`;
  const countersigner = user === opts.countersignBy ? ids.user.owner : opts.countersignBy;
  const hrName = (
    await tx.one<{ display_name: string }>('SELECT display_name FROM app.users WHERE id = $1', [
      countersigner,
    ])
  ).display_name;
  await tx.exec(
    `UPDATE app.signature_requests SET countersigner_user_id = $2, countersigner_name = $3, countersigner_ip = '192.0.2.20', countersigner_user_agent = 'Thapsus-HR staging seed', countersigned_at = $4 WHERE id = $1`,
    [sr.id, countersigner, hrName, at],
  );
  registerCountersignEffects({ objects: ctx.objects, now: () => new Date(at) });
  // nobody approves their own request: the HR admin's own contract was countersigned by the owner
  const approver = countersigner;
  if (approver !== opts.countersignBy)
    await tx.exec(
      `UPDATE app.approval_steps SET approver_user_ids = array_append(approver_user_ids, $2) WHERE request_id = $1 AND NOT ($2 = ANY(approver_user_ids))`,
      [approvalId, approver],
    );
  await decide(tx, approvalId, approver, 'approve');
  await tx.exec(`UPDATE app.approval_steps SET decided_at = $2 WHERE request_id = $1`, [approvalId, at]);
  await tx.exec(`UPDATE app.approval_requests SET decided_at = $2 WHERE id = $1`, [approvalId, at]);
  await tx.exec(`UPDATE app.tasks SET completed_at = $2 WHERE source = 'approval' AND source_id = $1`, [
    approvalId,
    at,
  ]);
  await tx.exec(
    `UPDATE app.documents SET created_at = $2, uploaded_at = $2 WHERE id = (SELECT signed_document_id FROM app.signature_requests WHERE id = $1)`,
    [sr.id, at],
  );
  await tx.exec(`UPDATE app.notifications SET read_at = $2 WHERE dedupe_key LIKE $1`, [
    `appr:${approvalId}:%`,
    at,
  ]);
}
