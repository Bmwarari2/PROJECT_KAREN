-- Phase 9 (brief §6.10), expand only: public API credentials, OAuth 2.0 client credentials and
-- idempotency keys. Every secret is a 256-bit random value stored only as its SHA-256 hash and shown
-- once on creation (ADR-0090). Tenant isolation: forced RLS on every table, tenant-leading keys.

-- Scoped API keys: thr_sk_<tenant id>.<secret>. `prefix` (the first 8 characters of the secret)
-- identifies a key in the UI and in audit entries without revealing it.
CREATE TABLE app.api_keys (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  prefix text NOT NULL CHECK (prefix ~ '^[A-Za-z0-9_-]{8}$'),
  key_hash bytea NOT NULL,
  scopes text[] NOT NULL,
  role_id uuid NOT NULL,
  scope_type text NOT NULL DEFAULT 'all' CHECK (scope_type IN ('all', 'entity', 'country', 'department', 'location')),
  scope_values text[] NOT NULL DEFAULT '{}',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES app.roles (tenant_id, id)
);
CREATE UNIQUE INDEX api_keys_hash ON app.api_keys (tenant_id, key_hash);
CREATE INDEX api_keys_created ON app.api_keys (tenant_id, created_at DESC, id);
SELECT app.enable_tenant_rls('app.api_keys');

-- OAuth 2.0 clients (RFC 6749 §4.4 client credentials). client_id = thr_ci_<tenant id>.<client_key>;
-- the secret (thr_cs_…) is hashed. During a rotation the previous secret stays valid until it expires.
CREATE TABLE app.oauth_clients (
  tenant_id uuid NOT NULL REFERENCES app.tenants (tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  client_key text NOT NULL CHECK (client_key ~ '^[A-Za-z0-9_-]{20,64}$'),
  secret_hash bytea NOT NULL,
  previous_secret_hash bytea,
  previous_secret_expires_at timestamptz,
  scopes text[] NOT NULL,
  role_id uuid NOT NULL,
  scope_type text NOT NULL DEFAULT 'all' CHECK (scope_type IN ('all', 'entity', 'country', 'department', 'location')),
  scope_values text[] NOT NULL DEFAULT '{}',
  token_ttl_seconds integer NOT NULL DEFAULT 3600 CHECK (token_ttl_seconds BETWEEN 300 AND 86400),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  secret_rotated_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, client_key),
  FOREIGN KEY (tenant_id, role_id) REFERENCES app.roles (tenant_id, id)
);
SELECT app.enable_tenant_rls('app.oauth_clients');

-- Short-lived bearer access tokens issued by POST /v1/oauth/token: thr_at_<tenant id>.<secret>.
CREATE TABLE app.oauth_access_tokens (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES app.oauth_clients (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX oauth_access_tokens_hash ON app.oauth_access_tokens (tenant_id, token_hash);
CREATE INDEX oauth_access_tokens_expiry ON app.oauth_access_tokens (tenant_id, expires_at);
SELECT app.enable_tenant_rls('app.oauth_access_tokens');

-- Idempotency keys (Idempotency-Key header on POST/PATCH). Scoped per tenant and per caller
-- (api key, OAuth client or user). The first response is stored and replayed for 24 hours.
CREATE TABLE app.idempotency_keys (
  tenant_id uuid NOT NULL,
  principal_key text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  method text NOT NULL,
  path text NOT NULL,
  request_hash bytea NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response_status integer,
  response_type text,
  response_body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, principal_key, key)
);
CREATE INDEX idempotency_keys_expiry ON app.idempotency_keys (tenant_id, expires_at);
SELECT app.enable_tenant_rls('app.idempotency_keys');

-- Reporting replicas never read credential hashes or stored API responses.
REVOKE ALL ON app.api_keys, app.oauth_clients, app.oauth_access_tokens, app.idempotency_keys FROM thapsus_reporting;
