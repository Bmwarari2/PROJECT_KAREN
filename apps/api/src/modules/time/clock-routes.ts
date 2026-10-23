import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { can, canSome } from '@thapsus/core/permissions';
import { addMinutes, compareInstants, instantToDate, isValidTimeZone, Temporal } from '@thapsus/core/time';
import { withTenant, writeAudit, type Tx } from '@thapsus/db';
import { authorize, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { throttle } from '../auth/common';
import {
  burnPasswordCheck,
  composeToken,
  hashPassword,
  hashToken,
  newToken,
  parseToken,
  verifyPassword,
} from '../auth/tokens';
import { loadTarget } from '../employees/service';
import { clockState, metresBetween, type ClockKind } from './engine';
import {
  employeeTimeContext,
  mergeTimeSettings,
  timeSettings,
  weekStartFor,
  type EmployeeTimeContext,
  type TimeSettings,
  type TimeSettingsPatch,
} from './service';
import { ClockEventIn, TimeSettingsSchema, Zone } from './schemas';

const KIOSK_PREFIX = 'kio_';
/** Clock events may arrive slightly ahead of the server clock (device skew). */
const CLOCK_SKEW_MINUTES = 5;
const Kind = Type.Union([
  Type.Literal('in'),
  Type.Literal('out'),
  Type.Literal('break_start'),
  Type.Literal('break_end'),
]);
const GeofenceInfo = Type.Object({ enabled: Type.Boolean(), notice: Nullable(Type.String()) });
const ClockStateOut = Type.Object({
  state: Type.Union([Type.Literal('out'), Type.Literal('in'), Type.Literal('break')]),
  since: Nullable(Type.String()),
});
const ClockEventOut = Type.Object({
  id: Uuid,
  kind: Type.String(),
  occurredAt: Type.String(),
  zone: Type.String(),
  source: Type.String(),
  withinGeofence: Nullable(Type.Boolean()),
  reason: Nullable(Type.String()),
  replacesEventId: Nullable(Uuid),
  superseded: Type.Boolean(),
});

/** Geofencing applies only where the tenant enabled it for the worker's country AND the location has a fence. */
function geofenceFor(settings: TimeSettings, ctx: EmployeeTimeContext, locale: string) {
  const enabled = !!ctx.country && settings.geofence.countries.includes(ctx.country) && !!ctx.geofence;
  const texts = ctx.country ? settings.geofence.notice[ctx.country] : undefined;
  const notice =
    enabled && texts
      ? (texts[locale] ?? texts['en-GB'] ?? texts['en-US'] ?? Object.values(texts)[0] ?? null)
      : null;
  return { enabled, notice };
}

/** RFC 3339 date-time (any offset) → UTC instant string. */
const toInstant = (v: string) => Temporal.Instant.from(v).toString();
const kioskHash = (secret: string) => hashToken(secret).toString('hex');
const weakPin = (pin: string) =>
  /^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin);

interface InsertedEvent {
  status: 'created' | 'duplicate' | 'rejected';
  id?: string;
  withinGeofence?: boolean | null;
  reason?: string;
}

/** Appends a clock event; idempotent per (tenant, employee, clientEventId). Coordinates are kept only when geofencing applies. */
async function insertClockEvent(
  tx: Tx,
  e: {
    employeeId: string;
    kind: ClockKind;
    occurredAt: string;
    zone: string;
    source: 'pwa' | 'kiosk' | 'manager';
    clientEventId: string;
    location?: { lat: number; lng: number } | null;
    geofence?: EmployeeTimeContext['geofence'] | null;
    recordedBy?: string | null;
    reason?: string | null;
    replacesEventId?: string | null;
    kioskId?: string | null;
  },
): Promise<InsertedEvent> {
  let lat: number | null = null;
  let lng: number | null = null;
  let within: boolean | null = null;
  if (e.geofence && e.location) {
    // coarse (4 dp ≈ 11 m) and never logged
    lat = Math.round(e.location.lat * 1e4) / 1e4;
    lng = Math.round(e.location.lng * 1e4) / 1e4;
    within = metresBetween(e.location, e.geofence) <= e.geofence.radiusMetres;
  }
  const row = await tx.maybe<{ id: string }>(
    `INSERT INTO app.clock_events (tenant_id, employee_id, kind, occurred_at, zone, source, client_event_id, lat, lng, within_geofence, recorded_by, reason, replaces_event_id, kiosk_id)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (tenant_id, employee_id, client_event_id) DO NOTHING RETURNING id`,
    [
      e.employeeId,
      e.kind,
      e.occurredAt,
      e.zone,
      e.source,
      e.clientEventId,
      lat,
      lng,
      within,
      e.recordedBy ?? null,
      e.reason ?? null,
      e.replacesEventId ?? null,
      e.kioskId ?? null,
    ],
  );
  return row ? { status: 'created', id: row.id, withinGeofence: within } : { status: 'duplicate' };
}

async function currentState(tx: Tx, employeeId: string, now: string) {
  const events = await tx.query<{ kind: ClockKind; occurred_at: string }>(
    `SELECT c.kind, c.occurred_at FROM app.clock_events c WHERE c.employee_id = $1 AND c.occurred_at >= ($2::timestamptz - interval '2 days') AND c.occurred_at <= $2::timestamptz
        AND NOT EXISTS (SELECT 1 FROM app.clock_events r WHERE r.tenant_id = c.tenant_id AND r.replaces_event_id = c.id) ORDER BY c.occurred_at`,
    [employeeId, now],
  );
  return clockState(events);
}

/** Corrections may not change a week whose timesheet was submitted or approved (payroll reproducibility). */
async function assertWeekOpen(
  tx: Tx,
  settings: TimeSettings,
  employeeId: string,
  occurredAt: string,
  zone: string,
) {
  const weekStart = weekStartFor(instantToDate(occurredAt, zone), settings.workweekStartsOn);
  const ts = await tx.maybe<{ status: string }>(
    'SELECT status FROM app.timesheets WHERE employee_id = $1 AND week_start = $2',
    [employeeId, weekStart],
  );
  if (ts && ['submitted', 'approved'].includes(ts.status))
    throw new ApiError('conflict', 'The timesheet for this week is submitted or approved — reopen it first');
}

export async function clockRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const now = () => deps.now().toISOString();

  // ---- settings ---------------------------------------------------------------------------------------
  app.get(
    '/v1/settings/time',
    {
      schema: {
        tags: ['time'],
        summary: 'Time and rota settings (readable by every signed-in user, e.g. for the geofence notice)',
        response: { 200: TimeSettingsSchema },
      },
    },
    async (req) => {
      requireAuth(req);
      return app.tenantTx(req, (tx) => timeSettings(tx), { readOnly: true });
    },
  );

  app.put(
    '/v1/settings/time',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['time'],
        body: Type.Partial(
          Type.Object({
            enforcement: TimeSettingsSchema.properties.enforcement,
            workweekStartsOn: TimeSettingsSchema.properties.workweekStartsOn,
            geofence: TimeSettingsSchema.properties.geofence,
            kiosk: Type.Partial(TimeSettingsSchema.properties.kiosk),
            clock: Type.Partial(TimeSettingsSchema.properties.clock),
            timesheets: Type.Partial(TimeSettingsSchema.properties.timesheets),
          }),
        ),
        response: { 200: TimeSettingsSchema, 403: Problem, 422: Problem },
      },
    },
    async (req) => {
      authorize(req, 'time.manage');
      const patch = req.body as TimeSettingsPatch;
      return app.tenantTx(req, async (tx) => {
        const before = await timeSettings(tx);
        const next = mergeTimeSettings(before, patch);
        next.geofence.countries = [...new Set(next.geofence.countries)].sort();
        // Workers must be told before location is recorded: every enabled country needs notice text.
        const missing = next.geofence.countries.filter(
          (c) => !Object.values(next.geofence.notice[c] ?? {}).some((t) => t.trim().length > 0),
        );
        if (missing.length)
          throw new ApiError(
            'unprocessable',
            'Add the notice workers will see for each country with geofencing',
            { countries: missing },
          );
        await tx.exec(`UPDATE app.tenants SET features = jsonb_set(features, '{time}', $1::jsonb)`, [
          JSON.stringify(next),
        ]);
        await app.audit(tx, req, {
          action: 'settings.time_updated',
          targetType: 'tenant',
          diff: {
            before: { ...before, geofence: { countries: before.geofence.countries } },
            after: { ...next, geofence: { countries: next.geofence.countries } },
          },
        });
        return next;
      });
    },
  );

  // ---- clocking (PWA, offline queue) -------------------------------------------------------------------
  app.post(
    '/v1/clock/events',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['time'],
        summary:
          'Batch sync of clock events from the offline queue; idempotent per clientEventId. Coordinates are discarded unless geofencing applies.',
        body: Type.Object({ events: Type.Array(ClockEventIn, { minItems: 1, maxItems: 200 }) }),
        response: {
          200: Type.Object({
            results: Type.Array(
              Type.Object({
                clientEventId: Type.String(),
                status: Type.Union([
                  Type.Literal('created'),
                  Type.Literal('duplicate'),
                  Type.Literal('rejected'),
                ]),
                id: Type.Optional(Uuid),
                withinGeofence: Type.Optional(Nullable(Type.Boolean())),
                reason: Type.Optional(Type.String()),
              }),
            ),
            state: ClockStateOut,
            geofence: GeofenceInfo,
          }),
          403: Problem,
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const me = auth.principal.employeeId;
      if (!me || !can(auth.principal, 'time.clock', { employeeId: me })) throw new ApiError('forbidden');
      const { events } = req.body as {
        events: Array<{
          clientEventId: string;
          kind: ClockKind;
          occurredAt: string;
          zone?: string;
          location?: { lat: number; lng: number };
        }>;
      };
      const t = now();
      return app.tenantTx(req, async (tx) => {
        const settings = await timeSettings(tx);
        const ctx = await employeeTimeContext(tx, me);
        const geo = geofenceFor(settings, ctx, req.ctx.locale);
        const results: Array<InsertedEvent & { clientEventId: string }> = [];
        const earliest = addMinutes(t, -settings.clock.maxOfflineHours * 60);
        for (const e of events) {
          const at = toInstant(e.occurredAt);
          if (compareInstants(at, addMinutes(t, CLOCK_SKEW_MINUTES)) > 0)
            results.push({ clientEventId: e.clientEventId, status: 'rejected', reason: 'inFuture' });
          else if (compareInstants(at, earliest) < 0)
            results.push({ clientEventId: e.clientEventId, status: 'rejected', reason: 'tooOld' });
          else {
            const zone = e.zone && isValidTimeZone(e.zone) ? e.zone : ctx.zone;
            const r = await insertClockEvent(tx, {
              employeeId: me,
              kind: e.kind,
              occurredAt: at,
              zone,
              source: 'pwa',
              clientEventId: e.clientEventId,
              location: geo.enabled ? e.location : null,
              geofence: geo.enabled ? ctx.geofence : null,
              recordedBy: auth.userId,
            });
            results.push({ clientEventId: e.clientEventId, ...r });
          }
        }
        const count = (s: string) => results.filter((r) => r.status === s).length;
        await app.audit(tx, req, {
          action: 'clock.synced',
          targetType: 'employee',
          targetId: me,
          diff: {
            created: count('created'),
            duplicate: count('duplicate'),
            rejected: count('rejected'),
            geofence: geo.enabled,
          },
        });
        return { results, state: await currentState(tx, me, t), geofence: geo };
      });
    },
  );

  app.get(
    '/v1/clock/status',
    {
      schema: {
        tags: ['time'],
        response: {
          200: Type.Object({
            employeeId: Nullable(Uuid),
            state: ClockStateOut,
            zone: Nullable(Type.String()),
            geofence: GeofenceInfo,
            today: Type.Array(ClockEventOut),
          }),
        },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const me = auth.principal.employeeId;
      if (!me)
        return {
          employeeId: null,
          state: { state: 'out' as const, since: null },
          zone: null,
          geofence: { enabled: false, notice: null },
          today: [],
        };
      return app.tenantTx(
        req,
        async (tx) => {
          const settings = await timeSettings(tx);
          const ctx = await employeeTimeContext(tx, me);
          const t = now();
          const rows = await eventsBetween(tx, me, addMinutes(t, -24 * 60), t);
          return {
            employeeId: me,
            state: await currentState(tx, me, t),
            zone: ctx.zone,
            geofence: geofenceFor(settings, ctx, req.ctx.locale),
            today: rows,
          };
        },
        { readOnly: true },
      );
    },
  );

  async function eventsBetween(tx: Tx, employeeId: string, from: string, to: string) {
    const rows = await tx.query<{
      id: string;
      kind: string;
      occurred_at: string;
      zone: string;
      source: string;
      within_geofence: boolean | null;
      reason: string | null;
      replaces_event_id: string | null;
      superseded: boolean;
    }>(
      `SELECT c.id, c.kind, c.occurred_at, c.zone, c.source, c.within_geofence, c.reason, c.replaces_event_id,
              EXISTS (SELECT 1 FROM app.clock_events r WHERE r.tenant_id = c.tenant_id AND r.replaces_event_id = c.id) AS superseded
         FROM app.clock_events c WHERE c.employee_id = $1 AND c.occurred_at >= $2 AND c.occurred_at <= $3 ORDER BY c.occurred_at, c.created_at LIMIT 2000`,
      [employeeId, from, to],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      occurredAt: r.occurred_at,
      zone: r.zone,
      source: r.source,
      withinGeofence: r.within_geofence,
      reason: r.reason,
      replacesEventId: r.replaces_event_id,
      superseded: r.superseded,
    }));
  }

  app.get(
    '/v1/clock/events',
    {
      schema: {
        tags: ['time'],
        summary: 'Clock events for an employee (never includes coordinates)',
        querystring: Type.Object({ employeeId: Type.Optional(Uuid), from: CivilDate, to: CivilDate }),
        response: { 200: Type.Array(ClockEventOut), 403: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const q = req.query as { employeeId?: string; from: string; to: string };
      const employeeId = q.employeeId ?? auth.principal.employeeId;
      if (!employeeId) throw new ApiError('validation', 'employeeId is required');
      return app.tenantTx(
        req,
        async (tx) => {
          const own = employeeId === auth.principal.employeeId;
          if (
            !(own
              ? can(auth.principal, 'time.clock', { employeeId })
              : can(auth.principal, 'time.read', await loadTarget(tx, employeeId)))
          )
            throw new ApiError('forbidden');
          return eventsBetween(tx, employeeId, `${q.from}T00:00:00Z`, `${q.to}T23:59:59Z`);
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/clock/corrections',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['time'],
        summary:
          'Manager correction: a new clock event (source manager, with reason) that may supersede an earlier one; audited',
        body: Type.Object({
          employeeId: Uuid,
          kind: Kind,
          occurredAt: Type.String({ format: 'date-time' }),
          zone: Type.Optional(Zone),
          reason: Type.String({ minLength: 3, maxLength: 500 }),
          replacesEventId: Type.Optional(Uuid),
        }),
        response: { 201: Type.Object({ id: Uuid }), 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as {
        employeeId: string;
        kind: ClockKind;
        occurredAt: string;
        zone?: string;
        reason: string;
        replacesEventId?: string;
      };
      const out = await app.tenantTx(req, async (tx) => {
        if (!can(auth.principal, 'time.correct', await loadTarget(tx, b.employeeId)))
          throw new ApiError('forbidden');
        const settings = await timeSettings(tx);
        const ctx = await employeeTimeContext(tx, b.employeeId);
        const zone = b.zone ?? ctx.zone;
        const at = toInstant(b.occurredAt);
        if (b.replacesEventId) {
          const orig = await tx.maybe<{ occurred_at: string; zone: string }>(
            'SELECT occurred_at, zone FROM app.clock_events WHERE id = $1 AND employee_id = $2',
            [b.replacesEventId, b.employeeId],
          );
          if (!orig) throw new ApiError('notFound');
          if (
            await tx.maybe('SELECT 1 FROM app.clock_events WHERE replaces_event_id = $1', [b.replacesEventId])
          )
            throw new ApiError('conflict', 'Already corrected');
          await assertWeekOpen(tx, settings, b.employeeId, orig.occurred_at, orig.zone);
        }
        await assertWeekOpen(tx, settings, b.employeeId, at, zone);
        const r = await insertClockEvent(tx, {
          employeeId: b.employeeId,
          kind: b.kind,
          occurredAt: at,
          zone,
          source: 'manager',
          clientEventId: `manager:${randomUUID()}`,
          recordedBy: auth.userId,
          reason: b.reason,
          replacesEventId: b.replacesEventId ?? null,
        });
        await app.audit(tx, req, {
          action: 'clock.corrected',
          targetType: 'employee',
          targetId: b.employeeId,
          diff: {
            eventId: r.id,
            kind: b.kind,
            occurredAt: at,
            replacesEventId: b.replacesEventId ?? null,
            reason: b.reason,
          },
        });
        return { id: r.id! };
      });
      return reply.status(201).send(out);
    },
  );

  // ---- kiosks -----------------------------------------------------------------------------------------------
  const KioskOut = Type.Object({
    id: Uuid,
    name: Type.String(),
    locationId: Nullable(Uuid),
    createdAt: Type.String(),
    lastUsedAt: Nullable(Type.String()),
    revokedAt: Nullable(Type.String()),
  });
  const kioskOut = (k: {
    id: string;
    name: string;
    location_id: string | null;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
  }) => ({
    id: k.id,
    name: k.name,
    locationId: k.location_id,
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
    revokedAt: k.revoked_at,
  });

  app.post(
    '/v1/kiosks',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['time'],
        summary: 'Registers a shared kiosk device. The token is returned once; only its hash is stored.',
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 120 }),
          locationId: Type.Optional(Nullable(Uuid)),
        }),
        response: { 201: Type.Object({ id: Uuid, name: Type.String(), token: Type.String() }), 403: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'time.manage')) throw new ApiError('forbidden');
      const b = req.body as { name: string; locationId?: string | null };
      const secret = newToken();
      const row = await app.tenantTx(req, async (tx) => {
        const k = await tx.one<{ id: string }>(
          `INSERT INTO app.kiosks (tenant_id, name, location_id, token_hash, created_by) VALUES (app.current_tenant(), $1, $2, $3, $4) RETURNING id`,
          [b.name, b.locationId ?? null, kioskHash(secret), auth.userId],
        );
        await app.audit(tx, req, {
          action: 'kiosk.created',
          targetType: 'kiosk',
          targetId: k.id,
          diff: { name: b.name, locationId: b.locationId ?? null },
        });
        return k;
      });
      return reply
        .status(201)
        .send({ id: row.id, name: b.name, token: composeToken(KIOSK_PREFIX, auth.tenantId, secret) });
    },
  );

  app.get(
    '/v1/kiosks',
    { schema: { tags: ['time'], response: { 200: Type.Array(KioskOut), 403: Problem } } },
    async (req) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'time.manage')) throw new ApiError('forbidden');
      return app.tenantTx(
        req,
        async (tx) =>
          (
            await tx.query<Parameters<typeof kioskOut>[0]>(
              'SELECT * FROM app.kiosks ORDER BY created_at DESC LIMIT 500',
            )
          ).map(kioskOut),
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/kiosks/:id/revoke',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['time'],
        params: Type.Object({ id: Uuid }),
        response: { 200: KioskOut, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      if (!canSome(auth.principal, 'time.manage')) throw new ApiError('forbidden');
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const k = await tx.maybe<Parameters<typeof kioskOut>[0]>(
          'UPDATE app.kiosks SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 RETURNING *',
          [id],
        );
        if (!k) throw new ApiError('notFound');
        await app.audit(tx, req, { action: 'kiosk.revoked', targetType: 'kiosk', targetId: id });
        return kioskOut(k);
      });
    },
  );

  app.put(
    '/v1/kiosk-pins/:employeeId',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['time'],
        summary: 'Sets an employee kiosk PIN (stored as an Argon2id hash)',
        params: Type.Object({ employeeId: Uuid }),
        body: Type.Object({ pin: Type.String({ pattern: '^\\d{4,8}$' }) }),
        response: { 204: Type.Null(), 403: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { employeeId } = req.params as { employeeId: string };
      const { pin } = req.body as { pin: string };
      if (weakPin(pin)) throw new ApiError('unprocessable', 'Choose a less predictable PIN');
      const hash = await hashPassword(pin);
      await app.tenantTx(req, async (tx) => {
        const own = employeeId === auth.principal.employeeId;
        if (
          !(own
            ? can(auth.principal, 'time.clock', { employeeId })
            : can(auth.principal, 'time.manage', await loadTarget(tx, employeeId)))
        )
          throw new ApiError('forbidden');
        await tx.exec(
          `INSERT INTO app.kiosk_pins (tenant_id, employee_id, pin_hash) VALUES (app.current_tenant(), $1, $2)
           ON CONFLICT (tenant_id, employee_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, failed_attempts = 0, locked_until = NULL, updated_at = now()`,
          [employeeId, hash],
        );
        await app.audit(tx, req, { action: 'kiosk.pin_set', targetType: 'employee', targetId: employeeId });
      });
      return reply.status(204).send(null);
    },
  );

  // ---- public kiosk endpoints (authenticated by the kiosk token, not a session) ----------------------------
  function kioskToken(req: FastifyRequest) {
    const h = req.headers.authorization;
    return parseToken(KIOSK_PREFIX, h?.startsWith('Kiosk ') ? h.slice(6) : undefined);
  }
  async function kioskFor(tx: Tx, secret: string) {
    return tx.maybe<{ id: string; name: string; location_id: string | null; zone: string | null }>(
      `SELECT k.id, k.name, k.location_id, l.time_zone AS zone FROM app.kiosks k LEFT JOIN app.locations l ON l.tenant_id = k.tenant_id AND l.id = k.location_id WHERE k.token_hash = $1 AND k.revoked_at IS NULL`,
      [kioskHash(secret)],
    );
  }

  app.get(
    '/v1/kiosk/session',
    {
      config: { auth: 'public' },
      schema: {
        tags: ['time'],
        summary: 'Kiosk device check (Authorization: Kiosk <token>)',
        response: { 200: Type.Object({ name: Type.String() }), 401: Problem, 429: Problem },
      },
    },
    async (req) => {
      await throttle(deps, [[`kiosk:ip:${req.ctx.ip}`, 120, 60]]);
      const tok = kioskToken(req);
      if (!tok) throw new ApiError('unauthorised');
      const k = await withTenant(deps.router, tok.tenantId, (tx) => kioskFor(tx, tok.secret), {
        readOnly: true,
      }).catch(() => undefined);
      if (!k) throw new ApiError('unauthorised');
      return { name: k.name };
    },
  );

  app.post(
    '/v1/kiosk/clock',
    {
      config: { auth: 'public' },
      schema: {
        tags: ['time'],
        summary:
          'Shared kiosk clock in/out: employee number + PIN. Rate-limited; locks after repeated failures; identical errors for unknown numbers and wrong PINs.',
        body: Type.Object({
          employeeNumber: Type.String({ minLength: 1, maxLength: 40 }),
          pin: Type.String({ pattern: '^\\d{4,8}$' }),
          kind: Kind,
          clientEventId: ClockEventIn.properties.clientEventId,
          occurredAt: Type.Optional(Type.String({ format: 'date-time' })),
        }),
        response: {
          200: Type.Object({
            status: Type.Union([Type.Literal('created'), Type.Literal('duplicate')]),
            kind: Type.String(),
            name: Type.String(),
            state: ClockStateOut,
          }),
          400: Problem,
          401: Problem,
          423: Problem,
          429: Problem,
        },
      },
    },
    async (req) => {
      await throttle(deps, [[`kiosk:ip:${req.ctx.ip}`, 120, 60]]);
      const tok = kioskToken(req);
      if (!tok) throw new ApiError('unauthorised');
      const b = req.body as {
        employeeNumber: string;
        pin: string;
        kind: ClockKind;
        clientEventId: string;
        occurredAt?: string;
      };
      const t = now();
      type Outcome =
        | { kind: 'unauthorised' }
        | { kind: 'bad' }
        | { kind: 'locked' }
        | { kind: 'rejected' }
        | { kind: 'ok'; status: 'created' | 'duplicate'; name: string; state: ReturnType<typeof clockState> };
      // Failure counters must persist, so the transaction always commits and the error is raised afterwards.
      const outcome = await withTenant<Outcome>(deps.router, tok.tenantId, async (tx) => {
        const kiosk = await kioskFor(tx, tok.secret);
        if (!kiosk) return { kind: 'unauthorised' };
        const settings = await timeSettings(tx);
        await throttle(deps, [[`kiosk:${kiosk.id}`, settings.kiosk.attemptsPerMinute, 60]]);
        const audit = (action: string, targetId: string | undefined, diff: Record<string, unknown>) =>
          writeAudit(tx, {
            actorType: 'system',
            action,
            targetType: targetId ? 'employee' : 'kiosk',
            targetId: targetId ?? kiosk.id,
            diff: { kioskId: kiosk.id, ...diff },
            ip: req.ctx.ip,
            userAgent: req.ctx.userAgent,
            requestId: req.id,
          });
        const emp = await tx.maybe<{
          id: string;
          display_name: string;
          preferred_name: string | null;
          pin_hash: string | null;
          failed_attempts: number | null;
          locked_until: string | null;
        }>(
          `SELECT e.id, e.display_name, e.preferred_name, p.pin_hash, p.failed_attempts, p.locked_until FROM app.employees e
             LEFT JOIN app.kiosk_pins p ON p.tenant_id = e.tenant_id AND p.employee_id = e.id WHERE e.employee_number = $1 AND e.status = 'active'`,
          [b.employeeNumber],
        );
        if (!emp?.pin_hash) {
          // Unknown number or no PIN: same work, same answers (including lockout) as a wrong PIN.
          await burnPasswordCheck(b.pin);
          const { count } = await deps.limiter.hit(
            `kiosk-unknown:${kiosk.id}:${b.employeeNumber}`,
            settings.kiosk.lockoutMinutes * 60,
          );
          await audit('kiosk.pin_failed', undefined, { locked: count >= settings.kiosk.maxFailedAttempts });
          return count >= settings.kiosk.maxFailedAttempts ? { kind: 'locked' } : { kind: 'bad' };
        }
        if (emp.locked_until && compareInstants(emp.locked_until, t) > 0) {
          await burnPasswordCheck(b.pin);
          return { kind: 'locked' };
        }
        if (!(await verifyPassword(emp.pin_hash, b.pin))) {
          const failed = (emp.failed_attempts ?? 0) + 1;
          const lock = failed >= settings.kiosk.maxFailedAttempts;
          await tx.exec(
            'UPDATE app.kiosk_pins SET failed_attempts = $2, locked_until = $3 WHERE employee_id = $1',
            [emp.id, lock ? 0 : failed, lock ? addMinutes(t, settings.kiosk.lockoutMinutes) : null],
          );
          await audit('kiosk.pin_failed', emp.id, { locked: lock });
          return lock ? { kind: 'locked' } : { kind: 'bad' };
        }
        await tx.exec(
          'UPDATE app.kiosk_pins SET failed_attempts = 0, locked_until = NULL WHERE employee_id = $1',
          [emp.id],
        );
        const at = b.occurredAt ? toInstant(b.occurredAt) : t;
        if (
          compareInstants(at, addMinutes(t, CLOCK_SKEW_MINUTES)) > 0 ||
          compareInstants(at, addMinutes(t, -settings.clock.maxOfflineHours * 60)) < 0
        )
          return { kind: 'rejected' };
        const ctx = await employeeTimeContext(tx, emp.id);
        const r = await insertClockEvent(tx, {
          employeeId: emp.id,
          kind: b.kind,
          occurredAt: at,
          zone: kiosk.zone ?? ctx.zone,
          source: 'kiosk',
          clientEventId: `kiosk:${kiosk.id}:${b.clientEventId}`,
          kioskId: kiosk.id,
        });
        await tx.exec('UPDATE app.kiosks SET last_used_at = $2 WHERE id = $1', [kiosk.id, t]);
        await audit('clock.recorded', emp.id, { kind: b.kind, source: 'kiosk', status: r.status });
        return {
          kind: 'ok',
          status: r.status as 'created' | 'duplicate',
          name: emp.preferred_name || emp.display_name.split(' ')[0] || emp.display_name,
          state: await currentState(tx, emp.id, t),
        };
      }).catch((err) => {
        if (err instanceof ApiError) throw err;
        return { kind: 'unauthorised' } as Outcome;
      });
      switch (outcome.kind) {
        case 'unauthorised':
          throw new ApiError('unauthorised');
        case 'bad':
          throw new ApiError('invalidCredentials');
        case 'locked':
          throw new ApiError('lockedOut');
        case 'rejected':
          throw new ApiError('validation', 'occurredAt is outside the accepted window');
        case 'ok':
          return { status: outcome.status, kind: b.kind, name: outcome.name, state: outcome.state };
      }
    },
  );
}
