import { addDays, addMonths, compareDates, dateParts, daysBetween } from '@thapsus/core/time';
import { renderTextPdf } from '../../../modules/documents/pdf';
import {
  i9Deadlines,
  i9Reverification,
  recordExpiry,
  rtwFollowUp,
  gpgDates,
  type Eeo1Rule,
  type I9CompletionRule,
  type RtwDocumentRules,
  type RtwListType,
} from '../../../modules/compliance/engine';
import { complianceSettings } from '../../../modules/compliance/service';
import { prng } from '../../fixtures';
import { bump, insertRows, mapLimit, seedUuid, type SeedCtx } from '../context';
import { currentJob, currentPay, employedOn, locationOf, ruleAtOrFirst, type PlanPerson } from '../plan';

const EU = new Set(['PL', 'ES', 'FR', 'IT', 'RO', 'PT', 'DE', 'NL']);
const ruleSource = (r: {
  source: unknown;
  verifiedOn: string;
  packVersion: number;
  effectiveFrom: string;
}) => ({
  ...(r.source as object),
  verifiedOn: r.verifiedOn,
  packVersion: r.packVersion,
  effectiveFrom: r.effectiveFrom,
});
const target = (ctx: SeedCtx, p: PlanPerson) => ({
  employeeId: ctx.ids.employee[p.idx]!,
  entityId: ctx.ids.entity[p.entity],
  country: locationOf(currentJob(p, ctx.anchor).location).country,
  managerChain: [] as string[],
});

/**
 * Compliance centre data: UK right-to-work checks (details and some evidence in the vault), US Form I-9
 * records, the licence/training matrix, FLSA exemption attestations, EEO-1 job categories, the sex used for
 * pay-gap reporting and EEO-1 self-identification (both only in the vault, encrypted through the regional
 * key provider) and pay-report inputs for the UK gender pay gap and EU pay transparency. Every deadline,
 * threshold and list comes from the jurisdiction packs through the compliance calculators.
 */
export async function seedCompliance(ctx: SeedCtx) {
  const { tx, book, plan, ids, anchor } = ctx;
  const r = prng(424_246);
  const settings = await complianceSettings(tx);
  const audits: Array<Record<string, unknown>> = [];

  // ---- UK right to work -------------------------------------------------------------------------------------
  const uk = plan.people.filter((p) => p.entity === 'uk');
  const upcomingUk = uk.filter((p) => p.kind === 'upcoming_starter');
  let rtw = 0;
  const evidenceFor = new Set(
    plan.people.filter((p) => p.managerIdx === plan.logins.manager || p.login).map((p) => p.idx),
  );
  const evidence: Array<{ p: PlanPerson; checkId: string; key: string; body: Buffer; name: string }> = [];
  for (const p of uk) {
    if (p === upcomingUk.at(-1)) continue; // one joiner's check is still to do (shows as missing)
    const loc = locationOf(p.jobs[0]!.location);
    const jurisdiction = loc.regionCode;
    const before = addDays(p.startDate, -(3 + (p.idx % 8)));
    const checkedOn = compareDates(before, anchor) < 0 ? before : addDays(anchor, -1);
    const rule = ruleAtOrFirst<RtwDocumentRules>(
      book,
      jurisdiction,
      'right_to_work.document_rules',
      checkedOn,
    );
    let listType: RtwListType = 'list_a';
    let method = 'manual_document_check';
    let documentType: string | null =
      p.nationality === 'IE'
        ? 'passport_or_passport_card_irish_citizen_current_or_expired'
        : 'passport_british_citizen_current_or_expired';
    let permissionExpiresOn: string | null = null;
    if (p.nationality !== 'GB' && p.nationality !== 'IE') {
      method = 'home_office_online_check';
      documentType = null;
      const timeLimited = !EU.has(p.nationality) || p.idx % 3 === 0;
      listType = timeLimited ? 'online_time_limited' : 'online_unlimited';
      if (timeLimited) {
        // permissions ending at different times: one lapsed, one due for a follow-up soon, the rest later
        const k = rtw % 7;
        permissionExpiresOn =
          k === 0 ? addDays(anchor, -5) : k === 1 ? addDays(anchor, 40) : addDays(anchor, 200 + 90 * k);
      }
    }
    if (!rule.value.listTypes.includes(listType)) continue;
    const fu = rtwFollowUp(rule.value, { listType, checkedOn, permissionExpiresOn });
    const id = seedUuid('rtw', p.number);
    await insertRows(tx, 'app.rtw_checks', [
      {
        id,
        employee_id: ids.employee[p.idx],
        jurisdiction: rule.jurisdiction,
        check_method: method,
        list_type: listType,
        checked_on: checkedOn,
        checked_by: null,
        permission_expires_on: permissionExpiresOn,
        pvn_date: null,
        excuse: fu.excuse,
        excuse_ends_on: fu.excuseEndsOn,
        follow_up_due_on: fu.followUpDueOn,
        rule_source: ruleSource(rule),
        created_at: `${checkedOn}T10:00:00Z`,
      },
    ]);
    const details = {
      documentType,
      documentReference: documentType ? `SAMPLE-${String(100000 + p.idx)}` : null,
      shareCode: method === 'home_office_online_check' ? `FAKE${String(p.idx).padStart(5, '0')}` : null,
    };
    const vid = await ctx.vault.put(
      tx,
      ctx.system,
      ctx.tenantId,
      target(ctx, p),
      'immigration',
      `rtw_details:${id}`,
      JSON.stringify(details),
    );
    await tx.exec('UPDATE app.rtw_checks SET details_vault_id = $2 WHERE id = $1', [id, vid]);
    if (evidenceFor.has(p.idx)) {
      const pdf = await renderTextPdf(
        'Right to work check (fictional sample)',
        `Fictional evidence generated for the Thapsus-HR staging environment.\nEmployee: ${p.number}\nChecked on: ${checkedOn}\nMethod: ${method}\nList: ${listType}`,
      );
      evidence.push({
        p,
        checkId: id,
        key: `${ctx.tenantId}/vault/immigration/${ids.employee[p.idx]}/${seedUuid('rtw-evidence', p.number)}.pdf`,
        body: Buffer.from(pdf),
        name: `right-to-work-${p.number}.pdf`,
      });
    }
    audits.push({
      actor_type: 'system',
      action: 'compliance.rtw_check_recorded',
      target_type: 'employee',
      target_id: ids.employee[p.idx],
      diff: { checkId: id, method, listType, checkedOn, followUpDueOn: fu.followUpDueOn },
      sensitive: true,
    });
    rtw++;
  }
  await mapLimit(evidence, 8, (e) => ctx.objects.put(e.key, e.body, 'application/pdf'));
  for (const e of evidence) {
    const vid = await ctx.vault.put(
      tx,
      ctx.system,
      ctx.tenantId,
      target(ctx, e.p),
      'immigration',
      `rtw_evidence:${e.checkId}`,
      e.name,
      e.key,
    );
    await tx.exec('UPDATE app.rtw_checks SET evidence_vault_id = $2 WHERE id = $1', [e.checkId, vid]);
  }
  ctx.counts.rightToWorkChecks = rtw;

  // ---- US Form I-9 ----------------------------------------------------------------------------------------
  const us = plan.people.filter((p) => p.entity === 'us');
  let i9 = 0;
  for (const [k, p] of us.entries()) {
    const firstDay = p.startDate;
    const completion = ruleAtOrFirst<I9CompletionRule>(book, 'US', 'i9.completion_deadlines', firstDay);
    const retention = ruleAtOrFirst<unknown>(book, 'US', 'i9.retention', firstDay);
    const reverification = ruleAtOrFirst<{ suggestedAdvanceNoticeDays?: number }>(
      book,
      'US',
      'i9.reverification',
      firstDay,
    );
    const dl = i9Deadlines(completion.value, {
      firstDay,
      lastDay: p.endDate,
      businessWeekdays: settings.businessWeekdays,
    });
    const pending = p.kind === 'upcoming_starter';
    // most are citizens; one has employment authorization that ends within the reminder window
    const attestation =
      k === 3 ? 'noncitizen_authorized_to_work' : k === 5 ? 'lawful_permanent_resident' : 'us_citizen';
    const authExpires = attestation === 'noncitizen_authorized_to_work' ? addDays(anchor, 60) : null;
    const rev = i9Reverification(reverification.value, authExpires);
    const id = seedUuid('i9', p.number);
    await insertRows(tx, 'app.i9_records', [
      {
        id,
        employee_id: ids.employee[p.idx],
        first_day_of_employment: firstDay,
        section1_completed_on: pending ? null : addDays(firstDay, -1),
        section2_completed_on: pending
          ? null
          : compareDates(dl.section2DueOn, addDays(firstDay, 1)) >= 0
            ? addDays(firstDay, 1)
            : dl.section2DueOn,
        section2_due_on: dl.section2DueOn,
        work_authorization_expires_on: authExpires,
        reverification_due_on: rev.dueOn,
        rule_source: {
          completion: completion.source,
          retention: retention.source,
          reverification: reverification.source,
          verifiedOn: completion.verifiedOn,
        },
        created_at: `${addDays(firstDay, -1)}T15:00:00Z`,
      },
    ]);
    if (!pending)
      await ctx.vault.put(
        tx,
        ctx.system,
        ctx.tenantId,
        target(ctx, p),
        'immigration',
        `i9_attestation:${id}`,
        attestation,
      );
    audits.push({
      actor_type: 'system',
      action: 'compliance.i9_recorded',
      target_type: 'employee',
      target_id: ids.employee[p.idx],
      diff: { recordId: id, firstDay, section2DueOn: dl.section2DueOn, reverificationDueOn: rev.dueOn },
      sensitive: true,
    });
    i9++;
  }
  ctx.counts.i9Records = i9;

  // ---- licences, certifications and training (compliance matrix) ------------------------------------------
  const reqs: Array<{
    key: string;
    kind: string;
    name: string;
    description: string;
    appliesTo: Record<string, unknown>;
    validity: number | null;
    reminders: number[];
    evidence: boolean;
    cover: number;
  }> = [
    {
      key: 'flt',
      kind: 'licence',
      name: 'Forklift truck operator certificate',
      description: 'Counterbalance and reach truck operation.',
      appliesTo: { jobTitles: ['Forklift driver'] },
      validity: 36,
      reminders: [60, 30, 7],
      evidence: true,
      cover: 1,
    },
    {
      key: 'cpc',
      kind: 'certification',
      name: 'Driver CPC periodic training',
      description: '35 hours of periodic training for professional drivers.',
      appliesTo: { jobTitles: ['Delivery driver'] },
      validity: 60,
      reminders: [90, 30],
      evidence: true,
      cover: 0.9,
    },
    {
      key: 'firstaid',
      kind: 'certification',
      name: 'First aid at work',
      description: 'Designated first aiders on every site.',
      appliesTo: {
        jobTitles: [
          'Warehouse team leader',
          'Night shift team leader',
          'Office manager',
          'Support team leader',
        ],
      },
      validity: 36,
      reminders: [60, 30],
      evidence: true,
      cover: 0.85,
    },
    {
      key: 'security',
      kind: 'training',
      name: 'Information security awareness',
      description: 'Annual e-learning for everyone with a company account.',
      appliesTo: {},
      validity: 12,
      reminders: [30, 7],
      evidence: false,
      cover: 0.88,
    },
    {
      key: 'dbs',
      kind: 'background_check',
      name: 'Basic criminal record check',
      description: 'For roles with access to payroll and finance systems (UK).',
      appliesTo: { departmentIds: [ids.dept.finance], countries: ['GB'] },
      validity: null,
      reminders: [],
      evidence: false,
      cover: 0.9,
    },
  ];
  let records = 0;
  for (const q of reqs) {
    const reqId = seedUuid('requirement', q.key);
    await insertRows(tx, 'app.compliance_requirements', [
      {
        id: reqId,
        kind: q.kind,
        name: q.name,
        description: q.description,
        applies_to: q.appliesTo,
        validity_months: q.validity,
        reminder_days: q.reminders,
        evidence_required: q.evidence,
        active: true,
      },
    ]);
    const applies = plan.people.filter((p) => {
      if (p.kind !== 'roster') return false;
      const j = currentJob(p, anchor);
      const at = q.appliesTo as { jobTitles?: string[]; departmentIds?: string[]; countries?: string[] };
      return (
        (!at.jobTitles || at.jobTitles.includes(j.title)) &&
        (!at.departmentIds || at.departmentIds.includes(ids.dept[p.dept])) &&
        (!at.countries || at.countries.includes(locationOf(j.location).country))
      );
    });
    const rows = applies
      .filter(() => r() < q.cover)
      .map((p) => {
        const months = q.validity ?? 24;
        // spread issue dates so a few have lapsed and a few are about to
        const issuedOn = addDays(anchor, -Math.floor(r() * months * 30.4));
        const iss = compareDates(issuedOn, p.startDate) < 0 ? p.startDate : issuedOn;
        return {
          requirement_id: reqId,
          employee_id: ids.employee[p.idx],
          issued_on: iss,
          expires_on: recordExpiry({ validityMonths: q.validity }, { issuedOn: iss, expiresOn: null }),
          reference:
            q.kind === 'licence' || q.kind === 'certification'
              ? `FICT-${q.key.toUpperCase()}-${p.number}`
              : null,
          status: 'active',
          notes: null,
          created_at: `${iss}T12:00:00Z`,
        };
      });
    // one forklift certificate has already lapsed
    if (q.key === 'flt' && rows[0]) {
      rows[0].issued_on = addMonths(anchor, -37);
      rows[0].expires_on = recordExpiry(
        { validityMonths: q.validity },
        { issuedOn: rows[0].issued_on, expiresOn: null },
      );
    }
    await insertRows(tx, 'app.compliance_records', rows);
    records += rows.length;
  }
  ctx.counts.complianceRequirements = reqs.length;
  ctx.counts.complianceRecords = records;

  // ---- US: FLSA exemption attestations and EEO-1 ------------------------------------------------------------
  const duties = book.resolve<{ categories: Array<{ id: string; duties: string[] }> }>(
    'US',
    'overtime.exempt_duties_tests',
    anchor,
  ).value;
  const exempt = us.filter((p) => p.flsa === 'exempt' && p.kind === 'roster');
  await insertRows(
    tx,
    'app.flsa_attestations',
    exempt.map((p) => {
      const cat = duties.categories.find(
        (c) => c.id === (p.level === 'member' ? 'administrative' : 'executive'),
      )!;
      return {
        employee_id: ids.employee[p.idx],
        exemption: cat.id,
        duties_attested: cat.duties,
        valid_from: p.startDate,
        attested_by: null,
      };
    }),
  );
  const eeo = book.resolve<Eeo1Rule>('US', 'reporting.eeo1', anchor).value;
  const category = (title: string, level: PlanPerson['level']) =>
    level === 'exec'
      ? 'executive_senior_level_officials_and_managers'
      : level === 'lead'
        ? 'first_mid_level_officials_and_managers'
        : title === 'Account executive'
          ? 'sales_workers'
          : title === 'HR generalist'
            ? 'professionals'
            : 'administrative_support_workers';
  const titles = new Map<string, string>();
  for (const p of us) titles.set(currentJob(p, anchor).title, category(currentJob(p, anchor).title, p.level));
  await insertRows(
    tx,
    'app.eeo_job_categories',
    [...titles]
      .filter(([, c]) => eeo.jobCategories.includes(c))
      .map(([job_title, c]) => ({ job_title, category: c })),
  );
  // voluntary self-identification (vault, eeo): most answered, two declined
  for (const [k, p] of us.filter((x) => x.kind === 'roster').entries()) {
    const declined = k % 7 === 6;
    const value = {
      raceEthnicity: declined
        ? 'declined'
        : eeo.raceEthnicityCategories[(p.idx * 5) % eeo.raceEthnicityCategories.length],
      sex: declined || !p.sex ? 'declined' : p.sex,
      veteranStatus: k % 5 === 0 ? 'protected_veteran' : 'not_protected_veteran',
      disabilityStatus: declined ? 'declined' : k % 6 === 0 ? 'yes' : 'no',
      source: 'self',
    };
    await ctx.vault.put(
      tx,
      ctx.system,
      ctx.tenantId,
      target(ctx, p),
      'eeo',
      'self_identification',
      JSON.stringify(value),
    );
    bump(ctx, 'eeoSelfIdentifications');
  }

  // ---- sex for statutory pay reporting (vault, diversity): UK and Ireland ----------------------------------
  for (const p of plan.people.filter((x) => x.entity !== 'us' && x.sex)) {
    await ctx.vault.put(
      tx,
      ctx.system,
      ctx.tenantId,
      target(ctx, p),
      'diversity',
      'pay_reporting',
      JSON.stringify({ sex: p.sex }),
    );
    bump(ctx, 'payReportingSexRecords');
  }

  // ---- pay-report inputs from payroll: UK gender pay gap and EU pay transparency ----------------------------
  const gpg = book.resolve<{
    snapshotDates: Record<string, { month: number; day: number }>;
    reportingDeadlines: Record<string, { month: number; day: number; yearOffset: number }>;
  }>('GB', 'reporting.gender_pay_gap', anchor).value;
  // the latest snapshot date on or before today
  const year = dateParts(anchor).year;
  let snapshot = gpgDates(gpg, year, settings.gpgSector).snapshotDate;
  if (compareDates(snapshot, anchor) > 0) snapshot = gpgDates(gpg, year - 1, settings.gpgSector).snapshotDate;
  const periodStart = `${snapshot.slice(0, 7)}-01`;
  const periodDays = daysBetween(periodStart, addMonths(periodStart, 1));
  const gpgRows = uk
    .filter((p) => employedOn(p, snapshot) && !p.casual)
    .map((p) => {
      const pay = currentPay(p, snapshot);
      const j = currentJob(p, snapshot);
      const weekly = j.weeklyHours ?? 37.5 * j.fte;
      const monthly =
        pay.frequency === 'annual'
          ? Math.round(pay.amountMinor / 12)
          : Math.round((pay.amountMinor * weekly * 52) / 12);
      return {
        report_kind: 'uk_gpg',
        snapshot_date: snapshot,
        employee_id: ids.employee[p.idx],
        currency: 'GBP',
        ordinary_pay_minor: monthly,
        bonus_in_period_minor: 0,
        pay_period_days: periodDays,
        weekly_hours: weekly,
        bonus_12_months_minor: p.bonus12mMinor,
        full_pay: true,
      };
    });
  await insertRows(tx, 'app.pay_report_inputs', gpgRows);
  const ptSnapshot = `${dateParts(anchor).year - 1}-12-31`;
  const ptRows = plan.people
    .filter((p) => p.entity === 'ie' && employedOn(p, ptSnapshot))
    .map((p) => {
      const pay = currentPay(p, ptSnapshot);
      const j = currentJob(p, ptSnapshot);
      return {
        report_kind: 'eu_pay_transparency',
        snapshot_date: ptSnapshot,
        employee_id: ids.employee[p.idx],
        currency: 'EUR',
        annual_basic_minor: pay.amountMinor,
        annual_variable_minor: p.bonus12mMinor,
        annual_hours: (j.weeklyHours ?? 37.5) * 52,
        worker_category:
          p.dept === 'support' ? 'Customer support' : p.level === 'member' ? 'Sales' : 'Management',
      };
    });
  await insertRows(tx, 'app.pay_report_inputs', ptRows);
  ctx.counts.payReportInputs = gpgRows.length + ptRows.length;
  await insertRows(tx, 'audit.events', audits);
}
