# Runbook: move a tenant to a dedicated database

Use this for very large tenants, such as the 200,000-employee enterprise profile, or tenants contracted for an isolated database. No code change is needed. Routing is configuration: `registry.tenants.db_key` plus the cell's database map.

**Proven by:**
- `apps/api/test/dedicated-db.int.test.ts`: the same API suite passes before and after the move, the source is purged, and neighbouring tenants are untouched.
- `apps/api/test/tenant-platform.int.test.ts` ("moves a tenant through a tracked back-office request…"): the back-office request path, the status tracking and the tenant keeps working afterwards.

## Before you start

1. Get approval for the extra recurring cost (a new Aurora cluster). See COSTS.md and CLAUDE.md: ask first.
2. Agree a maintenance window with the customer. Writes are refused while the tenant is `moving`; reads continue. For 200,000 employees with history, the copy takes minutes.
3. Confirm the tenant is `active`: `SELECT status, db_key FROM registry.tenants WHERE slug = '<slug>';`

## Steps

1. **Create the database** in the tenant's home cell. Add a dedicated Aurora cluster to the cell stack config (`infra/config/<env>.json` → `dedicatedDatabases: [{ key: "<key>" }]`) and deploy the cell stack. Never create it in another region: the startup residency check refuses it.
2. **Migrate it:** run the migrator task against the new cluster (`aws ecs run-task` with the migrator task definition and `DATABASE_HOST=<new writer endpoint>`).
3. **Add it to the routing configuration:** set `DEDICATED_DATABASE_HOSTS={"<key>":"<new proxy endpoint>"}` on the api and worker services and redeploy (rolling, no downtime). Nothing routes there yet.
4. **Request the move in the back office.** Sign in as a super admin (password + TOTP) and call:
   ```http
   POST /v1/backoffice/tenants/<tenantId>/database-moves
   { "targetKey": "<key>", "purgeSource": false, "reason": "<change ticket and contract reference>" }
   ```
   - The request is refused unless `<key>` is already in the routing configuration (step 3) and the tenant is `active`.
   - Only one open request is allowed per tenant.
   - The request is recorded in the staff trail and in the customer's audit log.
   - `GET /v1/backoffice/database-moves/<id>` shows its status: `requested` → `running` → `succeeded` or `failed`, with progress lines and the per-table report.
   - `POST /v1/backoffice/database-moves/<id>/cancel` withdraws a request that has not started.
5. **Run the move.** Run the move runner from a one-off task in the cell, with owner credentials from Secrets Manager. It claims requested moves one at a time (`FOR UPDATE SKIP LOCKED`) and records the outcome:
   ```bash
   OWNER_DATABASES='{"shared":"<owner url shared>","<key>":"<owner url dedicated>"}' \
   pnpm --filter @thapsus/db move-tenant -- --process-requests
   ```
   It exits non-zero if any move failed. The direct form is still available for emergencies. It is not tracked in the back office:
   `pnpm --filter @thapsus/db move-tenant -- <tenantId> <key> [--purge-source]`.
   The tool:
   - marks the tenant `moving` and waits for router caches (15s + 5s);
   - COPYs every tenant table in foreign-key order;
   - verifies row counts table by table;
   - fixes sequences;
   - switches `db_key`; and
   - sets the tenant back to `active`.
   On any error it rolls back the target and restores `active` on the shared database.
6. **Verify:** sign in as a test user in the tenant (with support access granted), check the people list, the audit log (`POST /v1/audit/verify` must return `intact: true`) and a write.
7. **Purge the source** once verified, within the change window. Either:
   - request the move with `"purgeSource": true` (the runner purges right after the switch); or
   - purge the tenant's rows from the shared database manually in a transaction with `SET LOCAL session_replication_role = replica`.

   The direct `--purge-source` flag copies **and** purges in one run, so use it only for a move that has not been done yet. Record the change in the tenant's audit trail and the staff audit.

## Rollback

- **Before step 5 completes:** nothing to do. The tool restores `active` on the shared database, and the request is marked `failed` with the error.
- **After the switch, before the purge:** set `db_key` back to `shared`. Writes made on the dedicated database since the switch must be copied back with the same tool in the reverse direction (`move-tenant <tenantId> shared`), after deleting the stale source rows.
