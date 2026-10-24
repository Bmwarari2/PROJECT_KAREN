import type { FastifyInstance, FastifyRequest } from 'fastify';
import { matchesMagic } from '../../lib/file-types';
import { Type } from 'typebox';
import { can } from '@thapsus/core/permissions';
import { instantToDate } from '@thapsus/core/time';
import { authorizeSome, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { objectKey } from '../../lib/object-store';
import { ruleBook } from '../rules/routes';
import { Vault } from '../vault/service';
import {
  i9Deadlines,
  i9RetainUntil,
  i9Reverification,
  rtwFollowUp,
  RtwInputError,
  type I9CompletionRule,
  type RtwDocumentRules,
  type RtwListType,
} from './engine';
import {
  complianceSettings,
  EMPLOYEE_COLUMNS,
  EMPLOYEE_FROM,
  jurisdictionOf,
  targetOf,
  vaultActor,
  type EmployeeRow,
} from './service';
import { loadTarget, scopePredicate } from '../employees/service';
import { i9Statuses, rtwStatuses } from './status';

const Source = Type.Object({ url: Type.String(), title: Type.String() });
const RtwRow = Type.Object({
  employeeId: Uuid,
  employeeName: Type.String(),
  jurisdiction: Nullable(Type.String()),
  employmentStatus: Type.String(),
  status: Type.Union(
    ['missing', 'valid', 'follow_up_due', 'expired', 'retention'].map((s) => Type.Literal(s)),
  ),
  checkId: Nullable(Uuid),
  checkMethod: Nullable(Type.String()),
  listType: Nullable(Type.String()),
  checkedOn: Nullable(Type.String()),
  followUpDueOn: Nullable(Type.String()),
  excuseEndsOn: Nullable(Type.String()),
  retainUntil: Nullable(Type.String()),
  hasEvidence: Type.Boolean(),
  /** Right-to-work evidence documents attached to the person (kept in the vault, ADR-0166). */
  evidenceDocuments: Type.Optional(Type.Integer()),
});
const I9Row = Type.Object({
  employeeId: Uuid,
  employeeName: Type.String(),
  jurisdiction: Nullable(Type.String()),
  recordId: Nullable(Uuid),
  status: Type.Union(
    [
      'missing',
      'section1_due',
      'section2_due',
      'section2_overdue',
      'complete',
      'reverification_due',
      'reverification_overdue',
    ].map((s) => Type.Literal(s)),
  ),
  firstDayOfEmployment: Nullable(Type.String()),
  section1CompletedOn: Nullable(Type.String()),
  section2CompletedOn: Nullable(Type.String()),
  section2DueOn: Nullable(Type.String()),
  reverificationDueOn: Nullable(Type.String()),
  retainUntil: Nullable(Type.String()),
  retainAtLeastUntil: Nullable(Type.String()),
});

const EVIDENCE_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];

/** UK right-to-work checks and US Form I-9 records. Documents, share codes and attestations live only in the vault (category immigration). */
export async function immigrationRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const vault = new Vault(deps.keys);
  const asOfOf = (req: FastifyRequest, q?: string) =>
    q ?? instantToDate(deps.now().toISOString(), requireAuth(req).user.timeZone ?? 'UTC');

  async function employee(tx: Parameters<Parameters<typeof app.tenantTx>[1]>[0], id: string) {
    const e = await tx.maybe<EmployeeRow>(
      `SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE e.id = $1`,
      [id],
    );
    if (!e) throw new ApiError('notFound');
    return e;
  }

  // ---- right to work ------------------------------------------------------------------------------
  app.get(
    '/v1/compliance/right-to-work/rules',
    {
      schema: {
        tags: ['compliance'],
        summary:
          'UK right-to-work check methods, document lists, follow-up and retention rules from the GB pack',
        querystring: Type.Object({ date: Type.Optional(CivilDate) }),
        response: {
          200: Type.Object({
            rules: Type.Any(),
            retention: Type.Any(),
            source: Source,
            retentionSource: Source,
            verifiedOn: Type.String(),
          }),
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      authorizeSome(req, 'compliance.read');
      const date = asOfOf(req, (req.query as { date?: string }).date);
      const book = await ruleBook(app);
      const r = book.tryResolve<RtwDocumentRules>('GB', 'right_to_work.document_rules', date);
      const ret = book.tryResolve('GB', 'right_to_work.retention', date);
      if (!r || !ret) throw new ApiError('notFound');
      return {
        rules: r.value,
        retention: ret.value,
        source: r.source,
        retentionSource: ret.source,
        verifiedOn: r.verifiedOn,
      };
    },
  );

  app.get(
    '/v1/compliance/right-to-work',
    {
      schema: {
        tags: ['compliance'],
        summary: 'Right-to-work status of UK employees (current and within the retention period)',
        querystring: Type.Object({
          asOf: Type.Optional(CivilDate),
          status: Type.Optional(Type.String({ maxLength: 20 })),
        }),
        response: { 200: Type.Array(RtwRow), 403: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'compliance.read');
      const q = req.query as { asOf?: string; status?: string };
      const asOf = asOfOf(req, q.asOf);
      const book = await ruleBook(app);
      const out = await app.tenantTx(req, async (tx) => {
        const params: unknown[] = [];
        const scope = scopePredicate(auth.principal, 'compliance.read', params);
        const emps = await tx.query<EmployeeRow>(
          `SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE coalesce(e.country, fl.country, le.country) = 'GB' AND ${scope} ORDER BY e.display_name, e.id LIMIT 5000`,
          params,
        );
        const statuses = await rtwStatuses(tx, book, emps, asOf, await complianceSettings(tx));
        const attached = new Map(
          (
            await tx.query<{ employee_id: string; n: number }>(
              `SELECT employee_id, count(*)::int AS n FROM app.documents WHERE attachment_type = 'right_to_work' AND status = 'ready' AND employee_id = ANY($1::uuid[]) GROUP BY employee_id`,
              [emps.map((e) => e.id)],
            )
          ).map((r) => [r.employee_id, r.n]),
        );
        const rows = statuses.map(({ employee: e, status, check: c, retainUntil }) => ({
          employeeId: e.id,
          employeeName: e.display_name,
          jurisdiction: jurisdictionOf(e),
          employmentStatus: e.status,
          status,
          checkId: c?.id ?? null,
          checkMethod: c?.check_method ?? null,
          listType: c?.list_type ?? null,
          checkedOn: c?.checked_on ?? null,
          followUpDueOn: c?.follow_up_due_on ?? null,
          excuseEndsOn: c?.excuse_ends_on ?? null,
          retainUntil,
          hasEvidence: !!c?.evidence_vault_id || (attached.get(e.id) ?? 0) > 0,
          evidenceDocuments: attached.get(e.id) ?? 0,
        }));
        // Follow-up dates reveal time-limited immigration permission: the list view is audited as sensitive.
        await app.audit(tx, req, {
          action: 'compliance.rtw_listed',
          targetType: 'compliance',
          diff: { rows: rows.length, asOf },
          sensitive: true,
        });
        return q.status ? rows.filter((r) => r.status === q.status) : rows;
      });
      return out;
    },
  );

  app.post(
    '/v1/compliance/right-to-work/checks',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['compliance'],
        summary: 'Record a right-to-work check; the follow-up date is calculated from the GB pack',
        body: Type.Object({
          employeeId: Uuid,
          checkMethod: Type.String({ maxLength: 60 }),
          listType: Type.Union(
            ['list_a', 'list_b_group_1', 'list_b_group_2', 'online_unlimited', 'online_time_limited'].map(
              (l) => Type.Literal(l),
            ),
          ),
          checkedOn: CivilDate,
          permissionExpiresOn: Type.Optional(Nullable(CivilDate)),
          pvnDate: Type.Optional(Nullable(CivilDate)),
          documentType: Type.Optional(Type.String({ maxLength: 120 })),
          documentReference: Type.Optional(Type.String({ maxLength: 120 })),
          shareCode: Type.Optional(Type.String({ maxLength: 20 })),
        }),
        response: {
          201: Type.Object({
            id: Uuid,
            excuse: Type.String(),
            excuseEndsOn: Nullable(Type.String()),
            followUpDueOn: Nullable(Type.String()),
            source: Source,
          }),
          400: Problem,
          403: Problem,
          404: Problem,
          422: Problem,
        },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as {
        employeeId: string;
        checkMethod: string;
        listType: RtwListType;
        checkedOn: string;
        permissionExpiresOn?: string | null;
        pvnDate?: string | null;
        documentType?: string;
        documentReference?: string;
        shareCode?: string;
      };
      const book = await ruleBook(app);
      const out = await app.tenantTx(req, async (tx) => {
        const e = await employee(tx, b.employeeId);
        const target = targetOf(e);
        if (!can(auth.principal, 'compliance.record', target)) throw new ApiError('forbidden');
        const jurisdiction = jurisdictionOf(e) ?? 'GB';
        const rule = book.tryResolve<RtwDocumentRules>(
          jurisdiction,
          'right_to_work.document_rules',
          b.checkedOn,
        );
        if (!rule)
          throw new ApiError('unprocessable', 'No right-to-work rules for this jurisdiction and date');
        if (!rule.value.methods.some((m) => m.id === b.checkMethod))
          throw new ApiError('validation', 'Unknown check method', {
            methods: rule.value.methods.map((m) => m.id),
          });
        if (b.documentType && !(rule.value.documentCatalogue?.[b.listType] ?? []).includes(b.documentType))
          throw new ApiError('validation', 'Document type is not on that list');
        let fu: ReturnType<typeof rtwFollowUp>;
        try {
          fu = rtwFollowUp(rule.value, {
            listType: b.listType,
            checkedOn: b.checkedOn,
            permissionExpiresOn: b.permissionExpiresOn,
            pvnDate: b.pvnDate,
          });
        } catch (err) {
          if (err instanceof RtwInputError) throw new ApiError('validation', err.message);
          throw err;
        }
        const row = await tx.one<{ id: string }>(
          `INSERT INTO app.rtw_checks (tenant_id, employee_id, jurisdiction, check_method, list_type, checked_on, checked_by, permission_expires_on, pvn_date, excuse, excuse_ends_on, follow_up_due_on, rule_source)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [
            e.id,
            rule.jurisdiction,
            b.checkMethod,
            b.listType,
            b.checkedOn,
            auth.userId,
            b.permissionExpiresOn ?? null,
            b.pvnDate ?? null,
            fu.excuse,
            fu.excuseEndsOn,
            fu.followUpDueOn,
            JSON.stringify({
              ...rule.source,
              verifiedOn: rule.verifiedOn,
              packVersion: rule.packVersion,
              effectiveFrom: rule.effectiveFrom,
            }),
          ],
        );
        const previous = await tx.query<{ id: string }>(
          `UPDATE app.rtw_checks SET superseded_by = $2 WHERE employee_id = $1 AND superseded_by IS NULL AND id <> $2 RETURNING id`,
          [e.id, row.id],
        );
        // a new check closes the follow-up tasks raised for the checks it replaces
        for (const p of previous)
          await tx.exec(
            `UPDATE app.tasks SET status = 'done', completed_at = now(), completed_by = $2 WHERE dedupe_key LIKE $1 AND status = 'open'`,
            [`rtwcheck:${p.id}:%`, auth.userId],
          );
        if (b.documentType || b.documentReference || b.shareCode) {
          const vid = await vault.put(
            tx,
            vaultActor(req),
            auth.tenantId,
            target,
            'immigration',
            `rtw_details:${row.id}`,
            JSON.stringify({
              documentType: b.documentType ?? null,
              documentReference: b.documentReference ?? null,
              shareCode: b.shareCode ?? null,
            }),
          );
          await tx.exec('UPDATE app.rtw_checks SET details_vault_id = $2 WHERE id = $1', [row.id, vid]);
        }
        await app.audit(tx, req, {
          action: 'compliance.rtw_check_recorded',
          targetType: 'employee',
          targetId: e.id,
          diff: {
            checkId: row.id,
            method: b.checkMethod,
            listType: b.listType,
            checkedOn: b.checkedOn,
            followUpDueOn: fu.followUpDueOn,
            superseded: previous.length,
          },
          sensitive: true,
        });
        return { id: row.id, ...fu, source: rule.source };
      });
      return reply.status(201).send(out);
    },
  );

  app.post(
    '/v1/compliance/right-to-work/checks/:id/evidence',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['compliance'],
        summary: 'Upload the copy of the documents or the online check result (stored in the vault)',
        consumes: ['multipart/form-data'],
        params: Type.Object({ id: Uuid }),
        response: { 201: Type.Object({ vaultId: Uuid }), 400: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const file = await req.file();
      if (!file || !EVIDENCE_TYPES.includes(file.mimetype))
        throw new ApiError('validation', 'Upload a PDF or image');
      const buf = await file.toBuffer();
      if (!matchesMagic(file.mimetype, buf))
        throw new ApiError('validation', 'The file content does not match its type');
      const out = await app.tenantTx(req, async (tx) => {
        const c = await tx.maybe<{ employee_id: string }>(
          'SELECT employee_id FROM app.rtw_checks WHERE id = $1',
          [id],
        );
        if (!c) throw new ApiError('notFound');
        const target = targetOf(await employee(tx, c.employee_id));
        if (!can(auth.principal, 'compliance.record', target)) throw new ApiError('forbidden');
        const key = objectKey(
          auth.tenantId,
          `vault/immigration/${c.employee_id}`,
          file.mimetype === 'application/pdf' ? '.pdf' : '.img',
        );
        await deps.objects.put(key, buf, file.mimetype);
        const vid = await vault.put(
          tx,
          vaultActor(req),
          auth.tenantId,
          target,
          'immigration',
          `rtw_evidence:${id}`,
          file.filename,
          key,
        );
        await tx.exec('UPDATE app.rtw_checks SET evidence_vault_id = $2 WHERE id = $1', [id, vid]);
        req.auditWritten = true; // vault.put writes the sensitive audit entry
        return { vaultId: vid };
      });
      return reply.status(201).send(out);
    },
  );

  app.get(
    '/v1/compliance/right-to-work/checks/:id',
    {
      schema: {
        tags: ['compliance'],
        summary:
          'One check with its vault details (every view and decrypt is audited). Without vault access to immigration data the details are left out and `detailsRestricted` is true.',
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({
            id: Uuid,
            employeeId: Uuid,
            employeeName: Type.String(),
            checkMethod: Type.String(),
            listType: Type.String(),
            checkedOn: Type.String(),
            checkedByName: Nullable(Type.String()),
            excuse: Type.String(),
            permissionExpiresOn: Nullable(Type.String()),
            pvnDate: Nullable(Type.String()),
            followUpDueOn: Nullable(Type.String()),
            excuseEndsOn: Nullable(Type.String()),
            current: Type.Boolean(),
            detailsRestricted: Type.Boolean(),
            details: Nullable(
              Type.Object({
                documentType: Nullable(Type.String()),
                documentReference: Nullable(Type.String()),
                shareCode: Nullable(Type.String()),
              }),
            ),
            evidence: Nullable(Type.Object({ fileName: Type.String(), url: Type.String() })),
            ruleSource: Type.Any(),
          }),
          403: Problem,
          404: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const c = await tx.maybe<{
          id: string;
          employee_id: string;
          check_method: string;
          list_type: string;
          checked_on: string;
          follow_up_due_on: string | null;
          excuse_ends_on: string | null;
          details_vault_id: string | null;
          evidence_vault_id: string | null;
          rule_source: unknown;
          excuse: string;
          permission_expires_on: string | null;
          pvn_date: string | null;
          superseded_by: string | null;
          checked_by_name: string | null;
        }>(
          `SELECT c.id, c.employee_id, c.check_method, c.list_type, c.checked_on::text, c.follow_up_due_on::text, c.excuse_ends_on::text, c.details_vault_id, c.evidence_vault_id, c.rule_source,
                  c.excuse, c.permission_expires_on::text, c.pvn_date::text, c.superseded_by, u.display_name AS checked_by_name
             FROM app.rtw_checks c LEFT JOIN app.users u ON u.tenant_id = c.tenant_id AND u.id = c.checked_by WHERE c.id = $1`,
          [id],
        );
        if (!c) throw new ApiError('notFound');
        const emp = await employee(tx, c.employee_id);
        const target = targetOf(emp);
        // the same scope as the right-to-work list (the whole management line), not only the direct manager
        if (!can(auth.principal, 'compliance.read', await loadTarget(tx, c.employee_id)))
          throw new ApiError('forbidden');
        let details = null;
        let evidence = null;
        const vaultAccess = can(auth.principal, 'vault.read:immigration', target);
        await app.audit(tx, req, {
          action: 'compliance.rtw_check_viewed',
          targetType: 'employee',
          targetId: c.employee_id,
          diff: { checkId: c.id, details: vaultAccess },
          sensitive: true,
        });
        if (vaultAccess && (c.details_vault_id || c.evidence_vault_id)) {
          const fields = await vault.read(tx, vaultActor(req), auth.tenantId, target, 'immigration');
          const d = fields.find((f) => f.field === `rtw_details:${id}`);
          if (d)
            details = JSON.parse(d.value) as {
              documentType: string | null;
              documentReference: string | null;
              shareCode: string | null;
            };
          const ev = fields.find((f) => f.field === `rtw_evidence:${id}`);
          if (ev?.fileKey)
            evidence = { fileName: ev.value, url: await deps.objects.presignGet(ev.fileKey, ev.value) };
        }
        req.auditWritten = true;
        return {
          id: c.id,
          employeeId: c.employee_id,
          employeeName: emp.display_name,
          checkMethod: c.check_method,
          listType: c.list_type,
          checkedOn: c.checked_on,
          checkedByName: c.checked_by_name,
          excuse: c.excuse,
          permissionExpiresOn: c.permission_expires_on,
          pvnDate: c.pvn_date,
          followUpDueOn: c.follow_up_due_on,
          excuseEndsOn: c.excuse_ends_on,
          current: !c.superseded_by,
          detailsRestricted: !vaultAccess && !!(c.details_vault_id || c.evidence_vault_id),
          details,
          evidence,
          ruleSource: c.rule_source,
        };
      });
    },
  );

  // ---- Form I-9 -----------------------------------------------------------------------------------
  async function i9Rule(date: string) {
    const book = await ruleBook(app);
    const completion = book.tryResolve<I9CompletionRule>('US', 'i9.completion_deadlines', date);
    const retention = book.tryResolve<Parameters<typeof i9RetainUntil>[0]>('US', 'i9.retention', date);
    const reverification = book.tryResolve<{ suggestedAdvanceNoticeDays?: number }>(
      'US',
      'i9.reverification',
      date,
    );
    if (!completion || !retention || !reverification)
      throw new ApiError('unprocessable', 'No Form I-9 rules for this date');
    return { completion, retention, reverification };
  }

  app.get(
    '/v1/compliance/i9',
    {
      schema: {
        tags: ['compliance'],
        summary: 'Form I-9 status of US employees (deadlines, reverification and retention from the US pack)',
        querystring: Type.Object({ asOf: Type.Optional(CivilDate) }),
        response: { 200: Type.Array(I9Row), 403: Problem },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'compliance.read');
      const asOf = asOfOf(req, (req.query as { asOf?: string }).asOf);
      const book = await ruleBook(app);
      return app.tenantTx(req, async (tx) => {
        const params: unknown[] = [];
        const scope = scopePredicate(auth.principal, 'compliance.read', params);
        const emps = await tx.query<EmployeeRow>(
          `SELECT ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_FROM} WHERE coalesce(e.country, fl.country, le.country) = 'US' AND ${scope} ORDER BY e.display_name, e.id LIMIT 5000`,
          params,
        );
        const statuses = await i9Statuses(tx, book, emps, asOf, await complianceSettings(tx));
        const rows = statuses.map(({ employee: e, status, record: r, retainUntil, retainAtLeastUntil }) => ({
          employeeId: e.id,
          employeeName: e.display_name,
          jurisdiction: jurisdictionOf(e),
          recordId: r?.id ?? null,
          status,
          firstDayOfEmployment: r?.first_day_of_employment ?? null,
          section1CompletedOn: r?.section1_completed_on ?? null,
          section2CompletedOn: r?.section2_completed_on ?? null,
          section2DueOn: r?.section2_due_on ?? null,
          reverificationDueOn: r?.reverification_due_on ?? null,
          retainUntil,
          retainAtLeastUntil,
        }));
        await app.audit(tx, req, {
          action: 'compliance.i9_listed',
          targetType: 'compliance',
          diff: { rows: rows.length, asOf },
          sensitive: true,
        });
        return rows;
      });
    },
  );

  const I9Body = {
    section1CompletedOn: Type.Optional(Nullable(CivilDate)),
    section2CompletedOn: Type.Optional(Nullable(CivilDate)),
    workAuthorizationExpiresOn: Type.Optional(Nullable(CivilDate)),
    supplementBCompletedOn: Type.Optional(Nullable(CivilDate)),
    lastDayOfEmployment: Type.Optional(Nullable(CivilDate)),
    citizenshipAttestation: Type.Optional(
      Type.Union(
        [
          'us_citizen',
          'noncitizen_national',
          'lawful_permanent_resident',
          'noncitizen_authorized_to_work',
        ].map((s) => Type.Literal(s)),
      ),
    ),
  };
  const I9Out = Type.Object({
    id: Uuid,
    section1DueOn: Type.String(),
    section2DueOn: Type.String(),
    reverificationDueOn: Nullable(Type.String()),
    retainAtLeastUntil: Type.String(),
    source: Source,
  });
  type I9Input = {
    section1CompletedOn?: string | null;
    section2CompletedOn?: string | null;
    workAuthorizationExpiresOn?: string | null;
    supplementBCompletedOn?: string | null;
    lastDayOfEmployment?: string | null;
    citizenshipAttestation?: string;
  };

  app.post(
    '/v1/compliance/i9',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['compliance'],
        summary: 'Create or update the Form I-9 record for an employment (deadlines from the US pack)',
        body: Type.Object({ employeeId: Uuid, firstDayOfEmployment: Type.Optional(CivilDate), ...I9Body }),
        response: { 200: I9Out, 403: Problem, 404: Problem, 422: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const b = req.body as I9Input & { employeeId: string; firstDayOfEmployment?: string };
      return app.tenantTx(req, async (tx) => {
        const e = await employee(tx, b.employeeId);
        const target = targetOf(e);
        if (!can(auth.principal, 'compliance.record', target)) throw new ApiError('forbidden');
        const firstDay = b.firstDayOfEmployment ?? e.start_date;
        const rules = await i9Rule(firstDay);
        const settings = await complianceSettings(tx);
        const dl = i9Deadlines(rules.completion.value, {
          firstDay,
          lastDay: b.lastDayOfEmployment ?? e.end_date,
          businessWeekdays: settings.businessWeekdays,
        });
        const rev = i9Reverification(rules.reverification.value, b.workAuthorizationExpiresOn ?? null);
        const row = await tx.one<{ id: string }>(
          `INSERT INTO app.i9_records (tenant_id, employee_id, first_day_of_employment, section1_completed_on, section2_completed_on, section2_due_on, work_authorization_expires_on, reverification_due_on, supplement_b_completed_on, rule_source, created_by)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (tenant_id, employee_id, first_day_of_employment) DO UPDATE SET
             section1_completed_on = coalesce(EXCLUDED.section1_completed_on, app.i9_records.section1_completed_on),
             section2_completed_on = coalesce(EXCLUDED.section2_completed_on, app.i9_records.section2_completed_on),
             section2_due_on = EXCLUDED.section2_due_on,
             work_authorization_expires_on = coalesce(EXCLUDED.work_authorization_expires_on, app.i9_records.work_authorization_expires_on),
             reverification_due_on = coalesce(EXCLUDED.reverification_due_on, app.i9_records.reverification_due_on),
             supplement_b_completed_on = coalesce(EXCLUDED.supplement_b_completed_on, app.i9_records.supplement_b_completed_on),
             rule_source = EXCLUDED.rule_source
           RETURNING id`,
          [
            e.id,
            firstDay,
            b.section1CompletedOn ?? null,
            b.section2CompletedOn ?? null,
            dl.section2DueOn,
            b.workAuthorizationExpiresOn ?? null,
            rev.dueOn,
            b.supplementBCompletedOn ?? null,
            JSON.stringify({
              completion: rules.completion.source,
              retention: rules.retention.source,
              reverification: rules.reverification.source,
              verifiedOn: rules.completion.verifiedOn,
            }),
            auth.userId,
          ],
        );
        if (b.citizenshipAttestation)
          await vault.put(
            tx,
            vaultActor(req),
            auth.tenantId,
            target,
            'immigration',
            `i9_attestation:${row.id}`,
            b.citizenshipAttestation,
          );
        await app.audit(tx, req, {
          action: 'compliance.i9_recorded',
          targetType: 'employee',
          targetId: e.id,
          diff: {
            recordId: row.id,
            firstDay,
            section2DueOn: dl.section2DueOn,
            reverificationDueOn: rev.dueOn,
          },
          sensitive: true,
        });
        const ret = i9RetainUntil(rules.retention.value, { hireDate: firstDay, terminationDate: e.end_date });
        return {
          id: row.id,
          section1DueOn: dl.section1DueOn,
          section2DueOn: dl.section2DueOn,
          reverificationDueOn: rev.dueOn,
          retainAtLeastUntil: ret.atLeastUntil,
          source: rules.completion.source,
        };
      });
    },
  );

  app.patch(
    '/v1/compliance/i9/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['compliance'],
        summary:
          'Record Section 1/2 completion, a new authorization expiry or a completed reverification (Supplement B)',
        params: Type.Object({ id: Uuid }),
        body: Type.Object(I9Body),
        response: { 200: I9Out, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const b = req.body as I9Input;
      return app.tenantTx(req, async (tx) => {
        const r = await tx.maybe<{
          employee_id: string;
          first_day_of_employment: string;
          work_authorization_expires_on: string | null;
        }>(
          'SELECT employee_id, first_day_of_employment::text, work_authorization_expires_on::text FROM app.i9_records WHERE id = $1',
          [id],
        );
        if (!r) throw new ApiError('notFound');
        const e = await employee(tx, r.employee_id);
        const target = targetOf(e);
        if (!can(auth.principal, 'compliance.record', target)) throw new ApiError('forbidden');
        const rules = await i9Rule(r.first_day_of_employment);
        const settings = await complianceSettings(tx);
        const dl = i9Deadlines(rules.completion.value, {
          firstDay: r.first_day_of_employment,
          lastDay: b.lastDayOfEmployment ?? e.end_date,
          businessWeekdays: settings.businessWeekdays,
        });
        const newExpiry =
          b.workAuthorizationExpiresOn !== undefined
            ? b.workAuthorizationExpiresOn
            : r.work_authorization_expires_on;
        const rev = i9Reverification(rules.reverification.value, newExpiry);
        // A new expiry date opens the next reverification cycle (the completed Supplement B is kept in the audit trail).
        const expiryChanged =
          b.workAuthorizationExpiresOn !== undefined &&
          b.workAuthorizationExpiresOn !== r.work_authorization_expires_on;
        const supplementB = expiryChanged ? null : b.supplementBCompletedOn;
        await tx.exec(
          `UPDATE app.i9_records SET section1_completed_on = CASE WHEN $2::boolean THEN $3::date ELSE section1_completed_on END,
             section2_completed_on = CASE WHEN $4::boolean THEN $5::date ELSE section2_completed_on END,
             section2_due_on = $6, work_authorization_expires_on = $7, reverification_due_on = $8,
             supplement_b_completed_on = CASE WHEN $9::boolean THEN $10::date ELSE supplement_b_completed_on END
           WHERE id = $1`,
          [
            id,
            b.section1CompletedOn !== undefined,
            b.section1CompletedOn ?? null,
            b.section2CompletedOn !== undefined,
            b.section2CompletedOn ?? null,
            dl.section2DueOn,
            newExpiry,
            rev.dueOn,
            supplementB !== undefined,
            supplementB ?? null,
          ],
        );
        if (b.citizenshipAttestation)
          await vault.put(
            tx,
            vaultActor(req),
            auth.tenantId,
            target,
            'immigration',
            `i9_attestation:${id}`,
            b.citizenshipAttestation,
          );
        await app.audit(tx, req, {
          action: 'compliance.i9_updated',
          targetType: 'employee',
          targetId: e.id,
          diff: {
            recordId: id,
            ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'citizenshipAttestation')),
          },
          sensitive: true,
        });
        const ret = i9RetainUntil(rules.retention.value, {
          hireDate: r.first_day_of_employment,
          terminationDate: e.end_date,
        });
        return {
          id,
          section1DueOn: dl.section1DueOn,
          section2DueOn: dl.section2DueOn,
          reverificationDueOn: rev.dueOn,
          retainAtLeastUntil: ret.atLeastUntil,
          source: rules.completion.source,
        };
      });
    },
  );

  app.post(
    '/v1/compliance/i9/:id/evidence',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['compliance'],
        summary: 'Upload the completed Form I-9 or document copies (stored in the vault)',
        consumes: ['multipart/form-data'],
        params: Type.Object({ id: Uuid }),
        response: { 201: Type.Object({ vaultId: Uuid }), 400: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      const file = await req.file();
      if (!file || !EVIDENCE_TYPES.includes(file.mimetype))
        throw new ApiError('validation', 'Upload a PDF or image');
      const buf = await file.toBuffer();
      if (!matchesMagic(file.mimetype, buf))
        throw new ApiError('validation', 'The file content does not match its type');
      const out = await app.tenantTx(req, async (tx) => {
        const r = await tx.maybe<{ employee_id: string }>(
          'SELECT employee_id FROM app.i9_records WHERE id = $1',
          [id],
        );
        if (!r) throw new ApiError('notFound');
        const target = targetOf(await employee(tx, r.employee_id));
        if (!can(auth.principal, 'compliance.record', target)) throw new ApiError('forbidden');
        const key = objectKey(
          auth.tenantId,
          `vault/immigration/${r.employee_id}`,
          file.mimetype === 'application/pdf' ? '.pdf' : '.img',
        );
        await deps.objects.put(key, buf, file.mimetype);
        const vid = await vault.put(
          tx,
          vaultActor(req),
          auth.tenantId,
          target,
          'immigration',
          `i9_evidence:${id}`,
          file.filename,
          key,
        );
        await tx.exec('UPDATE app.i9_records SET evidence_vault_id = $2 WHERE id = $1', [id, vid]);
        req.auditWritten = true;
        return { vaultId: vid };
      });
      return reply.status(201).send(out);
    },
  );
}
