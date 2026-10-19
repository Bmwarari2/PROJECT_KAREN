import pg from 'pg';
import { moveTenant, type MoveReport } from './move-tenant';

/**
 * Runs back-office move requests (backoffice.tenant_moves) with status tracking. Staff create a request
 * (POST /v1/backoffice/tenants/{id}/database-moves); this runner — a one-off task in the cell with owner
 * credentials from Secrets Manager — claims requests one at a time (FOR UPDATE SKIP LOCKED, so two
 * runners never take the same request), runs the move tool and records progress, the report or the
 * error. Runbook: docs/runbooks/move-tenant-to-dedicated-db.md.
 */
export interface ProcessMovesOptions {
  /** Owner (migrator) URLs keyed by database key; the registry key's database holds the requests. */
  ownerUrls: Record<string, string>;
  registryKey?: string;
  settleMs?: number;
  /** Maximum number of requests to run in this invocation. */
  limit?: number;
  log?: (msg: string) => void;
}

export interface MoveRequestOutcome {
  id: string;
  tenantId: string;
  targetKey: string;
  status: 'succeeded' | 'failed';
  report?: MoveReport;
  error?: string;
}

export async function processMoveRequests(opts: ProcessMovesOptions): Promise<MoveRequestOutcome[]> {
  const registryKey = opts.registryKey ?? 'shared';
  const url = opts.ownerUrls[registryKey];
  if (!url) throw new Error(`owner URL missing for registry database "${registryKey}"`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const outcomes: MoveRequestOutcome[] = [];
  try {
    for (let i = 0; i < (opts.limit ?? 10); i++) {
      await client.query('BEGIN');
      const req = (
        await client.query<{ id: string; subject_tenant_id: string; target_db_key: string; purge_source: boolean }>(
          `UPDATE backoffice.tenant_moves SET status = 'running', started_at = now()
            WHERE id = (SELECT id FROM backoffice.tenant_moves WHERE status = 'requested' ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1)
            RETURNING id, subject_tenant_id, target_db_key, purge_source`,
        )
      ).rows[0];
      await client.query('COMMIT');
      if (!req) break;
      let chain = Promise.resolve();
      const progress = (msg: string) => {
        opts.log?.(msg);
        chain = chain.then(() =>
          client.query(`UPDATE backoffice.tenant_moves SET progress = array_append(progress, $2) WHERE id = $1`, [req.id, msg.slice(0, 300)]).then(() => undefined, () => undefined),
        );
      };
      try {
        const report = await moveTenant({
          tenantId: req.subject_tenant_id,
          targetKey: req.target_db_key,
          ownerUrls: opts.ownerUrls,
          registryKey,
          settleMs: opts.settleMs,
          purgeSource: req.purge_source,
          log: progress,
        });
        await chain;
        await client.query(`UPDATE backoffice.tenant_moves SET status = 'succeeded', finished_at = now(), report = $2 WHERE id = $1`, [req.id, JSON.stringify(report)]);
        outcomes.push({ id: req.id, tenantId: req.subject_tenant_id, targetKey: req.target_db_key, status: 'succeeded', report });
      } catch (err) {
        await chain;
        const message = (err as Error).message.slice(0, 1000);
        await client.query(`UPDATE backoffice.tenant_moves SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [req.id, message]);
        outcomes.push({ id: req.id, tenantId: req.subject_tenant_id, targetKey: req.target_db_key, status: 'failed', error: message });
      }
    }
  } finally {
    await client.end();
  }
  return outcomes;
}
