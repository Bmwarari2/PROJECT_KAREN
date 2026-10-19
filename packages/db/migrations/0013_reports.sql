-- Phase 7 (expand only): saved reports, background report runs and scheduled report delivery.
-- Report queries run on the reporting reader (thapsus_reporting: SELECT only, no vault, no BYPASSRLS);
-- these tables are written on the writer by the API and the worker.

-- Leaver classification for turnover (voluntary / involuntary); NULL for leavers recorded before phase 7.
ALTER TABLE app.employees ADD COLUMN leaver_type text CHECK (leaver_type IN ('voluntary', 'involuntary', 'other'));
CREATE INDEX employees_end_date ON app.employees (tenant_id, end_date) WHERE end_date IS NOT NULL;

-- Saved report: a ready-made report with parameters, or a report-builder specification.
CREATE TABLE app.saved_reports (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('ready', 'builder')),
  report_key text, -- ready-made report id (kind = 'ready')
  spec jsonb NOT NULL DEFAULT '{}'::jsonb, -- builder spec or ready-made parameters (never row data)
  owner_user_id uuid NOT NULL,
  shared boolean NOT NULL DEFAULT false, -- visible to other report users (each still sees only their own scope)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK ((kind = 'ready') = (report_key IS NOT NULL)),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX saved_reports_owner ON app.saved_reports (tenant_id, owner_user_id, name);
SELECT app.enable_tenant_rls('app.saved_reports');
CREATE TRIGGER saved_reports_touch BEFORE UPDATE ON app.saved_reports FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Scheduled delivery of a saved report (daily / weekly / monthly at a local time in an IANA zone).
CREATE TABLE app.report_schedules (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  saved_report_id uuid NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  time_of_day text NOT NULL CHECK (time_of_day ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  weekday smallint CHECK (weekday BETWEEN 1 AND 7),
  day_of_month smallint CHECK (day_of_month BETWEEN 1 AND 28),
  time_zone text NOT NULL,
  format text NOT NULL CHECK (format IN ('csv', 'xlsx', 'pdf')),
  recipient_user_ids uuid[] NOT NULL CHECK (cardinality(recipient_user_ids) BETWEEN 1 AND 50),
  enabled boolean NOT NULL DEFAULT true,
  last_period_key text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK ((frequency = 'weekly') = (weekday IS NOT NULL)),
  CHECK ((frequency = 'monthly') = (day_of_month IS NOT NULL)),
  FOREIGN KEY (tenant_id, saved_report_id) REFERENCES app.saved_reports (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX report_schedules_report ON app.report_schedules (tenant_id, saved_report_id);
CREATE INDEX report_schedules_enabled ON app.report_schedules (tenant_id, enabled);
SELECT app.enable_tenant_rls('app.report_schedules');
CREATE TRIGGER report_schedules_touch BEFORE UPDATE ON app.report_schedules FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- One run of a report (interactive export or scheduled delivery). The result file lives in the home-region
-- object store and is downloadable only by the requester through a short-lived presigned URL until expiry.
CREATE TABLE app.report_runs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  saved_report_id uuid,
  schedule_id uuid,
  period_key text, -- schedule period (idempotency: one run per schedule + period + recipient)
  source jsonb NOT NULL, -- {kind:'ready', reportId, params} | {kind:'builder', spec}
  title text NOT NULL,
  format text NOT NULL CHECK (format IN ('csv', 'xlsx', 'pdf', 'json')),
  locale text NOT NULL DEFAULT 'en-GB',
  time_zone text NOT NULL DEFAULT 'UTC',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'expired')),
  progress_done bigint NOT NULL DEFAULT 0,
  progress_total bigint,
  row_count bigint,
  bytes bigint,
  result_key text,
  result_sha256 text,
  file_name text,
  error_code text,
  requested_by uuid NOT NULL,
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES app.report_schedules (tenant_id, id) ON DELETE SET NULL (schedule_id)
);
CREATE INDEX report_runs_requester ON app.report_runs (tenant_id, requested_by, created_at DESC);
CREATE INDEX report_runs_expiry ON app.report_runs (tenant_id, expires_at) WHERE result_key IS NOT NULL;
CREATE UNIQUE INDEX report_runs_schedule_period ON app.report_runs (tenant_id, schedule_id, period_key, requested_by) WHERE schedule_id IS NOT NULL;
SELECT app.enable_tenant_rls('app.report_runs');

-- Hardening: the reporting reader never needs authentication secrets or device tokens.
REVOKE ALL ON app.password_credentials, app.totp_factors, app.passkeys, app.auth_challenges, app.sessions, app.magic_links,
  app.sso_connections, app.scim_tokens, app.push_subscriptions, app.ics_tokens, app.kiosks, app.kiosk_pins FROM thapsus_reporting;
