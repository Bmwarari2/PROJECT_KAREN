-- Law-changes feed maintained by Thapsus staff in each cell's back office. No personal data: entries
-- describe changes in the law (jurisdiction, effective date, summary, what to do, linked rule versions).
-- Staff edit entries in place (every change is in backoffice.staff_audit); tenants read published,
-- non-withdrawn entries and record read / acknowledged state in app.law_change_reads.
CREATE TABLE backoffice.law_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^(EU|[A-Z]{2}(-[A-Z0-9]{1,3}){0,2})$'),
  effective_date date NOT NULL,
  title jsonb NOT NULL CHECK (title ? 'en-GB'),
  summary jsonb NOT NULL CHECK (summary ? 'en-GB'),
  what_to_do jsonb NOT NULL CHECK (what_to_do ? 'en-GB'),
  rule_version_ids uuid[] NOT NULL DEFAULT '{}',
  pack_rule_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_url text CHECK (source_url IS NULL OR source_url ~ '^https://'),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'withdrawn')),
  published_at timestamptz,
  created_by uuid NOT NULL REFERENCES backoffice.staff_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX law_changes_feed ON backoffice.law_changes (status, jurisdiction, effective_date);
CREATE TRIGGER law_changes_touch BEFORE UPDATE ON backoffice.law_changes FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

GRANT SELECT, INSERT, UPDATE ON backoffice.law_changes TO thapsus_backoffice;
GRANT SELECT ON backoffice.law_changes TO thapsus_app;
