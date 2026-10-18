-- Extensions (pg_trgm, citext, pgcrypto, btree_gist) live in schema public, on which 0001 revoked
-- everything from PUBLIC. Without USAGE the application roles cannot resolve extension operators:
-- trigram word similarity (`<%`) fails, and citext comparisons silently fall back to case-sensitive
-- text equality. Grant USAGE only — never CREATE — so the CVE-2018-1058 mitigation stays in place.
-- The only table in public (schema_migrations) is not granted to these roles.
GRANT USAGE ON SCHEMA public TO thapsus_app, thapsus_backoffice, thapsus_reporting;
