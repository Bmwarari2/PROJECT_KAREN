import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type, type TSchema } from 'typebox';
import ExcelJS from 'exceljs';
import { canSome, fieldAccess, type Principal } from '@thapsus/core/permissions';
import { today } from '@thapsus/core/time';
import type { Tx } from '@thapsus/db';
import { authorizeSome } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Problem, Uuid } from '../../http/schemas';
import { listApprovals } from '../approvals/service';
import { listDocuments } from '../documents/routes';
import { permKeyFor } from '../employees/model';
import { employeeAsOf, employeeListWhere, managerChainSql, rowTarget, type EmployeeListFilter } from '../employees/service';
import { listTasks } from '../workflows/service';

/**
 * CSV and Excel export of the app's list views. Each export returns exactly the rows the same list
 * shows the caller (shared queries), with field-level permissions applied per row, needs the
 * exports.run permission (bulk data leaving the product) and is audited.
 */
const MAX_ROWS = 10_000;
const Format = Type.Union([Type.Literal('csv'), Type.Literal('xlsx')]);
type Row = Record<string, unknown>;

const zoneOf = (req: FastifyRequest) => req.auth?.user.timeZone ?? 'Europe/London';

function capped<T>(rows: T[]): T[] {
  if (rows.length > MAX_ROWS) throw new ApiError('unprocessable', `More than ${MAX_ROWS} rows — narrow the filters or use a background report`);
  return rows;
}

/** Spreadsheet-safe cell text: values that a spreadsheet would run as a formula are prefixed with '. */
function cellText(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export async function sendTable(reply: FastifyReply, format: 'csv' | 'xlsx', name: string, columns: string[], rows: Row[]) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    const csv = [columns.join(','), ...rows.map((r) => columns.map((c) => `"${cellText(r[c]).replace(/"/g, '""')}"`).join(','))].join('\r\n');
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}_${stamp}.csv"`).send(csv);
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name);
  ws.addRow(columns);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(columns.map((c) => (typeof r[c] === 'number' ? r[c] : cellText(r[c]))));
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="${name}_${stamp}.xlsx"`).send(buf);
}

interface ListExport<Q> {
  list: string;
  querystring: TSchema;
  summary: string;
  load(tx: Tx, auth: { userId: string; principal: Principal }, q: Q, req: FastifyRequest): Promise<{ columns: string[]; rows: Row[] }>;
}

const DEFAULT_EMPLOYEE_FIELDS = ['employeeNumber', 'displayName', 'jobTitle', 'department', 'location', 'country', 'status', 'startDate', 'workEmail'];

const EXPORTS: Array<ListExport<Record<string, string | undefined>>> = [
  {
    list: 'employees',
    summary: 'Export the people list (same filters and scope as GET /v1/employees); unreadable fields are blank per row',
    querystring: Type.Object({
      fields: Type.Optional(Type.String({ maxLength: 2000 })),
      q: Type.Optional(Type.String({ maxLength: 100 })),
      status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('pre_start'), Type.Literal('leaver'), Type.Literal('all')])),
      entityId: Type.Optional(Uuid),
      departmentId: Type.Optional(Uuid),
      locationId: Type.Optional(Uuid),
      managerId: Type.Optional(Uuid),
      country: Type.Optional(Type.String({ pattern: '^[A-Z]{2}$' })),
    }),
    async load(tx, auth, q, req) {
      const columns = (q.fields?.split(',') ?? DEFAULT_EMPLOYEE_FIELDS).map((f) => f.trim()).filter(Boolean);
      const params: unknown[] = [];
      const where = employeeListWhere(auth.principal, 'employees.read', q as EmployeeListFilter, params);
      const people = capped(
        await tx.query<{ id: string; entity_id: string | null; country: string | null; department_id: string | null; location_id: string | null; chain: Array<string | null> | null }>(
          `SELECT e.id, e.entity_id, e.country, e.department_id, e.location_id, ${managerChainSql(auth.principal)} AS chain
             FROM app.employees e WHERE ${where.join(' AND ')} ORDER BY e.display_name, e.id LIMIT ${MAX_ROWS + 1}`,
          params,
        ),
      );
      const asOf = today(zoneOf(req));
      const rows: Row[] = [];
      for (const p of people) {
        const target = rowTarget(p);
        const view = await employeeAsOf(tx, p.id, asOf);
        // field-level permissions: a column the caller cannot read is blank for that row
        rows.push(Object.fromEntries(columns.map((f) => [f, fieldAccess(auth.principal, 'employee', permKeyFor(f), target) === 'none' ? '' : (view[f] ?? '')])));
      }
      return { columns, rows };
    },
  },
  {
    list: 'tasks',
    summary: 'Export my task list (same rows as GET /v1/tasks)',
    querystring: Type.Object({ status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('done'), Type.Literal('all')])) }),
    async load(tx, auth, q) {
      const tasks = capped(await listTasks(tx, auth.userId, auth.principal.grants.map((g) => g.roleKey), q.status ?? 'open', MAX_ROWS + 1));
      return { columns: ['title', 'status', 'dueOn', 'subjectName', 'assigneeRole', 'source'], rows: tasks as unknown as Row[] };
    },
  },
  {
    list: 'approvals',
    summary: 'Export approval requests (same rows as GET /v1/approvals); changed fields are listed by name, never their values',
    querystring: Type.Object({ view: Type.Optional(Type.Union([Type.Literal('mine'), Type.Literal('requested'), Type.Literal('all')])) }),
    async load(tx, auth, q) {
      const view = q.view ?? 'mine';
      if (view === 'all' && !canSome(auth.principal, 'approvals.manage')) throw new ApiError('forbidden');
      const requests = capped(await listApprovals(tx, auth.userId, view, MAX_ROWS + 1));
      const rows = requests.map((r) => ({ ...r, fields: Object.keys(r.payload).filter((k) => !['effectiveDate', 'reason'].includes(k)).join(';'), effectiveDate: r.payload.effectiveDate ?? '' }));
      return { columns: ['policy', 'subject', 'subjectName', 'status', 'requestedAt', 'currentStep', 'effectiveDate', 'fields'], rows };
    },
  },
  {
    list: 'documents',
    summary: 'Export the documents list (same folder permissions as GET /v1/documents)',
    querystring: Type.Object({ employeeId: Type.Optional(Uuid), folderId: Type.Optional(Uuid) }),
    async load(tx, auth, q) {
      const docs = capped(await listDocuments(tx, auth.principal, { employeeId: q.employeeId, folderId: q.folderId }, MAX_ROWS + 1));
      const rows = docs.map((d) => ({ title: d.title, category: d.category, employeeName: d.employee_name ?? '', fileName: d.file_name, contentType: d.content_type, sizeBytes: d.size_bytes === null ? '' : Number(d.size_bytes), expiresOn: d.expires_on ?? '', createdAt: d.created_at }));
      return { columns: ['title', 'category', 'employeeName', 'fileName', 'contentType', 'sizeBytes', 'expiresOn', 'createdAt'], rows };
    },
  },
];

export async function exportRoutes(app: FastifyInstance) {
  for (const def of EXPORTS) {
    app.get(
      `/v1/exports/${def.list}`,
      {
        config: { selfAudited: true },
        schema: {
          tags: ['exports'],
          summary: def.summary,
          querystring: Type.Intersect([Type.Object({ format: Format }), def.querystring]),
          response: { 200: Type.Any(), 403: Problem, 422: Problem },
        },
      },
      async (req, reply) => {
        const auth = authorizeSome(req, 'exports.run');
        const q = req.query as Record<string, string | undefined> & { format: 'csv' | 'xlsx' };
        const table = await app.tenantTx(req, async (tx) => {
          const t = await def.load(tx, auth, q, req);
          await app.audit(tx, req, { action: `export.${def.list}`, diff: { format: q.format, rows: t.rows.length, columns: t.columns } });
          return t;
        });
        return sendTable(reply, q.format, def.list, table.columns, table.rows);
      },
    );
  }
}
