import type pg from 'pg';
import {
  DETECTION_RULES,
  SEVERITIES,
  rulesInForce,
  type DetectionRule,
  type GroupField,
  type RuleLogic,
  type Severity,
  type Where,
} from '@thapsus/core/security';
import { instantToDate } from '@thapsus/core/time';

/**
 * The detection engine (ADR-0177). Once a minute the worker evaluates every active rule over
 * security.events: each rule is one aggregate query over its window, limited to groups that received an
 * event since the last run (the cursor). A hit becomes a detection (or extends the open one within the
 * rule's dedupe window), and a detection rolls up into an incident keyed by the address, person, staff
 * member or workspace it concerns. The caller applies containment and sends alerts from the result.
 */
export type Db = Pick<pg.PoolClient, 'query'>;

const COL: Record<GroupField, string> = {
  ip: 'ip_key',
  tenant: 'subject_tenant_id::text',
  actor: 'actor_id::text',
  staff: 'staff_id::text',
  account: 'account_key',
  route: 'route',
};
const RAW: Record<GroupField, string> = {
  ip: 'ip_key',
  tenant: 'subject_tenant_id',
  actor: 'actor_id',
  staff: 'staff_id',
  account: 'account_key',
  route: 'route',
};

export interface Hit {
  rule: DetectionRule;
  groupKey: string;
  count: number;
  first: string;
  last: string;
  tenantId: string | null;
  tenantIds: string[];
  actorId: string | null;
  staffId: string | null;
  ipKey: string | null;
  ipNet: string | null;
  actorType: string | null;
}

class Params {
  readonly values: unknown[] = [];
  add(v: unknown) {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

function whereSql(w: Where | undefined, p: Params, alias = ''): string {
  if (!w) return '';
  const out: string[] = [];
  for (const [k, v] of Object.entries(w.detail ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(k)) throw new Error(`bad detail key ${k}`);
    out.push(`${alias}detail->>'${k}' = ${p.add(String(v))}`);
  }
  if (w.routePrefix?.length)
    out.push(
      `${alias}route LIKE ANY(${p.add(w.routePrefix.map((x) => `${x.replace(/[\\%_]/g, (c) => `\\${c}`)}%`))})`,
    );
  if (w.outsideHoursUtc) {
    const h = `extract(hour FROM ${alias}at AT TIME ZONE 'UTC')`;
    out.push(`NOT (${h} >= ${p.add(w.outsideHoursUtc[0])} AND ${h} < ${p.add(w.outsideHoursUtc[1])})`);
  }
  return out.map((c) => ` AND ${c}`).join('');
}

const PICK = (alias: string) => `
  (array_agg(${alias}subject_tenant_id ORDER BY ${alias}id DESC) FILTER (WHERE ${alias}subject_tenant_id IS NOT NULL))[1]::text AS tenant,
  coalesce(array_agg(DISTINCT ${alias}subject_tenant_id::text) FILTER (WHERE ${alias}subject_tenant_id IS NOT NULL), '{}') AS tenants,
  (array_agg(${alias}actor_id ORDER BY ${alias}id DESC) FILTER (WHERE ${alias}actor_id IS NOT NULL))[1]::text AS actor,
  (array_agg(${alias}staff_id ORDER BY ${alias}id DESC) FILTER (WHERE ${alias}staff_id IS NOT NULL))[1]::text AS staff,
  (array_agg(${alias}ip_key ORDER BY ${alias}id DESC) FILTER (WHERE ${alias}ip_key IS NOT NULL))[1] AS ip_key,
  (array_agg(${alias}ip_net ORDER BY ${alias}id DESC) FILTER (WHERE ${alias}ip_net IS NOT NULL))[1]::text AS ip_net,
  (array_agg(${alias}detail->>'actorType' ORDER BY ${alias}id DESC) FILTER (WHERE ${alias}detail ? 'actorType'))[1] AS actor_type`;

/** The rule as one SQL statement; every value is a parameter, column names come from a fixed map. */
export function ruleQuery(
  logic: RuleLogic,
  at: { from: string; to: string; cursor: string },
): { sql: string; params: unknown[] } {
  const p = new Params();
  const cols = logic.groupBy.map((g) => COL[g]);
  const gk = cols.length ? `concat_ws('|', ${cols.map((c) => `coalesce(${c}, '')`).join(', ')})` : `''`;
  // a group must be known (an address may be unknown: honeytoken objects carry none)
  const known = logic.groupBy
    .filter((g) => g !== 'ip')
    .map((g) => ` AND ${RAW[g]} IS NOT NULL`)
    .join('');
  const groupBy = cols.length ? `GROUP BY ${cols.join(', ')}` : '';
  if (logic.kind === 'threshold') {
    const types = p.add(logic.types);
    const from = p.add(at.from);
    const to = p.add(at.to);
    const cursor = p.add(at.cursor);
    const min = p.add(logic.minEvents);
    const distinct = logic.distinct
      ? ` AND count(DISTINCT ${RAW[logic.distinct.field]}) >= ${p.add(logic.distinct.min)}`
      : '';
    const sql = `SELECT ${gk} AS gk, count(*)::int AS n, min(at)::text AS first, max(at)::text AS last, ${PICK('')}
      FROM security.events WHERE type = ANY(${types}) AND at > ${from} AND at <= ${to}${known}${whereSql(logic.where, p)}
      ${groupBy} HAVING count(*) >= ${min} AND max(id) > ${cursor}${distinct}`;
    return { sql, params: p.values };
  }
  if (logic.kind === 'sequence') {
    const then = p.add(logic.then.types);
    const from = p.add(at.from);
    const to = p.add(at.to);
    const cursor = p.add(at.cursor);
    const before = p.add(logic.before.types);
    const mins = p.add(logic.windowMinutes);
    const min = p.add(logic.before.minEvents);
    const sCols = logic.groupBy.map((g) => `s.${COL[g]}`);
    const sKnown = logic.groupBy.map((g) => ` AND s.${RAW[g]} IS NOT NULL`).join('');
    const match = logic.groupBy.map((g) => ` AND f.${RAW[g]} = s.${RAW[g]}`).join('');
    const sGk = sCols.length ? `concat_ws('|', ${sCols.map((c) => `coalesce(${c}, '')`).join(', ')})` : `''`;
    const sql = `SELECT ${sGk} AS gk, count(*)::int AS n, min(s.at)::text AS first, max(s.at)::text AS last, ${PICK('s.')}
      FROM security.events s WHERE s.type = ANY(${then}) AND s.at > ${from} AND s.at <= ${to} AND s.id > ${cursor}${sKnown}
        AND (SELECT count(*) FROM security.events f WHERE f.type = ANY(${before}) AND f.at >= s.at - make_interval(mins => ${mins}) AND f.at <= s.at${match}) >= ${min}
      ${sCols.length ? `GROUP BY ${sCols.join(', ')}` : ''}`;
    return { sql, params: p.values };
  }
  const failures = p.add(logic.failures);
  const all = p.add([...logic.failures, ...logic.successes]);
  const from = p.add(at.from);
  const to = p.add(at.to);
  const cursor = p.add(at.cursor);
  const minFailures = p.add(logic.minFailures);
  const ratio = p.add(logic.minRatioBasisPoints);
  const fails = `count(*) FILTER (WHERE type = ANY(${failures}))`;
  const sql = `SELECT ${gk} AS gk, ${fails}::int AS n, min(at)::text AS first, max(at)::text AS last, ${PICK('')}
    FROM security.events WHERE type = ANY(${all}) AND at > ${from} AND at <= ${to}${known}
    ${groupBy} HAVING ${fails} >= ${minFailures} AND ${fails} * 10000 >= ${ratio} * count(*) AND max(id) > ${cursor}`;
  return { sql, params: p.values };
}

interface Row {
  gk: string;
  n: number;
  first: string;
  last: string;
  tenant: string | null;
  tenants: string[];
  actor: string | null;
  staff: string | null;
  ip_key: string | null;
  ip_net: string | null;
  actor_type: string | null;
}

/** Evaluates every active rule in force; returns the hits (no writes). */
export async function evaluateRules(
  db: Db,
  now: Date,
  cursor: string,
  opts: { rules?: DetectionRule[]; disabled?: Set<string> } = {},
): Promise<Hit[]> {
  const rules = rulesInForce(instantToDate(now.toISOString(), 'UTC'), opts.rules ?? DETECTION_RULES).filter(
    (r) => r.status === 'active' && r.logic && !opts.disabled?.has(r.id),
  );
  const hits: Hit[] = [];
  for (const rule of rules) {
    const logic = rule.logic!;
    const q = ruleQuery(logic, {
      from: new Date(now.getTime() - logic.windowMinutes * 60_000).toISOString(),
      to: now.toISOString(),
      cursor,
    });
    const { rows } = await db.query<Row>(q.sql, q.params);
    for (const r of rows)
      hits.push({
        rule,
        groupKey: r.gk,
        count: r.n,
        first: new Date(r.first).toISOString(),
        last: new Date(r.last).toISOString(),
        tenantId: r.tenant,
        tenantIds: r.tenants ?? [],
        actorId: r.actor,
        staffId: r.staff,
        ipKey: r.ip_key,
        ipNet: r.ip_net,
        actorType: r.actor_type,
      });
  }
  return hits;
}

export const severityRank = (s: Severity) => SEVERITIES.indexOf(s);

/** The incident a hit rolls up into: the address, person, staff member or workspace it concerns. */
export function incidentKey(hit: Hit): string {
  const by = hit.rule.incidentBy ?? hit.rule.logic!.groupBy[0] ?? 'rule';
  const value =
    by === 'rule'
      ? null
      : by === 'ip'
        ? hit.ipKey
        : by === 'tenant'
          ? hit.tenantId
          : by === 'actor'
            ? hit.actorId && `${hit.tenantId}:${hit.actorId}`
            : by === 'staff'
              ? hit.staffId
              : hit.groupKey;
  return value ? `${by}:${value}` : `rule:${hit.rule.id}`;
}

export interface DetectionOutcome {
  detectionId: string;
  incidentId: string;
  incidentReference: string;
  hit: Hit;
  /** A new detection (not an extension of the open one within the dedupe window). */
  isNew: boolean;
  /** The incident was opened by this detection. */
  newIncident: boolean;
  /** The incident's severity rose because of this detection. */
  escalated: boolean;
  severity: Severity;
}

/** Records one hit: extends or creates its detection, and attaches it to (or opens) its incident. */
export async function recordHit(db: Db, hit: Hit, now: Date): Promise<DetectionOutcome> {
  const since = new Date(now.getTime() - hit.rule.dedupeMinutes * 60_000).toISOString();
  const existing = (
    await db.query<{ id: string; incident_id: string; reference: string; severity: Severity }>(
      `SELECT d.id, d.incident_id, i.reference, i.severity FROM security.detections d JOIN security.incidents i ON i.id = d.incident_id
        WHERE d.rule_id = $1 AND d.group_key = $2 AND d.last_seen_at >= $3 ORDER BY d.last_seen_at DESC LIMIT 1 FOR UPDATE OF d`,
      [hit.rule.id, hit.groupKey, since],
    )
  ).rows[0];
  if (existing) {
    await db.query(
      `UPDATE security.detections SET last_seen_at = greatest(last_seen_at, $2), event_count = greatest(event_count, $3) WHERE id = $1`,
      [existing.id, hit.last, hit.count],
    );
    await db.query(
      `UPDATE security.incidents SET last_seen_at = greatest(last_seen_at, $2), event_count = event_count + 0, updated_at = $3,
         tenant_ids = ARRAY(SELECT DISTINCT unnest(tenant_ids || $4::uuid[])) WHERE id = $1`,
      [existing.incident_id, hit.last, now.toISOString(), hit.tenantIds],
    );
    return {
      detectionId: existing.id,
      incidentId: existing.incident_id,
      incidentReference: existing.reference,
      hit,
      isNew: false,
      newIncident: false,
      escalated: false,
      severity: existing.severity,
    };
  }
  const key = incidentKey(hit);
  const open = (
    await db.query<{ id: string; reference: string; severity: Severity }>(
      `SELECT id, reference, severity FROM security.incidents WHERE dedupe_key = $1 AND status NOT IN ('resolved', 'false_positive') FOR UPDATE`,
      [key],
    )
  ).rows[0];
  let incidentId: string;
  let reference: string;
  let newIncident = false;
  let escalated = false;
  let severity = hit.rule.severity;
  if (open) {
    incidentId = open.id;
    reference = open.reference;
    escalated = severityRank(hit.rule.severity) > severityRank(open.severity);
    severity = escalated ? hit.rule.severity : open.severity;
    await db.query(
      `UPDATE security.incidents SET severity = $2, last_seen_at = greatest(last_seen_at, $3), detection_count = detection_count + 1,
         event_count = event_count + $4, updated_at = $5, tenant_ids = ARRAY(SELECT DISTINCT unnest(tenant_ids || $6::uuid[])),
         ip_key = coalesce(ip_key, $7), ip_net = coalesce(ip_net, $8::cidr) WHERE id = $1`,
      [incidentId, severity, hit.last, hit.count, now.toISOString(), hit.tenantIds, hit.ipKey, hit.ipNet],
    );
  } else {
    const created = (
      await db.query<{ id: string; reference: string }>(
        `INSERT INTO security.incidents (reference, dedupe_key, rule_id, area, severity, first_seen_at, last_seen_at, detection_count, event_count, tenant_ids, ip_key, ip_net, created_at, updated_at)
         VALUES ('SEC-' || lpad(nextval('security.incident_reference')::text, 5, '0'), $1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10::cidr, $11, $11)
         RETURNING id, reference`,
        [
          key,
          hit.rule.id,
          hit.rule.area,
          hit.rule.severity,
          hit.first,
          hit.last,
          hit.count,
          hit.tenantIds,
          hit.ipKey,
          hit.ipNet,
          now.toISOString(),
        ],
      )
    ).rows[0]!;
    incidentId = created.id;
    reference = created.reference;
    newIncident = true;
    await db.query(
      `INSERT INTO security.incident_events (incident_id, at, kind, detail) VALUES ($1, $2, 'opened', $3)`,
      [incidentId, now.toISOString(), JSON.stringify({ ruleId: hit.rule.id, severity: hit.rule.severity })],
    );
  }
  const detection = (
    await db.query<{ id: string }>(
      `INSERT INTO security.detections (rule_id, rule_version, severity, group_key, first_seen_at, last_seen_at, event_count, subject_tenant_id, actor_id, staff_id, ip_key, ip_net, detail, incident_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::cidr, $13, $14, $15) RETURNING id`,
      [
        hit.rule.id,
        hit.rule.version,
        hit.rule.severity,
        hit.groupKey,
        hit.first,
        hit.last,
        hit.count,
        hit.tenantId,
        hit.actorId,
        hit.staffId,
        hit.ipKey,
        hit.ipNet,
        JSON.stringify(hit.actorType ? { actorType: hit.actorType } : {}),
        incidentId,
        now.toISOString(),
      ],
    )
  ).rows[0]!;
  await db.query(
    `INSERT INTO security.incident_events (incident_id, at, kind, detail) VALUES ($1, $2, $3, $4)`,
    [
      incidentId,
      now.toISOString(),
      escalated ? 'escalated' : 'detection',
      JSON.stringify({
        detectionId: detection.id,
        ruleId: hit.rule.id,
        severity: hit.rule.severity,
        events: hit.count,
      }),
    ],
  );
  return {
    detectionId: detection.id,
    incidentId,
    incidentReference: reference,
    hit,
    isNew: true,
    newIncident,
    escalated,
    severity,
  };
}
