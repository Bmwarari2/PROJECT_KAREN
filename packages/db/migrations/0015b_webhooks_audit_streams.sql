-- Phase 9 (brief §6.10), expand only: signed webhooks driven by the transactional outbox, and audit
-- log streaming to customer SIEMs. Destinations are chosen by the customer (the controller); calls
-- originate from the tenant's home region. Signing secrets are KMS-sealed envelopes (never plaintext).

CREATE TABLE app.webhook_endpoints (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  url text NOT NULL CHECK (url ~ '^https?://' AND length(url) <= 2048),
  description text CHECK (length(description) <= 300),
  event_types text[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 50),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- [{ "id": "…", "envelope": {KMS envelope}, "createdAt": "…", "expiresAt": null | "…" }]; at most two active.
  secrets jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX webhook_endpoints_active ON app.webhook_endpoints (tenant_id, status);
SELECT app.enable_tenant_rls('app.webhook_endpoints');
CREATE TRIGGER webhook_endpoints_touch BEFORE UPDATE ON app.webhook_endpoints FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- One delivery per (endpoint, event); replays are new deliveries pointing at the original.
CREATE TABLE app.webhook_deliveries (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_response_status integer,
  last_duration_ms integer,
  last_error text CHECK (length(last_error) <= 200),
  replay_of uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES app.webhook_endpoints (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX webhook_deliveries_once ON app.webhook_deliveries (tenant_id, endpoint_id, event_id) WHERE replay_of IS NULL;
CREATE INDEX webhook_deliveries_log ON app.webhook_deliveries (tenant_id, endpoint_id, created_at DESC, id DESC);
SELECT app.enable_tenant_rls('app.webhook_deliveries');

-- Delivery log: one row per HTTP attempt (status code, duration, error class; never the response body).
CREATE TABLE app.webhook_attempts (
  tenant_id uuid NOT NULL,
  id bigserial NOT NULL,
  delivery_id uuid NOT NULL,
  attempt integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  response_status integer,
  duration_ms integer NOT NULL,
  error text CHECK (length(error) <= 200),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, delivery_id, attempt),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES app.webhook_deliveries (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.webhook_attempts');

-- Audit log streams to a customer SIEM: signed HTTPS or an S3 bucket in the home region reached
-- through a cross-account IAM role. cursor_seq is the last sealed audit sequence delivered.
CREATE TABLE app.audit_streams (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('https', 's3')),
  config jsonb NOT NULL,
  secret jsonb,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  cursor_seq bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  last_delivered_at timestamptz,
  last_error text CHECK (length(last_error) <= 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.audit_streams');
CREATE TRIGGER audit_streams_touch BEFORE UPDATE ON app.audit_streams FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Batches are idempotent: one row per (stream, first sequence); a retry resends the same range with
-- the same batch id and, for S3, the same object key.
CREATE TABLE app.audit_stream_batches (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL,
  from_seq bigint NOT NULL,
  to_seq bigint NOT NULL CHECK (to_seq >= from_seq),
  event_count integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  response_status integer,
  duration_ms integer,
  object_key text,
  error text CHECK (length(error) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, stream_id, from_seq),
  FOREIGN KEY (tenant_id, stream_id) REFERENCES app.audit_streams (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX audit_stream_batches_log ON app.audit_stream_batches (tenant_id, stream_id, created_at DESC, id DESC);
SELECT app.enable_tenant_rls('app.audit_stream_batches');

REVOKE ALL ON app.webhook_endpoints, app.webhook_deliveries, app.webhook_attempts, app.audit_streams, app.audit_stream_batches FROM thapsus_reporting;
