import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { Type, type Static } from 'typebox';
import { compareDates, dateParts, instantToDate } from '@thapsus/core/time';
import { canSome } from '@thapsus/core/permissions';
import { authorize, authorizeSome } from '../../http/context';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { scopePredicate } from '../employees/service';
import { ruleBook } from '../rules/routes';
import { eeo1SnapshotWindow, gpgDates, type Eeo1Rule, type PayTransparencyRule } from './engine';
import { immigrationRoutes } from './immigration-routes';
import { matrixRoutes } from './matrix-routes';
import { reportRoutes } from './report-routes';
import { lawChangeRoutes, relevantLawChanges } from './law-change-routes';
import {
  COMPLIANCE_DEFAULTS,
  complianceSettings,
  EMPLOYEE_COLUMNS,
  EMPLOYEE_FROM,
  tenantJurisdictionCodes,
  type EmployeeRow,
} from './service';
import { i9Statuses, matrixCells, rtwStatuses, serviceAlerts, type ReqRow } from './status';
import './jobs';

const Offsets = Type.Array(Type.Integer({ minimum: 0, maximum: 730 }), { minItems: 1, maxItems: 10 });
const Settings = Type.Object({
  rtwReminderDays: Offsets,
  i9ReminderDays: Offsets,
  matrixReminderDays: Offsets,
  probationReminderDays: Offsets,
  serviceReminderDays: Offsets,
  smallCellThreshold: Type.Integer({ minimum: 3, maximum: 50 }),
  businessWeekdays: Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7 }),
  gpgSector: Type.Union([Type.Literal('privateAndVoluntary'), Type.Literal('publicAuthority')]),
});
const Alert = Type.Object({
  kind: Type.String(),
  employeeId: Uuid,
  employeeName: Type.String(),
  dueOn: Type.String(),
  daysLeft: Type.Integer(),
  qualifyingPeriod: Nullable(Type.String()),
  source: Nullable(Type.Object({ url: Type.String(), title: Type.String() })),
});
const Count = Type.Integer();

/** Compliance centre (BUILD_BRIEF 6.4): dashboard, settings, alerts and the content routes. */
export async function complianceRoutes(app: FastifyInstance) {
  const deps = app.deps;
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  app.get(
    '/v1/settings/compliance',
    {
      schema: {
        tags: ['compliance'],
        summary:
          'Compliance reminder and reporting settings (product settings; statutory values come from the jurisdiction packs)',
        response: { 200: Settings, 403: Problem },
      },
    },
    async (req) => {
      authorizeSome(req, 'compliance.read');
      return app.tenantTx(req, (tx) => complianceSettings(tx), { readOnly: true });
    },
  );

  app.put(
    '/v1/settings/compliance',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['compliance'],
        body: Type.Partial(Settings),
        response: { 200: Settings, 403: Problem },
      },
    },
    async (req) => {
      authorize(req, 'compliance.manage');
      const patch = req.body as Partial<Static<typeof Settings>>;
      return app.tenantTx(req, async (tx) => {
        const before = await complianceSettings(tx);
        const next = { ...COMPLIANCE_DEFAULTS, ...before, ...patch };
        await tx.exec(`UPDATE app.tenants SET features = jsonb_set(features, '{compliance}', $1::jsonb)`, [
          JSON.stringify(next),
        ]);
        await app.audit(tx, req, {
          action: 'settings.compliance_updated',
          targetType: 'tenant',
          diff: { before, after: next },
        });
        return next;
      });
    },
  );

  app.get(
    '/v1/compliance/alerts',
    {
      schema: {
        tags: ['compliance'],
        summary:
          'Probation end dates and the date unfair dismissal protection begins (qualifying period effective-dated from the packs)',
        querystring: Type.Object({
          asOf: Type.Optional(CivilDate),
          withinDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 730 })),
        }),
        response: { 200: Type.Array(Alert), 403: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'compliance.read');
      const q = req.query as { asOf?: string; withinDays?: number };
      const asOf = q.asOf ?? instantToDate(deps.now().toISOString(), auth.user.timeZone ?? 'UTC');
      const book = await ruleBook(app);
      return app.tenantTx(
        req,
        async (tx) => {
          const params: unknown[] = [];
          const emps = await tx.query<EmployeeRow>(
            `SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE e.status <> 'leaver' AND ${scopePredicate(auth.principal, 'compliance.read', params)}`,
            params,
          );
          return (await serviceAlerts(tx, book, emps, asOf, await complianceSettings(tx), q.withinDays)).map(
            (a) => ({
              kind: a.kind,
              employeeId: a.employee.id,
              employeeName: a.employee.display_name,
              dueOn: a.dueOn,
              daysLeft: a.daysLeft,
              qualifyingPeriod: a.qualifyingPeriod ?? null,
              source: a.source ?? null,
            }),
          );
        },
        { readOnly: true },
      );
    },
  );

  app.get(
    '/v1/compliance/dashboard',
    {
      schema: {
        tags: ['compliance'],
        summary: "Compliance status overview for the caller's scope on a date",
        querystring: Type.Object({ asOf: Type.Optional(CivilDate) }),
        response: {
          200: Type.Object({
            asOf: Type.String(),
            rightToWork: Type.Object({
              total: Count,
              missing: Count,
              valid: Count,
              followUpDue: Count,
              expired: Count,
              retention: Count,
            }),
            i9: Type.Object({
              total: Count,
              missing: Count,
              incomplete: Count,
              overdue: Count,
              reverificationDue: Count,
              complete: Count,
            }),
            matrix: Type.Object({ compliant: Count, expiring: Count, expired: Count, missing: Count }),
            alerts: Type.Array(Alert),
            reporting: Type.Object({
              genderPayGap: Nullable(
                Type.Object({
                  headcount: Count,
                  threshold: Count,
                  required: Type.Boolean(),
                  snapshotDate: Type.String(),
                  deadline: Type.String(),
                }),
              ),
              eeo1: Nullable(
                Type.Object({
                  usEmployees: Count,
                  threshold: Count,
                  required: Type.Boolean(),
                  window: Type.Object({ from: Type.String(), to: Type.String() }),
                }),
              ),
              payTransparency: Type.Array(
                Type.Object({
                  entityId: Uuid,
                  entityName: Type.String(),
                  country: Type.String(),
                  status: Type.String(),
                  workers: Count,
                  reportingRequired: Type.Boolean(),
                  firstReportBy: Nullable(Type.String()),
                }),
              ),
            }),
            lawChanges: Type.Object({ relevant: Count, unacknowledged: Count }),
          }),
          403: Problem,
        },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'compliance.read');
      const asOf =
        (req.query as { asOf?: string }).asOf ??
        instantToDate(deps.now().toISOString(), auth.user.timeZone ?? 'UTC');
      const book = await ruleBook(app);
      const data = await app.tenantTx(
        req,
        async (tx) => {
          const settings = await complianceSettings(tx);
          const params: unknown[] = [];
          const emps = await tx.query<EmployeeRow>(
            `SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE ${scopePredicate(auth.principal, 'compliance.read', params)}`,
            params,
          );
          const current = emps.filter(
            (e) => e.status !== 'leaver' && (!e.end_date || compareDates(e.end_date, asOf) >= 0),
          );
          const rtw = await rtwStatuses(
            tx,
            book,
            emps.filter((e) => e.country === 'GB'),
            asOf,
            settings,
          );
          const i9 = await i9Statuses(
            tx,
            book,
            emps.filter((e) => e.country === 'US'),
            asOf,
            settings,
          );
          const reqs = await tx.query<ReqRow>('SELECT * FROM app.compliance_requirements WHERE active');
          const cells = await matrixCells(tx, current, reqs, asOf, settings);
          const alerts = await serviceAlerts(tx, book, current, asOf, settings);
          const n = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
          // reporting obligations: thresholds, snapshot dates and deadlines from the packs
          const { year } = dateParts(asOf);
          let genderPayGap = null;
          const gb = current.filter((e) => e.country === 'GB');
          const gpg = gb.length
            ? book.tryResolve<Parameters<typeof gpgDates>[0] & { employeeThreshold: number }>(
                'GB',
                'reporting.gender_pay_gap',
                asOf,
              )
            : undefined;
          if (gpg) {
            let d = gpgDates(gpg.value, year, settings.gpgSector);
            if (compareDates(d.snapshotDate, asOf) > 0) d = gpgDates(gpg.value, year - 1, settings.gpgSector);
            const headcount = n(gb, (e) => compareDates(e.start_date, d.snapshotDate) <= 0);
            genderPayGap = {
              headcount,
              threshold: gpg.value.employeeThreshold,
              required: headcount >= gpg.value.employeeThreshold,
              ...d,
            };
          }
          let eeo1 = null;
          const us = current.filter((e) => e.country === 'US');
          const eeo = us.length ? book.tryResolve<Eeo1Rule>('US', 'reporting.eeo1', asOf) : undefined;
          if (eeo)
            eeo1 = {
              usEmployees: us.length,
              threshold: eeo.value.privateEmployerMinEmployees,
              required: us.length >= eeo.value.privateEmployerMinEmployees,
              window: eeo1SnapshotWindow(eeo.value, year),
            };
          const entities = await tx.query<{ id: string; name: string; country: string }>(
            'SELECT id, name, country FROM app.legal_entities ORDER BY name',
          );
          const payTransparency = entities
            .filter((en) => book.pack(en.country)?.parent === 'EU')
            .flatMap((en) => {
              const st = book.tryResolve<{ status: string }>(en.country, 'reporting.pay_transparency', asOf);
              const dir = book.tryResolve<PayTransparencyRule>('EU', 'reporting.pay_transparency', asOf);
              if (!st || !dir || st.jurisdiction === 'EU') return [];
              const workers = n(current, (e) => e.entity_id === en.id);
              const band = dir.value.gapReporting.find(
                (b) => workers >= b.minWorkers && (b.maxWorkers === null || workers <= b.maxWorkers),
              );
              return [
                {
                  entityId: en.id,
                  entityName: en.name,
                  country: en.country,
                  status: st.value.status,
                  workers,
                  reportingRequired: !!band,
                  firstReportBy: band?.firstReportBy ?? null,
                },
              ];
            });
          return {
            asOf,
            rightToWork: {
              total: rtw.length,
              missing: n(rtw, (r) => r.status === 'missing'),
              valid: n(rtw, (r) => r.status === 'valid'),
              followUpDue: n(rtw, (r) => r.status === 'follow_up_due'),
              expired: n(rtw, (r) => r.status === 'expired'),
              retention: n(rtw, (r) => r.status === 'retention'),
            },
            i9: {
              total: i9.length,
              missing: n(i9, (r) => r.status === 'missing'),
              incomplete: n(i9, (r) => r.status === 'section1_due' || r.status === 'section2_due'),
              overdue: n(i9, (r) => r.status === 'section2_overdue' || r.status === 'reverification_overdue'),
              reverificationDue: n(i9, (r) => r.status === 'reverification_due'),
              complete: n(i9, (r) => r.status === 'complete'),
            },
            matrix: {
              compliant: n(cells, (c) => c.status === 'compliant'),
              expiring: n(cells, (c) => c.status === 'expiring'),
              expired: n(cells, (c) => c.status === 'expired'),
              missing: n(cells, (c) => c.status === 'missing'),
            },
            alerts: alerts.slice(0, 50).map((a) => ({
              kind: a.kind,
              employeeId: a.employee.id,
              employeeName: a.employee.display_name,
              dueOn: a.dueOn,
              daysLeft: a.daysLeft,
              qualifyingPeriod: a.qualifyingPeriod ?? null,
              source: a.source ?? null,
            })),
            reporting: { genderPayGap, eeo1, payTransparency },
            codes: await tenantJurisdictionCodes(tx),
          };
        },
        { readOnly: true },
      );
      let lawChanges = { relevant: 0, unacknowledged: 0 };
      if (canSome(auth.principal, 'compliance.law_changes')) {
        const entries = await relevantLawChanges(app, data.codes);
        const acked = await app.tenantTx(
          req,
          (tx) =>
            tx.query<{ law_change_id: string }>(
              `SELECT law_change_id FROM app.law_change_reads WHERE user_id = $1 AND acknowledged_at IS NOT NULL`,
              [auth.userId],
            ),
          { readOnly: true },
        );
        lawChanges = {
          relevant: entries.length,
          unacknowledged: entries.filter((e) => !acked.some((a) => a.law_change_id === e.id)).length,
        };
      }
      const { codes: _codes, ...rest } = data;
      void _codes;
      return { ...rest, lawChanges };
    },
  );

  await immigrationRoutes(app);
  await matrixRoutes(app);
  await reportRoutes(app);
  await lawChangeRoutes(app);
}
