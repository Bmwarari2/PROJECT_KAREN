-- Phase 7 (expand only): scheduled data export to the customer's own S3 bucket or SFTP server.
-- Destinations belong to the customer (the controller); they are not Thapsus sub-processors.

CREATE TABLE app.export_destinations (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('s3', 'sftp')),
  -- s3: {bucket, region, prefix, roleArn, externalId}; sftp: {host, port, username, directory, hostKeySha256, auth}
  -- Never secrets: SFTP passwords / private keys are sealed in credentials (regional KMS envelope).
  config jsonb NOT NULL,
  credentials jsonb,
  credential_fields text[] NOT NULL DEFAULT '{}',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_tested_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX export_destinations_name ON app.export_destinations (tenant_id, name);
SELECT app.enable_tenant_rls('app.export_destinations');
CREATE TRIGGER export_destinations_touch BEFORE UPDATE ON app.export_destinations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
-- The reporting role reads report data only; destination configuration and sealed credentials are not report data.
REVOKE ALL ON app.export_destinations FROM thapsus_reporting;

-- A scheduled data export: datasets (report-builder catalogue) delivered to a destination.
CREATE TABLE app.data_exports (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  destination_id uuid NOT NULL,
  datasets jsonb NOT NULL, -- [{dataset, fields[]}]
  format text NOT NULL CHECK (format IN ('csv', 'jsonl')),
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  time_of_day text NOT NULL CHECK (time_of_day ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  weekday smallint CHECK (weekday BETWEEN 1 AND 7),
  day_of_month smallint CHECK (day_of_month BETWEEN 1 AND 28),
  time_zone text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  -- Rows and fields are limited by this user's permissions at delivery time (same rules as the builder).
  run_as_user_id uuid NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK ((frequency = 'weekly') = (weekday IS NOT NULL)),
  CHECK ((frequency = 'monthly') = (day_of_month IS NOT NULL)),
  FOREIGN KEY (tenant_id, destination_id) REFERENCES app.export_destinations (tenant_id, id),
  FOREIGN KEY (tenant_id, run_as_user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX data_exports_destination ON app.data_exports (tenant_id, destination_id);
SELECT app.enable_tenant_rls('app.data_exports');
CREATE TRIGGER data_exports_touch BEFORE UPDATE ON app.data_exports FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Delivery log: one row per export + period (idempotency). Counts and timings only — never personal data.
CREATE TABLE app.export_deliveries (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  export_id uuid NOT NULL,
  destination_id uuid NOT NULL,
  period_key text NOT NULL,
  trigger text NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  files int,
  rows bigint,
  bytes bigint,
  duration_ms int,
  error_code text,
  error text CHECK (length(error) <= 300),
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, export_id, period_key),
  FOREIGN KEY (tenant_id, export_id) REFERENCES app.data_exports (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX export_deliveries_recent ON app.export_deliveries (tenant_id, export_id, created_at DESC);
SELECT app.enable_tenant_rls('app.export_deliveries');
