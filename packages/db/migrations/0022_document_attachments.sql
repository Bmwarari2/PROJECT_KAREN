-- 2026-10-23 (ADR-0165, ADR-0166): documents HR attaches to a person, opened in the in-app viewer.
-- Expand only: new nullable columns (and one with a constant default, which needs no table rewrite) on
-- app.documents. Rows written before this migration, and code that does not know these columns, are
-- unaffected: a NULL attachment_type is a library, template or signed document as before.
--
--  attachment_type  what HR attached to the person: right-to-work evidence, a driving licence, a contract,
--                   a qualification or certificate, a background check, or something else.
--  visibility       who may read an attached document: 'hr' (HR who manage the person's documents) or
--                   'employee' (that HR and the person). NULL keeps the folder rules of the library.
--  issued_on        the issue date of a licence, certificate or check (expires_on already exists).
--  note             HR's note on the document (part of the personnel record; managers never see it).
--  vault_record_id  right-to-work evidence only (ADR-0166): the vault record (category immigration) that holds
--                   the evidence type, the uploaded file name and the note, sealed with the regional key. The
--                   file itself is sealed with the same key, so this row holds no immigration detail at all.
--  scan_status      the upload scan hook's verdict. No malware scanner runs yet (HUMAN_TODO 1.7), so every
--                   upload is 'not_scanned' until one does.
--  rtw_check_id     the right-to-work check the evidence was attached from, when it was.
ALTER TABLE app.documents
  ADD COLUMN attachment_type text CHECK (
    attachment_type IN ('right_to_work', 'driving_licence', 'contract', 'qualification', 'background_check', 'other')
  ),
  ADD COLUMN visibility text CHECK (visibility IN ('hr', 'employee')),
  ADD COLUMN issued_on date,
  ADD COLUMN note text CHECK (length(note) <= 1000),
  ADD COLUMN vault_record_id uuid,
  ADD COLUMN scan_status text NOT NULL DEFAULT 'not_scanned' CHECK (scan_status IN ('not_scanned', 'clean', 'infected')),
  ADD COLUMN rtw_check_id uuid;

ALTER TABLE app.documents
  ADD CONSTRAINT documents_attachment_has_person CHECK (attachment_type IS NULL OR employee_id IS NOT NULL),
  ADD CONSTRAINT documents_attachment_has_visibility CHECK (attachment_type IS NULL OR visibility IS NOT NULL),
  ADD CONSTRAINT documents_vault_is_immigration CHECK (vault_record_id IS NULL OR category = 'immigration'),
  ADD CONSTRAINT documents_issued_before_expiry CHECK (issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on),
  ADD CONSTRAINT documents_rtw_check FOREIGN KEY (tenant_id, rtw_check_id)
    REFERENCES app.rtw_checks (tenant_id, id) ON DELETE SET NULL (rtw_check_id);

-- The person's documents tab and the right-to-work page look attachments up by person and by check.
CREATE INDEX documents_attachments ON app.documents (tenant_id, employee_id, attachment_type) WHERE attachment_type IS NOT NULL;
CREATE INDEX documents_rtw_check ON app.documents (tenant_id, rtw_check_id) WHERE rtw_check_id IS NOT NULL;

-- ---- Countersignature (ADR-0169): a signature that needs approval -------------------------------------------------
-- After the person signs, a document that needs a company signature goes to an approver through the approvals
-- service (subject document.countersign: HR admin by default, or the authorised signatory the customer's approval
-- chain names). It is completed only when the approver countersigns; the signed copy then carries both
-- signatures. A template says whether its documents need it (contracts and policies that need a company
-- signature do by default); each signature request keeps its own setting.
ALTER TABLE app.document_templates ADD COLUMN requires_countersign boolean NOT NULL DEFAULT false;

ALTER TABLE app.signature_requests
  ADD COLUMN requires_countersign boolean NOT NULL DEFAULT false,
  -- pending: waiting for the approver; approved: countersigned; returned: sent back to the signer with a reason
  ADD COLUMN approval_status text CHECK (approval_status IN ('pending', 'approved', 'returned')),
  ADD COLUMN approval_request_id uuid,
  ADD COLUMN returned_reason text CHECK (length(returned_reason) <= 1000),
  -- the copy with the signer's certificate only, while it waits for the countersignature
  ADD COLUMN employee_signed_sha256 text,
  ADD COLUMN countersigner_user_id uuid,
  ADD COLUMN countersigner_name text CHECK (length(countersigner_name) <= 120),
  ADD COLUMN countersigner_ip inet,
  ADD COLUMN countersigner_user_agent text CHECK (length(countersigner_user_agent) <= 512),
  ADD COLUMN countersigned_at timestamptz,
  -- set when the document is complete: signed, and countersigned when that is required
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN signed_document_id uuid;

ALTER TABLE app.signature_requests
  ADD CONSTRAINT signature_requests_approval CHECK (approval_status IS NULL OR requires_countersign),
  ADD CONSTRAINT signature_requests_signed_document FOREIGN KEY (tenant_id, signed_document_id)
    REFERENCES app.documents (tenant_id, id) ON DELETE SET NULL (signed_document_id);
CREATE INDEX signature_requests_document ON app.signature_requests (tenant_id, document_id);
CREATE INDEX signature_requests_awaiting_approval ON app.signature_requests (tenant_id, approval_request_id)
  WHERE approval_status = 'pending';
-- Signatures made before countersignatures existed were complete when signed. The migrator owns the tables
-- and RLS is forced, so it would see no rows: FORCE is lifted only inside this transaction (as in 0007b) and
-- restored straight after. The application role is never the owner, so its policy applies throughout.
ALTER TABLE app.signature_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.documents NO FORCE ROW LEVEL SECURITY;
UPDATE app.signature_requests s SET completed_at = s.signed_at,
       signed_document_id = (SELECT d.id FROM app.documents d WHERE d.tenant_id = s.tenant_id AND d.file_key = s.signed_file_key LIMIT 1)
 WHERE s.status = 'signed' AND s.completed_at IS NULL;
ALTER TABLE app.documents FORCE ROW LEVEL SECURITY;
ALTER TABLE app.signature_requests FORCE ROW LEVEL SECURITY;
