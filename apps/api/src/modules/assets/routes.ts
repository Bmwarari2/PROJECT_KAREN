import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { can, canSome } from '@thapsus/core/permissions';
import { isLocale, t } from '@thapsus/core/i18n';
import { compareDates } from '@thapsus/core/time';
import type { Tx } from '@thapsus/db';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { createTask, notify, userForEmployee } from '../../lib/notify';
import { loadTarget } from '../employees/service';
import { maybeCompleteInstance, workflowStartHooks } from '../workflows/service';

/**
 * Asset register (PROGRESS 6.5): assets with purchase cost in integer minor units, assignment to an
 * employee with a handover sign-off the employee gives themselves (who, when, from where, which
 * statement), and a return checklist. When an offboarding workflow starts, every asset still with the
 * leaver becomes a return task in that workflow; recording the return completes the task.
 */
const TYPES = ['laptop', 'desktop', 'phone', 'tablet', 'monitor', 'headset', 'peripheral', 'vehicle', 'access_card', 'other'] as const;
type AssetType = (typeof TYPES)[number];
const lit = <T extends string>(v: readonly T[]) => Type.Union(v.map((x) => Type.Literal(x)));

/** Default return checklists (item keys; the UI shows `assets.checklist.<key>` unless a label is set). */
export const DEFAULT_CHECKLISTS: Record<AssetType, string[]> = {
  laptop: ['device', 'charger', 'dataWiped'],
  desktop: ['device', 'dataWiped'],
  phone: ['device', 'charger', 'simRemoved', 'dataWiped'],
  tablet: ['device', 'charger', 'dataWiped'],
  monitor: ['device', 'cables'],
  headset: ['device'],
  peripheral: ['device'],
  vehicle: ['vehicle', 'keys', 'fuelCard'],
  access_card: ['card'],
  other: ['device'],
};
/** Version of the handover statement the employee accepts (text in the message catalogues). */
export const ACK_STATEMENT = 'assets.ackStatement.v1';

const ChecklistItem = Type.Object({ key: Type.String({ pattern: '^[A-Za-z0-9_-]{1,40}$' }), label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })) }, { additionalProperties: false });
const AssetBody = Type.Object(
  {
    assetTag: Type.String({ minLength: 1, maxLength: 60 }),
    type: lit(TYPES),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    serialNumber: Type.Optional(Nullable(Type.String({ maxLength: 120 }))),
    costMinor: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 }))),
    currency: Type.Optional(Nullable(Type.String({ pattern: '^[A-Z]{3}$' }))),
    purchasedOn: Type.Optional(Nullable(CivilDate)),
    entityId: Type.Optional(Nullable(Uuid)),
    locationId: Type.Optional(Nullable(Uuid)),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
    returnChecklist: Type.Optional(Type.Array(ChecklistItem, { maxItems: 20 })),
  },
  { additionalProperties: false },
);
const AssetPatch = Type.Partial(Type.Object({ ...Type.Omit(AssetBody, ['assetTag', 'type']).properties, status: lit(['in_stock', 'in_repair', 'retired'] as const) }), { additionalProperties: false });
const Holder = Nullable(Type.Object({ assignmentId: Uuid, employeeId: Uuid, employeeName: Type.String(), assignedOn: Type.String(), acknowledgedAt: Nullable(Type.String()) }));
const AssetOut = Type.Object({ id: Uuid, assetTag: Type.String(), type: Type.String(), name: Type.String(), serialNumber: Nullable(Type.String()), costMinor: Nullable(Type.Integer()), currency: Nullable(Type.String()), purchasedOn: Nullable(Type.String()), status: Type.String(), entityId: Nullable(Type.String()), locationId: Nullable(Type.String()), notes: Nullable(Type.String()), returnChecklist: Type.Array(ChecklistItem), holder: Holder, createdAt: Type.String(), updatedAt: Type.String() });
const AssignmentOut = Type.Object({
  id: Uuid,
  assetId: Uuid,
  assetTag: Type.String(),
  assetName: Type.String(),
  assetType: Type.String(),
  serialNumber: Nullable(Type.String()),
  employeeId: Uuid,
  employeeName: Nullable(Type.String()),
  status: Type.String(),
  assignedOn: Type.String(),
  dueBackOn: Nullable(Type.String()),
  conditionOut: Nullable(Type.String()),
  handoverNote: Nullable(Type.String()),
  acknowledgedAt: Nullable(Type.String()),
  acknowledgementStatement: Nullable(Type.String()),
  returnRequestedOn: Nullable(Type.String()),
  returnTaskId: Nullable(Type.String()),
  returnedOn: Nullable(Type.String()),
  conditionIn: Nullable(Type.String()),
  checklist: Type.Array(Type.Object({ key: Type.String(), label: Type.Optional(Type.String()), done: Type.Boolean() })),
  returnChecklist: Type.Array(ChecklistItem),
});

type AssetRow = { id: string; asset_tag: string; type: AssetType; name: string; serial_number: string | null; cost_minor: string | null; currency: string | null; purchased_on: string | null; status: string; entity_id: string | null; location_id: string | null; notes: string | null; return_checklist: Array<{ key: string; label?: string }>; created_at: string; updated_at: string; holder_assignment: string | null; holder_employee: string | null; holder_name: string | null; holder_since: string | null; holder_ack: string | null };
const ASSET_SELECT = `SELECT a.*, h.id AS holder_assignment, h.employee_id AS holder_employee, e.display_name AS holder_name, h.assigned_on AS holder_since, h.acknowledged_at AS holder_ack
  FROM app.assets a LEFT JOIN app.asset_assignments h ON h.tenant_id = a.tenant_id AND h.asset_id = a.id AND h.status = 'active'
  LEFT JOIN app.employees e ON e.tenant_id = h.tenant_id AND e.id = h.employee_id`;
const mapAsset = (a: AssetRow) => ({
  id: a.id,
  assetTag: a.asset_tag,
  type: a.type,
  name: a.name,
  serialNumber: a.serial_number,
  costMinor: a.cost_minor === null ? null : Number(a.cost_minor),
  currency: a.currency,
  purchasedOn: a.purchased_on,
  status: a.status,
  entityId: a.entity_id,
  locationId: a.location_id,
  notes: a.notes,
  returnChecklist: a.return_checklist,
  holder: a.holder_assignment ? { assignmentId: a.holder_assignment, employeeId: a.holder_employee!, employeeName: a.holder_name ?? '', assignedOn: a.holder_since!, acknowledgedAt: a.holder_ack } : null,
  createdAt: a.created_at,
  updatedAt: a.updated_at,
});

type AssignmentRow = { id: string; asset_id: string; asset_tag: string; name: string; type: string; serial_number: string | null; employee_id: string; display_name: string | null; status: string; assigned_on: string; due_back_on: string | null; condition_out: string | null; handover_note: string | null; acknowledged_at: string | null; acknowledgement_statement: string | null; return_requested_on: string | null; return_task_id: string | null; returned_on: string | null; condition_in: string | null; checklist: Array<{ key: string; label?: string; done: boolean }>; return_checklist: Array<{ key: string; label?: string }>; acknowledgement_task_id: string | null };
const ASSIGNMENT_SELECT = `SELECT s.*, a.asset_tag, a.name, a.type, a.serial_number, a.return_checklist, e.display_name FROM app.asset_assignments s
  JOIN app.assets a ON a.tenant_id = s.tenant_id AND a.id = s.asset_id LEFT JOIN app.employees e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id`;
const mapAssignment = (s: AssignmentRow) => ({
  id: s.id,
  assetId: s.asset_id,
  assetTag: s.asset_tag,
  assetName: s.name,
  assetType: s.type,
  serialNumber: s.serial_number,
  employeeId: s.employee_id,
  employeeName: s.display_name,
  status: s.status,
  assignedOn: s.assigned_on,
  dueBackOn: s.due_back_on,
  conditionOut: s.condition_out,
  handoverNote: s.handover_note,
  acknowledgedAt: s.acknowledged_at,
  acknowledgementStatement: s.acknowledgement_statement,
  returnRequestedOn: s.return_requested_on,
  returnTaskId: s.return_task_id,
  returnedOn: s.returned_on,
  conditionIn: s.condition_in,
  checklist: s.checklist,
  returnChecklist: s.return_checklist,
});

/** Assets belong to the company or to one legal entity / location; access follows the role's scope. */
function canAsset(auth: ReturnType<typeof requireAuth>, action: string, a: { entity_id: string | null; location_id: string | null }) {
  return a.entity_id || a.location_id ? can(auth.principal, action, { entityId: a.entity_id, locationId: a.location_id }) : can(auth.principal, action);
}
function need(req: FastifyRequest, action: string) {
  const auth = requireAuth(req);
  if (!canSome(auth.principal, action)) throw new ApiError('forbidden');
  return auth;
}
async function tenantLocale(tx: Tx) {
  const l = (await tx.one<{ default_locale: string }>('SELECT default_locale FROM app.tenants')).default_locale;
  return isLocale(l) ? l : 'en-GB';
}

export async function assetRoutes(app: FastifyInstance) {
  const deps = app.deps;

  async function loadAsset(tx: Tx, id: string, lock = false) {
    const a = await tx.maybe<AssetRow>(`${ASSET_SELECT} WHERE a.id = $1${lock ? ' FOR UPDATE OF a' : ''}`, [id]);
    if (!a) throw new ApiError('notFound');
    return a;
  }
  async function loadAssignment(tx: Tx, id: string) {
    const s = await tx.maybe<AssignmentRow>(`${ASSIGNMENT_SELECT} WHERE s.id = $1 FOR UPDATE OF s`, [id]);
    if (!s) throw new ApiError('notFound');
    return s;
  }

  app.get('/v1/assets', { schema: { tags: ['assets'], querystring: Type.Object({ status: Type.Optional(Type.String({ maxLength: 20 })), type: Type.Optional(lit(TYPES)), q: Type.Optional(Type.String({ maxLength: 100 })) }), response: { 200: Type.Array(AssetOut), 403: Problem } } }, async (req) => {
    const auth = need(req, 'assets.read');
    const q = req.query as { status?: string; type?: string; q?: string };
    const rows = await app.tenantTx(
      req,
      (tx) => tx.query<AssetRow>(`${ASSET_SELECT} WHERE ($1::text IS NULL OR a.status = $1) AND ($2::text IS NULL OR a.type = $2) AND ($3::text IS NULL OR a.name ILIKE '%' || $3 || '%' OR a.asset_tag ILIKE $3 || '%' OR a.serial_number ILIKE $3 || '%') ORDER BY a.asset_tag LIMIT 1000`, [q.status ?? null, q.type ?? null, q.q ?? null]),
      { readOnly: true },
    );
    return rows.filter((r) => canAsset(auth, 'assets.read', r)).map(mapAsset);
  });

  app.post('/v1/assets', { config: { selfAudited: true }, schema: { tags: ['assets'], body: AssetBody, response: { 201: AssetOut, 400: Problem, 403: Problem, 409: Problem } } }, async (req, reply) => {
    const auth = need(req, 'assets.manage');
    const b = req.body as { assetTag: string; type: AssetType; name: string; serialNumber?: string | null; costMinor?: number | null; currency?: string | null; purchasedOn?: string | null; entityId?: string | null; locationId?: string | null; notes?: string | null; returnChecklist?: Array<{ key: string; label?: string }> };
    if ((b.costMinor === undefined || b.costMinor === null) !== (b.currency === undefined || b.currency === null)) throw new ApiError('validation', 'Give the cost together with its currency');
    if (!canAsset(auth, 'assets.manage', { entity_id: b.entityId ?? null, location_id: b.locationId ?? null })) throw new ApiError('forbidden');
    const out = await app.tenantTx(req, async (tx) => {
      const checklist = b.returnChecklist ?? DEFAULT_CHECKLISTS[b.type].map((key) => ({ key }));
      const r = await tx.one<{ id: string }>(
        `INSERT INTO app.assets (tenant_id, asset_tag, type, name, serial_number, cost_minor, currency, purchased_on, entity_id, location_id, notes, return_checklist, created_by)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [b.assetTag, b.type, b.name, b.serialNumber ?? null, b.costMinor ?? null, b.currency ?? null, b.purchasedOn ?? null, b.entityId ?? null, b.locationId ?? null, b.notes ?? null, JSON.stringify(checklist), auth.userId],
      );
      await app.audit(tx, req, { action: 'asset.created', targetType: 'asset', targetId: r.id, diff: { assetTag: b.assetTag, type: b.type, name: b.name, costMinor: b.costMinor ?? null, currency: b.currency ?? null } });
      return mapAsset(await loadAsset(tx, r.id));
    });
    return reply.status(201).send(out);
  });

  app.get('/v1/assets/:id', { schema: { tags: ['assets'], params: Type.Object({ id: Uuid }), response: { 200: Type.Object({ ...AssetOut.properties, assignments: Type.Array(AssignmentOut) }), 403: Problem, 404: Problem } } }, async (req) => {
    const auth = need(req, 'assets.read');
    return app.tenantTx(
      req,
      async (tx) => {
        const a = await loadAsset(tx, (req.params as { id: string }).id);
        if (!canAsset(auth, 'assets.read', a)) throw new ApiError('notFound');
        const history = await tx.query<AssignmentRow>(`${ASSIGNMENT_SELECT} WHERE s.asset_id = $1 ORDER BY s.assigned_on DESC, s.created_at DESC`, [a.id]);
        return { ...mapAsset(a), assignments: history.map(mapAssignment) };
      },
      { readOnly: true },
    );
  });

  app.patch('/v1/assets/:id', { config: { selfAudited: true }, schema: { tags: ['assets'], params: Type.Object({ id: Uuid }), body: AssetPatch, response: { 200: AssetOut, 400: Problem, 403: Problem, 404: Problem, 409: Problem } } }, async (req) => {
    const auth = need(req, 'assets.manage');
    const b = req.body as Record<string, unknown>;
    return app.tenantTx(req, async (tx) => {
      const a = await loadAsset(tx, (req.params as { id: string }).id, true);
      if (!canAsset(auth, 'assets.manage', a)) throw new ApiError('forbidden');
      if (b.status && a.holder_assignment) throw new ApiError('conflict', 'Record the return before changing the status of an issued asset');
      const cols: Record<string, string> = { name: 'name', serialNumber: 'serial_number', costMinor: 'cost_minor', currency: 'currency', purchasedOn: 'purchased_on', entityId: 'entity_id', locationId: 'location_id', notes: 'notes', returnChecklist: 'return_checklist', status: 'status' };
      const sets: string[] = [];
      const vals: unknown[] = [a.id];
      for (const [k, col] of Object.entries(cols)) {
        if (b[k] === undefined) continue;
        vals.push(k === 'returnChecklist' ? JSON.stringify(b[k]) : b[k]);
        sets.push(`${col} = $${vals.length}`);
      }
      if (sets.length) await tx.exec(`UPDATE app.assets SET ${sets.join(', ')} WHERE id = $1`, vals);
      await app.audit(tx, req, { action: 'asset.updated', targetType: 'asset', targetId: a.id, diff: { fields: Object.keys(b), status: b.status } });
      return mapAsset(await loadAsset(tx, a.id));
    });
  });

  // ---- assignment and handover sign-off ------------------------------------------------------------------------------
  app.post(
    '/v1/assets/:id/assign',
    { config: { selfAudited: true }, schema: { tags: ['assets'], summary: 'Issue an asset to an employee; the employee is asked to acknowledge the handover', params: Type.Object({ id: Uuid }), body: Type.Object({ employeeId: Uuid, assignedOn: CivilDate, dueBackOn: Type.Optional(Nullable(CivilDate)), conditionOut: Type.Optional(Type.String({ maxLength: 500 })), handoverNote: Type.Optional(Type.String({ maxLength: 2000 })) }, { additionalProperties: false }), response: { 201: AssignmentOut, 400: Problem, 403: Problem, 404: Problem, 409: Problem } } },
    async (req, reply) => {
      const auth = need(req, 'assets.manage');
      const b = req.body as { employeeId: string; assignedOn: string; dueBackOn?: string | null; conditionOut?: string; handoverNote?: string };
      if (b.dueBackOn && compareDates(b.dueBackOn, b.assignedOn) < 0) throw new ApiError('validation', 'dueBackOn is before assignedOn');
      const out = await app.tenantTx(req, async (tx) => {
        const a = await loadAsset(tx, (req.params as { id: string }).id, true);
        if (!canAsset(auth, 'assets.manage', a) || !can(auth.principal, 'assets.manage', await loadTarget(tx, b.employeeId))) throw new ApiError('forbidden');
        if (a.status !== 'in_stock') throw new ApiError('conflict', 'This asset is not in stock');
        const s = await tx.one<{ id: string }>(
          `INSERT INTO app.asset_assignments (tenant_id, asset_id, employee_id, assigned_on, due_back_on, condition_out, handover_note, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [a.id, b.employeeId, b.assignedOn, b.dueBackOn ?? null, b.conditionOut ?? null, b.handoverNote ?? null, auth.userId],
        );
        await tx.exec(`UPDATE app.assets SET status = 'assigned' WHERE id = $1`, [a.id]);
        const user = await userForEmployee(tx, b.employeeId);
        if (user) {
          const locale = await tenantLocale(tx);
          const taskId = await createTask(tx, { source: 'manual', sourceId: s.id, title: t(locale, 'assets.ackTaskTitle', { asset: a.name }), subjectEmployeeId: b.employeeId, assigneeUserId: user, link: `/app/assets?ack=${s.id}`, dedupeKey: `asset-ack:${s.id}` });
          await tx.exec('UPDATE app.asset_assignments SET acknowledgement_task_id = $2 WHERE id = $1', [s.id, taskId ?? null]);
          await notify(tx, { userIds: [user], kind: 'asset.assigned', titleKey: 'notify.assetAssigned', params: { asset: a.name }, link: `/app/assets?ack=${s.id}`, dedupeKey: `asset-assigned:${s.id}` });
        }
        await app.audit(tx, req, { action: 'asset.assigned', targetType: 'asset', targetId: a.id, diff: { assignmentId: s.id, employeeId: b.employeeId, assignedOn: b.assignedOn, dueBackOn: b.dueBackOn ?? null } });
        return mapAssignment(await loadAssignment(tx, s.id));
      });
      return reply.status(201).send(out);
    },
  );

  app.post(
    '/v1/asset-assignments/:id/acknowledge',
    { config: { selfAudited: true }, schema: { tags: ['assets'], summary: 'The employee confirms they received the asset (handover sign-off)', params: Type.Object({ id: Uuid }), body: Type.Object({ confirm: Type.Literal(true) }, { additionalProperties: false }), response: { 200: AssignmentOut, 403: Problem, 404: Problem, 409: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const s = await loadAssignment(tx, id);
        // only the person who received the asset can sign for it
        if (s.employee_id !== auth.principal.employeeId || !can(auth.principal, 'assets.acknowledge', { employeeId: s.employee_id })) throw new ApiError('notFound');
        if (s.status !== 'active') throw new ApiError('conflict', 'This asset has been returned');
        if (s.acknowledged_at) throw new ApiError('conflict', 'Already acknowledged');
        const at = deps.now().toISOString();
        await tx.exec(`UPDATE app.asset_assignments SET acknowledged_at = $2, acknowledged_by = $3, acknowledged_ip = $4, acknowledged_user_agent = $5, acknowledgement_statement = $6 WHERE id = $1`, [id, at, auth.userId, req.ctx.ip, req.ctx.userAgent?.slice(0, 512) ?? null, ACK_STATEMENT]);
        if (s.acknowledgement_task_id) await tx.exec(`UPDATE app.tasks SET status = 'done', completed_at = $2, completed_by = $3 WHERE id = $1 AND status = 'open'`, [s.acknowledgement_task_id, at, auth.userId]);
        await app.audit(tx, req, { action: 'asset.acknowledged', targetType: 'asset_assignment', targetId: id, diff: { assetId: s.asset_id, acknowledgedAt: at, statement: ACK_STATEMENT } });
        return mapAssignment(await loadAssignment(tx, id));
      });
    },
  );

  app.post(
    '/v1/asset-assignments/:id/return',
    { config: { selfAudited: true }, schema: { tags: ['assets'], summary: 'Record the return against the checklist (completes the offboarding return task)', params: Type.Object({ id: Uuid }), body: Type.Object({ returnedOn: CivilDate, outcome: Type.Optional(lit(['returned', 'lost'] as const)), conditionIn: Type.Optional(Type.String({ maxLength: 500 })), checklist: Type.Array(Type.Object({ key: Type.String({ maxLength: 40 }), done: Type.Boolean() }, { additionalProperties: false }), { maxItems: 20 }), assetStatus: Type.Optional(lit(['in_stock', 'in_repair', 'retired'] as const)) }, { additionalProperties: false }), response: { 200: AssignmentOut, 403: Problem, 404: Problem, 409: Problem, 422: Problem } } },
    async (req) => {
      const auth = need(req, 'assets.manage');
      const { id } = req.params as { id: string };
      const b = req.body as { returnedOn: string; outcome?: 'returned' | 'lost'; conditionIn?: string; checklist: Array<{ key: string; done: boolean }>; assetStatus?: 'in_stock' | 'in_repair' | 'retired' };
      const outcome = b.outcome ?? 'returned';
      return app.tenantTx(req, async (tx) => {
        const s = await loadAssignment(tx, id);
        if (!can(auth.principal, 'assets.manage', await loadTarget(tx, s.employee_id))) throw new ApiError('forbidden');
        if (s.status !== 'active') throw new ApiError('conflict', 'This assignment is already closed');
        if (compareDates(b.returnedOn, s.assigned_on) < 0) throw new ApiError('validation', 'returnedOn is before the assignment');
        const done = new Map(b.checklist.map((c) => [c.key, c.done]));
        const checklist = s.return_checklist.map((item) => ({ ...item, done: done.get(item.key) === true }));
        const missing = checklist.filter((c) => !c.done).map((c) => c.key);
        if (outcome === 'returned' && missing.length) throw new ApiError('unprocessable', 'Every checklist item must be ticked to record a return', { missing });
        const at = deps.now().toISOString();
        await tx.exec(`UPDATE app.asset_assignments SET status = $2, returned_on = $3, returned_at = $4, received_by = $5, condition_in = $6, checklist = $7 WHERE id = $1`, [id, outcome, b.returnedOn, at, auth.userId, b.conditionIn ?? null, JSON.stringify(checklist)]);
        await tx.exec(`UPDATE app.assets SET status = $2 WHERE id = $1`, [s.asset_id, outcome === 'lost' ? 'lost' : (b.assetStatus ?? 'in_stock')]);
        if (s.return_task_id) {
          const task = await tx.maybe<{ source: string; source_id: string | null }>(`UPDATE app.tasks SET status = 'done', completed_at = $2, completed_by = $3 WHERE id = $1 AND status = 'open' RETURNING source, source_id`, [s.return_task_id, at, auth.userId]);
          if (task?.source === 'workflow' && task.source_id) await maybeCompleteInstance(tx, task.source_id);
        }
        if (s.acknowledgement_task_id) await tx.exec(`UPDATE app.tasks SET status = 'cancelled' WHERE id = $1 AND status = 'open'`, [s.acknowledgement_task_id]);
        await app.audit(tx, req, { action: outcome === 'lost' ? 'asset.lost' : 'asset.returned', targetType: 'asset_assignment', targetId: id, diff: { assetId: s.asset_id, returnedOn: b.returnedOn, checklist: checklist.map((c) => `${c.key}:${c.done ? 'yes' : 'no'}`), returnTaskId: s.return_task_id } });
        return mapAssignment(await loadAssignment(tx, id));
      });
    },
  );

  app.get('/v1/asset-assignments', { schema: { tags: ['assets'], querystring: Type.Object({ employeeId: Uuid, status: Type.Optional(lit(['active', 'returned', 'lost'] as const)) }), response: { 200: Type.Array(AssignmentOut), 403: Problem } } }, async (req) => {
    const auth = requireAuth(req);
    const q = req.query as { employeeId: string; status?: string };
    return app.tenantTx(
      req,
      async (tx) => {
        const own = q.employeeId === auth.principal.employeeId;
        if (!(own ? can(auth.principal, 'assets.read_own', { employeeId: q.employeeId }) : can(auth.principal, 'assets.read', await loadTarget(tx, q.employeeId)))) throw new ApiError('forbidden');
        return (await tx.query<AssignmentRow>(`${ASSIGNMENT_SELECT} WHERE s.employee_id = $1 AND ($2::text IS NULL OR s.status = $2) ORDER BY s.assigned_on DESC`, [q.employeeId, q.status ?? null])).map(mapAssignment);
      },
      { readOnly: true },
    );
  });

  app.get('/v1/me/assets', { schema: { tags: ['assets'], summary: 'Equipment issued to me (with handover sign-off status)', response: { 200: Type.Array(AssignmentOut) } } }, async (req) => {
    const auth = requireAuth(req);
    const employeeId = auth.principal.employeeId;
    if (!employeeId || !can(auth.principal, 'assets.read_own', { employeeId })) return [];
    return (await app.tenantTx(req, (tx) => tx.query<AssignmentRow>(`${ASSIGNMENT_SELECT} WHERE s.employee_id = $1 AND s.status = 'active' ORDER BY s.assigned_on DESC`, [employeeId]), { readOnly: true })).map(mapAssignment);
  });
}

// ---- offboarding: one return task per issued asset ------------------------------------------------------------------------
workflowStartHooks.push(async (tx, inst) => {
  if (inst.kind !== 'offboarding') return;
  const active = await tx.query<{ id: string; name: string; asset_tag: string }>(
    `SELECT s.id, a.name, a.asset_tag FROM app.asset_assignments s JOIN app.assets a ON a.tenant_id = s.tenant_id AND a.id = s.asset_id WHERE s.employee_id = $1 AND s.status = 'active' ORDER BY a.asset_tag`,
    [inst.employeeId],
  );
  if (!active.length) return;
  const settings = await tx.one<{ assets: { returnAssigneeRole?: string } | null; default_locale: string }>(`SELECT features->'assets' AS assets, default_locale FROM app.tenants`);
  const locale = isLocale(settings.default_locale) ? settings.default_locale : 'en-GB';
  const role = settings.assets?.returnAssigneeRole ?? 'hr_admin';
  for (const s of active) {
    const taskId = await createTask(tx, { source: 'workflow', sourceId: inst.id, title: t(locale, 'assets.returnTaskTitle', { asset: s.name, tag: s.asset_tag }), subjectEmployeeId: inst.employeeId, assigneeRole: role, dueOn: inst.anchorDate, link: `/app/assets?return=${s.id}`, dedupeKey: `asset-return:${s.id}` });
    if (taskId) await tx.exec(`UPDATE app.asset_assignments SET return_task_id = $2, return_requested_on = $3 WHERE id = $1`, [s.id, taskId, inst.anchorDate]);
  }
});
