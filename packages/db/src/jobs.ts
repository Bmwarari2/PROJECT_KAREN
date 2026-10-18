import type { Tx } from './client';

/** Shared contracts between the API (which owns domain handlers) and the worker (which runs them). */
export interface JobRow {
  id: string;
  tenant_id: string;
  kind: string;
  idempotency_key: string;
  input: Record<string, unknown>;
  attempts: number;
  created_by: string | null;
}

export interface JobContext<D = unknown> {
  tenantId: string;
  job: JobRow;
  deps: D;
  /** Runs fn in the tenant context (new transaction). */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Persists progress in its own transaction so callers can poll it while the job runs. */
  progress(done: number, total?: number): Promise<void>;
}

export type JobHandler<D = unknown> = (ctx: JobContext<D>) => Promise<Record<string, unknown> | void>;

export interface OutboxEvent {
  tenantId: string;
  id: string;
  topic: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** In-process subscriber: may enqueue jobs inside the provided tenant transaction (idempotently). */
export type EventSubscriber = (tx: Tx, event: OutboxEvent) => Promise<void>;
