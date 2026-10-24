-- 2026-10-24 (ADR-0194): document templates in Settings. Templates are listed, created, edited and archived; every
-- edit is a new version and each generated document keeps the version it was made from (PROGRESS 16.9, 16.10).
-- Expand only: one new tenant table and nullable or defaulted columns. Nothing is dropped or renamed.
--
-- app.document_templates keeps its name, body, locale, category and requires_countersign columns in step with the
-- latest version, so code that does not know versions still reads the current wording (the expand half; a later
-- release may stop writing them). A template with no version rows yet (made before this migration) is given
-- version 1 from those columns the first time the API reads it, so no data is rewritten here: with forced row
-- level security a managed-Postgres migrator would not see tenant rows anyway (ADR-0170).

ALTER TABLE app.document_templates
  -- active, or archived (hidden from sending; its documents and versions stay)
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  ADD COLUMN current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  -- a starter template copied from Thapsus-HR's samples (for example uk_statement): shown as a sample whose
  -- wording the customer's legal adviser should review (HUMAN_TODO 3.17)
  ADD COLUMN sample_key text CHECK (sample_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- who signs first when this template is sent: the employee (default), the company, or either (ADR-0196)
  ADD COLUMN signing_order text NOT NULL DEFAULT 'employee_first'
    CHECK (signing_order IN ('employee_first', 'company_first', 'any')),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid,
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by uuid;

CREATE INDEX document_templates_status ON app.document_templates (tenant_id, status, name);

-- One row per saved version. A version is never changed after it is written.
--  body        the wording with merge fields ({{employee.firstName}}) and simple formatting (# headings,
--              paragraphs, - and 1. lists, **bold**)
--  ask_fields  fields typed in when sending: [{ "key": "startTime", "label": "Start time", "required": true }],
--              used in the body as {{ask.startTime}}
CREATE TABLE app.document_template_versions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  locale text NOT NULL,
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 50000),
  ask_fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(ask_fields) = 'array'),
  requires_countersign boolean NOT NULL DEFAULT false,
  signing_order text NOT NULL DEFAULT 'employee_first'
    CHECK (signing_order IN ('employee_first', 'company_first', 'any')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, template_id, version),
  FOREIGN KEY (tenant_id, template_id) REFERENCES app.document_templates (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.document_template_versions');

-- The version a generated document was made from (NULL: made before versions existed, i.e. version 1, or not
-- from a template at all).
ALTER TABLE app.documents ADD COLUMN template_version_id uuid;
ALTER TABLE app.documents
  ADD CONSTRAINT documents_template_version FOREIGN KEY (tenant_id, template_version_id)
    REFERENCES app.document_template_versions (tenant_id, id) ON DELETE SET NULL (template_version_id);
CREATE INDEX documents_template_version ON app.documents (tenant_id, template_version_id)
  WHERE template_version_id IS NOT NULL;
