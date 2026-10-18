-- Foundation: roles, schemas, extensions and the tenant-context helpers used by every RLS policy.
-- Role passwords are never stored here; the migrator sets them from Secrets Manager / .env.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thapsus_app') THEN
    CREATE ROLE thapsus_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thapsus_backoffice') THEN
    CREATE ROLE thapsus_backoffice LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thapsus_reporting') THEN
    CREATE ROLE thapsus_reporting LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS registry;
CREATE SCHEMA IF NOT EXISTS backoffice;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA app, vault, audit, registry TO thapsus_app, thapsus_reporting;
GRANT USAGE ON SCHEMA registry, backoffice, app, audit TO thapsus_backoffice;

-- Current tenant for this transaction (NULL when unset, so policies match nothing).
CREATE OR REPLACE FUNCTION app.current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.current_actor() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.actor_id', true), '')::uuid $$;

-- Applies the standard tenant isolation policy: RLS enabled AND forced, one policy for all commands.
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(tbl regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL TO PUBLIC '
    'USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant())', tbl);
END $$;

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- Regional tenant registry: tenant → database routing (configuration, not code). No personal data.
CREATE TABLE registry.tenants (
  tenant_id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  home_region text NOT NULL CHECK (home_region IN ('uk', 'eu', 'us')),
  db_key text NOT NULL DEFAULT 'shared',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'moving', 'suspended', 'closing', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER registry_tenants_touch BEFORE UPDATE ON registry.tenants FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
GRANT SELECT, INSERT, UPDATE ON registry.tenants TO thapsus_app;
GRANT SELECT ON registry.tenants TO thapsus_backoffice, thapsus_reporting;

-- Tenant (the customer company). Lives in the tenant's own database so it moves with the tenant.
CREATE TABLE app.tenants (
  tenant_id uuid PRIMARY KEY,
  slug text NOT NULL,
  name text NOT NULL,
  home_region text NOT NULL CHECK (home_region IN ('uk', 'eu', 'us')),
  status text NOT NULL DEFAULT 'active',
  kind text NOT NULL DEFAULT 'production' CHECK (kind IN ('production', 'sandbox')),
  default_locale text NOT NULL DEFAULT 'en-GB',
  default_currency char(3) NOT NULL DEFAULT 'GBP',
  default_time_zone text NOT NULL DEFAULT 'Europe/London',
  security jsonb NOT NULL DEFAULT '{}'::jsonb,
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('app.tenants');
CREATE TRIGGER tenants_touch BEFORE UPDATE ON app.tenants FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
