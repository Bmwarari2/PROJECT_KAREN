import { addDays } from '@thapsus/core/time';
import { writeAudit } from '@thapsus/db';
import {
  applySectionChange,
  refreshCurrentMany,
  replaceContacts,
  setCustomFields,
  setManager,
} from '../../../modules/employees/service';
import { bulkCreateEmployees, bulkLinkManagers } from '../../../modules/imports/bulk';
import { insertRows, seedUuid, type SeedCtx } from '../context';
import { DEPARTMENTS, ENTITIES, LOCATIONS, currentJob, type JobRecord, type PlanPerson } from '../plan';

/** Legal entities, locations, departments, cost centres, grades and open positions. */
export async function seedOrganisation(ctx: SeedCtx) {
  const { tx, ids } = ctx;
  for (const e of ENTITIES) {
    ids.entity[e.key] = seedUuid('entity', e.key);
  }
  await insertRows(
    tx,
    'app.legal_entities',
    ENTITIES.map((e) => ({
      id: ids.entity[e.key],
      name: e.name,
      country: e.country,
      region_code: e.regionCode,
      registration_number: e.registrationNumber,
      currency: e.currency,
      time_zone: e.timeZone,
      address: e.address,
    })),
  );
  for (const l of LOCATIONS) ids.location[l.key] = seedUuid('location', l.key);
  await insertRows(
    tx,
    'app.locations',
    LOCATIONS.map((l) => ({
      id: ids.location[l.key],
      name: l.name,
      entity_id: ids.entity[l.entity],
      country: l.country,
      region_code: l.regionCode,
      time_zone: l.timeZone,
      address: l.address,
    })),
  );
  for (const d of DEPARTMENTS) ids.dept[d.key] = seedUuid('dept', d.key);
  // parents first (the self-referencing foreign key)
  const ordered = [...DEPARTMENTS].sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
  await insertRows(
    tx,
    'app.departments',
    ordered.map((d) => ({
      id: ids.dept[d.key],
      name: d.name,
      code: d.code,
      parent_id: d.parent ? ids.dept[d.parent] : null,
    })),
  );
  const centres = DEPARTMENTS.map((d) => ({
    code: `UK-${d.code}`,
    name: `${d.name} (UK)`,
    entity: 'uk' as const,
  })).concat([
    { code: 'IE-GEN', name: 'Ireland', entity: 'ie' as never },
    { code: 'US-GEN', name: 'United States', entity: 'us' as never },
  ]);
  for (const c of centres) ids.costCentre[c.code] = seedUuid('cost-centre', c.code);
  await insertRows(
    tx,
    'app.cost_centres',
    centres.map((c) => ({
      id: ids.costCentre[c.code],
      code: c.code,
      name: c.name,
      entity_id: ids.entity[c.entity],
    })),
  );
  // salary grades (company pay structure, GBP)
  const grades: Array<[code: string, name: string, min: number, max: number]> = [
    ['G1', 'Grade 1: entry', 2_400_000, 3_200_000],
    ['G2', 'Grade 2: professional', 3_000_000, 4_500_000],
    ['G3', 'Grade 3: senior professional', 4_200_000, 6_500_000],
    ['G4', 'Grade 4: lead', 5_500_000, 8_500_000],
    ['G5', 'Grade 5: head of', 7_500_000, 11_000_000],
    ['G6', 'Grade 6: executive', 10_000_000, 20_000_000],
  ];
  for (const [code] of grades) ids.grade[code] = seedUuid('grade', code);
  await insertRows(
    tx,
    'app.grades',
    grades.map(([code, name, min, max]) => ({
      id: ids.grade[code],
      code,
      name,
      currency: 'GBP',
      min_minor: min,
      max_minor: max,
    })),
  );
  // open and frozen positions (vacancies)
  await insertRows(tx, 'app.positions', [
    {
      title: 'Senior software engineer',
      department_id: ids.dept.engineering,
      grade_id: ids.grade.G3,
      entity_id: ids.entity.uk,
      location_id: ids.location.LON,
      headcount: 2,
      status: 'open',
    },
    {
      title: 'Warehouse operative',
      department_id: ids.dept.logistics,
      grade_id: null,
      entity_id: ids.entity.uk,
      location_id: ids.location.MAN,
      headcount: 3,
      status: 'open',
    },
    {
      title: 'Customer support specialist',
      department_id: ids.dept.support,
      grade_id: ids.grade.G1,
      entity_id: ids.entity.uk,
      location_id: ids.location.EDI,
      headcount: 2,
      status: 'open',
    },
    {
      title: 'Account executive',
      department_id: ids.dept.sales,
      grade_id: ids.grade.G2,
      entity_id: ids.entity.us,
      location_id: ids.location.NYC,
      headcount: 1,
      status: 'open',
    },
    {
      title: 'Head of data',
      department_id: ids.dept.engineering,
      grade_id: ids.grade.G5,
      entity_id: ids.entity.uk,
      location_id: ids.location.LON,
      headcount: 1,
      status: 'frozen',
    },
  ]);
  ctx.counts.legalEntities = ENTITIES.length;
  ctx.counts.locations = LOCATIONS.length;
  ctx.counts.departments = DEPARTMENTS.length;
}

const gradeFor = (p: PlanPerson, j: JobRecord) => {
  if (j.hourly || p.entity !== 'uk') return null;
  if (p.level === 'exec') return 'G6';
  if (p.level === 'lead') return /^Head of|General counsel|manager$/i.test(j.title) ? 'G5' : 'G4';
  if (/^Senior|Legal counsel|Product manager|Security engineer|Data engineer/.test(j.title)) return 'G3';
  if (/Receptionist|clerk|coordinator|associate|Customer support specialist/i.test(j.title)) return 'G1';
  return 'G2';
};

function jobValues(ctx: SeedCtx, p: PlanPerson, j: JobRecord) {
  const { ids } = ctx;
  const loc = LOCATIONS.find((l) => l.key === j.location)!;
  const grade = gradeFor(p, j);
  return {
    jobTitle: j.title,
    departmentId: ids.dept[p.dept],
    locationId: ids.location[j.location],
    entityId: ids.entity[loc.entity],
    costCentreId:
      ids.costCentre[
        p.entity === 'uk'
          ? `UK-${DEPARTMENTS.find((d) => d.key === p.dept)!.code}`
          : p.entity === 'ie'
            ? 'IE-GEN'
            : 'US-GEN'
      ],
    gradeId: grade ? ids.grade[grade] : null,
    employmentType: j.employmentType,
    fte: j.fte,
    weeklyHours: j.weeklyHours,
    workPattern: j.pattern,
    flsaStatus: p.flsa,
  };
}

/**
 * Employees with effective-dated personal, job, pay and contract records, the manager tree, emergency
 * contacts and custom fields. Existing staff are created the way the bulk import creates them (the
 * import's set-based service functions: no `employee.created` events, so the worker does not start
 * onboarding for people hired years ago); later history is applied through the same effective-dated
 * change functions the API uses.
 */
export async function seedPeople(ctx: SeedCtx) {
  const { tx, plan, ids } = ctx;
  const rows = plan.people.map((p) => {
    const first = p.jobs[0]!;
    const pay = p.pay[0]!;
    return {
      employeeNumber: p.number,
      startDate: p.startDate,
      workEmail: p.workEmail,
      legalFirstName: p.first,
      legalLastName: p.last,
      preferredName: p.preferred,
      pronouns: p.pronouns,
      dateOfBirth: p.dateOfBirth,
      personalEmail: p.personalEmail,
      personalPhone: p.personalPhone,
      address: p.address,
      nationality: p.nationality,
      ...jobValues(ctx, p, first),
      payAmountMinor: pay.amountMinor,
      payCurrency: p.currency,
      payFrequency: pay.frequency,
      contractType: p.contract.type,
      noticePeriodDays: p.contract.noticeDays,
      probationEndDate: p.contract.probationEnd,
    };
  });
  const created = await bulkCreateEmployees(tx, rows, null);
  ids.employee = plan.people.map((p) => created.get(p.number)!);
  // work phones (not part of the bulk path)
  const phones = plan.people.filter((p) => p.workPhone);
  await tx.exec(
    `UPDATE app.employees e SET work_phone = u.phone FROM unnest($1::uuid[], $2::text[]) AS u(id, phone) WHERE e.id = u.id`,
    [phones.map((p) => ids.employee[p.idx]), phones.map((p) => p.workPhone)],
  );
  // later job and pay history (promotions, relocations, annual pay reviews) in date order per person
  for (const p of plan.people) {
    const id = ids.employee[p.idx]!;
    for (const j of p.jobs.slice(1))
      await applySectionChange(tx, id, 'job', j.from, jobValues(ctx, p, j), null);
    for (const pay of p.pay.slice(1))
      await applySectionChange(
        tx,
        id,
        'pay',
        pay.from,
        { payAmountMinor: pay.amountMinor, payCurrency: p.currency, payFrequency: pay.frequency },
        null,
      );
  }
  // pay records carry the reason shown in the history (the change function has no reason parameter)
  const reasons = plan.people.flatMap((p) =>
    p.pay.map((x) => ({ id: ids.employee[p.idx]!, from: x.from, reason: x.reason ?? null })),
  );
  await tx.exec(
    `UPDATE app.employee_pay ep SET reason = u.reason FROM unnest($1::uuid[], $2::date[], $3::text[]) AS u(id, f, reason) WHERE ep.employee_id = u.id AND ep.valid_from = u.f`,
    [reasons.map((r) => r.id), reasons.map((r) => r.from), reasons.map((r) => r.reason)],
  );
  const jobReasons = plan.people.flatMap((p) =>
    p.jobs
      .filter((j) => j.reason)
      .map((j) => ({ id: ids.employee[p.idx]!, from: j.from, reason: j.reason! })),
  );
  if (jobReasons.length)
    await tx.exec(
      `UPDATE app.employee_jobs ej SET reason = u.reason FROM unnest($1::uuid[], $2::date[], $3::text[]) AS u(id, f, reason) WHERE ej.employee_id = u.id AND ej.valid_from = u.f`,
      [jobReasons.map((r) => r.id), jobReasons.map((r) => r.from), jobReasons.map((r) => r.reason)],
    );
  // manager tree (solid lines from each person's first day), in bulk like the import
  const links = plan.people
    .filter((p) => p.managerIdx !== null)
    .map((p) => ({
      employeeId: ids.employee[p.idx]!,
      managerId: ids.employee[p.managerIdx!]!,
      date: p.startDate,
    }));
  const { rest } = await bulkLinkManagers(tx, links, null);
  for (const l of rest) await setManager(tx, l.employeeId, l.managerId, l.date, 'solid', null);
  // dotted lines: payroll also reports to the head of people operations; health and safety to the COO
  const byTitle = (title: string) =>
    plan.people.find((p) => p.kind === 'roster' && currentJob(p, ctx.anchor).title === title);
  for (const [who, to] of [
    ['Payroll manager', 'Head of people operations'],
    ['Health and safety advisor', 'Chief operating officer'],
    ['Security engineering manager', 'Chief financial officer'],
  ] as const) {
    const a = byTitle(who);
    const b = byTitle(to);
    if (a && b) await setManager(tx, ids.employee[a.idx]!, ids.employee[b.idx]!, ctx.anchor, 'dotted', null);
  }
  // future-dated changes (promotion next month, a transfer, a change of hours)
  for (const c of plan.futureChanges) {
    const p = plan.people[c.personIdx]!;
    const id = ids.employee[p.idx]!;
    const base = currentJob(p, c.effectiveDate);
    const next: JobRecord = { ...base, ...c.job, from: c.effectiveDate, reason: c.reason };
    await applySectionChange(tx, id, 'job', c.effectiveDate, { ...jobValues(ctx, p, next) }, null);
    await tx.exec('UPDATE app.employee_jobs SET reason = $3 WHERE employee_id = $1 AND valid_from = $2', [
      id,
      c.effectiveDate,
      c.reason,
    ]);
    if (c.payAmountMinor)
      await applySectionChange(
        tx,
        id,
        'pay',
        c.effectiveDate,
        { payAmountMinor: c.payAmountMinor, payCurrency: p.currency, payFrequency: 'annual' },
        null,
      );
    if (c.managerIdx !== undefined)
      await setManager(tx, id, ids.employee[c.managerIdx]!, c.effectiveDate, 'solid', null);
  }
  // leavers: the termination route's effect (end date, leaver type, open records closed the day after)
  for (const p of plan.people.filter((x) => x.endDate)) {
    const id = ids.employee[p.idx]!;
    await tx.exec('UPDATE app.employees SET end_date = $2, leaver_type = $3 WHERE id = $1', [
      id,
      p.endDate,
      p.leaverType,
    ]);
    const closeOn = addDays(p.endDate!, 1);
    for (const t of [
      'app.employee_jobs',
      'app.employee_pay',
      'app.employee_contracts',
      'app.reporting_lines',
    ])
      await tx.exec(
        `UPDATE ${t} SET valid_to = $2 WHERE employee_id = $1 AND (valid_to IS NULL OR valid_to > $2) AND valid_from < $2`,
        [id, closeOn],
      );
    await writeAudit(tx, {
      actorType: 'system',
      action: 'employee.terminated',
      targetType: 'employee',
      targetId: id,
      diff: { endDate: p.endDate, reason: p.leaverReason, leaverType: p.leaverType, source: 'staging_seed' },
    });
  }
  // emergency contacts (effective-dated list) and custom fields
  for (const p of plan.people)
    await replaceContacts(
      tx,
      ids.employee[p.idx]!,
      p.startDate,
      p.emergency.map((c, i) => ({
        name: c.name,
        relationship: c.relationship,
        phone: c.phone,
        priority: i + 1,
      })),
      null,
    );
  await insertRows(
    tx,
    'app.custom_field_definitions',
    [
      {
        key: 'tShirtSize',
        label: { 'en-GB': 'T-shirt size', 'en-US': 'T-shirt size' },
        field_type: 'select',
        options: [{ value: 'S' }, { value: 'M' }, { value: 'L' }, { value: 'XL' }],
      },
      {
        key: 'parkingPermit',
        label: { 'en-GB': 'Car park permit', 'en-US': 'Parking permit' },
        field_type: 'boolean',
        options: [],
      },
    ],
    { json: ['options'] },
  );
  for (const p of plan.people) {
    const values: Record<string, unknown> = {};
    if (p.tShirt) values.tShirtSize = p.tShirt;
    if (p.parking !== null) values.parkingPermit = p.parking;
    if (Object.keys(values).length)
      await setCustomFields(tx, ids.employee[p.idx]!, values, p.startDate, null);
  }
  await refreshCurrentMany(tx, ids.employee);
  // one audit entry per person, as an import records what it created (system actor, no personal values)
  await insertRows(
    tx,
    'audit.events',
    plan.people.map((p) => ({
      actor_type: 'system',
      action: 'employee.created',
      target_type: 'employee',
      target_id: ids.employee[p.idx],
      diff: { startDate: p.startDate, source: 'staging_seed' },
    })),
  );
  ctx.counts.employees = plan.people.length;
  ctx.counts.jobRecords = plan.people.reduce((a, p) => a + p.jobs.length, 0) + plan.futureChanges.length;
  ctx.counts.payRecords = plan.people.reduce((a, p) => a + p.pay.length, 0);
}
