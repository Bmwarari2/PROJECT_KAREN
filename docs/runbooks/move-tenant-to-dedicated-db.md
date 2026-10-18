# Runbook: move a tenant to a dedicated database

Use this for very large tenants, such as the 200,000-employee enterprise profile, or tenants contracted for an isolated database. No code change is needed. Routing is configuration: `registry.tenants.db_key` plus the cell's database map.

**Proven by:** `apps/api/test/dedicated-db.int.test.ts`. The same API suite passes before and after the move, the source is purged, and neighbouring tenants are untouched.

## Before you start

1. Get approval for the extra recurring cost (a new Aurora cluster). See COSTS.md and CLAUDE.md: ask first.
2. Agree a maintenance window with the customer. Writes are refused while the tenant is `moving`; reads continue. For 200,000 employees with history, the copy takes minutes.
3. Confirm the tenant is `active`: `SELECT status, db_key FROM registry.tenants WHERE slug = '<slug>';`

## Steps

1. **Create the database** in the tenant's home cell. Add a dedicated Aurora cluster to the cell stack config (`infra/config/<env>.json` → `dedicatedDatabases: [{ key: "<key>" }]`) and deploy the cell stack. Never create it in another region: the startup residency check refuses it.
2. **Migrate it:** run the migrator task against the new cluster (`aws ecs run-task` with the migrator task definition and `DATABASE_HOST=<new writer endpoint>`).
3. **Add it to the routing configuration:** set `DEDICATED_DATABASE_HOSTS={"<key>":"<new proxy endpoint>"}` on the api and worker services and redeploy (rolling, no downtime). Nothing routes there yet.
4. **Move the tenant.** Run this from a one-off task in the cell, with owner credentials from Secrets Manager:
   ```bash
   OWNER_DATABASES='{"shared":"<owner url shared>","<key>":"<owner url dedicated>"}' \
   pnpm --filter @thapsus/db move-tenant -- <tenantId> <key>
   ```
   The tool:
   - marks the tenant `moving` and waits for router caches (15s + 5s);
   - COPYs every tenant table in foreign-key order;
   - verifies row counts table by table;
   - fixes sequences;
   - switches `db_key`; and
   - sets the tenant back to `active`.
   On any error it rolls back the target and restores `active` on the shared database.
5. **Verify:** sign in as a test user in the tenant (with support access granted), check the people list, the audit log (`POST /v1/audit/verify` must return `intact: true`) and a write.
6. **Purge the source** once verified, within the change window: rerun with `--purge-source` (skips copying, purges only), or run the purge step manually. Record the change in the tenant's audit trail and the staff audit.

## Rollback

- **Before step 4 completes:** nothing to do. The tool restores `active` on the shared database.
- **After the switch, before the purge:** set `db_key` back to `shared`. Writes made on the dedicated database since the switch must be copied back with the same tool in the reverse direction (`move-tenant <tenantId> shared`), after deleting the stale source rows.
