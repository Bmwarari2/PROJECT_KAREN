-- 2026-10-24 (ADR-0195 to ADR-0197): sending from a template, the signing order, the company's signature in the
-- viewer, signatures stamped into the document and a status timeline (PROGRESS 16.11 to 16.13).
-- Expand only: nullable or defaulted columns on app.signature_requests and one new tenant table. Rows written
-- before this migration keep their meaning: the employee signs, then the company when requires_countersign.

ALTER TABLE app.signature_requests
  -- the employee is asked to sign (false: only the company signs, for example a letter HR sends for the record)
  ADD COLUMN requires_employee_signature boolean NOT NULL DEFAULT true,
  ADD COLUMN signing_order text NOT NULL DEFAULT 'employee_first'
    CHECK (signing_order IN ('employee_first', 'company_first', 'any')),
  ADD COLUMN due_on date,
  -- HR's message to the employee, shown in the viewer and the notification
  ADD COLUMN message text CHECK (length(message) <= 1000),
  -- the task this send fulfils (the onboarding "Send the statement of main terms" step, 16.14); it is closed
  -- when the document is complete
  ADD COLUMN task_id uuid,
  -- where signatures go on the document: [{ party, kind, page, x, y, width, height }] in PDF points, page
  -- 0-based. Filled for template documents (their signature block) and uploaded PDFs (placed boxes or an added
  -- signature page). NULL for requests made before this migration (they get the certificate page only).
  ADD COLUMN fields jsonb CHECK (fields IS NULL OR jsonb_typeof(fields) = 'array'),
  -- the exact PDF the request started from, and its hash: the "unsigned" version
  ADD COLUMN original_file_key text,
  ADD COLUMN original_sha256 text,
  -- the copy the employee signed into, kept when the company signs after them (the signed_file_key moves on to
  -- the completed copy); and the copy the company signed into when it signs first
  ADD COLUMN employee_signed_file_key text,
  ADD COLUMN company_signed_file_key text,
  ADD COLUMN company_signed_sha256 text,
  -- typed (the name in the handwriting font) or drawn
  ADD COLUMN signature_method text CHECK (signature_method IN ('typed', 'drawn')),
  ADD COLUMN countersignature_method text CHECK (countersignature_method IN ('typed', 'drawn')),
  -- a drawn signature as the person drew it (a PNG in the object store under the person's prefix), kept as
  -- evidence beside the copy it was stamped into
  ADD COLUMN signature_drawing_key text,
  ADD COLUMN countersignature_drawing_key text,
  ADD COLUMN reminded_at timestamptz,
  ADD COLUMN reminder_count integer NOT NULL DEFAULT 0 CHECK (reminder_count >= 0),
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by uuid,
  ADD COLUMN void_reason text CHECK (length(void_reason) <= 1000),
  -- a new request sent for the same document after this one was voided
  ADD COLUMN resent_as uuid;

ALTER TABLE app.signature_requests
  ADD CONSTRAINT signature_requests_someone_signs CHECK (requires_employee_signature OR requires_countersign),
  ADD CONSTRAINT signature_requests_task FOREIGN KEY (tenant_id, task_id)
    REFERENCES app.tasks (tenant_id, id) ON DELETE SET NULL (task_id),
  ADD CONSTRAINT signature_requests_resent_as FOREIGN KEY (tenant_id, resent_as)
    REFERENCES app.signature_requests (tenant_id, id) ON DELETE SET NULL (resent_as);
CREATE INDEX signature_requests_task ON app.signature_requests (tenant_id, task_id) WHERE task_id IS NOT NULL;

-- Each step of a signature request, for the status timeline: sent, reminded, signed by the employee, signed for
-- the company, returned, voided, sent again, completed. Steps that produce a version of the PDF record its object
-- key and SHA-256, so the unsigned, signed and completed versions are all kept with their hashes (the same
-- hashes are in the audit log). Append-only: the API never updates or deletes a row (erasure deletes them with
-- the person's other records).
CREATE TABLE app.signature_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- the order the steps were recorded in (two steps can share a timestamp)
  seq bigint GENERATED ALWAYS AS IDENTITY,
  signature_request_id uuid NOT NULL,
  -- the person the document is for (the data subject of the timeline)
  employee_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sent', 'reminded', 'employee_signed', 'company_signed', 'returned', 'voided',
                                      'resent', 'completed')),
  actor_user_id uuid,
  -- the name the person signed with, or the sender's name as it was then
  actor_name text CHECK (length(actor_name) <= 200),
  file_key text,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, signature_request_id) REFERENCES app.signature_requests (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES app.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX signature_events_request ON app.signature_events (tenant_id, signature_request_id, at, seq);
CREATE INDEX signature_events_employee ON app.signature_events (tenant_id, employee_id);
SELECT app.enable_tenant_rls('app.signature_events');
