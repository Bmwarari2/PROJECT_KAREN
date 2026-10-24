-- Security monitoring (docs/security-hardening plan §3.1–3.3, ADR-0177 to ADR-0179). Expand only: a new schema,
-- new tables, nullable columns, a widened check and two AFTER INSERT triggers. Nothing is dropped. Safe to re-run.

-- ---- staff role for the Security module ------------------------------------------------------------------
ALTER TABLE backoffice.staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check;
ALTER TABLE backoffice.staff_users ADD CONSTRAINT staff_users_role_check
  CHECK (role IN ('super_admin', 'support', 'rules_editor', 'billing', 'security_analyst'));

-- ---- the security store (per cell; pseudonymous ids only, no tenant_id column, no personal data) ------------
CREATE SCHEMA IF NOT EXISTS security;
GRANT USAGE ON SCHEMA security TO thapsus_app, thapsus_backoffice;

-- Security signals: request outcomes (refused, rejected, throttled), authentication and staff events, watched
-- audit actions and honeytoken touches. ip_key is a keyed hash of the client address; ip_net its /24 (IPv4) or
-- /48 (IPv6) network for display; account_key a keyed hash of a submitted account name. detail holds codes and
-- counts only. Kept 30 days.
CREATE TABLE IF NOT EXISTS security.events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_.]{2,80}$'),
  source text NOT NULL CHECK (source IN ('request', 'auth', 'audit', 'staff', 'honeytoken', 'pipeline')),
  subject_tenant_id uuid,
  actor_id uuid,
  staff_id uuid,
  ip_key text CHECK (ip_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  ip_net cidr,
  account_key text CHECK (account_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  route text CHECK (length(route) <= 200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_type_at ON security.events (type, at);
CREATE INDEX IF NOT EXISTS events_at ON security.events (at);
CREATE INDEX IF NOT EXISTS events_ip ON security.events (ip_key, at) WHERE ip_key IS NOT NULL;

-- Incidents roll detections up (dedupe window per rule); one open incident per dedupe key.
CREATE TABLE IF NOT EXISTS security.incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  dedupe_key text NOT NULL,
  rule_id text NOT NULL,
  area text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'contained', 'resolved', 'false_positive')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  detection_count integer NOT NULL DEFAULT 0,
  event_count integer NOT NULL DEFAULT 0,
  tenant_ids uuid[] NOT NULL DEFAULT '{}',
  ip_key text,
  ip_net cidr,
  assigned_to uuid REFERENCES backoffice.staff_users (id),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_open_key ON security.incidents (dedupe_key) WHERE status NOT IN ('resolved', 'false_positive');
CREATE INDEX IF NOT EXISTS incidents_recent ON security.incidents (created_at DESC);
CREATE SEQUENCE IF NOT EXISTS security.incident_reference;

-- One rule firing for one group (an address, a workspace, a person, a staff member) within its window.
CREATE TABLE IF NOT EXISTS security.detections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id text NOT NULL,
  rule_version integer NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  group_key text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  event_count integer NOT NULL,
  subject_tenant_id uuid,
  actor_id uuid,
  staff_id uuid,
  ip_key text,
  ip_net cidr,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  incident_id uuid NOT NULL REFERENCES security.incidents (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS detections_rule_group ON security.detections (rule_id, group_key, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS detections_recent ON security.detections (created_at DESC);
CREATE INDEX IF NOT EXISTS detections_incident ON security.detections (incident_id);

-- The incident timeline: detections, containment, status, assignment and notes. Append-only.
CREATE TABLE IF NOT EXISTS security.incident_events (
  id bigserial PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES security.incidents (id),
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind text NOT NULL CHECK (kind IN ('opened', 'detection', 'escalated', 'containment', 'reversal', 'status', 'assignment', 'note', 'alert')),
  staff_id uuid REFERENCES backoffice.staff_users (id),
  body text CHECK (length(body) <= 2000),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS incident_events_incident ON security.incident_events (incident_id, id);
CREATE TRIGGER incident_events_append_only BEFORE UPDATE OR DELETE ON security.incident_events FOR EACH ROW EXECUTE FUNCTION backoffice.block_mutation();

-- Containment: audited, reversible, never deleting customer data. A frozen staff account is unfrozen only when
-- a second staff member approves the request (reversal_requested_by <> reversed_by).
CREATE TABLE IF NOT EXISTS security.containment_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('block_ip', 'end_sessions', 'suspend_api_key', 'freeze_staff')),
  incident_id uuid REFERENCES security.incidents (id),
  automated boolean NOT NULL,
  subject_tenant_id uuid,
  target_id uuid,
  ip_key text,
  ip_net cidr,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  created_by uuid REFERENCES backoffice.staff_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  reversal_requested_by uuid REFERENCES backoffice.staff_users (id),
  reversal_requested_at timestamptz,
  reversed_by uuid REFERENCES backoffice.staff_users (id),
  reversed_at timestamptz,
  CHECK (kind <> 'block_ip' OR ip_key IS NOT NULL),
  CHECK (kind <> 'freeze_staff' OR reversed_by IS NULL OR reversed_by IS DISTINCT FROM reversal_requested_by)
);
CREATE INDEX IF NOT EXISTS containment_active_blocks ON security.containment_actions (ip_key) WHERE kind = 'block_ip' AND reversed_at IS NULL;
CREATE INDEX IF NOT EXISTS containment_incident ON security.containment_actions (incident_id);

-- Honeytokens (deception): only a SHA-256 fingerprint of a decoy value is stored.
CREATE TABLE IF NOT EXISTS security.honeytokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('api_key', 'endpoint', 'object_key')),
  label text NOT NULL CHECK (length(label) BETWEEN 3 AND 120),
  fingerprint text NOT NULL UNIQUE CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  planted_in text NOT NULL CHECK (length(planted_in) BETWEEN 3 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

-- Per-cell rule settings (a rule turned off here; the catalogue itself is versioned in the repository) and the
-- last result of running each rule's test fixture against this cell's engine.
CREATE TABLE IF NOT EXISTS security.rule_settings (
  rule_id text PRIMARY KEY CHECK (rule_id ~ '^THR-[A-Z]+-[0-9]{3}$'),
  enabled boolean NOT NULL,
  updated_by uuid NOT NULL REFERENCES backoffice.staff_users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS security.rule_tests (
  rule_id text NOT NULL,
  rule_version integer NOT NULL,
  passed boolean NOT NULL,
  detections integer NOT NULL,
  ran_at timestamptz NOT NULL,
  ran_by uuid REFERENCES backoffice.staff_users (id),
  PRIMARY KEY (rule_id, rule_version)
);

-- The detection run's cursor and heartbeat (the dead-man's switch reads it).
CREATE TABLE IF NOT EXISTS security.pipeline_state (
  name text PRIMARY KEY CHECK (name IN ('detections')),
  cursor_id bigint NOT NULL DEFAULT 0,
  ran_at timestamptz,
  events_processed bigint NOT NULL DEFAULT 0
);
INSERT INTO security.pipeline_state (name) VALUES ('detections') ON CONFLICT DO NOTHING;

-- Every alert sent (or due), once per dedupe key: immediate incident alerts, digests, the daily test alert and
-- the dead-man's switch. Recipients are counted, never stored.
CREATE TABLE IF NOT EXISTS security.alert_log (
  id bigserial PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE CHECK (length(dedupe_key) <= 200),
  audience text NOT NULL CHECK (audience IN ('staff', 'tenant')),
  kind text NOT NULL CHECK (kind IN ('incident', 'digest', 'test', 'deadman')),
  severity text,
  incident_id uuid REFERENCES security.incidents (id),
  subject_tenant_id uuid,
  recipients integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'no_recipients')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_log_recent ON security.alert_log (created_at DESC);

-- ---- signals from the audit trails (no application change needed; they roll back with their transaction) ----
-- Only codes, flags and counts leave a diff: allowlisted keys whose values are short codes, booleans or numbers
-- (a {from, to} change gives its `to`), and the length of an allowlisted array.
CREATE OR REPLACE FUNCTION security.audit_detail(d jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS
$$
  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
    SELECT key AS k,
           CASE WHEN jsonb_typeof(value) = 'object' AND value ? 'to' THEN value->'to' ELSE value END AS v
      FROM jsonb_each(CASE WHEN jsonb_typeof(d) = 'object' THEN d ELSE '{}'::jsonb END)
     WHERE key IN ('role', 'isAdmin', 'admin', 'scopeType', 'method', 'reason', 'rows', 'count', 'format', 'kind', 'scope', 'status', 'category', 'refused', 'outcome')
  ) x
  WHERE jsonb_typeof(v) IN ('boolean', 'number') OR (jsonb_typeof(v) = 'string' AND (v #>> '{}') ~ '^[a-z0-9_.:-]{1,40}$')
$$;

CREATE OR REPLACE FUNCTION security.net_of(ip inet) RETURNS cidr
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT CASE WHEN ip IS NULL THEN NULL WHEN family(ip) = 4 THEN network(set_masklen(ip, 24)) ELSE network(set_masklen(ip, 48)) END $$;

CREATE OR REPLACE FUNCTION security.from_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, security AS $$
BEGIN
  INSERT INTO security.events (at, type, source, subject_tenant_id, actor_id, ip_net, detail)
  VALUES (NEW.at, 'audit.' || NEW.action, 'audit', NEW.tenant_id,
          CASE WHEN NEW.actor_type IN ('user', 'api_client', 'scim') THEN NEW.actor_id END,
          security.net_of(NEW.ip),
          security.audit_detail(NEW.diff) || jsonb_build_object('actorType', NEW.actor_type));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS audit_events_security_signals ON audit.events;
CREATE TRIGGER audit_events_security_signals AFTER INSERT ON audit.events FOR EACH ROW
  WHEN (NEW.action = ANY (ARRAY[
    'auth.login', 'auth.login_failed', 'auth.mfa_reset', 'auth.passkey_registered', 'auth.mfa.totp_enroll_started',
    'auth.password_reset', 'auth.password_reset_requested', 'auth.password_reset_completed', 'auth.all_sessions_ended',
    'role.assigned', 'role.created', 'role.updated', 'role.revoked', 'role.deleted', 'user.invited',
    'api_key.created', 'oauth_client.created', 'scim.token_created',
    'sso.connection_created', 'sso.connection_updated', 'sso.connection_deleted', 'settings.security_updated',
    'support.grant_created', 'domain.added', 'webhook.created', 'audit_stream.created', 'export.destination_created',
    'export.created', 'export.run_requested', 'privacy.company_export_requested', 'privacy.company_export_downloaded',
    'report.downloaded', 'report.run_requested', 'payroll.export_downloaded', 'document.downloaded', 'payslip.downloaded',
    'audit.exported', 'vault.read', 'vault.read_denied', 'ai.question_asked'
  ]))
  EXECUTE FUNCTION security.from_audit();

CREATE OR REPLACE FUNCTION security.from_staff_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, security AS $$
BEGIN
  INSERT INTO security.events (at, type, source, subject_tenant_id, staff_id, ip_net, route, detail)
  VALUES (NEW.at, 'staffaudit.' || NEW.action, 'staff', NEW.subject_tenant_id, NEW.staff_id, security.net_of(NEW.ip),
          left(NEW.target, 200), security.audit_detail(NEW.detail));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS staff_audit_security_signals ON backoffice.staff_audit;
CREATE TRIGGER staff_audit_security_signals AFTER INSERT ON backoffice.staff_audit FOR EACH ROW
  WHEN (NEW.action ~ '^staff\.' OR NEW.action = ANY (ARRAY['tenant.viewed', 'support.ticket_viewed', 'support.attachment_viewed', 'staff_audit.exported']))
  EXECUTE FUNCTION security.from_staff_audit();

-- ---- containment on customer credentials: a suspended API key stops working until it is restored ------------
ALTER TABLE app.api_keys ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

-- ---- the customer's Security centre (tenant tables: RLS enabled and forced) -----------------------------------
-- Alerts about the workspace's own events (a copy of the detection with the workspace's own user id).
CREATE TABLE IF NOT EXISTS app.security_alerts (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  detection_id uuid NOT NULL,
  rule_id text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  event_count integer NOT NULL,
  subject_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, detection_id)
);
CREATE INDEX IF NOT EXISTS security_alerts_recent ON app.security_alerts (tenant_id, created_at DESC);
SELECT app.enable_tenant_rls('app.security_alerts');

-- Who in the workspace receives its security alert emails (default: the owners).
CREATE TABLE IF NOT EXISTS app.security_alert_recipients (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.security_alert_recipients');

-- ---- grants ----------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON security.events TO thapsus_app, thapsus_backoffice;
GRANT USAGE ON SEQUENCE security.events_id_seq TO thapsus_app, thapsus_backoffice;
GRANT DELETE ON security.events TO thapsus_app;
GRANT SELECT, INSERT, UPDATE ON security.incidents, security.detections, security.containment_actions,
  security.pipeline_state, security.rule_tests TO thapsus_app, thapsus_backoffice;
GRANT SELECT, INSERT ON security.incident_events TO thapsus_app, thapsus_backoffice;
GRANT SELECT, INSERT, UPDATE ON security.alert_log TO thapsus_app, thapsus_backoffice;
GRANT USAGE ON SEQUENCE security.incident_events_id_seq, security.alert_log_id_seq, security.incident_reference TO thapsus_app, thapsus_backoffice;
GRANT SELECT ON security.honeytokens TO thapsus_app;
GRANT SELECT, INSERT, UPDATE ON security.honeytokens, security.rule_settings TO thapsus_backoffice;
GRANT SELECT ON security.rule_settings TO thapsus_app;
GRANT SELECT, INSERT, UPDATE ON app.security_alerts TO thapsus_app;
GRANT SELECT, INSERT, DELETE ON app.security_alert_recipients TO thapsus_app;
-- the worker freezes a staff account found under attack (containment); unfreezing goes through two people
GRANT SELECT (id, role, active), UPDATE (active) ON backoffice.staff_users TO thapsus_app;
GRANT SELECT (staff_id, revoked_at), UPDATE (revoked_at) ON backoffice.staff_sessions TO thapsus_app;

-- ---- the honeytoken registry: decoys planted today (fingerprints only) ------------------------------------------
INSERT INTO security.honeytokens (kind, label, fingerprint, planted_in) VALUES
  ('api_key', 'Decoy API key in the API documentation examples', encode(sha256(convert_to('thr_sk_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e.decoyKeyDoNotUseXq7Lm2Np9Rs4Tv6Wy8Za0Bc3Df5Gh', 'UTF8')), 'hex'), 'docs/api.md'),
  ('endpoint', 'Honey endpoint: environment file', encode(sha256(convert_to('/.env', 'UTF8')), 'hex'), 'API and web hosts'),
  ('endpoint', 'Honey endpoint: WordPress sign-in', encode(sha256(convert_to('/wp-login.php', 'UTF8')), 'hex'), 'API and web hosts'),
  ('endpoint', 'Honey endpoint: Git configuration', encode(sha256(convert_to('/.git/config', 'UTF8')), 'hex'), 'API and web hosts'),
  ('endpoint', 'Honey endpoint: bulk admin export', encode(sha256(convert_to('/v1/admin/export-all', 'UTF8')), 'hex'), 'API host'),
  ('endpoint', 'Honey endpoint: internal debug', encode(sha256(convert_to('/v1/internal/debug', 'UTF8')), 'hex'), 'API host'),
  ('object_key', 'Decoy object: full employee export', encode(sha256(convert_to('exports/backup/all-employees-full.csv', 'UTF8')), 'hex'), 'object store (app-level check)'),
  ('object_key', 'Decoy object: payroll archive', encode(sha256(convert_to('payroll/archive/payroll-all-tenants.zip', 'UTF8')), 'hex'), 'object store (app-level check)')
ON CONFLICT (fingerprint) DO NOTHING;
