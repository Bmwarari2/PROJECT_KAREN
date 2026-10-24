-- Founder's console (ADR-0175, ADR-0176): more aggregates in the back-office usage snapshot, and per-cell
-- platform performance metrics. Expand only: new columns are nullable, new tables and a new schema hold no
-- tenant id and no personal data. Safe to re-run.

-- ---- business snapshot: counts, dates and money totals per customer (no personal data) ----------------
ALTER TABLE backoffice.tenant_usage ADD COLUMN IF NOT EXISTS active_users_7d integer;
ALTER TABLE backoffice.tenant_usage ADD COLUMN IF NOT EXISTS active_users_30d integer;
ALTER TABLE backoffice.tenant_usage ADD COLUMN IF NOT EXISTS users_with_mfa integer;
ALTER TABLE backoffice.tenant_usage ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
ALTER TABLE backoffice.tenant_usage ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE backoffice.tenant_usage ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
-- Live paid subscription lines: [{"currency": "GBP", "term": "monthly", "intervalAmountMinor": "4500"}].
-- MRR and ARR are derived from these by @thapsus/core/metrics (one tested place for the money rule).
ALTER TABLE backoffice.tenant_usage ADD COLUMN IF NOT EXISTS recurring jsonb;

-- ---- platform performance (per cell; no tenant id, no personal data, route groups only) -----------------
CREATE SCHEMA IF NOT EXISTS platform;
GRANT USAGE ON SCHEMA platform TO thapsus_app, thapsus_backoffice;

-- One row per API process, minute and route group. Each process aggregates in memory and inserts once a
-- minute, so the request path never waits on the database. The latency histogram uses the bucket bounds
-- in @thapsus/core/metrics (HISTOGRAM_BOUNDS_MS, plus one overflow bucket).
CREATE TABLE IF NOT EXISTS platform.request_metrics (
  bucket_start timestamptz NOT NULL,
  instance_id uuid NOT NULL,
  route_group text NOT NULL CHECK (route_group ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  requests integer NOT NULL CHECK (requests >= 0),
  errors_4xx integer NOT NULL CHECK (errors_4xx >= 0),
  errors_5xx integer NOT NULL CHECK (errors_5xx >= 0),
  latency_sum_ms bigint NOT NULL CHECK (latency_sum_ms >= 0),
  latency_buckets integer[] NOT NULL CHECK (cardinality(latency_buckets) BETWEEN 1 AND 32),
  PRIMARY KEY (bucket_start, instance_id, route_group)
);
CREATE INDEX IF NOT EXISTS request_metrics_time ON platform.request_metrics (bucket_start);

-- The worker's queue sample, once a minute per database of the cell (counts and ages only).
CREATE TABLE IF NOT EXISTS platform.queue_metrics (
  at timestamptz NOT NULL,
  db_key text NOT NULL CHECK (db_key ~ '^[a-z0-9_-]{1,40}$'),
  outbox_pending integer NOT NULL,
  outbox_oldest_seconds integer,
  jobs_queued integer NOT NULL,
  jobs_due integer NOT NULL,
  jobs_oldest_due_seconds integer,
  jobs_running integer NOT NULL,
  jobs_failed_1h integer NOT NULL,
  jobs_failed_24h integer NOT NULL,
  database_bytes bigint NOT NULL,
  PRIMARY KEY (at, db_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON platform.request_metrics TO thapsus_app;
GRANT SELECT, INSERT, DELETE ON platform.queue_metrics TO thapsus_app;
GRANT SELECT ON platform.request_metrics, platform.queue_metrics TO thapsus_backoffice;

-- Partial indexes for the queue sample (running and failed jobs are few; queued jobs use jobs_runnable).
CREATE INDEX IF NOT EXISTS jobs_running ON app.jobs (tenant_id, started_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_failed ON app.jobs (tenant_id, finished_at) WHERE status = 'failed';

-- Cross-tenant queue counts for the worker. Row level security keeps the application role to one tenant per
-- transaction, so the counts come from a SECURITY DEFINER function owned by a NOLOGIN role whose only rights
-- are these columns and a SELECT policy on the two queue tables (the pattern of thapsus_lookup, 0002/0020).
-- It returns counts and ages only: no tenant id, no topic, no payload, no job input.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thapsus_metrics') THEN
    CREATE ROLE thapsus_metrics NOLOGIN NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT thapsus_metrics TO %I', current_user);
END $$;
GRANT USAGE ON SCHEMA app TO thapsus_metrics;
GRANT USAGE, CREATE ON SCHEMA platform TO thapsus_metrics;
GRANT SELECT (tenant_id, published_at, created_at) ON app.outbox TO thapsus_metrics;
GRANT SELECT (tenant_id, status, run_after, started_at, finished_at) ON app.jobs TO thapsus_metrics;
DROP POLICY IF EXISTS metrics_queue_counts ON app.outbox;
CREATE POLICY metrics_queue_counts ON app.outbox FOR SELECT TO thapsus_metrics USING (true);
DROP POLICY IF EXISTS metrics_queue_counts ON app.jobs;
CREATE POLICY metrics_queue_counts ON app.jobs FOR SELECT TO thapsus_metrics USING (true);

CREATE OR REPLACE FUNCTION platform.queue_snapshot(p_now timestamptz)
  RETURNS TABLE (
    outbox_pending integer,
    outbox_oldest_seconds integer,
    jobs_queued integer,
    jobs_due integer,
    jobs_oldest_due_seconds integer,
    jobs_running integer,
    jobs_failed_1h integer,
    jobs_failed_24h integer,
    database_bytes bigint
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS
$$
  SELECT
    (SELECT count(*)::int FROM app.outbox WHERE published_at IS NULL),
    (SELECT greatest(0, extract(epoch FROM p_now - min(created_at)))::int FROM app.outbox WHERE published_at IS NULL),
    (SELECT count(*)::int FROM app.jobs WHERE status = 'queued'),
    (SELECT count(*)::int FROM app.jobs WHERE status = 'queued' AND run_after <= p_now),
    (SELECT greatest(0, extract(epoch FROM p_now - min(run_after)))::int FROM app.jobs WHERE status = 'queued' AND run_after <= p_now),
    (SELECT count(*)::int FROM app.jobs WHERE status = 'running'),
    (SELECT count(*)::int FROM app.jobs WHERE status = 'failed' AND finished_at >= p_now - interval '1 hour'),
    (SELECT count(*)::int FROM app.jobs WHERE status = 'failed' AND finished_at >= p_now - interval '24 hours'),
    pg_database_size(current_database())
$$;
ALTER FUNCTION platform.queue_snapshot(timestamptz) OWNER TO thapsus_metrics;
REVOKE ALL ON FUNCTION platform.queue_snapshot(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.queue_snapshot(timestamptz) TO thapsus_app;
-- the role needed CREATE only to be given the function (managed Postgres, see 0001b)
REVOKE CREATE ON SCHEMA platform FROM thapsus_metrics;
