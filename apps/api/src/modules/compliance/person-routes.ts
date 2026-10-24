import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { can } from '@thapsus/core/permissions';
import { instantToDate } from '@thapsus/core/time';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { loadTarget } from '../employees/service';
import { ruleBook } from '../rules/routes';
import { complianceSettings, EMPLOYEE_COLUMNS, EMPLOYEE_FROM, jurisdictionOf, type EmployeeRow } from './service';
import { i9Statuses, matrixCells, rtwStatuses, type ReqRow } from './status';

const Check = Type.Object({
  id: Uuid,
  checkMethod: Type.String(),
  listType: Type.String(),
  checkedOn: Type.String(),
  followUpDueOn: Nullable(Type.String()),
  excuseEndsOn: Nullable(Type.String()),
  current: Type.Boolean(),
  hasEvidence: Type.Boolean(),
});

/**
 * One person's compliance (ADR-0161): what the compliance lists show about them, on their profile.
 * UK right to work with every check recorded, the US Form I-9, and the requirements of the matrix that
 * apply to them. Follow-up dates reveal time-limited immigration permission, so each view is audited as
 * sensitive, as the right-to-work list is.
 */
export async function personComplianceRoutes(app: FastifyInstance) {
  const deps = app.deps;
  app.get(
    '/v1/compliance/people/:employeeId',
    {
      schema: {
        tags: ['compliance'],
        summary:
          "One person's right to work (every check), Form I-9 and compliance requirements, for their profile",
        params: Type.Object({ employeeId: Uuid }),
        response: {
          200: Type.Object({
            employeeId: Uuid,
            employeeName: Type.String(),
            jurisdiction: Nullable(Type.String()),
            rightToWork: Nullable(
              Type.Object({
                status: Type.String(),
                retainUntil: Nullable(Type.String()),
                checks: Type.Array(Check),
              }),
            ),
            i9: Nullable(
              Type.Object({
                status: Type.String(),
                recordId: Nullable(Uuid),
                section1CompletedOn: Nullable(Type.String()),
                section2DueOn: Nullable(Type.String()),
                section2CompletedOn: Nullable(Type.String()),
                reverificationDueOn: Nullable(Type.String()),
              }),
            ),
            requirements: Type.Array(
              Type.Object({
                requirementId: Uuid,
                name: Type.String(),
                kind: Type.String(),
                status: Type.String(),
                issuedOn: Nullable(Type.String()),
                expiresOn: Nullable(Type.String()),
              }),
            ),
          }),
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { employeeId } = req.params as { employeeId: string };
      const asOf = instantToDate(deps.now().toISOString(), auth.user.timeZone ?? 'UTC');
      const book = await ruleBook(app);
      return app.tenantTx(req, async (tx) => {
        const e = await tx.maybe<EmployeeRow>(
          `SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE e.id = $1`,
          [employeeId],
        );
        if (!e) throw new ApiError('notFound');
        if (!can(auth.principal, 'compliance.read', await loadTarget(tx, e.id))) throw new ApiError('forbidden');
        const settings = await complianceSettings(tx);
        const jurisdiction = jurisdictionOf(e);
        let rightToWork = null;
        if (e.country === 'GB') {
          const [row] = await rtwStatuses(tx, book, [e], asOf, settings);
          const checks = await tx.query<{
            id: string;
            check_method: string;
            list_type: string;
            checked_on: string;
            follow_up_due_on: string | null;
            excuse_ends_on: string | null;
            superseded_by: string | null;
            evidence_vault_id: string | null;
          }>(
            `SELECT id, check_method, list_type, checked_on::text, follow_up_due_on::text, excuse_ends_on::text, superseded_by, evidence_vault_id
               FROM app.rtw_checks WHERE employee_id = $1 ORDER BY checked_on DESC, created_at DESC LIMIT 50`,
            [e.id],
          );
          rightToWork = {
            // starters far in the future need no check yet: the list leaves them out, the profile says so
            status: row?.status ?? 'not_due',
            retainUntil: row?.retainUntil ?? null,
            checks: checks.map((c) => ({
              id: c.id,
              checkMethod: c.check_method,
              listType: c.list_type,
              checkedOn: c.checked_on,
              followUpDueOn: c.follow_up_due_on,
              excuseEndsOn: c.excuse_ends_on,
              current: !c.superseded_by,
              hasEvidence: !!c.evidence_vault_id,
            })),
          };
        }
        let i9 = null;
        if (e.country === 'US') {
          const [row] = await i9Statuses(tx, book, [e], asOf, settings);
          if (row)
            i9 = {
              status: row.status,
              recordId: row.record?.id ?? null,
              section1CompletedOn: row.record?.section1_completed_on ?? null,
              section2DueOn: row.record?.section2_due_on ?? null,
              section2CompletedOn: row.record?.section2_completed_on ?? null,
              reverificationDueOn: row.record?.reverification_due_on ?? null,
            };
        }
        const reqs = await tx.query<ReqRow>(
          'SELECT * FROM app.compliance_requirements WHERE active ORDER BY name',
        );
        const cells = await matrixCells(tx, [e], reqs, asOf, settings);
        await app.audit(tx, req, {
          action: 'compliance.person_viewed',
          targetType: 'employee',
          targetId: e.id,
          diff: { rightToWork: !!rightToWork, i9: !!i9, requirements: cells.length },
          sensitive: true,
        });
        return {
          employeeId: e.id,
          employeeName: e.display_name,
          jurisdiction,
          rightToWork,
          i9,
          requirements: cells.map((c) => ({
            requirementId: c.requirement.id,
            name: c.requirement.name,
            kind: c.requirement.kind,
            status: c.status,
            issuedOn: c.record?.issued_on ?? null,
            expiresOn: c.expiresOn,
          })),
        };
      });
    },
  );
}
