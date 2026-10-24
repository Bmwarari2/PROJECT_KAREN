import type pg from 'pg';
import { TenantNotFoundError, TenantUnavailableError, withTenant } from '@thapsus/db';
import { DETECTION_RULES, type DetectionRule } from '@thapsus/core/security';
import type { Deps } from '../../deps';
import { registerCellTask } from '../../jobs/registry';
import { applyContainment } from './containment';
import { evaluateRules, recordHit, type DetectionOutcome } from './engine';

/**
 * The detection run (ADR-0177): one worker at a time (a row lock on security.pipeline_state, others skip),
 * once a minute. It evaluates the rules, records detections and incidents and moves the cursor in one
 * transaction; then it applies the rules' automated containment, copies customer-visible detections to the
 * workspace's Security centre and hands the outcomes to the alert senders.
 */
export const CURSOR_LAG_SECONDS = 10;
export const EVENTS_RETENTION_DAYS = 30;

type OutcomeHandler = (deps: Deps, outcomes: DetectionOutcome[], now: Date) => Promise<void>;
const handlers: OutcomeHandler[] = [];
/** Alert senders register here (alerts.ts), so the engine does not depend on the mailer. */
export function onDetectionOutcomes(h: OutcomeHandler) {
  handlers.push(h);
}

export interface PipelineResult {
  skipped?: boolean;
  processed: number;
  hits: number;
  outcomes: DetectionOutcome[];
}

export async function runDetectionPipeline(
  deps: Deps,
  now = deps.now(),
  opts: { rules?: DetectionRule[] } = {},
): Promise<PipelineResult> {
  const pool = deps.router.registryPool();
  const client = await pool.connect();
  const outcomes: DetectionOutcome[] = [];
  let processed: number;
  let hits: number;
  try {
    await client.query('BEGIN');
    const state = (
      await client.query<{ cursor_id: string }>(
        `SELECT cursor_id::text FROM security.pipeline_state WHERE name = 'detections' FOR UPDATE SKIP LOCKED`,
      )
    ).rows[0];
    if (!state) {
      await client.query('ROLLBACK');
      return { skipped: true, processed: 0, hits: 0, outcomes: [] };
    }
    // events younger than the lag may still be committing out of id order: they are looked at again next run
    const next = (
      await client.query<{ id: string }>(
        `SELECT coalesce(max(id), 0)::text AS id FROM security.events WHERE at <= $1`,
        [new Date(now.getTime() - CURSOR_LAG_SECONDS * 1000)],
      )
    ).rows[0]!.id;
    const disabled = new Set(
      (
        await client.query<{ rule_id: string }>(
          'SELECT rule_id FROM security.rule_settings WHERE NOT enabled',
        )
      ).rows.map((r) => r.rule_id),
    );
    const found = await evaluateRules(client, now, state.cursor_id, {
      rules: opts.rules ?? DETECTION_RULES,
      disabled,
    });
    hits = found.length;
    for (const hit of found) outcomes.push(await recordHit(client, hit, now));
    // automated blocks touch only this database: in the same transaction
    for (const o of outcomes.filter((x) => x.isNew))
      for (const c of o.hit.rule.containment ?? [])
        if (c.kind === 'block_ip')
          await applyContainment(deps, client, {
            kind: 'block_ip',
            incidentId: o.incidentId,
            automated: true,
            reason: `rule ${o.hit.rule.id}`,
            ipKey: o.hit.ipKey,
            ipNet: o.hit.ipNet,
            minutes: c.minutes,
          });
    processed = Math.max(0, Number(next) - Number(state.cursor_id));
    await client.query(
      `UPDATE security.pipeline_state SET cursor_id = greatest(cursor_id, $1::bigint), ran_at = $2, events_processed = events_processed + $3 WHERE name = 'detections'`,
      [next, now, processed],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await afterCommit(deps, pool, outcomes, now);
  return { processed, hits, outcomes };
}

async function afterCommit(deps: Deps, pool: pg.Pool, outcomes: DetectionOutcome[], now: Date) {
  for (const o of outcomes.filter((x) => x.isNew)) {
    for (const c of o.hit.rule.containment ?? []) {
      if (c.kind === 'freeze_staff' && o.hit.staffId)
        await applyContainment(deps, pool, {
          kind: 'freeze_staff',
          incidentId: o.incidentId,
          automated: true,
          reason: `rule ${o.hit.rule.id}`,
          targetId: o.hit.staffId,
        }).catch(() => undefined);
      if (c.kind === 'end_sessions' && o.hit.tenantId && o.hit.actorId && o.hit.actorType !== 'api_client')
        await applyContainment(deps, pool, {
          kind: 'end_sessions',
          incidentId: o.incidentId,
          automated: true,
          reason: `rule ${o.hit.rule.id}`,
          tenantId: o.hit.tenantId,
          targetId: o.hit.actorId,
        }).catch(() => undefined);
    }
    if (o.hit.rule.customerVisible && o.hit.tenantId) await copyToWorkspace(deps, o).catch(() => undefined);
  }
  // an extended detection refreshes the workspace's copy (count, last seen)
  for (const o of outcomes.filter((x) => !x.isNew && x.hit.rule.customerVisible && x.hit.tenantId))
    await copyToWorkspace(deps, o).catch(() => undefined);
  for (const h of handlers) await h(deps, outcomes, now).catch(() => undefined);
}

/** The workspace's own copy of a detection about it, for its Security centre (tenant table, RLS). */
export async function copyToWorkspace(deps: Pick<Deps, 'router'>, o: DetectionOutcome) {
  try {
    await withTenant(deps.router, o.hit.tenantId!, (tx) =>
      tx.exec(
        `INSERT INTO app.security_alerts (tenant_id, detection_id, rule_id, severity, first_seen_at, last_seen_at, event_count, subject_user_id)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, (SELECT id FROM app.users WHERE id = $7::uuid))
         ON CONFLICT (tenant_id, detection_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, event_count = greatest(app.security_alerts.event_count, EXCLUDED.event_count)`,
        [
          o.detectionId,
          o.hit.rule.id,
          o.hit.rule.severity,
          o.hit.first,
          o.hit.last,
          o.hit.count,
          o.hit.actorType === 'api_client' ? null : o.hit.actorId,
        ],
      ),
    );
  } catch (err) {
    if (err instanceof TenantNotFoundError || err instanceof TenantUnavailableError) return;
    throw err;
  }
}

/** Raw events older than the retention window are removed; detections and incidents are kept. */
export async function purgeSecurityEvents(deps: Pick<Deps, 'router'>, now: Date) {
  await deps.router
    .registryPool()
    .query('DELETE FROM security.events WHERE at < $1', [
      new Date(now.getTime() - EVENTS_RETENTION_DAYS * 86_400_000),
    ]);
}

registerCellTask({
  name: 'security.detections',
  everyMs: 60_000,
  run: (deps, now) => runDetectionPipeline(deps, now),
});
registerCellTask({ name: 'security.events_retention', everyMs: 3_600_000, run: purgeSecurityEvents });
