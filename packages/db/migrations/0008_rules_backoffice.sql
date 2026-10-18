-- Back-office maintained rule versions (overlay on the jurisdiction packs). Append-only: an edit adds a
-- new version; nothing is updated or deleted. No personal data.
CREATE TABLE backoffice.rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction text NOT NULL,
  rule_key text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  value jsonb NOT NULL,
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  source_title text NOT NULL,
  verified_on date NOT NULL,
  reviewer text NOT NULL,
  notes text,
  created_by uuid NOT NULL REFERENCES backoffice.staff_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX rule_versions_lookup ON backoffice.rule_versions (jurisdiction, rule_key, effective_from);

CREATE OR REPLACE FUNCTION backoffice.block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER rule_versions_append_only BEFORE UPDATE OR DELETE ON backoffice.rule_versions FOR EACH ROW EXECUTE FUNCTION backoffice.block_mutation();
CREATE TRIGGER staff_audit_append_only BEFORE UPDATE OR DELETE ON backoffice.staff_audit FOR EACH ROW EXECUTE FUNCTION backoffice.block_mutation();

GRANT SELECT, INSERT ON backoffice.rule_versions TO thapsus_backoffice;
GRANT USAGE ON SCHEMA backoffice TO thapsus_app;
GRANT SELECT ON backoffice.rule_versions TO thapsus_app;
