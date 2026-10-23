-- Managed Postgres (Cloud SQL, ADR-0156) runs migrations as a role with CREATEROLE and CREATEDB but no SUPERUSER.
-- 0002 gives app.tenants_for_email() to the NOLOGIN thapsus_lookup role, and a non-superuser may give an object
-- only to a role that can create in the object's schema. So the role is created here, before 0002 and exactly as
-- 0002 creates it, and may create in schema app until 0020 revokes that again. Every database therefore ends with
-- the same privileges, whichever role migrated it. Where 0002 already ran, this only re-grants what 0020 revokes.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thapsus_lookup') THEN
    CREATE ROLE thapsus_lookup NOLOGIN NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT thapsus_lookup TO %I', current_user);
END $$;
GRANT CREATE ON SCHEMA app TO thapsus_lookup;
