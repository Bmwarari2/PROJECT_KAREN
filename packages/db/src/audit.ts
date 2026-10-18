import type { Tx } from './client';

export type ActorType = 'user' | 'support' | 'system' | 'api_client' | 'scim';

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  diff?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  sensitive?: boolean;
}

/** Fields whose values are always redacted in audit diffs (the change is recorded, the value is not). */
const REDACT_IN_DIFF = /password|secret|token|totp|pin|ssn|ni_?number|national_?id|tax_?id|bank|iban|envelope|ciphertext|health|disability|diversity|ethnic|religion|immigration|visa|passport/i;

export function redactDiff(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDiff);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = REDACT_IN_DIFF.test(k) ? '[REDACTED]' : redactDiff(v);
    return out;
  }
  return value;
}

/** Before/after diff of changed keys only. */
export function diffObjects(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    const a = before?.[k];
    const b = after?.[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[k] = { from: a ?? null, to: b ?? null };
  }
  return redactDiff(changes) as Record<string, { from: unknown; to: unknown }>;
}

export async function writeAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.exec(
    `INSERT INTO audit.events (tenant_id, actor_type, actor_id, action, target_type, target_id, diff, ip, user_agent, request_id, sensitive)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      e.actorType,
      e.actorId ?? null,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      e.diff === undefined ? null : JSON.stringify(redactDiff(e.diff)),
      e.ip ?? null,
      e.userAgent ? e.userAgent.slice(0, 512) : null,
      e.requestId ?? null,
      e.sensitive ?? false,
    ],
  );
}

/** Writes a domain event to the transactional outbox (same transaction as the change). */
export async function emitEvent(
  tx: Tx,
  topic: string,
  payload: Record<string, unknown>,
  aggregate?: { type: string; id: string },
): Promise<void> {
  await tx.exec(
    `INSERT INTO app.outbox (tenant_id, topic, aggregate_type, aggregate_id, payload) VALUES (app.current_tenant(), $1, $2, $3, $4)`,
    [topic, aggregate?.type ?? null, aggregate?.id ?? null, JSON.stringify(payload)],
  );
  await tx.exec(
    `INSERT INTO registry.work_signals (tenant_id, kind) VALUES (app.current_tenant(), 'outbox')
     ON CONFLICT (tenant_id, kind) DO UPDATE SET signalled_at = now()`,
  );
}

/** Enqueues an idempotent job; returns the existing job if the idempotency key was already used. */
export async function enqueueJob(
  tx: Tx,
  kind: string,
  idempotencyKey: string,
  input: Record<string, unknown>,
  opts: { createdBy?: string | null; runAfter?: string; total?: number } = {},
): Promise<{ id: string; status: string; created: boolean }> {
  const inserted = await tx.maybe<{ id: string; status: string }>(
    `INSERT INTO app.jobs (tenant_id, kind, idempotency_key, input, created_by, run_after, progress_total)
     VALUES (app.current_tenant(), $1, $2, $3, $4, coalesce($5::timestamptz, now()), $6)
     ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING RETURNING id, status`,
    [kind, idempotencyKey, JSON.stringify(input), opts.createdBy ?? null, opts.runAfter ?? null, opts.total ?? null],
  );
  if (inserted) {
    await tx.exec(
      `INSERT INTO registry.work_signals (tenant_id, kind) VALUES (app.current_tenant(), 'jobs')
       ON CONFLICT (tenant_id, kind) DO UPDATE SET signalled_at = now()`,
    );
    return { ...inserted, created: true };
  }
  const existing = await tx.one<{ id: string; status: string }>(
    'SELECT id, status FROM app.jobs WHERE kind = $1 AND idempotency_key = $2',
    [kind, idempotencyKey],
  );
  return { ...existing, created: false };
}
