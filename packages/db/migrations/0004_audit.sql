-- Append-only, hash-chained audit log.
-- * thapsus_app may only INSERT and SELECT (UPDATE/DELETE/TRUNCATE privileges never granted).
-- * A trigger rejects UPDATE/DELETE/TRUNCATE for every role, except the sealing function, which may only
--   fill seq/prev_hash/hash on rows that are not yet sealed.
-- * Sealing assigns a per-tenant sequence and SHA-256 chain asynchronously so writers never serialise.

CREATE TABLE audit.events (
  tenant_id uuid NOT NULL,
  id bigserial NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'support', 'system', 'api_client', 'scim')),
  actor_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  diff jsonb,
  ip inet,
  user_agent text,
  request_id text,
  sensitive boolean NOT NULL DEFAULT false,
  seq bigint,
  prev_hash bytea,
  hash bytea,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX audit_events_tenant_at ON audit.events (tenant_id, at);
CREATE INDEX audit_events_unsealed ON audit.events (tenant_id, id) WHERE hash IS NULL;
CREATE UNIQUE INDEX audit_events_seq ON audit.events (tenant_id, seq) WHERE seq IS NOT NULL;
SELECT app.enable_tenant_rls('audit.events');

CREATE TABLE audit.chain_heads (
  tenant_id uuid PRIMARY KEY,
  seq bigint NOT NULL,
  hash bytea NOT NULL
);
SELECT app.enable_tenant_rls('audit.chain_heads');

GRANT SELECT, INSERT ON audit.events TO thapsus_app;
GRANT SELECT ON audit.events TO thapsus_reporting;
GRANT USAGE ON SEQUENCE audit.events_id_seq TO thapsus_app;
GRANT SELECT ON audit.chain_heads TO thapsus_app;

-- Canonical hash input. Shared by sealing and verification so both agree byte-for-byte.
CREATE OR REPLACE FUNCTION audit.entry_hash(prev bytea, e audit.events) RETURNS bytea
  LANGUAGE sql IMMUTABLE AS
$$
  SELECT sha256(
    coalesce(prev, '\x'::bytea) ||
    convert_to(
      jsonb_build_object(
        'tenant_id', e.tenant_id, 'seq', e.seq, 'id', e.id,
        'at', to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'actor_type', e.actor_type, 'actor_id', e.actor_id, 'action', e.action,
        'target_type', e.target_type, 'target_id', e.target_id, 'diff', e.diff,
        'ip', host(e.ip), 'user_agent', e.user_agent, 'request_id', e.request_id, 'sensitive', e.sensitive
      )::text, 'UTF8'))
$$;

CREATE OR REPLACE FUNCTION audit.block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('audit.sealing', true) = 'on' AND OLD.hash IS NULL
     AND NEW.tenant_id = OLD.tenant_id AND NEW.id = OLD.id AND NEW.at = OLD.at
     AND NEW.action = OLD.action AND NEW.actor_type = OLD.actor_type
     AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
     AND NEW.target_type IS NOT DISTINCT FROM OLD.target_type
     AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
     AND NEW.diff IS NOT DISTINCT FROM OLD.diff
     AND NEW.ip IS NOT DISTINCT FROM OLD.ip
     AND NEW.user_agent IS NOT DISTINCT FROM OLD.user_agent
     AND NEW.request_id IS NOT DISTINCT FROM OLD.request_id
     AND NEW.sensitive = OLD.sensitive THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit.events is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.block_mutation();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.block_mutation();

-- Seals pending entries for the current tenant in id order. Runs as the table owner via SECURITY DEFINER,
-- but only for app.current_tenant(), and only touching seq/prev_hash/hash.
CREATE OR REPLACE FUNCTION audit.seal_pending(p_limit int DEFAULT 5000) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, audit, app AS $$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_seq bigint;
  v_hash bytea;
  v_count int := 0;
  r audit.events;
BEGIN
  IF v_tenant IS NULL THEN RETURN 0; END IF;
  PERFORM set_config('audit.sealing', 'on', true);
  INSERT INTO audit.chain_heads (tenant_id, seq, hash) VALUES (v_tenant, 0, '\x'::bytea)
    ON CONFLICT (tenant_id) DO NOTHING;
  SELECT seq, hash INTO v_seq, v_hash FROM audit.chain_heads WHERE tenant_id = v_tenant FOR UPDATE;
  FOR r IN SELECT * FROM audit.events WHERE tenant_id = v_tenant AND hash IS NULL ORDER BY id LIMIT p_limit LOOP
    v_seq := v_seq + 1;
    r.seq := v_seq;
    r.prev_hash := v_hash;
    v_hash := audit.entry_hash(v_hash, r);
    UPDATE audit.events SET seq = v_seq, prev_hash = r.prev_hash, hash = v_hash
      WHERE tenant_id = v_tenant AND id = r.id;
    v_count := v_count + 1;
  END LOOP;
  UPDATE audit.chain_heads SET seq = v_seq, hash = v_hash WHERE tenant_id = v_tenant;
  PERFORM set_config('audit.sealing', 'off', true);
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION audit.seal_pending(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.seal_pending(int) TO thapsus_app;

-- Recomputes the chain for the current tenant; returns the first broken seq or NULL when intact.
CREATE OR REPLACE FUNCTION audit.verify_chain() RETURNS bigint
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, audit, app AS $$
DECLARE
  v_prev bytea := '\x'::bytea;
  v_expected_seq bigint := 0;
  r audit.events;
BEGIN
  FOR r IN SELECT * FROM audit.events WHERE tenant_id = app.current_tenant() AND seq IS NOT NULL ORDER BY seq LOOP
    v_expected_seq := v_expected_seq + 1;
    IF r.seq <> v_expected_seq OR r.prev_hash IS DISTINCT FROM v_prev OR audit.entry_hash(v_prev, r) <> r.hash THEN
      RETURN coalesce(r.seq, v_expected_seq);
    END IF;
    v_prev := r.hash;
  END LOOP;
  IF EXISTS (SELECT 1 FROM audit.chain_heads h WHERE h.tenant_id = app.current_tenant()
             AND (h.seq <> v_expected_seq OR h.hash <> v_prev)) THEN
    RETURN v_expected_seq + 1;
  END IF;
  RETURN NULL;
END $$;
GRANT EXECUTE ON FUNCTION audit.verify_chain() TO thapsus_app;
