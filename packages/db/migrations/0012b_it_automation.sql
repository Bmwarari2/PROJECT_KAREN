-- Phase 6 (expand only): joiner/leaver IT automation for Microsoft 365 (Graph) and Google Workspace
-- (Admin SDK). Per-customer connections with admin consent, mapping rules, linked accounts and an
-- append-style execution log of every provider call (planned, executed or skipped).

CREATE TABLE app.it_connections (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('microsoft365', 'google_workspace')),
  status text NOT NULL DEFAULT 'pending_consent' CHECK (status IN ('pending_consent', 'connected', 'disabled')),
  -- Microsoft Entra tenant id, or Google Workspace customer id (identifiers, not secrets)
  directory_id text CHECK (length(directory_id) <= 100),
  -- primary domain for new accounts (user principal name / primary email)
  domain text NOT NULL CHECK (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  -- Entra application (client) id, or the Google service account client email
  client_id text CHECK (length(client_id) <= 200),
  -- Google: the Workspace admin impersonated through domain-wide delegation
  admin_subject citext,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  consented_at timestamptz,
  consented_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider)
);
SELECT app.enable_tenant_rls('app.it_connections');
CREATE TRIGGER it_connections_touch BEFORE UPDATE ON app.it_connections FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Licences, groups and organisational unit per legal entity / department / location / job title.
CREATE TABLE app.it_mapping_rules (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  priority integer NOT NULL DEFAULT 100,
  -- {entityId?, departmentId?, locationId?, jobTitleContains?}; an empty object matches everyone
  match jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- [{skuId, productId?}] (productId is used by Google's Enterprise License Manager)
  licences jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Entra group object ids or Google group emails
  groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  org_unit_path text CHECK (length(org_unit_path) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES app.it_connections (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX it_mapping_rules_connection ON app.it_mapping_rules (tenant_id, connection_id, priority);
SELECT app.enable_tenant_rls('app.it_mapping_rules');

-- The account Thapsus-HR created (or adopted) for an employee in the customer's directory.
CREATE TABLE app.it_accounts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  principal_name citext NOT NULL,
  remote_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  licences jsonb NOT NULL DEFAULT '[]'::jsonb,
  groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, connection_id, employee_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES app.it_connections (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.it_accounts');
CREATE TRIGGER it_accounts_touch BEFORE UPDATE ON app.it_accounts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Execution log: one row per provider call. The idempotency key makes re-runs skip completed calls.
-- Request bodies are stored without secrets (generated passwords are never stored).
CREATE TABLE app.it_operations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('joiner', 'leaver')),
  anchor_date date NOT NULL,
  seq integer NOT NULL,
  op text NOT NULL,
  method text NOT NULL CHECK (method IN ('GET', 'POST', 'PATCH', 'PUT', 'DELETE')),
  url text NOT NULL,
  body jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'skipped')),
  response_status integer,
  response jsonb,
  error text CHECK (length(error) <= 500),
  idempotency_key text NOT NULL,
  job_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES app.it_connections (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX it_operations_employee ON app.it_operations (tenant_id, employee_id, created_at DESC);
CREATE INDEX it_operations_recent ON app.it_operations (tenant_id, created_at DESC);
SELECT app.enable_tenant_rls('app.it_operations');
