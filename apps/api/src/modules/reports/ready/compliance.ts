import { Type, type Static } from 'typebox';
import { ApiError } from '../../../http/errors';
import { CivilDate, Uuid } from '../../../http/schemas';
import { eeo1Report, genderPayGapReport, payTransparencyReport } from '../../compliance/reporting';
import { complianceSettings, EMPLOYEE_COLUMNS, EMPLOYEE_FROM, type EmployeeRow } from '../../compliance/service';
import { i9Statuses, matrixCells, rtwStatuses, type ReqRow } from '../../compliance/status';
import { compareDates } from '@thapsus/core/time';
import { rowScope } from '../access';
import type { Cell, Column, ReportContext, ReportDefinition, Row } from '../types';

/**
 * Statutory and compliance reports, wired to the phase 5 compliance centre (apps/api/src/modules/compliance):
 * the same functions serve /v1/compliance/reports/* and these ready-made reports, so figures always agree.
 * Sex and EEO-1 self-identification are only read through the compliance module's vault-backed aggregates
 * (EEO-1 with small-cell suppression); no individual value reaches a report row.
 */
const pct = (v: number | null | undefined): Cell => (v === null || v === undefined ? null : v.toFixed(1));

function needCompliance(ctx: ReportContext) {
  if (!ctx.compliance) throw new ApiError('unprocessable', 'Statutory reports need the compliance centre');
  return ctx.compliance;
}

// ---- UK gender pay gap -----------------------------------------------------------------------------------
const GpgParams = Type.Object({ year: Type.Integer({ minimum: 2017, maximum: 2100 }), sector: Type.Optional(Type.Union([Type.Literal('privateAndVoluntary'), Type.Literal('publicAuthority')])), entityId: Type.Optional(Uuid) }, { additionalProperties: false });
export const genderPayGapReportDef: ReportDefinition<Static<typeof GpgParams>> = {
  id: 'gender-pay-gap',
  category: 'compliance',
  titleKey: 'reports.ready.genderPayGap.title',
  descriptionKey: 'reports.ready.genderPayGap.description',
  permission: 'compliance.reports',
  jurisdictions: ['GB'],
  sensitivity: 'special',
  params: GpgParams,
  status: 'available',
  async run(ctx, p) {
    const r = await needCompliance(ctx)((c) => genderPayGapReport(c, p));
    const f = r.figures;
    const rows: Row[] = [
      { measure: ctx.t('compliance.gpg.meanHourly'), gap: pct(f.meanHourlyPayGap), men: null, women: null },
      { measure: ctx.t('compliance.gpg.medianHourly'), gap: pct(f.medianHourlyPayGap), men: null, women: null },
      { measure: ctx.t('compliance.gpg.meanBonus'), gap: pct(f.meanBonusGap), men: null, women: null },
      { measure: ctx.t('compliance.gpg.medianBonus'), gap: pct(f.medianBonusGap), men: null, women: null },
      { measure: ctx.t('reports.gpg.bonusProportion'), gap: null, men: pct(f.bonusProportions.male), women: pct(f.bonusProportions.female) },
      ...f.quartiles.map((q) => ({ measure: ctx.t(`compliance.band.${q.band}`), gap: null, men: pct(q.malePercent), women: pct(q.femalePercent) })),
    ];
    return {
      columns: [
        { key: 'measure', labelKey: 'reports.col.measure', type: 'text' },
        { key: 'gap', labelKey: 'reports.col.gap', type: 'percent', scale: 1 },
        { key: 'men', labelKey: 'compliance.gpg.men', type: 'percent', scale: 1 },
        { key: 'women', labelKey: 'compliance.gpg.women', type: 'percent', scale: 1 },
      ],
      rows,
      facts: [
        { key: 'snapshotDate', labelKey: 'reports.fact.snapshotDate', type: 'date', value: r.snapshotDate },
        { key: 'deadline', labelKey: 'reports.fact.deadline', type: 'date', value: r.deadline },
        { key: 'headcount', labelKey: 'reports.fact.headcount', type: 'integer', value: r.headcount },
        { key: 'threshold', labelKey: 'reports.fact.threshold', type: 'integer', value: r.employeeThreshold },
        { key: 'required', labelKey: 'reports.fact.required', type: 'boolean', value: r.required },
        { key: 'relevantEmployees', labelKey: 'reports.fact.relevantEmployees', type: 'integer', value: r.population.relevantEmployees },
        { key: 'excludedNoSexRecorded', labelKey: 'reports.fact.excludedNoSex', type: 'integer', value: r.population.excludedNoSexRecorded },
        { key: 'dataSource', labelKey: 'reports.fact.dataSource', type: 'enum', enumKey: 'compliance.gpg.dataSource', value: r.dataSource },
        { key: 'source', labelKey: 'reports.fact.source', type: 'text', value: `${r.source.title} — ${r.source.url}` },
      ],
      notes: ['reports.note.complianceAggregates'],
      sensitive: true,
    };
  },
};

// ---- EEO-1 Component 1 -----------------------------------------------------------------------------------
const Eeo1Params = Type.Object({ year: Type.Integer({ minimum: 2020, maximum: 2100 }), snapshotDate: Type.Optional(CivilDate) }, { additionalProperties: false });
export const eeo1ReportDef: ReportDefinition<Static<typeof Eeo1Params>> = {
  id: 'eeo-1',
  category: 'compliance',
  titleKey: 'reports.ready.eeo1.title',
  descriptionKey: 'reports.ready.eeo1.description',
  permission: 'compliance.reports',
  jurisdictions: ['US'],
  sensitivity: 'special',
  params: Eeo1Params,
  status: 'available',
  async run(ctx, p) {
    // never the exact (unsuppressed) table from a report: exports and schedules leave the compliance centre
    const r = await needCompliance(ctx)((c) => eeo1Report(c, { year: p.year, snapshotDate: p.snapshotDate, exact: false }));
    const cellKey = (race: string, sex: string) => `${race}__${sex}`;
    const columns: Column[] = [
      { key: 'jobCategory', labelKey: 'reports.col.jobCategory', type: 'enum', enumKey: 'compliance.job' },
      ...r.rule.raceEthnicityCategories.flatMap((race) => r.rule.sexCategories.map((sex): Column => ({ key: cellKey(race, sex), labelKey: `compliance.race.${race}`, subLabelKey: `compliance.sex.${sex}`, type: 'integer' }))),
      { key: 'total', labelKey: 'reports.col.total', type: 'integer' },
    ];
    const rows: Row[] = r.table.map((t) => ({ jobCategory: t.jobCategory, ...Object.fromEntries(t.cells.map((c) => [cellKey(c.raceEthnicity, c.sex), c.count])), total: t.total }));
    return {
      columns,
      rows,
      facts: [
        { key: 'snapshotDate', labelKey: 'reports.fact.snapshotDate', type: 'date', value: r.snapshotDate },
        { key: 'windowFrom', labelKey: 'reports.fact.windowFrom', type: 'date', value: r.window.from },
        { key: 'windowTo', labelKey: 'reports.fact.windowTo', type: 'date', value: r.window.to },
        { key: 'headcount', labelKey: 'reports.fact.headcount', type: 'integer', value: r.totalEmployees },
        { key: 'threshold', labelKey: 'reports.fact.threshold', type: 'integer', value: r.threshold },
        { key: 'required', labelKey: 'reports.fact.required', type: 'boolean', value: r.required },
        { key: 'notReported', labelKey: 'reports.fact.notReported', type: 'integer', value: r.notReported },
        { key: 'unmappedJobs', labelKey: 'reports.fact.unmappedJobs', type: 'integer', value: r.unmappedJobs },
        { key: 'suppressionThreshold', labelKey: 'reports.fact.suppressionThreshold', type: 'integer', value: r.suppressionThreshold },
        { key: 'source', labelKey: 'reports.fact.source', type: 'text', value: `${r.source.title} — ${r.source.url}` },
      ],
      notes: ['reports.note.complianceAggregates', 'reports.note.suppressed'],
      sensitive: true,
    };
  },
};

// ---- EU pay transparency -----------------------------------------------------------------------------
const PtParams = Type.Object({ year: Type.Integer({ minimum: 2026, maximum: 2100 }), entityId: Type.Optional(Uuid) }, { additionalProperties: false });
export const payTransparencyReportDef: ReportDefinition<Static<typeof PtParams>> = {
  id: 'pay-transparency',
  category: 'compliance',
  titleKey: 'reports.ready.payTransparency.title',
  descriptionKey: 'reports.ready.payTransparency.description',
  permission: 'compliance.reports',
  jurisdictions: ['EU'],
  sensitivity: 'special',
  params: PtParams,
  status: 'available',
  async run(ctx, p) {
    const entities = await needCompliance(ctx)((c) => payTransparencyReport(c, p));
    const rows: Row[] = entities.map((e) => {
      const i = e.indicators;
      return {
        entity: e.entityName,
        country: e.country,
        transposition: e.transposition.status,
        workers: i.population.workers,
        reportingRequired: i.obligation.reportingRequired,
        firstReportBy: 'firstReportBy' in i.obligation ? (i.obligation.firstReportBy ?? null) : null,
        genderPayGap: pct(i.genderPayGap),
        medianGenderPayGap: pct(i.medianGenderPayGap),
        variablePayGap: pct(i.genderPayGapVariable),
        variableMen: pct(i.proportionReceivingVariable.male),
        variableWomen: pct(i.proportionReceivingVariable.female),
        jointPayAssessmentCategories: i.jointPayAssessment.categoriesIndicated.length,
      };
    });
    return {
      columns: [
        { key: 'entity', labelKey: 'reports.groupBy.entity', type: 'text' },
        { key: 'country', labelKey: 'reports.groupBy.country', type: 'text' },
        { key: 'transposition', labelKey: 'reports.col.transposition', type: 'enum', enumKey: 'compliance.ptStatus' },
        { key: 'workers', labelKey: 'reports.col.workers', type: 'integer' },
        { key: 'reportingRequired', labelKey: 'reports.fact.required', type: 'boolean' },
        { key: 'firstReportBy', labelKey: 'reports.col.firstReportBy', type: 'date' },
        { key: 'genderPayGap', labelKey: 'compliance.pt.gap', type: 'percent', scale: 1 },
        { key: 'medianGenderPayGap', labelKey: 'compliance.pt.medianGap', type: 'percent', scale: 1 },
        { key: 'variablePayGap', labelKey: 'compliance.pt.variableGap', type: 'percent', scale: 1 },
        { key: 'variableMen', labelKey: 'compliance.pt.variableMen', type: 'percent', scale: 1 },
        { key: 'variableWomen', labelKey: 'compliance.pt.variableWomen', type: 'percent', scale: 1 },
        { key: 'jointPayAssessmentCategories', labelKey: 'reports.col.jpaCategories', type: 'integer' },
      ],
      rows,
      notes: ['reports.note.complianceAggregates', 'reports.note.payTransparencyInterpretation'],
      sensitive: true,
    };
  },
};

// ---- compliance status ---------------------------------------------------------------------------------
const StatusParams = Type.Object({ asOf: CivilDate }, { additionalProperties: false });
const RTW = ['missing', 'valid', 'follow_up_due', 'expired', 'retention'] as const;
const I9 = ['missing', 'section1_due', 'section2_due', 'section2_overdue', 'reverification_due', 'reverification_overdue', 'complete'] as const;
const MATRIX = ['compliant', 'expiring', 'expired', 'missing'] as const;
export const complianceStatusReportDef: ReportDefinition<Static<typeof StatusParams>> = {
  id: 'compliance-status',
  category: 'compliance',
  titleKey: 'reports.ready.complianceStatus.title',
  descriptionKey: 'reports.ready.complianceStatus.description',
  permission: 'compliance.read',
  jurisdictions: ['*'],
  sensitivity: 'personal',
  params: StatusParams,
  status: 'available',
  async run(ctx, p) {
    // status calculations are shared with the compliance dashboard and the reminder job (no vault access)
    const params: unknown[] = [];
    const scope = rowScope(ctx.principal, 'compliance.read', params);
    const emps = await ctx.tx.query<EmployeeRow>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE ${scope}`, params);
    const settings = await complianceSettings(ctx.tx);
    const current = emps.filter((e) => e.status !== 'leaver' && (!e.end_date || compareDates(e.end_date, p.asOf) >= 0));
    const rtw = await rtwStatuses(ctx.tx, ctx.book, emps.filter((e) => e.country === 'GB'), p.asOf, settings);
    const i9 = await i9Statuses(ctx.tx, ctx.book, emps.filter((e) => e.country === 'US'), p.asOf, settings);
    const reqs = await ctx.tx.query<ReqRow>('SELECT * FROM app.compliance_requirements WHERE active');
    const cells = await matrixCells(ctx.tx, current, reqs, p.asOf, settings);
    const rows: Row[] = [];
    const push = (area: string, statuses: readonly string[], items: Array<{ status: string }>) => {
      if (!items.length) return;
      for (const s of statuses) rows.push({ area: ctx.t(area), status: s, count: items.filter((x) => x.status === s).length });
    };
    push('compliance.dashboard.rtwTitle', RTW, rtw);
    push('compliance.dashboard.i9Title', I9, i9);
    push('compliance.dashboard.matrixTitle', MATRIX, cells);
    return {
      columns: [
        { key: 'area', labelKey: 'reports.col.area', type: 'text' },
        { key: 'status', labelKey: 'reports.col.status', type: 'enum', enumKey: 'compliance.status' },
        { key: 'count', labelKey: 'reports.col.count', type: 'integer' },
      ],
      rows,
      chart: { type: 'bar', x: 'status', y: ['count'] },
      notes: ['reports.note.complianceStatus'],
    };
  },
};
