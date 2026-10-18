-- Execution log for "call integration" automation actions. One row per requesting outbox event
-- (idempotency), written by the integrations.dispatch job with the handler's result.
CREATE TABLE app.integration_calls (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id bigint NOT NULL,
  rule_id uuid,
  integration text NOT NULL,
  operation text NOT NULL,
  subject_employee_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, event_id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES app.automation_rules (tenant_id, id) ON DELETE SET NULL (rule_id)
);
CREATE INDEX integration_calls_rule ON app.integration_calls (tenant_id, rule_id, created_at DESC);
SELECT app.enable_tenant_rls('app.integration_calls');
