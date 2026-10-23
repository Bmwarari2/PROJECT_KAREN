-- thapsus_lookup needed CREATE on schema app only while 0002 gave it app.tenants_for_email() (0001b, ADR-0156).
-- It keeps USAGE on the schema and the column grants on app.users from 0002, nothing more.
REVOKE CREATE ON SCHEMA app FROM thapsus_lookup;
