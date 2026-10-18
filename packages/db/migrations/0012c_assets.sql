-- Phase 6 (expand only): asset register with assignment, handover sign-off by the employee and a return
-- checklist that offboarding turns into tasks.

CREATE TABLE app.assets (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  asset_tag text NOT NULL CHECK (length(asset_tag) BETWEEN 1 AND 60),
  type text NOT NULL CHECK (type IN ('laptop', 'desktop', 'phone', 'tablet', 'monitor', 'headset', 'peripheral', 'vehicle', 'access_card', 'other')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  serial_number text CHECK (length(serial_number) <= 120),
  -- purchase cost in integer minor units with its ISO 4217 currency
  cost_minor bigint CHECK (cost_minor >= 0),
  currency char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  purchased_on date,
  status text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'assigned', 'in_repair', 'retired', 'lost')),
  entity_id uuid,
  location_id uuid,
  notes text CHECK (length(notes) <= 2000),
  -- [{key, label}] items checked when the asset comes back
  return_checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((cost_minor IS NULL) = (currency IS NULL)),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, asset_tag),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES app.legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.locations (tenant_id, id)
);
CREATE UNIQUE INDEX assets_serial ON app.assets (tenant_id, type, serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX assets_status ON app.assets (tenant_id, status, type);
CREATE INDEX assets_search ON app.assets USING gin (name gin_trgm_ops);
SELECT app.enable_tenant_rls('app.assets');
CREATE TRIGGER assets_touch BEFORE UPDATE ON app.assets FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.asset_assignments (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  assigned_on date NOT NULL,
  due_back_on date,
  condition_out text CHECK (length(condition_out) <= 500),
  handover_note text CHECK (length(handover_note) <= 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'returned', 'lost')),
  -- handover sign-off by the employee (who, when, from where, which statement)
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  acknowledged_ip inet,
  acknowledged_user_agent text CHECK (length(acknowledged_user_agent) <= 512),
  acknowledgement_statement text,
  acknowledgement_task_id uuid,
  -- return (offboarding creates the task; marking the asset returned completes it)
  return_task_id uuid,
  returned_on date,
  returned_at timestamptz,
  received_by uuid,
  condition_in text CHECK (length(condition_in) <= 500),
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (due_back_on IS NULL OR due_back_on >= assigned_on),
  CHECK (returned_on IS NULL OR returned_on >= assigned_on),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES app.assets (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
-- an asset is with at most one person at a time
CREATE UNIQUE INDEX asset_assignments_one_active ON app.asset_assignments (tenant_id, asset_id) WHERE status = 'active';
CREATE INDEX asset_assignments_employee ON app.asset_assignments (tenant_id, employee_id, status);
CREATE INDEX asset_assignments_asset ON app.asset_assignments (tenant_id, asset_id, assigned_on DESC);
SELECT app.enable_tenant_rls('app.asset_assignments');

-- Built-in roles of existing tenants pick up the new self-service permissions (new tenants get them from
-- packages/core/src/roles.ts). Idempotent; custom roles are left to the customer.
UPDATE app.roles SET permissions = permissions || ARRAY['assets.read_own', 'assets.acknowledge']
 WHERE built_in AND key IN ('hr_admin', 'entity_hr_admin', 'payroll_admin', 'manager', 'employee') AND NOT ('assets.acknowledge' = ANY (permissions));
UPDATE app.roles SET permissions = permissions || ARRAY['integrations.*']
 WHERE built_in AND key = 'hr_admin' AND NOT ('integrations.*' = ANY (permissions));
