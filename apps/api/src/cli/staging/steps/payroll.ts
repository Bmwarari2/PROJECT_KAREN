import { createHash } from 'node:crypto';
import { formatDate, formatMoney } from '@thapsus/core/i18n';
import { money } from '@thapsus/core/money';
import {
  addDays,
  addMonths,
  compareDates,
  dateParts,
  dayOfWeek,
  makeDate,
  monthsBetween,
} from '@thapsus/core/time';
import { writeAudit } from '@thapsus/db';
import { notify } from '../../../lib/notify';
import { renderTextPdf } from '../../../modules/documents/pdf';
import {
  buildPayrollInputs,
  canonicalJson,
  sectionCounts,
  sha256Hex,
  type PeriodRow,
} from '../../../modules/payroll/inputs';
import { defaultMapping } from '../../../modules/payroll/mapping';
import { createExport, loadConnector, loadPeriod } from '../../../modules/payroll/service';
import { decide as matchFile } from '../../../modules/payslips/matching';
import { checkStatement, storedStatement, type PayslipStatement } from '../../../modules/payslips/statement';
import {
  BONUSES_BY_MONTHS_AGO,
  OVERTIME_HOURS_BY_MONTHS_AGO,
  OVERTIME_RATE_PERCENT,
  SAMPLE_NOTE,
  SAMPLE_PROVIDER_NAME,
  sampleStatement,
  withYearToDate,
} from '../sample-payroll-provider';
import { insertRows, mapLimit, seedUuid, type SeedCtx } from '../context';
import { currentJob, currentPay, employedOn, entityOf, type PlanPerson } from '../plan';

/** The last weekday on or before the 28th: the company's pay day (policy). */
const payDay = (y: number, m: number) => {
  let d = makeDate(y, m, 28);
  while (dayOfWeek(d) > 5) d = addDays(d, -1);
  return d;
};

/**
 * Payroll handoff and payslips: a CSV connector (UK), an Excel connector (Ireland) and the ADP connector
 * (US, a stub, so disabled as the API creates it); monthly UK and Ireland pay periods and semi-monthly US
 * periods, the past ones closed with an immutable input snapshot built by the payroll inputs service, and
 * reproducible exports of the closed UK and Ireland periods. Payslips for the last two UK months and the
 * last Ireland and US periods, and P60s for the last UK tax year, as published batches. Payslip PDFs are
 * fictional samples showing gross pay only: tax and deductions are the payroll provider's (running payroll
 * is out of scope).
 */
export async function seedPayroll(ctx: SeedCtx) {
  const { tx, plan, ids, anchor, book } = ctx;
  const payroll = ids.user.payroll_admin;
  const connectors = [
    { key: 'uk', name: 'UK payroll bureau (CSV)', kind: 'csv', entity: ids.entity.uk, enabled: true },
    { key: 'ie', name: 'Ireland payroll (Excel)', kind: 'excel', entity: ids.entity.ie, enabled: true },
    { key: 'us', name: 'ADP Workforce Now (US)', kind: 'adp', entity: ids.entity.us, enabled: false },
  ];
  for (const c of connectors)
    await tx.exec(
      `INSERT INTO app.payroll_connectors (tenant_id, id, name, kind, entity_id, mapping, delivery, settings, enabled, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, '{}', $7, $8)`,
      [
        seedUuid('connector', c.key),
        c.name,
        c.kind,
        c.entity,
        JSON.stringify(defaultMapping()),
        JSON.stringify({ method: c.kind === 'adp' ? 'api' : 'download' }),
        c.enabled,
        payroll,
      ],
    );
  // ---- pay periods ----------------------------------------------------------------------------------------
  const { year, month } = dateParts(anchor);
  const thisMonth = makeDate(year, month, 1);
  const periods: Array<{
    id: string;
    entity: 'uk' | 'ie' | 'us';
    name: string;
    frequency: string;
    start: string;
    end: string;
    pay: string;
    close: boolean;
  }> = [];
  const monthName = (d: string) => formatDate(d, 'en-GB', 'long').replace(/^\d+ /, '');
  for (const [entity, back] of [
    ['uk', 3],
    ['ie', 1],
  ] as const) {
    for (let k = back; k >= 0; k--) {
      const start = addMonths(thisMonth, -k);
      const { year: y, month: m } = dateParts(start);
      periods.push({
        id: seedUuid('pay-period', `${entity}:${start}`),
        entity,
        name: `${entity === 'uk' ? 'UK' : 'Ireland'} monthly ${monthName(start)}`,
        frequency: 'monthly',
        start,
        end: addDays(addMonths(start, 1), -1),
        pay: payDay(y, m),
        close: k > 0,
      });
    }
  }
  // US semi-monthly: 1st–15th and 16th–end; the last finished half is closed
  const usHalves = [addMonths(thisMonth, -1), thisMonth].flatMap((m) => [
    [m, addDays(m, 14)],
    [addDays(m, 15), addDays(addMonths(m, 1), -1)],
  ]);
  for (const [start, end] of usHalves.filter(([, e]) => compareDates(e!, addDays(anchor, 16)) <= 0).slice(-2))
    periods.push({
      id: seedUuid('pay-period', `us:${start}`),
      entity: 'us',
      name: `US semi-monthly ${start} to ${end}`,
      frequency: 'semi_monthly',
      start: start!,
      end: end!,
      pay: end!,
      close: compareDates(end!, anchor) < 0,
    });
  for (const p of periods)
    await tx.exec(
      `INSERT INTO app.pay_periods (tenant_id, id, entity_id, name, frequency, start_date, end_date, pay_date, created_by, created_at) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        p.id,
        ids.entity[p.entity],
        p.name,
        p.frequency,
        p.start,
        p.end,
        p.pay,
        payroll,
        `${addDays(p.start, -7)}T09:00:00Z`,
      ],
    );
  // close past periods: immutable snapshot of the inputs (the close route), then a reproducible export
  let closed = 0;
  let exports = 0;
  for (const p of periods.filter((x) => x.close)) {
    const row = (await loadPeriod(tx, p.id, true)) as PeriodRow;
    const inputs = await buildPayrollInputs(tx, book, row);
    const sha256 = sha256Hex(canonicalJson(inputs));
    const counts = sectionCounts(inputs);
    const closedAt = `${addDays(p.end, 2)}T16:00:00Z`;
    const snap = await tx.one<{ id: string }>(
      `INSERT INTO app.pay_period_snapshots (tenant_id, period_id, inputs, sha256, counts, created_by, created_at) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [p.id, canonicalJson(inputs), sha256, JSON.stringify(counts), payroll, closedAt],
    );
    await tx.exec(
      `UPDATE app.pay_periods SET status = 'closed', snapshot_id = $2, closed_at = $3, closed_by = $4 WHERE id = $1`,
      [p.id, snap.id, closedAt, payroll],
    );
    await writeAudit(tx, {
      actorType: 'system',
      action: 'pay_period.closed',
      targetType: 'pay_period',
      targetId: p.id,
      diff: { snapshotSha256: sha256, counts },
    });
    closed++;
    if (p.entity === 'us') continue; // the US connector is a stub (not yet implemented)
    const connector = await loadConnector(tx, seedUuid('connector', p.entity));
    const exp = await createExport(
      tx,
      ctx.objects,
      ctx.tenantId,
      book,
      await loadPeriod(tx, p.id),
      connector,
      payroll,
    );
    await tx.exec('UPDATE app.payroll_exports SET created_at = $2 WHERE id = $1', [
      exp.id,
      `${addDays(p.end, 2)}T16:30:00Z`,
    ]);
    exports++;
  }
  ctx.counts.payPeriods = periods.length;
  ctx.counts.payPeriodsClosed = closed;
  ctx.counts.payrollExports = exports;

  // ---- payslips: the sample payroll provider's statements (ADR-0167) -------------------------------------------
  // Twelve monthly UK payslips for the logins and a slice of the roster, the last two months for everyone in the UK,
  // and the last two periods in Ireland and the US. Every deduction comes from the sample provider fixture as it
  // stands (illustrative, never calculated); the batches are flagged as sample data.
  const depts = new Map(
    (await tx.query<{ id: string; name: string }>('SELECT id, name FROM app.departments')).map((d) => [
      d.id,
      d.name,
    ]),
  );
  const deptName = (p: PlanPerson) => depts.get(ids.dept[p.dept]) ?? '';
  const ukYearEnd =
    book.tryResolve<{ taxYearEnd?: string }>('GB', 'retention.payroll_records', anchor)?.value.taxYearEnd ??
    '04-05';
  /** The provider's tax-year label for a pay date: the UK tax year end from the GB pack; this provider's own calendar years elsewhere. */
  const taxYearOf = (currency: string, payDate: string) => {
    const y = Number(payDate.slice(0, 4));
    if (currency !== 'GBP') return { label: String(y), start: makeDate(y, 1, 1) };
    const [m, d] = ukYearEnd.split('-').map(Number) as [number, number];
    const end = makeDate(y, m, d);
    const startYear = compareDates(payDate, end) > 0 ? y : y - 1;
    return {
      label: `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
      start: addDays(makeDate(startYear, m, d), 1),
    };
  };
  const history = new Set(
    plan.people
      .filter(
        (p) =>
          p.entity === 'uk' &&
          (p.login || p.managerIdx === plan.logins.manager || p.idx % 15 === 0) &&
          p.kind !== 'upcoming_starter',
      )
      .map((p) => p.idx),
  );
  interface SamplePeriod {
    key: string;
    entity: 'uk' | 'ie' | 'us';
    start: string;
    end: string;
    pay: string;
    monthsAgo: number;
    frequency: 'monthly' | 'semi_monthly';
    people: PlanPerson[];
  }
  const samplePeriods: SamplePeriod[] = [];
  for (let k = 12; k >= 1; k--) {
    const start = addMonths(thisMonth, -k);
    const end = addDays(addMonths(start, 1), -1);
    const { year: y, month: m } = dateParts(start);
    samplePeriods.push({
      key: `uk:${start}`,
      entity: 'uk',
      start,
      end,
      pay: payDay(y, m),
      monthsAgo: k,
      frequency: 'monthly',
      people: plan.people.filter(
        (p) => p.entity === 'uk' && employedOn(p, end) && (k <= 2 || history.has(p.idx)),
      ),
    });
  }
  for (const m of periods.filter((x) => x.entity !== 'uk' && x.close).slice(-2))
    samplePeriods.push({
      key: `${m.entity}:${m.start}`,
      entity: m.entity,
      start: m.start,
      end: m.end,
      pay: m.pay,
      monthsAgo: 1,
      frequency: m.entity === 'us' ? 'semi_monthly' : 'monthly',
      people: plan.people.filter((p) => p.entity === m.entity && employedOn(p, m.end)),
    });
  const perYear = (f: SamplePeriod['frequency']) => (f === 'monthly' ? 12 : 24);
  const paymentsFor = (p: PlanPerson, sp: SamplePeriod): PayslipStatement['payments'] => {
    const pay = currentPay(p, sp.end);
    const job = currentJob(p, sp.end);
    const weekly = job.weeklyHours ?? 37.5;
    const lines: PayslipStatement['payments'] = [];
    let hourlyRate: number;
    if (pay.frequency === 'hourly') {
      hourlyRate = pay.amountMinor;
      const hoursX100 = Math.round((weekly * 52 * 100) / perYear(sp.frequency));
      lines.push({
        kind: 'basic',
        label: 'Basic pay',
        quantity: (hoursX100 / 100).toFixed(2),
        rateMinor: hourlyRate,
        amountMinor: Math.round((hoursX100 * hourlyRate) / 100),
      });
    } else {
      hourlyRate = Math.round(pay.amountMinor / 52 / weekly);
      lines.push({
        kind: 'basic',
        label: 'Basic salary',
        amountMinor: Math.round(pay.amountMinor / perYear(sp.frequency)),
      });
    }
    const hours = OVERTIME_HOURS_BY_MONTHS_AGO[sp.monthsAgo];
    if (hours && (pay.frequency === 'hourly' || p.shift || p.login)) {
      const rate = Math.round((hourlyRate * OVERTIME_RATE_PERCENT) / 100);
      const hoursX100 = Math.round(Number(hours) * 100);
      lines.push({
        kind: 'overtime',
        label: 'Overtime',
        quantity: hours,
        rateMinor: rate,
        amountMinor: Math.round((hoursX100 * rate) / 100),
      });
    }
    const bonus = BONUSES_BY_MONTHS_AGO[sp.monthsAgo];
    if (bonus && sp.entity === 'uk' && (p.level !== 'member' || p.login || p.idx % 4 === 0))
      lines.push({ kind: 'bonus', label: bonus.label, amountMinor: bonus[p.level] });
    return lines;
  };
  const employerOf = (key: 'uk' | 'ie' | 'us') => {
    const e = entityOf(key);
    return {
      name: e.name,
      address: [e.address.line1, e.address.city, e.address.postcode],
      // fictional references in the provider's style
      taxReference: key === 'uk' ? '999/KF00001' : key === 'ie' ? '9999999KF' : e.registrationNumber,
    };
  };
  const fictionalId = (p: PlanPerson) =>
    p.entity === 'uk'
      ? `QQ${String(100000 + p.idx).slice(-6)}C` // QQ is the prefix HMRC uses in examples; never issued
      : p.entity === 'ie'
        ? `${String(9000000 + p.idx)}KF`
        : `000-00-${String(1000 + p.idx).slice(-4)}`; // area 000 is never issued
  const statementsByPerson = new Map<number, Array<{ ty: string; s: PayslipStatement }>>();
  let slips = 0;
  let pdfs = 0;
  const latestUk = samplePeriods.filter((x) => x.entity === 'uk').at(-1)!;
  for (const sp of samplePeriods) {
    const batchId = seedUuid('payslip-batch', sp.key);
    const currency = entityOf(sp.entity).currency as 'GBP' | 'EUR' | 'USD';
    const published = `${sp.pay}T07:00:00Z`;
    // the batch label names the period only ("August 2026"); the product adds "payslip" around it
    const label =
      sp.entity === 'us'
        ? `${formatDate(sp.start, 'en-US', 'medium')} - ${formatDate(sp.end, 'en-US', 'medium')}`
        : monthName(sp.start);
    const rows: Array<Record<string, unknown>> = [];
    for (const p of sp.people) {
      const ty = taxYearOf(currency, sp.pay);
      const base = sampleStatement({
        employeeNumber: p.number,
        employeeName: `${p.first} ${p.last}`,
        employeeAddress: [p.address.line1, p.address.city, p.address.postcode],
        department: deptName(p),
        jobTitle: currentJob(p, sp.end).title,
        employer: employerOf(sp.entity),
        currency,
        period: {
          start: sp.start,
          end: sp.end,
          payDate: sp.pay,
          frequency: sp.frequency,
          ...(currency === 'GBP' ? { number: `Month ${monthsBetween(ty.start, sp.start) + 1}` } : {}),
          taxYear: ty.label,
        },
        payments: paymentsFor(p, sp),
        studentLoan: p.idx % 4 === 1 || p.login === 'employee',
        nationalId: fictionalId(p),
        taxCode: currency === 'GBP' ? '1257L' : null,
        accountNumber: String(10_000_000 + ((p.idx * 7919) % 90_000_000)),
      });
      const earlier = (statementsByPerson.get(p.idx) ?? []).filter((x) => x.ty === ty.label).map((x) => x.s);
      const statement = storedStatement(withYearToDate(earlier, base));
      if (checkStatement(statement).length)
        throw new Error(`sample statement for ${p.number} does not add up`);
      statementsByPerson.set(p.idx, [
        ...(statementsByPerson.get(p.idx) ?? []),
        { ty: ty.label, s: statement },
      ]);
      // the provider's own PDF comes with the latest UK payslips of the employee and manager logins
      let file: { name: string; key: string; size: number; sha: string } | null = null;
      if (sp === latestUk && (p.login === 'employee' || p.login === 'manager')) {
        const pdf = Buffer.from(
          await renderTextPdf(
            `${SAMPLE_PROVIDER_NAME} - payslip`,
            [
              `${statement.employer.name}`,
              `${statement.employee.name} (${p.number})`,
              `Pay date ${sp.pay}, period ${sp.start} to ${sp.end}`,
              '',
              ...statement.payments.map(
                (l) => `${l.label}: ${formatMoney(money(BigInt(l.amountMinor), currency), 'en-GB')}`,
              ),
              ...statement.deductions.map(
                (l) => `${l.label}: -${formatMoney(money(BigInt(l.amountMinor), currency), 'en-GB')}`,
              ),
              `Net pay: ${formatMoney(money(BigInt(statement.totals.netMinor), currency), 'en-GB')}`,
              '',
              SAMPLE_NOTE,
            ].join('\n'),
          ),
        );
        const key = `${ctx.tenantId}/payslips/${batchId}/${seedUuid('payslip', `${sp.key}:${p.number}`)}.pdf`;
        await ctx.objects.put(key, pdf, 'application/pdf');
        file = {
          name: `${p.number}_payslip_${sp.start.slice(0, 7)}.pdf`,
          key,
          size: pdf.length,
          sha: createHash('sha256').update(pdf).digest('hex'),
        };
        pdfs++;
      }
      rows.push({
        batch_id: batchId,
        employee_id: ids.employee[p.idx],
        file_name: file?.name ?? null,
        file_key: file?.key ?? null,
        size_bytes: file?.size ?? null,
        sha256: file?.sha ?? null,
        match_status: 'matched',
        match_detail: { employeeNumber: p.number },
        status: 'published',
        published_at: published,
        // older payslips have been opened; the latest ones are new to most people
        first_viewed_at: sp.monthsAgo > 1 || p.idx % 3 === 0 ? `${addDays(sp.pay, 1)}T19:00:00Z` : null,
        statement,
        pay_date: sp.pay,
        period_start: sp.start,
        period_end: sp.end,
        currency,
        gross_minor: statement.totals.grossMinor,
        net_minor: statement.totals.netMinor,
      });
    }
    await tx.exec(
      `INSERT INTO app.payslip_batches (tenant_id, id, kind, doc_type, label, pay_date, tax_year, match_by, status, file_count, matched_count, created_by, created_at, published_by, published_at, source, provider_name, sample)
       VALUES (app.current_tenant(), $1, 'payslip', 'payslip', $2, $3, NULL, 'employee_number', 'published', $4, $4, $5, $6, $5, $6, 'provider_statements', $7, true)`,
      [batchId, label, sp.pay, rows.length, payroll, published, SAMPLE_PROVIDER_NAME],
    );
    await insertRows(tx, 'app.payslips', rows, { json: ['match_detail', 'statement'] });
    slips += rows.length;
    if (sp === latestUk) {
      const mine = await tx.one<{ id: string }>(
        'SELECT id FROM app.payslips WHERE batch_id = $1 AND employee_id = $2',
        [batchId, ids.employee[plan.logins.employee]],
      );
      // the month is formatted in the reader's locale when the notification is shown ("August 2026")
      await notify(tx, {
        userIds: [ids.user.employee],
        kind: 'payslip.published',
        titleKey: 'notify.payslipReady',
        params: { period: sp.start },
        link: `/app/payslips/${mine.id}`,
        dedupeKey: `payslip:${mine.id}`,
      });
    }
    await writeAudit(tx, {
      actorType: 'system',
      action: 'payslip_batch.published',
      targetType: 'payslip_batch',
      targetId: batchId,
      diff: { published: rows.length, source: 'provider_statements', sample: true },
    });
  }

  // ---- P60s for the last complete UK tax year (the provider's year-end PDFs) ------------------------------------------
  // the last complete UK tax year ended the day before the current one started (tax year end from the GB pack)
  const taxYearEnd = addDays(taxYearOf('GBP', anchor).start, -1);
  const ty = `${Number(taxYearEnd.slice(0, 4)) - 1}-${taxYearEnd.slice(2, 4)}`;
  const p60People = plan.people.filter((p) => p.entity === 'uk' && employedOn(p, taxYearEnd));
  const p60Batch = seedUuid('payslip-batch', `p60:${ty}`);
  const numbers = new Map(
    plan.people.map((p) => [p.number.toLowerCase(), { id: ids.employee[p.idx]!, employeeNumber: p.number }]),
  );
  const p60Files = await mapLimit(p60People, 8, async (p) => {
    const pdf = Buffer.from(
      await renderTextPdf(
        'P60 End of Year Certificate',
        [
          `Employee: ${p.first} ${p.last} (${p.number})`,
          `Tax year ending ${taxYearEnd}`,
          '',
          'Fictional sample end-of-year certificate generated for the Thapsus-HR staging environment.',
          'Pay and tax figures come from the payroll provider and are not shown here.',
        ].join('\n'),
      ),
    );
    const name = `${p.number}_p60_${ty}.pdf`;
    const key = `${ctx.tenantId}/payslips/${p60Batch}/${seedUuid('payslip', `p60:${ty}:${p.number}`)}.pdf`;
    await ctx.objects.put(key, pdf, 'application/pdf');
    return { p, name, key, size: pdf.length, sha: createHash('sha256').update(pdf).digest('hex') };
  });
  const p60Published = `${addDays(taxYearEnd, 50)}T07:00:00Z`;
  await tx.exec(
    `INSERT INTO app.payslip_batches (tenant_id, id, kind, doc_type, label, pay_date, tax_year, match_by, status, file_count, matched_count, created_by, created_at, published_by, published_at)
     VALUES (app.current_tenant(), $1, 'year_end', 'p60', $2, NULL, $3, 'employee_number', 'published', $4, $4, $5, $6, $5, $6)`,
    [p60Batch, `P60 ${ty}`, ty, p60Files.length, payroll, p60Published],
  );
  await insertRows(
    tx,
    'app.payslips',
    p60Files.map((f) => {
      const m = matchFile(f.name, 'employee_number', null, numbers);
      return {
        batch_id: p60Batch,
        employee_id: m.employeeId,
        file_name: f.name,
        file_key: f.key,
        size_bytes: f.size,
        sha256: f.sha,
        match_status: m.status,
        match_detail: m.detail,
        status: m.employeeId ? 'published' : 'draft',
        published_at: m.employeeId ? p60Published : null,
        first_viewed_at:
          m.employeeId && f.p.idx % 3 === 0 ? `${addDays(p60Published.slice(0, 10), 1)}T19:00:00Z` : null,
      };
    }),
    { json: ['match_detail'] },
  );
  await writeAudit(tx, {
    actorType: 'system',
    action: 'payslip_batch.published',
    targetType: 'payslip_batch',
    targetId: p60Batch,
    diff: { published: p60Files.length },
  });
  ctx.counts.payslipBatches = samplePeriods.length + 1;
  ctx.counts.payslips = slips + p60Files.length;
  ctx.counts.payslipProviderPdfs = pdfs;
}
