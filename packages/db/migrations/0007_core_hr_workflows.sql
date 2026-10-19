-- Phase 1: documents and e-signature, notifications and tasks, workflows, approvals, automation, imports.

-- ---- Notifications and tasks -----------------------------------------------------------------
CREATE TABLE app.notifications (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL,
  title_key text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  link text,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  emailed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX notifications_user ON app.notifications (tenant_id, user_id, created_at DESC);
CREATE UNIQUE INDEX notifications_dedupe ON app.notifications (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
SELECT app.enable_tenant_rls('app.notifications');

CREATE TABLE app.tasks (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('workflow', 'approval', 'automation', 'document', 'manual', 'compliance')),
  source_id uuid,
  title text NOT NULL,
  description text,
  subject_employee_id uuid,
  assignee_user_id uuid,
  assignee_role text,
  due_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  link text,
  dedupe_key text,
  completed_at timestamptz,
  completed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX tasks_assignee ON app.tasks (tenant_id, assignee_user_id, status, due_on);
CREATE INDEX tasks_source ON app.tasks (tenant_id, source, source_id);
CREATE UNIQUE INDEX tasks_dedupe ON app.tasks (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
SELECT app.enable_tenant_rls('app.tasks');

-- ---- Documents ----------------------------------------------------------------------------------
CREATE TABLE app.document_folders (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  parent_id uuid,
  visibility text NOT NULL DEFAULT 'hr' CHECK (visibility IN ('hr', 'employee', 'managers', 'everyone')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES app.document_folders (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.document_folders');

CREATE TABLE app.documents (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  folder_id uuid,
  employee_id uuid,
  title text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  file_key text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint,
  sha256 text,
  status text NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload', 'ready', 'rejected')),
  expires_on date,
  template_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, folder_id) REFERENCES app.document_folders (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX documents_employee ON app.documents (tenant_id, employee_id);
CREATE INDEX documents_expiry ON app.documents (tenant_id, expires_on) WHERE expires_on IS NOT NULL;
SELECT app.enable_tenant_rls('app.documents');

CREATE TABLE app.document_templates (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  locale text NOT NULL DEFAULT 'en-GB',
  body text NOT NULL,
  category text NOT NULL DEFAULT 'letter',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.document_templates');

CREATE TABLE app.signature_requests (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  signer_employee_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'declined', 'cancelled')),
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz,
  signer_user_id uuid,
  signer_name text,
  signer_ip inet,
  signer_user_agent text,
  document_sha256 text,
  signed_file_key text,
  signed_sha256 text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES app.documents (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, signer_employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX signature_requests_signer ON app.signature_requests (tenant_id, signer_employee_id, status);
SELECT app.enable_tenant_rls('app.signature_requests');

-- ---- Workflows ---------------------------------------------------------------------------------------
CREATE TABLE app.workflow_templates (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('onboarding', 'offboarding', 'transfer', 'custom')),
  name text NOT NULL,
  tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
  auto_start boolean NOT NULL DEFAULT true,
  entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.workflow_templates');

CREATE TABLE app.workflow_instances (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  kind text NOT NULL,
  anchor_date date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, template_id, employee_id, anchor_date),
  FOREIGN KEY (tenant_id, template_id) REFERENCES app.workflow_templates (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX workflow_instances_emp ON app.workflow_instances (tenant_id, employee_id);
SELECT app.enable_tenant_rls('app.workflow_instances');

-- ---- Approvals --------------------------------------------------------------------------------------
CREATE TABLE app.approval_policies (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject text NOT NULL,
  name text NOT NULL,
  steps jsonb NOT NULL,
  condition jsonb,
  enabled boolean NOT NULL DEFAULT true,
  priority int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX approval_policies_subject ON app.approval_policies (tenant_id, subject, priority);
SELECT app.enable_tenant_rls('app.approval_policies');

CREATE TABLE app.approval_requests (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL,
  subject text NOT NULL,
  subject_employee_id uuid,
  payload jsonb NOT NULL,
  requested_by uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  current_step int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES app.approval_policies (tenant_id, id)
);
CREATE INDEX approval_requests_status ON app.approval_requests (tenant_id, status, created_at);
SELECT app.enable_tenant_rls('app.approval_requests');

CREATE TABLE app.approval_steps (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  step_index int NOT NULL,
  approver_user_ids uuid[] NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('waiting', 'pending', 'approved', 'rejected', 'skipped', 'escalated')),
  due_at timestamptz,
  decided_by uuid,
  delegated_from uuid,
  decided_at timestamptz,
  comment text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, request_id, step_index),
  FOREIGN KEY (tenant_id, request_id) REFERENCES app.approval_requests (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX approval_steps_due ON app.approval_steps (tenant_id, status, due_at);
SELECT app.enable_tenant_rls('app.approval_steps');

-- ---- Automation rules -------------------------------------------------------------------------------
CREATE TABLE app.automation_rules (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  trigger jsonb NOT NULL,
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.automation_rules');

CREATE TABLE app.automation_runs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL,
  event_key text NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('matched', 'skipped', 'succeeded', 'failed')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES app.automation_rules (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX automation_runs_once ON app.automation_runs (tenant_id, rule_id, event_key) WHERE NOT dry_run;
SELECT app.enable_tenant_rls('app.automation_runs');

-- ---- Bulk import --------------------------------------------------------------------------------------
CREATE TABLE app.import_batches (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'employees',
  file_key text NOT NULL,
  file_name text NOT NULL,
  file_sha256 text NOT NULL,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'previewed', 'running', 'completed', 'failed')),
  row_count int,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_file_key text,
  job_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.import_batches');
