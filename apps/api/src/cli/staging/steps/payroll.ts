import { createHash } from 'node:crypto';
import { formatDate, formatMoney } from '@thapsus/core/i18n';
import { money } from '@thapsus/core/money';
import { addDays, addMonths, compareDates, dateParts, dayOfWeek, makeDate } from '@thapsus/core/time';
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
import { insertRows, mapLimit, seedUuid, type SeedCtx } from '../context';
import { currentJob, currentPay, employedOn, type PlanPerson } from '../plan';

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

  // ---- payslips and year-end documents ----------------------------------------------------------------------
  const ukMonths = periods.filter((p) => p.entity === 'uk' && p.close).slice(-2);
  const batches: Array<{
    key: string;
    kind: 'payslip' | 'year_end';
    docType: string;
    label: string;
    payDate: string | null;
    taxYear: string | null;
    people: PlanPerson[];
    render: (p: PlanPerson) => string;
    period?: { start: string; end: string };
  }> = [];
  const gross = (p: PlanPerson, from: string, to: string) => {
    const pay = currentPay(p, to);
    const j = currentJob(p, to);
    const minor =
      pay.frequency === 'annual'
        ? Math.round(pay.amountMinor / 12)
        : Math.round((pay.amountMinor * (j.weeklyHours ?? 20) * 52) / 12);
    return formatMoney(money(BigInt(minor), p.currency), p.currency === 'USD' ? 'en-US' : 'en-GB');
  };
  const slip = (period: { start: string; end: string }, pay: string) => (p: PlanPerson) =>
    [
      `Employee: ${p.first} ${p.last} (${p.number})`,
      `Pay period: ${period.start} to ${period.end}`,
      `Pay date: ${pay}`,
      `Gross pay: ${gross(p, period.start, period.end)}`,
      '',
      'Fictional sample payslip generated for the Thapsus-HR staging environment.',
      'Tax, social security and other deductions are calculated by the payroll provider and are not shown here.',
    ].join('\n');
  for (const m of ukMonths)
    batches.push({
      key: `uk:${m.start}`,
      kind: 'payslip',
      docType: 'payslip',
      label: `Payslips ${monthName(m.start)}`,
      payDate: m.pay,
      taxYear: null,
      people: plan.people.filter((p) => p.entity === 'uk' && employedOn(p, m.end)),
      render: slip(m, m.pay),
      period: m,
    });
  for (const m of periods.filter((p) => p.entity !== 'uk' && p.close).slice(-2))
    batches.push({
      key: `${m.entity}:${m.start}`,
      kind: 'payslip',
      docType: 'payslip',
      label:
        m.entity === 'ie' ? `Ireland payslips ${monthName(m.start)}` : `US pay stubs ${m.start} to ${m.end}`,
      payDate: m.pay,
      taxYear: null,
      people: plan.people.filter((p) => p.entity === m.entity && employedOn(p, m.end)),
      render: slip(m, m.pay),
      period: m,
    });
  // P60s for the last complete UK tax year (6 April to 5 April)
  const taxYearEnd =
    compareDates(anchor, makeDate(year, 4, 6)) >= 0 ? makeDate(year, 4, 5) : makeDate(year - 1, 4, 5);
  const ty = `${Number(taxYearEnd.slice(0, 4)) - 1}-${taxYearEnd.slice(2, 4)}`;
  batches.push({
    key: `p60:${ty}`,
    kind: 'year_end',
    docType: 'p60',
    label: `P60 ${ty}`,
    payDate: null,
    taxYear: ty,
    people: plan.people.filter((p) => p.entity === 'uk' && employedOn(p, taxYearEnd)),
    render: (p) =>
      [
        `Employee: ${p.first} ${p.last} (${p.number})`,
        `Tax year ending ${taxYearEnd}`,
        '',
        'Fictional sample end-of-year certificate generated for the Thapsus-HR staging environment.',
        'Pay and tax figures come from the payroll provider and are not shown here.',
      ].join('\n'),
  });
  let slips = 0;
  const empUser = ids.user.employee;
  const numbers = new Map(
    plan.people.map((p) => [p.number.toLowerCase(), { id: ids.employee[p.idx]!, employeeNumber: p.number }]),
  );
  for (const b of batches) {
    const batchId = seedUuid('payslip-batch', b.key);
    const files = await mapLimit(b.people, 8, async (p) => {
      const pdf = Buffer.from(
        await renderTextPdf(b.kind === 'payslip' ? 'Payslip' : 'P60 End of Year Certificate', b.render(p)),
      );
      const name = `${p.number}_${b.docType}_${b.period?.start.slice(0, 7) ?? b.taxYear}.pdf`;
      const key = `${ctx.tenantId}/payslips/${batchId}/${seedUuid('payslip', `${b.key}:${p.number}`)}.pdf`;
      await ctx.objects.put(key, pdf, 'application/pdf');
      return { p, name, key, size: pdf.length, sha: createHash('sha256').update(pdf).digest('hex') };
    });
    const published = `${b.payDate ?? addDays(taxYearEnd, 50)}T07:00:00Z`;
    await tx.exec(
      `INSERT INTO app.payslip_batches (tenant_id, id, kind, doc_type, label, pay_date, tax_year, match_by, status, file_count, matched_count, created_by, created_at, published_by, published_at)
       VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, 'employee_number', 'published', $7, $7, $8, $9, $8, $9)`,
      [batchId, b.kind, b.docType, b.label, b.payDate, b.taxYear, files.length, payroll, published],
    );
    await insertRows(
      tx,
      'app.payslips',
      files.map((f) => {
        const m = matchFile(f.name, 'employee_number', null, numbers);
        return {
          batch_id: batchId,
          employee_id: m.employeeId,
          file_name: f.name,
          file_key: f.key,
          size_bytes: f.size,
          sha256: f.sha,
          match_status: m.status,
          match_detail: m.detail,
          status: m.employeeId ? 'published' : 'draft',
          published_at: m.employeeId ? published : null,
          first_viewed_at:
            m.employeeId && f.p.idx % 3 === 0 ? `${addDays(published.slice(0, 10), 1)}T19:00:00Z` : null,
        };
      }),
      { json: ['match_detail'] },
    );
    slips += files.length;
    const emp = files.find((f) => f.p.login === 'employee');
    if (emp)
      await notify(tx, {
        userIds: [empUser],
        kind: b.kind === 'payslip' ? 'payslip.published' : 'payslip.year_end_published',
        titleKey: b.kind === 'payslip' ? 'notify.payslipAvailable' : 'notify.yearEndAvailable',
        params: { label: b.label },
        link: '/app/payslips',
        dedupeKey: `payslip:${batchId}:${emp.p.number}`,
      });
    await writeAudit(tx, {
      actorType: 'system',
      action: 'payslip_batch.published',
      targetType: 'payslip_batch',
      targetId: batchId,
      diff: { published: files.length },
    });
  }
  ctx.counts.payslipBatches = batches.length;
  ctx.counts.payslips = slips;
}
