-- 2026-10-23 (ADR-0167): structured payslip content as the customer's payroll provider supplies it.
-- Thapsus-HR does not run payroll or calculate tax (CLAUDE.md scope): every figure in a statement comes from
-- the provider and is stored as received (integer minor units with an ISO 4217 code), after a check that its
-- lines add up to its totals. The provider's PDF stays attached when there is one.
--
-- Expand only. A payslip is now a file, a statement, or both: the file columns become nullable (code that
-- predates this migration always sets them), and a CHECK keeps every row holding at least one of the two.
ALTER TABLE app.payslip_batches
  ADD COLUMN source text NOT NULL DEFAULT 'files' CHECK (source IN ('files', 'provider_statements')),
  ADD COLUMN provider_name text CHECK (length(provider_name) BETWEEN 1 AND 120),
  -- Fictional sample data (the staging seed's sample payroll provider): shown with a "Sample data" marker.
  ADD COLUMN sample boolean NOT NULL DEFAULT false;

ALTER TABLE app.payslips
  ALTER COLUMN file_name DROP NOT NULL,
  ALTER COLUMN file_key DROP NOT NULL,
  ALTER COLUMN size_bytes DROP NOT NULL,
  ALTER COLUMN sha256 DROP NOT NULL,
  ADD COLUMN statement jsonb,
  ADD COLUMN pay_date date,
  ADD COLUMN period_start date,
  ADD COLUMN period_end date,
  ADD COLUMN currency text CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN gross_minor bigint,
  ADD COLUMN net_minor bigint;

ALTER TABLE app.payslips
  ADD CONSTRAINT payslips_file_or_statement CHECK (file_key IS NOT NULL OR statement IS NOT NULL),
  ADD CONSTRAINT payslips_file_complete CHECK (
    file_key IS NULL OR (file_name IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL)
  ),
  ADD CONSTRAINT payslips_statement_summary CHECK (
    statement IS NULL OR (currency IS NOT NULL AND net_minor IS NOT NULL AND gross_minor IS NOT NULL AND pay_date IS NOT NULL)
  ),
  ADD CONSTRAINT payslips_period CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start);

-- The employee's payslip list (year filter, newest first).
CREATE INDEX payslips_employee_pay_date ON app.payslips (tenant_id, employee_id, pay_date DESC) WHERE status = 'published';
