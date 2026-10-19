-- Phase 10 (expand only): support tickets, billing state, enterprise contracts, status page, usage
-- aggregates and back-office settings. Tenant data (tickets, billing contacts, invoices) lives in
-- tenant tables under forced RLS in the home region. Back-office tables hold no tenant_id column and
-- no personal data; they reference a customer only by subject_tenant_id (isolation suite rule).

-- ---- Support tickets (tenant data, home region) ------------------------------------------------------
CREATE TABLE app.support_tickets (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  reference text NOT NULL CHECK (reference ~ '^T-[0-9A-F]{8}$'),
  requester_user_id uuid NOT NULL,
  subject text NOT NULL CHECK (length(subject) BETWEEN 3 AND 200),
  category text NOT NULL DEFAULT 'question' CHECK (category IN ('question', 'problem', 'billing', 'account', 'data', 'feature_request')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awaiting_customer', 'resolved', 'closed')),
  plan_id text NOT NULL,
  context_path text CHECK (length(context_path) <= 300),
  first_response_due_at timestamptz NOT NULL,
  first_response_at_risk_at timestamptz NOT NULL,
  resolution_due_at timestamptz NOT NULL,
  resolution_at_risk_at timestamptz NOT NULL,
  first_responded_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  sla_at_risk_notified_at timestamptz,
  sla_breached_notified_at timestamptz,
  last_activity_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, reference),
  FOREIGN KEY (tenant_id, requester_user_id) REFERENCES app.users (tenant_id, id)
);
CREATE INDEX support_tickets_requester ON app.support_tickets (tenant_id, requester_user_id, created_at DESC);
CREATE INDEX support_tickets_open ON app.support_tickets (tenant_id, status, resolution_due_at) WHERE status IN ('open', 'awaiting_customer');
SELECT app.enable_tenant_rls('app.support_tickets');
CREATE TRIGGER support_tickets_touch BEFORE UPDATE ON app.support_tickets FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.support_ticket_messages (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL,
  author_type text NOT NULL CHECK (author_type IN ('user', 'staff')),
  author_user_id uuid,
  author_staff_id uuid,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES app.support_tickets (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, author_user_id) REFERENCES app.users (tenant_id, id),
  CHECK ((author_type = 'user' AND author_user_id IS NOT NULL) OR (author_type = 'staff' AND author_staff_id IS NOT NULL))
);
CREATE INDEX support_ticket_messages_ticket ON app.support_ticket_messages (tenant_id, ticket_id, created_at);
SELECT app.enable_tenant_rls('app.support_ticket_messages');

-- Attachments are objects in the home-region bucket (key starts with the tenant id).
CREATE TABLE app.support_ticket_attachments (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL,
  message_id uuid,
  object_key text NOT NULL,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  uploaded_by_type text NOT NULL CHECK (uploaded_by_type IN ('user', 'staff')),
  uploaded_by_user_id uuid,
  uploaded_by_staff_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES app.support_tickets (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, message_id) REFERENCES app.support_ticket_messages (tenant_id, id) ON DELETE SET NULL (message_id)
);
CREATE INDEX support_ticket_attachments_ticket ON app.support_ticket_attachments (tenant_id, ticket_id);
SELECT app.enable_tenant_rls('app.support_ticket_attachments');

-- ---- Billing state (tenant data, home region; ADR-0103) --------------------------------------------
-- A billing account groups legal entities that are invoiced together (multi-entity billing, ADR-0107).
CREATE TABLE app.billing_accounts (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  is_default boolean NOT NULL DEFAULT false,
  currency char(3) NOT NULL CHECK (currency IN ('GBP', 'EUR', 'USD')),
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  company_tax_id text CHECK (length(company_tax_id) <= 40),
  company_tax_id_type text CHECK (length(company_tax_id_type) <= 20),
  po_number text CHECK (length(po_number) <= 100),
  collection text NOT NULL DEFAULT 'charge_automatically' CHECK (collection IN ('charge_automatically', 'send_invoice')),
  payment_terms_days integer CHECK (payment_terms_days BETWEEN 1 AND 120),
  provider_customer_id text,
  has_payment_method boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (collection = 'charge_automatically' OR payment_terms_days IS NOT NULL)
);
CREATE UNIQUE INDEX billing_accounts_one_default ON app.billing_accounts (tenant_id) WHERE is_default;
CREATE UNIQUE INDEX billing_accounts_provider ON app.billing_accounts (tenant_id, provider_customer_id) WHERE provider_customer_id IS NOT NULL;
SELECT app.enable_tenant_rls('app.billing_accounts');
CREATE TRIGGER billing_accounts_touch BEFORE UPDATE ON app.billing_accounts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Each legal entity is billed through at most one account; unassigned entities use the default account.
CREATE TABLE app.billing_account_entities (
  tenant_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  billing_account_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, entity_id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES app.legal_entities (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, billing_account_id) REFERENCES app.billing_accounts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX billing_account_entities_account ON app.billing_account_entities (tenant_id, billing_account_id);
SELECT app.enable_tenant_rls('app.billing_account_entities');

-- Billing contacts (personal data of the customer's own billing staff). The primary contact's name and
-- email go to Stripe; failed-payment emails go to every contact, from the home region.
CREATE TABLE app.billing_contacts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  billing_account_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email citext NOT NULL CHECK (length(email) <= 254),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, billing_account_id) REFERENCES app.billing_accounts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX billing_contacts_account ON app.billing_contacts (tenant_id, billing_account_id);
CREATE UNIQUE INDEX billing_contacts_one_primary ON app.billing_contacts (tenant_id, billing_account_id) WHERE is_primary;
SELECT app.enable_tenant_rls('app.billing_contacts');

CREATE TABLE app.billing_subscriptions (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  billing_account_id uuid NOT NULL,
  plan_id text NOT NULL,
  term text NOT NULL CHECK (term IN ('monthly', 'annual')),
  currency char(3) NOT NULL CHECK (currency IN ('GBP', 'EUR', 'USD')),
  status text NOT NULL CHECK (status IN ('trialing', 'trial_expired', 'incomplete', 'active', 'past_due', 'canceled')),
  source text NOT NULL DEFAULT 'self_serve' CHECK (source IN ('self_serve', 'contract')),
  contract_id uuid,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  band_id text,
  unit_amount_minor bigint NOT NULL DEFAULT 0 CHECK (unit_amount_minor >= 0),
  interval_amount_minor bigint NOT NULL DEFAULT 0 CHECK (interval_amount_minor >= 0),
  discount_code text,
  pending_change jsonb,
  cancel_requested_at timestamptz,
  cancel_effective_at timestamptz,
  canceled_at timestamptz,
  provider_subscription_id text,
  config_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, billing_account_id) REFERENCES app.billing_accounts (tenant_id, id) ON DELETE CASCADE
);
-- One live subscription per billing account.
CREATE UNIQUE INDEX billing_subscriptions_live ON app.billing_subscriptions (tenant_id, billing_account_id) WHERE status <> 'canceled';
CREATE UNIQUE INDEX billing_subscriptions_provider ON app.billing_subscriptions (tenant_id, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;
SELECT app.enable_tenant_rls('app.billing_subscriptions');
CREATE TRIGGER billing_subscriptions_touch BEFORE UPDATE ON app.billing_subscriptions FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Only the invoice fields the app shows are kept; webhook payloads themselves are never stored.
CREATE TABLE app.billing_invoices (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  billing_account_id uuid NOT NULL,
  provider_invoice_id text NOT NULL,
  number text,
  status text NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'uncollectible', 'void')),
  currency char(3) NOT NULL,
  subtotal_minor bigint NOT NULL DEFAULT 0,
  tax_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL DEFAULT 0,
  amount_due_minor bigint NOT NULL DEFAULT 0,
  amount_paid_minor bigint NOT NULL DEFAULT 0,
  period_start timestamptz,
  period_end timestamptz,
  due_at timestamptz,
  hosted_url text CHECK (hosted_url IS NULL OR hosted_url ~ '^https://'),
  po_number text,
  payment_failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider_invoice_id),
  FOREIGN KEY (tenant_id, billing_account_id) REFERENCES app.billing_accounts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX billing_invoices_account ON app.billing_invoices (tenant_id, billing_account_id, created_at DESC);
SELECT app.enable_tenant_rls('app.billing_invoices');
CREATE TRIGGER billing_invoices_touch BEFORE UPDATE ON app.billing_invoices FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Webhook idempotency: event id and type only.
CREATE TABLE app.billing_webhook_events (
  tenant_id uuid NOT NULL,
  event_id text NOT NULL,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id)
);
SELECT app.enable_tenant_rls('app.billing_webhook_events');

-- ---- Back-office store (no personal data, no tenant_id column) -------------------------------------
-- Support queue index: routing metadata only. Subjects, messages and files stay in the tenant tables.
CREATE TABLE backoffice.support_queue (
  ticket_id uuid PRIMARY KEY,
  subject_tenant_id uuid NOT NULL,
  reference text NOT NULL,
  priority text NOT NULL,
  status text NOT NULL,
  category text NOT NULL,
  plan_id text NOT NULL,
  first_response_due_at timestamptz NOT NULL,
  first_response_at_risk_at timestamptz NOT NULL,
  resolution_due_at timestamptz NOT NULL,
  resolution_at_risk_at timestamptz NOT NULL,
  first_responded_at timestamptz,
  resolved_at timestamptz,
  last_activity_at timestamptz NOT NULL,
  last_author text NOT NULL CHECK (last_author IN ('user', 'staff')),
  created_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_queue_open ON backoffice.support_queue (status, resolution_due_at);
CREATE INDEX support_queue_subject ON backoffice.support_queue (subject_tenant_id);

-- Enterprise contracts (commercial terms; no personal data). ADR-0107.
CREATE TABLE backoffice.contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_tenant_id uuid NOT NULL,
  reference text NOT NULL UNIQUE CHECK (length(reference) BETWEEN 3 AND 60),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'ended')),
  plan_id text NOT NULL,
  currency char(3) NOT NULL CHECK (currency IN ('GBP', 'EUR', 'USD')),
  term text NOT NULL DEFAULT 'annual' CHECK (term IN ('monthly', 'annual')),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  renewal text NOT NULL DEFAULT 'manual' CHECK (renewal IN ('auto', 'manual', 'none')),
  renewal_notice_days integer NOT NULL DEFAULT 90 CHECK (renewal_notice_days BETWEEN 0 AND 365),
  collection text NOT NULL DEFAULT 'send_invoice' CHECK (collection IN ('charge_automatically', 'send_invoice')),
  payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 1 AND 120),
  pricing jsonb NOT NULL,
  notes text CHECK (length(notes) <= 2000),
  activated_at timestamptz,
  created_by uuid NOT NULL REFERENCES backoffice.staff_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES backoffice.staff_users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on > starts_on)
);
CREATE UNIQUE INDEX contracts_one_active ON backoffice.contracts (subject_tenant_id) WHERE status = 'active';
CREATE INDEX contracts_subject ON backoffice.contracts (subject_tenant_id, created_at DESC);

-- Provider customer id → tenant, so a webhook can be routed without reading tenant data.
CREATE TABLE backoffice.billing_customers (
  provider_customer_id text PRIMARY KEY,
  subject_tenant_id uuid NOT NULL,
  billing_account_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_customers_subject ON backoffice.billing_customers (subject_tenant_id);

-- Usage aggregates per customer (counts and bytes only), refreshed daily by the billing job.
CREATE TABLE backoffice.tenant_usage (
  subject_tenant_id uuid PRIMARY KEY,
  headcount integer NOT NULL,
  active_users integer NOT NULL,
  storage_bytes bigint NOT NULL,
  plan_id text,
  billing_status text,
  computed_at timestamptz NOT NULL
);

-- Append-only back-office settings (newest version of a key wins), e.g. support contact channels.
CREATE TABLE backoffice.settings_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{2,80}$'),
  value jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES backoffice.staff_users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX settings_versions_key ON backoffice.settings_versions (key, created_at DESC);
CREATE TRIGGER settings_versions_append_only BEFORE UPDATE OR DELETE ON backoffice.settings_versions FOR EACH ROW EXECUTE FUNCTION backoffice.block_mutation();

-- Public status page: incidents and maintenance posted by staff for this cell's region (ADR-0105).
CREATE TABLE backoffice.status_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('incident', 'maintenance')),
  impact text NOT NULL CHECK (impact IN ('minor', 'major', 'critical', 'maintenance')),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 160),
  components text[] NOT NULL CHECK (components <@ ARRAY['api', 'database', 'worker', 'email']::text[] AND cardinality(components) > 0),
  status text NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed')),
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  started_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_by uuid NOT NULL REFERENCES backoffice.staff_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'incident' OR (scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL AND scheduled_end > scheduled_start))
);
CREATE INDEX status_incidents_recent ON backoffice.status_incidents (started_at DESC);
CREATE TABLE backoffice.status_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES backoffice.status_incidents (id),
  status text NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_by uuid NOT NULL REFERENCES backoffice.staff_users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX status_updates_incident ON backoffice.status_updates (incident_id, created_at);
CREATE TRIGGER status_updates_append_only BEFORE UPDATE OR DELETE ON backoffice.status_updates FOR EACH ROW EXECUTE FUNCTION backoffice.block_mutation();

-- Service heartbeats for the status page (worker loop, email delivery outcomes). No personal data.
CREATE TABLE backoffice.service_heartbeats (
  service text PRIMARY KEY CHECK (service IN ('worker', 'email')),
  beat_at timestamptz NOT NULL,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  recent_failures integer NOT NULL DEFAULT 0
);

-- ---- Grants -----------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON backoffice.support_queue, backoffice.tenant_usage, backoffice.service_heartbeats TO thapsus_app;
GRANT SELECT, INSERT ON backoffice.billing_customers TO thapsus_app;
GRANT SELECT ON backoffice.contracts, backoffice.settings_versions, backoffice.status_incidents, backoffice.status_updates TO thapsus_app;
GRANT SELECT ON backoffice.support_queue, backoffice.tenant_usage, backoffice.service_heartbeats, backoffice.billing_customers TO thapsus_backoffice;
GRANT SELECT, INSERT, UPDATE ON backoffice.contracts, backoffice.status_incidents TO thapsus_backoffice;
GRANT SELECT, INSERT ON backoffice.settings_versions, backoffice.status_updates TO thapsus_backoffice;
