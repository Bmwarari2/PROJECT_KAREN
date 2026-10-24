-- Phase 16 part B: tasks that lead to the work (ADR-0191 to ADR-0193). Expand only: nullable columns,
-- columns with defaults, a wider source check, one partial index and a backfill of what older tasks are
-- about. Nothing is dropped or renamed; `title`, `description`, `link` and `due_on` keep their meaning, so
-- code that predates this migration keeps working. Safe to re-run.

ALTER TABLE app.tasks
  -- the main button (packages/core/src/task-actions.ts): a kind and its parameters. Not an enum check,
  -- so later parts add kinds without a migration; the API validates every kind against the registry.
  ADD COLUMN IF NOT EXISTS action_kind text CHECK (action_kind IS NULL OR action_kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  ADD COLUMN IF NOT EXISTS action_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- the record whose completion closes the task (ADR-0192), e.g. ('asset_return', <assignment id>)
  ADD COLUMN IF NOT EXISTS record_type text CHECK (record_type IS NULL OR record_type ~ '^[a-z][a-z0-9_.]{1,60}$'),
  ADD COLUMN IF NOT EXISTS record_id uuid,
  -- system-made tasks: catalogue keys and their parameters, rendered in the reader's locale. `title` and
  -- `description` keep the workspace-locale rendering for exports, e-mails and older clients.
  ADD COLUMN IF NOT EXISTS title_key text CHECK (title_key IS NULL OR title_key ~ '^[A-Za-z0-9_.-]{1,120}$'),
  ADD COLUMN IF NOT EXISTS description_key text CHECK (description_key IS NULL OR description_key ~ '^[A-Za-z0-9_.-]{1,120}$'),
  ADD COLUMN IF NOT EXISTS text_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- how due_on was worked out ({ anchor, offsetDays, businessDays?, packDeadline? }), so it follows the
  -- person's own dates when they change (ADR-0193)
  ADD COLUMN IF NOT EXISTS due_rule jsonb,
  -- how a task was closed: by hand (with a short note), or by its record completing
  ADD COLUMN IF NOT EXISTS completed_via text CHECK (completed_via IS NULL OR completed_via IN ('manual', 'record')),
  ADD COLUMN IF NOT EXISTS completion_note text CHECK (completion_note IS NULL OR length(completion_note) <= 1000);

-- "Comes from" names the real source: absences (the return-to-work conversation) and the asset register
-- (acknowledging an issued asset) get their own values instead of 'manual'.
ALTER TABLE app.tasks DROP CONSTRAINT IF EXISTS tasks_source_check;
ALTER TABLE app.tasks ADD CONSTRAINT tasks_source_check
  CHECK (source IN ('workflow', 'approval', 'automation', 'document', 'manual', 'compliance', 'hr_request', 'absence', 'asset'));

-- open tasks waiting for a record to complete (completeTasksFor), leading with tenant_id
CREATE INDEX IF NOT EXISTS tasks_open_record ON app.tasks (tenant_id, record_type, record_id)
  WHERE status = 'open' AND record_id IS NOT NULL;

-- ---- backfill: what tasks made before this release are about ------------------------------------------
-- Their dedupe keys and sources name their records, so they close themselves too and their pages show a
-- main button. Only rows without a record or action are touched. As in 0018 and 0021, FORCE RLS is lifted
-- only inside this transaction so the owner can see every tenant's rows; the application role never owns
-- the table.
ALTER TABLE app.tasks NO FORCE ROW LEVEL SECURITY;

-- approvals: decided on the request's page
UPDATE app.tasks SET record_type = 'approval_request', record_id = source_id,
       action_kind = 'open_record', action_params = jsonb_build_object('type', 'approval_request', 'id', source_id)
 WHERE source = 'approval' AND source_id IS NOT NULL AND record_type IS NULL;

-- signatures (and "sign again" after a return): signed in the document viewer
UPDATE app.tasks SET record_type = 'signature_request', record_id = source_id,
       action_kind = CASE WHEN link LIKE '/app/documents/%' THEN 'open_link' END,
       action_params = CASE WHEN link LIKE '/app/documents/%'
                            THEN jsonb_build_object('href', link, 'label', 'sign') ELSE '{}'::jsonb END
 WHERE source = 'document' AND dedupe_key LIKE 'sign:%' AND source_id IS NOT NULL AND record_type IS NULL;

-- documents HR attached to a person, due for renewal
UPDATE app.tasks SET record_type = 'document', record_id = source_id,
       action_kind = 'open_record', action_params = jsonb_build_object('type', 'document', 'id', source_id)
 WHERE source = 'document' AND dedupe_key LIKE 'attachment:%' AND source_id IS NOT NULL AND record_type IS NULL;

-- an issued asset to acknowledge (was source 'manual')
UPDATE app.tasks SET source = 'asset', record_type = 'asset_acknowledgement', record_id = source_id,
       action_kind = 'open_record', action_params = jsonb_build_object('type', 'asset_assignment', 'id', source_id)
 WHERE dedupe_key LIKE 'asset-ack:%' AND source_id IS NOT NULL AND record_type IS NULL;

-- an asset to collect from a leaver (part of the offboarding workflow)
UPDATE app.tasks SET record_type = 'asset_return', record_id = substring(dedupe_key FROM 14)::uuid,
       action_kind = 'open_record',
       action_params = jsonb_build_object('type', 'asset_return', 'id', substring(dedupe_key FROM 14))
 WHERE dedupe_key ~ '^asset-return:[0-9a-f-]{36}$' AND record_type IS NULL;

-- the return-to-work conversation after a sickness absence (was source 'manual')
UPDATE app.tasks SET source = 'absence', record_type = 'return_to_work', record_id = substring(dedupe_key FROM 5)::uuid,
       action_kind = 'form', action_params = '{"formKind": "return_to_work"}'::jsonb
 WHERE dedupe_key ~ '^rtw:[0-9a-f-]{36}$' AND record_type IS NULL;

-- compliance reminders
UPDATE app.tasks SET record_type = 'rtw_check', record_id = source_id,
       action_kind = 'open_record', action_params = jsonb_build_object('type', 'rtw_check', 'id', source_id)
 WHERE source = 'compliance' AND dedupe_key ~ '^rtwcheck:[0-9a-f-]{36}:task$' AND record_type IS NULL;
UPDATE app.tasks SET record_type = 'right_to_work', record_id = subject_employee_id,
       action_kind = 'open_person', action_params = '{"tab": "compliance"}'::jsonb
 WHERE source = 'compliance' AND dedupe_key LIKE 'rtw-missing:%' AND subject_employee_id IS NOT NULL AND record_type IS NULL;
UPDATE app.tasks SET record_type = 'i9_reverify', record_id = subject_employee_id,
       action_kind = 'open_person', action_params = '{"tab": "compliance"}'::jsonb
 WHERE source = 'compliance' AND dedupe_key LIKE 'i9-rev:%' AND subject_employee_id IS NOT NULL AND record_type IS NULL;
UPDATE app.tasks SET record_type = 'compliance_record', record_id = source_id,
       action_kind = 'open_person', action_params = '{"tab": "compliance"}'::jsonb
 WHERE source = 'compliance' AND dedupe_key ~ '^matrix:[0-9a-f-]{36}:task$' AND source_id IS NOT NULL AND record_type IS NULL;
UPDATE app.tasks SET record_type = 'compliance_requirement', record_id = source_id,
       action_kind = 'open_person', action_params = '{"tab": "compliance"}'::jsonb
 WHERE source = 'compliance' AND dedupe_key LIKE 'matrix-missing:%' AND source_id IS NOT NULL AND record_type IS NULL;

-- requests to HR are their own record: they close when HR resolves them
UPDATE app.tasks SET record_type = 'hr_request', record_id = id
 WHERE source = 'hr_request' AND record_type IS NULL;

ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY;
