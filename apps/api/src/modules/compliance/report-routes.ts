import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type, type Static } from 'typebox';
import { can } from '@thapsus/core/permissions';
import { compareDates, dateParts, instantToDate } from '@thapsus/core/time';
import type { Tx } from '@thapsus/db';
import { authorize, authorizeSome, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { ruleBook } from '../rules/routes';
import { Vault } from '../vault/service';
import { scopePredicate } from '../employees/service';
import {
  classifyExemption,
  eeo1Aggregate,
  eeo1SnapshotWindow,
  exemptThresholds,
  genderPayGap,
  gpgDates,
  gpgHourlyRate,
  irregularHoursAccrual,
  irregularHoursPolicyCheck,
  payTransparency,
  RATE_SCALE,
  type DutiesRule,
  type Eeo1Rule,
  type GpgEmployee,
  type GpgRule,
  type IrregularHoursRule,
  type PayFrequency,
  type PayTransparencyRule,
  type PtWorker,
  type Sex,
} from './engine';
import { complianceSettings, EMPLOYEE_COLUMNS, EMPLOYEE_FROM, jurisdictionOf, targetOf, vaultActor, withSelfDisclosure, type EmployeeRow } from './service';

const Source = Type.Object({ url: Type.String(), title: Type.String() });
const Pct = Nullable(Type.Number());
const SEXES = ['male', 'female'] as const;

/**
 * Reporting data: UK gender pay gap, EEO-1 Component 1, EU pay transparency, FLSA classification,
 * irregular-hours accrual, SSP and US/EU leave coverage. Sex for pay reporting and EEO-1
 * self-identification are read from the vault (every decrypt audited) and only aggregates leave it.
 */
export async function reportRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const vault = new Vault(deps.keys);
  const asOfOf = (req: FastifyRequest, q?: string) => q ?? instantToDate(deps.now().toISOString(), requireAuth(req).user.timeZone ?? 'UTC');

  async function employeesIn(tx: Tx, req: FastifyRequest, action: string, where: string, args: unknown[] = []) {
    const auth = requireAuth(req);
    const params = [...args];
    const scope = scopePredicate(auth.principal, action, params);
    return tx.query<EmployeeRow>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE ${where} AND ${scope} ORDER BY e.display_name, e.id`, params);
  }

  /** Reads one vault field per employee; the reader must hold vault.read:<category> for every subject (403 otherwise). */
  async function vaultField(tx: Tx, req: FastifyRequest, emps: EmployeeRow[], category: 'diversity' | 'eeo', field: string) {
    const auth = requireAuth(req);
    const out = new Map<string, Record<string, string>>();
    for (const e of emps) {
      const fields = await vault.read(tx, vaultActor(req), auth.tenantId, targetOf(e), category);
      const f = fields.find((x) => x.field === field);
      if (f) out.set(e.id, JSON.parse(f.value) as Record<string, string>);
    }
    return out;
  }

  // ---- sex for statutory pay reporting (vault, diversity) and EEO-1 self-identification (vault, eeo) ----
  app.put(
    '/v1/compliance/demographics/:employeeId',
    { config: { selfAudited: true }, schema: { tags: ['compliance'], summary: 'Record the sex used for statutory pay-gap reporting (vault, diversity)', params: Type.Object({ employeeId: Uuid }), body: Type.Object({ sex: Type.Union([...SEXES.map((s) => Type.Literal(s)), Type.Literal('not_recorded')]) }), response: { 204: Type.Null(), 403: Problem, 404: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { employeeId } = req.params as { employeeId: string };
      const { sex } = req.body as { sex: string };
      await app.tenantTx(req, async (tx) => {
        const e = await tx.maybe<EmployeeRow>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE e.id = $1`, [employeeId]);
        if (!e) throw new ApiError('notFound');
        const own = auth.principal.employeeId === employeeId;
        const principal = own ? withSelfDisclosure(auth.principal, ['vault.write:diversity']) : auth.principal;
        await vault.put(tx, vaultActor(req, principal), auth.tenantId, targetOf(e), 'diversity', 'pay_reporting', JSON.stringify({ sex }));
        req.auditWritten = true;
      });
      return reply.status(204).send(null);
    },
  );

  const SelfId = Type.Object({
    raceEthnicity: Type.Union([Type.String({ pattern: '^[a-z_]{3,60}$' }), Type.Literal('declined')]),
    sex: Type.Union([...SEXES.map((s) => Type.Literal(s)), Type.Literal('declined')]),
    veteranStatus: Type.Optional(Type.Union(['protected_veteran', 'not_protected_veteran', 'declined'].map((s) => Type.Literal(s)))),
    disabilityStatus: Type.Optional(Type.Union(['yes', 'no', 'declined'].map((s) => Type.Literal(s)))),
  });

  app.post(
    '/v1/compliance/eeo/self-identification',
    { config: { selfAudited: true }, schema: { tags: ['compliance'], summary: 'Voluntary self-identification (race/ethnicity, sex, veteran and disability status) — stored only in the vault', body: Type.Intersect([Type.Object({ employeeId: Type.Optional(Uuid) }), SelfId]), response: { 204: Type.Null(), 400: Problem, 403: Problem, 404: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as Static<typeof SelfId> & { employeeId?: string };
      const employeeId = b.employeeId ?? auth.principal.employeeId;
      if (!employeeId) throw new ApiError('validation', 'employeeId is required');
      const book = await ruleBook(app);
      const rule = book.tryResolve<Eeo1Rule>('US', 'reporting.eeo1', asOfOf(req));
      if (rule && b.raceEthnicity !== 'declined' && !rule.value.raceEthnicityCategories.includes(b.raceEthnicity)) throw new ApiError('validation', 'Unknown race/ethnicity category', { categories: rule.value.raceEthnicityCategories });
      await app.tenantTx(req, async (tx) => {
        const e = await tx.maybe<EmployeeRow>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE e.id = $1`, [employeeId]);
        if (!e) throw new ApiError('notFound');
        const own = auth.principal.employeeId === employeeId;
        const principal = own ? withSelfDisclosure(auth.principal, ['vault.write:eeo']) : auth.principal;
        await vault.put(tx, vaultActor(req, principal), auth.tenantId, targetOf(e), 'eeo', 'self_identification', JSON.stringify({ raceEthnicity: b.raceEthnicity, sex: b.sex, veteranStatus: b.veteranStatus ?? 'declined', disabilityStatus: b.disabilityStatus ?? 'declined', source: own ? 'self' : 'recorded_by_hr' }));
        req.auditWritten = true;
      });
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/v1/compliance/eeo/self-identification/:employeeId',
    { schema: { tags: ['compliance'], summary: 'Read one self-identification (vault.read:eeo; the view is audited)', params: Type.Object({ employeeId: Uuid }), response: { 200: Nullable(Type.Object({ raceEthnicity: Type.String(), sex: Type.String(), veteranStatus: Type.String(), disabilityStatus: Type.String(), source: Type.String(), recordedAt: Type.String() })), 403: Problem, 404: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { employeeId } = req.params as { employeeId: string };
      return app.tenantTx(req, async (tx) => {
        const e = await tx.maybe<EmployeeRow>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE e.id = $1`, [employeeId]);
        if (!e) throw new ApiError('notFound');
        const own = auth.principal.employeeId === employeeId;
        const principal = own ? withSelfDisclosure(auth.principal, ['vault.read:eeo']) : auth.principal;
        const f = (await vault.read(tx, vaultActor(req, principal), auth.tenantId, targetOf(e), 'eeo')).find((x) => x.field === 'self_identification');
        req.auditWritten = true;
        return f ? { ...(JSON.parse(f.value) as { raceEthnicity: string; sex: string; veteranStatus: string; disabilityStatus: string; source: string }), recordedAt: String(f.recordedAt) } : null;
      });
    },
  );

  const JobMap = Type.Object({ jobTitle: Type.String({ minLength: 1, maxLength: 200 }), category: Type.String({ maxLength: 80 }) });
  app.get('/v1/compliance/eeo/job-categories', { schema: { tags: ['compliance'], response: { 200: Type.Object({ categories: Type.Array(Type.String()), mappings: Type.Array(JobMap), unmappedJobTitles: Type.Array(Type.String()) }), 403: Problem } } }, async (req) => {
    authorizeSome(req, 'compliance.read');
    const rule = (await ruleBook(app)).tryResolve<Eeo1Rule>('US', 'reporting.eeo1', asOfOf(req));
    return app.tenantTx(
      req,
      async (tx) => {
        const mappings = (await tx.query<{ job_title: string; category: string }>('SELECT job_title, category FROM app.eeo_job_categories ORDER BY job_title')).map((m) => ({ jobTitle: m.job_title, category: m.category }));
        const titles = await tx.query<{ job_title: string }>(`SELECT DISTINCT job_title FROM app.employees WHERE country = 'US' AND status <> 'leaver' AND job_title IS NOT NULL AND job_title NOT IN (SELECT job_title FROM app.eeo_job_categories) ORDER BY job_title`);
        return { categories: rule?.value.jobCategories ?? [], mappings, unmappedJobTitles: titles.map((t) => t.job_title) };
      },
      { readOnly: true },
    );
  });

  app.put('/v1/compliance/eeo/job-categories', { config: { selfAudited: true }, schema: { tags: ['compliance'], body: Type.Object({ mappings: Type.Array(JobMap, { minItems: 1, maxItems: 2000 }) }), response: { 200: Type.Object({ saved: Type.Integer() }), 400: Problem, 403: Problem } } }, async (req) => {
    const auth = authorize(req, 'compliance.manage');
    const { mappings } = req.body as { mappings: Array<{ jobTitle: string; category: string }> };
    const rule = (await ruleBook(app)).tryResolve<Eeo1Rule>('US', 'reporting.eeo1', asOfOf(req));
    const bad = mappings.filter((m) => !rule?.value.jobCategories.includes(m.category));
    if (bad.length) throw new ApiError('validation', 'Unknown EEO-1 job category', { categories: rule?.value.jobCategories ?? [] });
    return app.tenantTx(req, async (tx) => {
      for (const m of mappings) await tx.exec(`INSERT INTO app.eeo_job_categories (tenant_id, job_title, category, updated_by) VALUES (app.current_tenant(), $1, $2, $3) ON CONFLICT (tenant_id, job_title) DO UPDATE SET category = EXCLUDED.category, updated_by = EXCLUDED.updated_by, updated_at = now()`, [m.jobTitle, m.category, auth.userId]);
      await app.audit(tx, req, { action: 'compliance.eeo_job_categories_saved', targetType: 'tenant', diff: { mappings: mappings.length } });
      return { saved: mappings.length };
    });
  });

  // ---- EEO-1 Component 1 aggregate ------------------------------------------------------------------
  app.get(
    '/v1/compliance/reports/eeo-1',
    {
      schema: {
        tags: ['compliance'],
        summary: 'EEO-1 Component 1 data: counts by job category, race/ethnicity and sex for a workforce snapshot date, with small-cell suppression',
        querystring: Type.Object({ year: Type.Integer({ minimum: 2020, maximum: 2100 }), snapshotDate: Type.Optional(CivilDate), exact: Type.Optional(Type.Boolean()) }),
        response: { 200: Type.Object({ year: Type.Integer(), snapshotDate: Type.String(), window: Type.Object({ from: Type.String(), to: Type.String() }), required: Type.Boolean(), threshold: Type.Integer(), totalEmployees: Type.Integer(), notReported: Type.Integer(), unmappedJobs: Type.Integer(), suppressionThreshold: Nullable(Type.Integer()), table: Type.Array(Type.Object({ jobCategory: Type.String(), total: Nullable(Type.Integer()), cells: Type.Array(Type.Object({ raceEthnicity: Type.String(), sex: Type.String(), count: Nullable(Type.Integer()), suppressed: Type.Boolean() })) })), source: Source, verifiedOn: Type.String() }), 403: Problem, 422: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'compliance.reports');
      const q = req.query as { year: number; snapshotDate?: string; exact?: boolean };
      const book = await ruleBook(app);
      const rule = book.tryResolve<Eeo1Rule>('US', 'reporting.eeo1', `${q.year}-12-31`);
      if (!rule) throw new ApiError('unprocessable', 'No EEO-1 rule for that year');
      const window = eeo1SnapshotWindow(rule.value, q.year);
      const snapshot = q.snapshotDate ?? window.to;
      if (compareDates(snapshot, window.from) < 0 || compareDates(snapshot, window.to) > 0) throw new ApiError('unprocessable', 'The snapshot date must fall in the workforce snapshot window', window);
      return app.tenantTx(req, async (tx) => {
        const settings = await complianceSettings(tx);
        const emps = await employeesIn(tx, req, 'compliance.reports', `coalesce(e.country, fl.country, le.country) = 'US' AND e.start_date <= $1 AND (e.end_date IS NULL OR e.end_date >= $1)`, [snapshot]);
        const jobs = new Map((await tx.query<{ job_title: string; category: string }>('SELECT job_title, category FROM app.eeo_job_categories')).map((m) => [m.job_title, m.category]));
        const selfId = await vaultField(tx, req, emps, 'eeo', 'self_identification');
        const result = eeo1Aggregate(rule.value, emps.map((e) => ({ jobCategory: e.job_title ? (jobs.get(e.job_title) ?? null) : null, raceEthnicity: selfId.get(e.id)?.raceEthnicity ?? null, sex: selfId.get(e.id)?.sex ?? null })), { k: settings.smallCellThreshold, exact: q.exact === true && can(auth.principal, 'compliance.reports_exact') });
        await app.audit(tx, req, { action: 'compliance.eeo1_report_viewed', targetType: 'compliance', diff: { year: q.year, snapshot, employees: emps.length, exact: result.suppressionThreshold === null }, sensitive: true });
        return { year: q.year, snapshotDate: snapshot, window, ...result, source: rule.source, verifiedOn: rule.verifiedOn };
      });
    },
  );

  // ---- pay-report inputs (from payroll) ---------------------------------------------------------------
  const InputRow = Type.Object({
    employeeId: Uuid,
    currency: Type.String({ pattern: '^[A-Z]{3}$' }),
    ordinaryPayMinor: Type.Optional(Type.Integer({ minimum: 0 })),
    bonusInPeriodMinor: Type.Optional(Type.Integer({ minimum: 0 })),
    payPeriodDays: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 366 })),
    weeklyHours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 168 })),
    bonus12MonthsMinor: Type.Optional(Type.Integer({ minimum: 0 })),
    fullPay: Type.Optional(Type.Boolean()),
    annualBasicMinor: Type.Optional(Type.Integer({ minimum: 0 })),
    annualVariableMinor: Type.Optional(Type.Integer({ minimum: 0 })),
    annualHours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 8784 })),
    workerCategory: Type.Optional(Type.String({ maxLength: 120 })),
  });
  app.put(
    '/v1/compliance/pay-report-inputs',
    { config: { selfAudited: true }, schema: { tags: ['compliance'], summary: 'Load per-employee pay data for a reporting snapshot (UK gender pay gap or EU pay transparency); replaces rows for the same snapshot', body: Type.Object({ kind: Type.Union([Type.Literal('uk_gpg'), Type.Literal('eu_pay_transparency')]), snapshotDate: CivilDate, rows: Type.Array(InputRow, { minItems: 1, maxItems: 20_000 }) }), response: { 200: Type.Object({ saved: Type.Integer() }), 403: Problem } } },
    async (req) => {
      const auth = authorize(req, 'compliance.manage');
      const b = req.body as { kind: string; snapshotDate: string; rows: Array<Static<typeof InputRow>> };
      return app.tenantTx(req, async (tx) => {
        for (const r of b.rows) {
          await tx.exec(
            `INSERT INTO app.pay_report_inputs (tenant_id, report_kind, snapshot_date, employee_id, currency, ordinary_pay_minor, bonus_in_period_minor, pay_period_days, weekly_hours, bonus_12_months_minor, full_pay, annual_basic_minor, annual_variable_minor, annual_hours, worker_category, created_by)
             VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (tenant_id, report_kind, snapshot_date, employee_id) DO UPDATE SET currency = EXCLUDED.currency, ordinary_pay_minor = EXCLUDED.ordinary_pay_minor, bonus_in_period_minor = EXCLUDED.bonus_in_period_minor,
               pay_period_days = EXCLUDED.pay_period_days, weekly_hours = EXCLUDED.weekly_hours, bonus_12_months_minor = EXCLUDED.bonus_12_months_minor, full_pay = EXCLUDED.full_pay, annual_basic_minor = EXCLUDED.annual_basic_minor,
               annual_variable_minor = EXCLUDED.annual_variable_minor, annual_hours = EXCLUDED.annual_hours, worker_category = EXCLUDED.worker_category, created_by = EXCLUDED.created_by`,
            [b.kind, b.snapshotDate, r.employeeId, r.currency, r.ordinaryPayMinor ?? 0, r.bonusInPeriodMinor ?? 0, r.payPeriodDays ?? null, r.weeklyHours ?? null, r.bonus12MonthsMinor ?? 0, r.fullPay ?? true, r.annualBasicMinor ?? null, r.annualVariableMinor ?? null, r.annualHours ?? null, r.workerCategory ?? null, auth.userId],
          );
        }
        await app.audit(tx, req, { action: 'compliance.pay_report_inputs_loaded', targetType: 'tenant', diff: { kind: b.kind, snapshotDate: b.snapshotDate, rows: b.rows.length } });
        return { saved: b.rows.length };
      });
    },
  );

  // ---- UK gender pay gap --------------------------------------------------------------------------
  const Quart = Type.Object({ band: Type.String(), total: Type.Integer(), malePercent: Pct, femalePercent: Pct });
  app.get(
    '/v1/compliance/reports/gender-pay-gap',
    {
      schema: {
        tags: ['compliance'],
        summary: 'UK gender pay gap figures (S.I. 2017/172) for a snapshot year and sector, from loaded pay data or current pay records',
        querystring: Type.Object({ year: Type.Integer({ minimum: 2017, maximum: 2100 }), sector: Type.Optional(Type.Union([Type.Literal('privateAndVoluntary'), Type.Literal('publicAuthority')])), entityId: Type.Optional(Uuid) }),
        response: {
          200: Type.Object({
            snapshotDate: Type.String(),
            deadline: Type.String(),
            sector: Type.String(),
            employeeThreshold: Type.Integer(),
            headcount: Type.Integer(),
            required: Type.Boolean(),
            dataSource: Type.Union([Type.Literal('pay_report_inputs'), Type.Literal('employee_pay')]),
            population: Type.Object({ relevantEmployees: Type.Integer(), fullPayRelevantEmployees: Type.Integer(), excludedNoSexRecorded: Type.Integer(), male: Type.Integer(), female: Type.Integer() }),
            figures: Type.Object({ meanHourlyPayGap: Pct, medianHourlyPayGap: Pct, meanBonusGap: Pct, medianBonusGap: Pct, bonusProportions: Type.Object({ male: Pct, female: Pct }), quartiles: Type.Array(Quart) }),
            source: Source,
            verifiedOn: Type.String(),
          }),
          403: Problem,
          422: Problem,
        },
      },
    },
    async (req) => {
      authorizeSome(req, 'compliance.reports');
      const q = req.query as { year: number; sector?: 'privateAndVoluntary' | 'publicAuthority'; entityId?: string };
      const book = await ruleBook(app);
      return app.tenantTx(req, async (tx) => {
        const settings = await complianceSettings(tx);
        const sector = q.sector ?? settings.gpgSector;
        const probe = book.tryResolve<GpgRule & Parameters<typeof gpgDates>[0]>('GB', 'reporting.gender_pay_gap', `${q.year}-12-31`);
        if (!probe) throw new ApiError('unprocessable', 'No gender pay gap rule for that year');
        const { snapshotDate, deadline } = gpgDates(probe.value, q.year, sector);
        const rule = book.resolve<GpgRule & Parameters<typeof gpgDates>[0]>('GB', 'reporting.gender_pay_gap', snapshotDate);
        const territory = (rule.value as { territory?: string[] }).territory ?? [];
        const args: unknown[] = [snapshotDate];
        let where = `coalesce(e.country, fl.country, le.country) = 'GB' AND e.start_date <= $1 AND (e.end_date IS NULL OR e.end_date >= $1)`;
        if (q.entityId) {
          args.push(q.entityId);
          where += ` AND coalesce(e.entity_id, fj.entity_id) = $2`;
        }
        const emps = (await employeesIn(tx, req, 'compliance.reports', where, args)).filter((e) => !e.region_code || territory.length === 0 || territory.includes(e.region_code) || !e.region_code.startsWith('GB-'));
        const inputs = new Map((await tx.query<{ employee_id: string; ordinary_pay_minor: string; bonus_in_period_minor: string; pay_period_days: string | null; weekly_hours: string | null; bonus_12_months_minor: string; full_pay: boolean }>(`SELECT * FROM app.pay_report_inputs WHERE report_kind = 'uk_gpg' AND snapshot_date = $1`, [snapshotDate])).map((r) => [r.employee_id, r]));
        const pay = new Map((await tx.query<{ employee_id: string; amount_minor: string; frequency: PayFrequency }>(`SELECT employee_id, amount_minor, frequency FROM app.employee_pay WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)`, [snapshotDate])).map((r) => [r.employee_id, r]));
        const hours = new Map((await tx.query<{ employee_id: string; weekly_hours: string | null }>(`SELECT employee_id, weekly_hours FROM app.employee_jobs WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)`, [snapshotDate])).map((r) => [r.employee_id, r.weekly_hours]));
        const sexes = await vaultField(tx, req, emps, 'diversity', 'pay_reporting');
        const dataSource = inputs.size ? ('pay_report_inputs' as const) : ('employee_pay' as const);
        const rows: GpgEmployee[] = [];
        for (const e of emps) {
          const s = sexes.get(e.id)?.sex;
          const sex: Sex | null = s === 'male' || s === 'female' ? s : null;
          const inp = inputs.get(e.id);
          if (inp) {
            const wh = Number(inp.weekly_hours ?? hours.get(e.id) ?? 0);
            const rate = wh > 0 ? gpgHourlyRate(rule.value, { ordinaryPayMinor: Number(inp.ordinary_pay_minor), bonusInPeriodMinor: Number(inp.bonus_in_period_minor), period: inp.pay_period_days ? { days: Number(inp.pay_period_days) } : 'monthly', weeklyHours: wh }) : 0;
            rows.push({ sex, fullPay: inp.full_pay && wh > 0, hourlyRate: rate, bonus12MonthsMinor: Number(inp.bonus_12_months_minor) });
            continue;
          }
          if (dataSource === 'pay_report_inputs') continue; // a loaded dataset is authoritative for the snapshot
          const p = pay.get(e.id);
          const wh = Number(hours.get(e.id) ?? 0);
          if (!p || !(wh > 0)) {
            rows.push({ sex, fullPay: false, hourlyRate: 0, bonus12MonthsMinor: 0 });
            continue;
          }
          const amount = Number(p.amount_minor);
          if (p.frequency === 'daily') {
            // a daily rate has no reg. 6 pay period of its own: load the payroll figures via pay-report inputs
            rows.push({ sex, fullPay: false, hourlyRate: 0, bonus12MonthsMinor: 0 });
            continue;
          }
          const rate = p.frequency === 'hourly' ? amount * RATE_SCALE : gpgHourlyRate(rule.value, { ordinaryPayMinor: amount, period: p.frequency, weeklyHours: wh });
          rows.push({ sex, fullPay: true, hourlyRate: rate, bonus12MonthsMinor: 0 });
        }
        const r = genderPayGap(rule.value, rows);
        await app.audit(tx, req, { action: 'compliance.gpg_report_viewed', targetType: 'compliance', diff: { year: q.year, sector, snapshotDate, employees: emps.length }, sensitive: true });
        return {
          snapshotDate,
          deadline,
          sector,
          employeeThreshold: rule.value.employeeThreshold,
          headcount: emps.length,
          required: emps.length >= rule.value.employeeThreshold,
          dataSource,
          population: r.population,
          figures: { ...r.rounded, quartiles: r.quartiles.map((x, i) => ({ band: x.band, total: x.total, malePercent: r.rounded.quartiles[i]!.malePercent, femalePercent: r.rounded.quartiles[i]!.femalePercent })) },
          source: rule.source,
          verifiedOn: rule.verifiedOn,
        };
      });
    },
  );

  // ---- EU pay transparency ------------------------------------------------------------------------
  app.get(
    '/v1/compliance/reports/pay-transparency',
    {
      schema: {
        tags: ['compliance'],
        summary: 'EU Pay Transparency Directive (EU) 2023/970 indicators per EU legal entity, with the member state\'s transposition status',
        querystring: Type.Object({ year: Type.Integer({ minimum: 2026, maximum: 2100 }), entityId: Type.Optional(Uuid) }),
        response: {
          200: Type.Array(
            Type.Object({
              entityId: Uuid,
              entityName: Type.String(),
              country: Type.String(),
              transposition: Type.Object({ status: Type.String(), law: Nullable(Type.String()), inForceFrom: Nullable(Type.String()), source: Source, verifiedOn: Type.String() }),
              directive: Type.Object({ source: Source, verifiedOn: Type.String() }),
              indicators: Type.Any(),
            }),
          ),
          403: Problem,
        },
      },
    },
    async (req) => {
      authorizeSome(req, 'compliance.reports');
      const q = req.query as { year: number; entityId?: string };
      const book = await ruleBook(app);
      const asOf = `${q.year}-12-31`;
      const snapshot = `${q.year - 1}-12-31`; // reports concern the previous calendar year (art. 9(2)-(4))
      return app.tenantTx(req, async (tx) => {
        const entities = await tx.query<{ id: string; name: string; country: string }>(`SELECT id, name, country FROM app.legal_entities ${q.entityId ? 'WHERE id = $1' : ''} ORDER BY name`, q.entityId ? [q.entityId] : []);
        const eu = entities.filter((en) => book.pack(en.country)?.parent === 'EU');
        const out = [];
        for (const en of eu) {
          const directive = book.tryResolve<PayTransparencyRule>('EU', 'reporting.pay_transparency', asOf);
          const status = book.tryResolve<{ status: string; law: string | null; inForceFrom: string | null }>(en.country, 'reporting.pay_transparency', asOf);
          if (!directive || !status || status.jurisdiction === 'EU') continue;
          const emps = await employeesIn(tx, req, 'compliance.reports', `coalesce(e.entity_id, fj.entity_id) = $1 AND e.start_date <= $2 AND (e.end_date IS NULL OR e.end_date >= $2)`, [en.id, snapshot]);
          const inputs = new Map((await tx.query<{ employee_id: string; annual_basic_minor: string | null; annual_variable_minor: string | null; annual_hours: string | null; worker_category: string | null }>(`SELECT * FROM app.pay_report_inputs WHERE report_kind = 'eu_pay_transparency' AND snapshot_date = $1`, [snapshot])).map((r) => [r.employee_id, r]));
          const sexes = await vaultField(tx, req, emps, 'diversity', 'pay_reporting');
          const workers: PtWorker[] = emps.map((e) => {
            const s = sexes.get(e.id)?.sex;
            const i = inputs.get(e.id);
            return { sex: s === 'male' || s === 'female' ? s : null, annualBasicMinor: Number(i?.annual_basic_minor ?? 0), annualVariableMinor: Number(i?.annual_variable_minor ?? 0), annualHours: i?.annual_hours ? Number(i.annual_hours) : null, category: i?.worker_category ?? null };
          });
          const ind = payTransparency(directive.value, workers, q.year);
          out.push({ entityId: en.id, entityName: en.name, country: en.country, transposition: { ...status.value, source: status.source, verifiedOn: status.verifiedOn }, directive: { source: directive.source, verifiedOn: directive.verifiedOn }, indicators: ind });
        }
        await app.audit(tx, req, { action: 'compliance.pay_transparency_viewed', targetType: 'compliance', diff: { year: q.year, entities: out.length }, sensitive: true });
        return out;
      });
    },
  );

  // ---- US FLSA classification --------------------------------------------------------------------
  const FlsaRow = Type.Object({ employeeId: Uuid, employeeName: Type.String(), jurisdiction: Nullable(Type.String()), flsaStatus: Nullable(Type.String()), exemption: Nullable(Type.String()), status: Type.String(), overtimeEligible: Type.Boolean(), issues: Type.Array(Type.String()), applicableAnnualThresholdMinor: Nullable(Type.Integer()), sources: Type.Array(Type.Object({ jurisdiction: Type.String(), url: Type.String(), title: Type.String() })) });
  async function flsaFor(tx: Tx, emps: EmployeeRow[], asOf: string) {
    const book = await ruleBook(app);
    const duties = book.tryResolve<DutiesRule>('US', 'overtime.exempt_duties_tests', asOf);
    if (!duties) throw new ApiError('unprocessable', 'No exemption rules for that date');
    const size = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.employees WHERE status = 'active'`)).n;
    const jobs = new Map((await tx.query<{ employee_id: string; flsa_status: 'exempt' | 'non_exempt' | null; weekly_hours: string | null }>(`SELECT employee_id, flsa_status, weekly_hours FROM app.employee_jobs WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)`, [asOf])).map((j) => [j.employee_id, j]));
    const pay = new Map((await tx.query<{ employee_id: string; amount_minor: string; frequency: PayFrequency; currency: string }>(`SELECT employee_id, amount_minor, frequency, currency FROM app.employee_pay WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)`, [asOf])).map((p) => [p.employee_id, p]));
    const att = new Map((await tx.query<{ employee_id: string; exemption: string; duties_attested: string[] }>(`SELECT employee_id, exemption, duties_attested FROM app.flsa_attestations WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)`, [asOf])).map((a) => [a.employee_id, a]));
    return emps.map((e) => {
      const j = jobs.get(e.id);
      const p = pay.get(e.id);
      const a = att.get(e.id);
      const jur = jurisdictionOf(e) ?? 'US';
      const th = exemptThresholds(book, jur, asOf, size);
      const c = classifyExemption(duties.value, th, { flsaStatus: j?.flsa_status ?? null, pay: p && p.currency === 'USD' ? { amountMinor: Number(p.amount_minor), frequency: p.frequency } : null, weeklyHours: Number(j?.weekly_hours ?? 40), attestation: a ? { exemption: a.exemption, duties: a.duties_attested } : null });
      return { employeeId: e.id, employeeName: e.display_name, jurisdiction: jur, flsaStatus: j?.flsa_status ?? null, exemption: a?.exemption ?? null, status: c.status, overtimeEligible: c.overtimeEligible, issues: c.issues, applicableAnnualThresholdMinor: th.applicableAnnualMinor, sources: [...th.sources, { jurisdiction: 'US', ...duties.source }] };
    });
  }

  app.get('/v1/compliance/flsa', { schema: { tags: ['compliance'], summary: 'Exempt / non-exempt check for US employees (salary level incl. state thresholds, salary basis, duties attestation) and resulting overtime eligibility', querystring: Type.Object({ asOf: Type.Optional(CivilDate) }), response: { 200: Type.Array(FlsaRow), 403: Problem, 422: Problem } } }, async (req) => {
    authorizeSome(req, 'compliance.read');
    const asOf = asOfOf(req, (req.query as { asOf?: string }).asOf);
    return app.tenantTx(req, async (tx) => flsaFor(tx, await employeesIn(tx, req, 'compliance.read', `coalesce(e.country, fl.country, le.country) = 'US' AND e.status <> 'leaver'`), asOf), { readOnly: true });
  });

  app.get('/v1/compliance/flsa/:employeeId/overtime-eligibility', { schema: { tags: ['compliance'], summary: 'Whether an employee is overtime-eligible on a date (for the time and payroll modules)', params: Type.Object({ employeeId: Uuid }), querystring: Type.Object({ asOf: Type.Optional(CivilDate) }), response: { 200: FlsaRow, 403: Problem, 404: Problem } } }, async (req) => {
    const auth = requireAuth(req);
    const { employeeId } = req.params as { employeeId: string };
    const asOf = asOfOf(req, (req.query as { asOf?: string }).asOf);
    return app.tenantTx(
      req,
      async (tx) => {
        const e = await tx.maybe<EmployeeRow>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE e.id = $1`, [employeeId]);
        if (!e) throw new ApiError('notFound');
        if (!can(auth.principal, 'compliance.read', targetOf(e)) && !can(auth.principal, 'time.read', targetOf(e))) throw new ApiError('forbidden');
        return (await flsaFor(tx, [e], asOf))[0]!;
      },
      { readOnly: true },
    );
  });

  app.post(
    '/v1/compliance/flsa/attestations',
    { config: { selfAudited: true }, schema: { tags: ['compliance'], summary: 'Attest the duties test for an exempt employee (effective-dated; closes the previous attestation)', body: Type.Object({ employeeId: Uuid, exemption: Type.String({ maxLength: 60 }), duties: Type.Array(Type.String({ maxLength: 200 }), { minItems: 1, maxItems: 20 }), validFrom: CivilDate }), response: { 201: Type.Object({ id: Uuid, complete: Type.Boolean() }), 400: Problem, 403: Problem, 404: Problem } } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { employeeId: string; exemption: string; duties: string[]; validFrom: string };
      const duties = (await ruleBook(app)).tryResolve<DutiesRule>('US', 'overtime.exempt_duties_tests', b.validFrom);
      const cat = duties?.value.categories.find((c) => c.id === b.exemption);
      if (!cat) throw new ApiError('validation', 'Unknown exemption', { exemptions: duties?.value.categories.map((c) => c.id) ?? [] });
      if (b.duties.some((d) => !cat.duties.includes(d))) throw new ApiError('validation', 'Unknown duty criterion for that exemption', { duties: cat.duties });
      const out = await app.tenantTx(req, async (tx) => {
        const e = await tx.maybe<EmployeeRow>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE e.id = $1`, [b.employeeId]);
        if (!e) throw new ApiError('notFound');
        if (!can(auth.principal, 'compliance.record', targetOf(e))) throw new ApiError('forbidden');
        await tx.exec(`UPDATE app.flsa_attestations SET valid_to = $2 WHERE employee_id = $1 AND valid_from < $2 AND (valid_to IS NULL OR valid_to > $2)`, [e.id, b.validFrom]);
        await tx.exec(`DELETE FROM app.flsa_attestations WHERE employee_id = $1 AND valid_from >= $2`, [e.id, b.validFrom]);
        const row = await tx.one<{ id: string }>(`INSERT INTO app.flsa_attestations (tenant_id, employee_id, exemption, duties_attested, valid_from, attested_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5) RETURNING id`, [e.id, b.exemption, b.duties, b.validFrom, auth.userId]);
        const complete = cat.duties.every((d) => b.duties.includes(d));
        await app.audit(tx, req, { action: 'compliance.flsa_attested', targetType: 'employee', targetId: e.id, diff: { exemption: b.exemption, duties: b.duties, validFrom: b.validFrom, complete } });
        return { id: row.id, complete };
      });
      return reply.status(201).send(out);
    },
  );

  // ---- UK holiday: irregular-hours and part-year accrual -------------------------------------------
  app.post('/v1/compliance/uk/holiday-accrual/calculate', { schema: { tags: ['compliance'], summary: 'Holiday accrued in a pay period by an irregular-hours or part-year worker (WTR reg. 15B)', body: Type.Object({ minutesWorked: Type.Integer({ minimum: 0, maximum: 1_000_000 }), payPeriodEnd: CivilDate, jurisdiction: Type.Optional(Type.String({ pattern: '^GB(-[A-Z]{3})?$' })) }), response: { 200: Type.Object({ exactHours: Type.Number(), accruedHours: Type.Number(), percent: Type.Number(), source: Source, verifiedOn: Type.String() }), 404: Problem } } }, async (req) => {
    requireAuth(req);
    const b = req.body as { minutesWorked: number; payPeriodEnd: string; jurisdiction?: string };
    const r = (await ruleBook(app)).tryResolve<IrregularHoursRule>(b.jurisdiction ?? 'GB', 'leave.irregular_hours_accrual', b.payPeriodEnd);
    if (!r) throw new ApiError('notFound');
    req.auditWritten = true; // calculation only, nothing stored
    return { ...irregularHoursAccrual(r.value, { minutesWorked: b.minutesWorked }), percent: r.value.accrualPercentOfHoursWorked, source: r.source, verifiedOn: r.verifiedOn };
  });

  app.get(
    '/v1/compliance/uk/holiday-accrual',
    { schema: { tags: ['compliance'], summary: 'GB irregular-hours / part-year workers and whether their leave policy accrues per hour worked at the statutory percentage', querystring: Type.Object({ asOf: Type.Optional(CivilDate) }), response: { 200: Type.Array(Type.Object({ employeeId: Uuid, employeeName: Type.String(), jurisdiction: Nullable(Type.String()), basis: Type.String(), policyName: Nullable(Type.String()), ok: Type.Boolean(), issue: Nullable(Type.String()), statutoryPercent: Nullable(Type.Number()), source: Nullable(Source) })), 403: Problem } } },
    async (req) => {
      authorizeSome(req, 'compliance.read');
      const asOf = asOfOf(req, (req.query as { asOf?: string }).asOf);
      const book = await ruleBook(app);
      return app.tenantTx(
        req,
        async (tx) => {
          const emps = await employeesIn(tx, req, 'compliance.read', `coalesce(e.country, fl.country, le.country) = 'GB' AND e.status <> 'leaver'`);
          const jobs = new Map((await tx.query<{ employee_id: string; employment_type: string }>(`SELECT employee_id, employment_type FROM app.employee_jobs WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)`, [asOf])).map((j) => [j.employee_id, j.employment_type]));
          const contracts = new Map((await tx.query<{ employee_id: string; contract_type: string }>(`SELECT employee_id, contract_type FROM app.employee_contracts WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to > $1)`, [asOf])).map((c) => [c.employee_id, c.contract_type]));
          const policies = new Map(
            (
              await tx.query<{ employee_id: string; name: string; config: { accrual: { method: string; percent?: number; days?: number } } }>(
                `SELECT a.employee_id, p.name, p.config FROM app.leave_policy_assignments a JOIN app.leave_policies p ON p.tenant_id = a.tenant_id AND p.id = a.policy_id
                   JOIN app.leave_types t ON t.tenant_id = a.tenant_id AND t.id = a.leave_type_id
                  WHERE t.key = 'annual' AND a.valid_from <= $1 AND (a.valid_to IS NULL OR a.valid_to > $1)`,
                [asOf],
              )
            ).map((p) => [p.employee_id, p]),
          );
          const out = [];
          for (const e of emps) {
            const basis = contracts.get(e.id) === 'zero_hours' ? 'zero_hours_contract' : jobs.get(e.id) === 'casual' ? 'casual' : null;
            if (!basis) continue;
            const jur = jurisdictionOf(e) ?? 'GB';
            const rule = book.tryResolve<IrregularHoursRule>(jur, 'leave.irregular_hours_accrual', asOf);
            const pol = policies.get(e.id) ?? null;
            const check = rule ? irregularHoursPolicyCheck(rule.value, pol ? { accrual: pol.config.accrual } : null) : { ok: false, issue: 'rule_not_modelled' };
            out.push({ employeeId: e.id, employeeName: e.display_name, jurisdiction: jur, basis, policyName: pol?.name ?? null, ok: check.ok, issue: check.issue, statutoryPercent: rule?.value.accrualPercentOfHoursWorked ?? null, source: rule?.source ?? null });
          }
          return out;
        },
        { readOnly: true },
      );
    },
  );

  // ---- UK SSP (reads the leave module's statutory-pay endpoint for each employee) -------------------
  app.get(
    '/v1/compliance/uk/ssp',
    { schema: { tags: ['compliance'], summary: 'Statutory Sick Pay position of GB employees with sickness in the last year (from /v1/sickness/{employeeId}/statutory-pay)', querystring: Type.Object({ asOf: Type.Optional(CivilDate) }), response: { 200: Type.Array(Type.Object({ employeeId: Uuid, employeeName: Type.String(), scheme: Nullable(Type.String()), result: Type.Any(), source: Nullable(Source) })), 403: Problem } } },
    async (req) => {
      authorizeSome(req, 'compliance.read');
      const asOf = asOfOf(req, (req.query as { asOf?: string }).asOf);
      const emps = await app.tenantTx(req, (tx) => employeesIn(tx, req, 'compliance.read', `coalesce(e.country, fl.country, le.country) = 'GB' AND EXISTS (SELECT 1 FROM app.sickness_records s WHERE s.tenant_id = e.tenant_id AND s.employee_id = e.id AND s.start_date >= $1::date - 365 AND s.start_date <= $1)`, [asOf]), { readOnly: true });
      const out = [];
      for (const e of emps.slice(0, 500)) {
        const res = await app.inject({ method: 'GET', url: `/v1/sickness/${e.id}/statutory-pay?asOf=${asOf}`, headers: { cookie: req.headers.cookie ?? '', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) } });
        if (res.statusCode !== 200) {
          out.push({ employeeId: e.id, employeeName: e.display_name, scheme: null, result: { status: res.statusCode }, source: null });
          continue;
        }
        const body = res.json() as { scheme: string; result: unknown; source: { url: string; title: string } | null };
        out.push({ employeeId: e.id, employeeName: e.display_name, scheme: body.scheme, result: body.result, source: body.source });
      }
      return out;
    },
  );

  // ---- US paid sick leave and FMLA coverage; EU baseline and member-state leave -----------------------
  app.get(
    '/v1/compliance/leave-coverage',
    { schema: { tags: ['compliance'], summary: 'Statutory leave rules that apply where the tenant employs people (US state/local paid sick leave and FMLA; EU baseline and member-state leave, sick pay and notice)', querystring: Type.Object({ asOf: Type.Optional(CivilDate) }), response: { 200: Type.Object({ asOf: Type.String(), us: Type.Object({ paidSickLeave: Type.Array(Type.Object({ jurisdiction: Type.String(), employees: Type.Integer(), answeredBy: Nullable(Type.String()), modelled: Type.Boolean(), summary: Type.Any(), source: Nullable(Source) })), fmla: Nullable(Type.Object({ usEmployees: Type.Integer(), coveredEmployer: Type.Boolean(), minEmployees: Type.Integer(), openCases: Type.Integer(), source: Source })) }), eu: Type.Array(Type.Object({ country: Type.String(), employees: Type.Integer(), rules: Type.Array(Type.Object({ key: Type.String(), answeredBy: Nullable(Type.String()), modelled: Type.Boolean(), source: Nullable(Source), verifiedOn: Nullable(Type.String()) })), publicHolidays: Type.Integer() })) }), 403: Problem } } },
    async (req) => {
      authorizeSome(req, 'compliance.read');
      const asOf = asOfOf(req, (req.query as { asOf?: string }).asOf);
      const book = await ruleBook(app);
      return app.tenantTx(
        req,
        async (tx) => {
          const emps = await employeesIn(tx, req, 'compliance.read', `e.status <> 'leaver'`);
          const usCodes = new Map<string, number>();
          const euCountries = new Map<string, number>();
          for (const e of emps) {
            if (e.country === 'US') {
              const j = jurisdictionOf(e) ?? 'US';
              usCodes.set(j, (usCodes.get(j) ?? 0) + 1);
            } else if (e.country && book.pack(e.country)?.parent === 'EU') euCountries.set(e.country, (euCountries.get(e.country) ?? 0) + 1);
          }
          const paidSickLeave = [...usCodes.entries()].sort().map(([j, n]) => {
            const r = book.tryResolve(j, 'sick_pay.paid_sick_leave_accrual', asOf);
            return { jurisdiction: j, employees: n, answeredBy: r?.jurisdiction ?? null, modelled: !!r && r.jurisdiction !== 'US', summary: r?.value ?? null, source: r?.source ?? null };
          });
          let fmla = null;
          const usTotal = [...usCodes.values()].reduce((s, n) => s + n, 0);
          const f = usTotal ? book.tryResolve<{ coveredEmployer: { privateSectorMinEmployees: number } }>('US', 'family_leave.fmla', asOf) : undefined;
          if (f) {
            const open = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.fmla_cases WHERE status = 'open'`)).n;
            fmla = { usEmployees: usTotal, coveredEmployer: usTotal >= f.value.coveredEmployer.privateSectorMinEmployees, minEmployees: f.value.coveredEmployer.privateSectorMinEmployees, openCases: open, source: f.source };
          }
          const { year } = dateParts(asOf);
          const eu = [...euCountries.entries()].sort().map(([c, n]) => ({
            country: c,
            employees: n,
            rules: ['leave.statutory_annual_minimum', 'sick_pay.statutory', 'employment.notice_period', 'working_time.max_weekly_hours', 'reporting.pay_transparency'].map((key) => {
              const r = book.tryResolve(c, key, asOf);
              return { key, answeredBy: r?.jurisdiction ?? null, modelled: !!r, source: r?.source ?? null, verifiedOn: r?.verifiedOn ?? null };
            }),
            publicHolidays: book.holidays(c, year).length,
          }));
          return { asOf, us: { paidSickLeave, fmla }, eu };
        },
        { readOnly: true },
      );
    },
  );

}
