# Runbook: move a tenant to a dedicated database

Use this for very large tenants, such as the 200,000-employee enterprise profile, or tenants contracted for an isolated database. No code change is needed. Routing is configuration: `registry.tenants.db_key` plus the cell's database map (`DEDICATED_DATABASE_HOSTS`, which the cell stack sets from `infra/config/<env>.json`). Decision records: ADR-0068 (infrastructure) and ADR-0099 (back-office requests).

**Proven by:**

- `apps/api/test/dedicated-db.int.test.ts`: the same API suite passes before and after the move, the source is purged, and neighbouring tenants are untouched.
- `apps/api/test/tenant-platform.int.test.ts` ("moves a tenant through a tracked back-office request…"): the back-office request path, status tracking, a runner without the target's credentials leaving the request queued, and the tenant working afterwards.
- `infra/test/infra.test.ts` ("dedicated databases …"): what a config entry creates (cluster, proxy, backups, tools task, `DEDICATED_*` settings), only in the cell's own region, and nothing for the committed configs.
- `packages/db/test/router.test.ts` and `packages/db/test/dedicated-db.residency.test.ts`: the router reads `DEDICATED_DATABASE_HOSTS` and refuses a dedicated host in another region, for every region pair.
- `scripts/test/deploy-plan.test.ts`: every cell deploy migrates each dedicated database of that cell.

## Before you start

1. Get approval for the extra recurring cost. Each entry adds an Aurora cluster (writer and reporting reader) and an RDS Proxy in the tenant's home cell. See `docs/COSTS.md` ("Dedicated databases") and CLAUDE.md: ask first. Raise that cell's budget (`cells.<cell>.monthlyBudgetUsd` in the same config file) in the same change.
2. Agree a maintenance window with the customer. Writes are refused while the tenant is `moving`; reads continue. For 200,000 employees with history, the copy takes minutes.
3. Confirm the tenant is `active` and note its home cell: `SELECT status, db_key, home_region FROM registry.tenants WHERE slug = '<slug>';`

## Steps

1. **Declare the database** in `infra/config/<env>.json` (the committed configs have none):
   ```json
   "dedicatedDatabases": [{ "key": "<key>", "cell": "<home_region from the query: uk, eu or us>" }]
   ```
   - `key` becomes the tenant's `db_key`. Use lower-case letters, digits and single hyphens, start with a letter, and keep it to 24 characters at most. It can never be `shared`, and it must differ from every other key even when hyphens are ignored.
   - `cell` must be the tenant's home cell. The cluster is created only in that cell's region: UK `eu-west-2`, EU `eu-central-1`, US `us-east-2`.
   - Optional `minAcu` and `maxAcu` (Aurora Serverless v2, 0.5 to 256) size it. They default to the environment's `aurora` settings. Backup retention and deletion protection always follow `aurora`.
   - `pnpm --filter @thapsus/infra synth` and `pnpm exec vitest run --project unit infra` validate the entry. A cell can never use a database in another region: the services' startup residency check and `TenantRouter.fromEnv` both refuse one.
2. **Deploy the cell** (production only after approval, with `--approved`):

   ```bash
   node --import tsx scripts/deploy.mjs --env <env> --only cell-<cell>
   ```

   This adds to the cell stack:
   - the cluster `thapsus-hr-<env>-<cell>-<key>`: writer and reporting reader in two AZs, the cell's data KMS key, the cell's backup plan (with its permitted copy region), the cell VPC's isolated subnets and database security group, and its own owner secret `thapsus-hr/<env>/db/<key>/thapsus_owner`;
   - its RDS Proxy `thapsus-hr-<env>-<cell>-<key>-proxy` (TLS required);
   - the tools task definition `thapsus-hr-<env>-<cell>-db-<key>`;
   - the api and worker settings `DEDICATED_DATABASE_HOSTS={"<key>":"<proxy endpoint>"}` and `DEDICATED_READER_HOSTS={"<key>":"<reader endpoint>"}`.

   The deploy then runs the shared migrator and the tools task of every dedicated database in the cell, and restarts the services. The tools task applies the migrations and sets the same `thapsus_app`, `thapsus_backoffice` and `thapsus_reporting` passwords as on the shared database. Nothing routes to the new database yet. Every later deploy of the cell migrates it again before the restart.

   The stack outputs, in `.deploy/ThapsusHr-<env>-cell-<cell>.json`, include `Dedicated<Key>ProxyEndpoint`, `Dedicated<Key>WriterEndpoint` and `Dedicated<Key>ToolsTaskDefinitionArn`. `<Key>` is the key in PascalCase (`big-co` → `BigCo`).

3. **Request the move in the back office.** Sign in to the back office with your passkey, hold an approved `super_admin` elevation ([staff access](staff-access.md)) and re-authenticate with your key if asked, then call:
   ```http
   POST /v1/backoffice/tenants/<tenantId>/database-moves
   { "targetKey": "<key>", "purgeSource": false, "reason": "<change ticket and contract reference>" }
   ```
   - The request is refused (`targetNotConfigured`) unless `<key>` is already in the routing configuration (step 2), and refused (`tenantNotActive`) unless the tenant is `active`.
   - Only one open request is allowed per tenant.
   - The request is recorded in the staff trail and in the customer's audit log.
   - `GET /v1/backoffice/database-moves/<id>` shows its status: `requested` → `running` → `succeeded` or `failed`, with progress lines and the per-table report.
   - `POST /v1/backoffice/database-moves/<id>/cancel` withdraws a request that has not started.
4. **Run the move** with the dedicated database's tools task and the move-runner command. Take the values from the stack outputs:

   ```bash
   aws --region <cell region> ecs run-task --cluster <EcsClusterName> \
     --task-definition <Dedicated<Key>ToolsTaskDefinitionArn> --launch-type FARGATE \
     --network-configuration 'awsvpcConfiguration={subnets=[<MigratorSubnetIds>],securityGroups=[<MigratorSecurityGroupId>],assignPublicIp=DISABLED}' \
     --overrides '{"containerOverrides":[{"name":"tools","command":["node","dist/move-tenant.mjs","--process-requests"]}]}'
   ```
   - The task reads the owner credentials of both databases from Secrets Manager: the shared one (`SHARED_OWNER_DATABASE_SECRET`, `SHARED_DATABASE_HOST`) and the dedicated one (`OWNER_DATABASE_SECRET`, `DATABASE_HOST`). Its logs are in `/thapsus-hr/<env>/<cell>/migrator` with the stream prefix `db-<key>`.
   - It claims requested moves one at a time (`FOR UPDATE SKIP LOCKED`), and only moves between `shared` and `<key>`. Requests for another dedicated database stay queued for that database's tools task. It records each outcome and exits non-zero if any move failed; `aws ecs describe-tasks` shows the exit code.
   - For emergencies there is a direct form, which is not tracked in the back office. Run the same task with the command `["node","dist/move-tenant.mjs","<tenantId>","<key>"]`, adding `"--purge-source"` to purge in the same run.
   - In local dev and tests, the same tool runs as `OWNER_DATABASES='{"shared":"<owner url>","<key>":"<owner url>"}' pnpm --filter @thapsus/db move-tenant -- --process-requests`.

   The tool:
   - marks the tenant `moving` and waits for router caches (15s + 5s);
   - COPYs every tenant table in foreign-key order;
   - verifies row counts table by table;
   - fixes sequences;
   - switches `db_key`; and
   - sets the tenant back to `active`.

   On any error it rolls back the target and restores `active` on the shared database.

5. **Verify:** sign in as a test user in the tenant (with support access granted), check the people list, the audit log (`POST /v1/audit/verify` must return `intact: true`) and a write.
6. **Purge the source** once verified, within the change window. Either:
   - request the move with `"purgeSource": true` (the runner purges right after the switch); or
   - purge the tenant's rows from the shared database manually in a transaction with `SET LOCAL session_replication_role = replica`.

   The direct `--purge-source` flag copies **and** purges in one run, so use it only for a move that has not been done yet. Record the change in the tenant's audit trail and the staff audit.

## Rollback

- **Before step 4 completes:** nothing to do. The tool restores `active` on the shared database, and the request is marked `failed` with the error.
- **After the switch:** move the tenant back with the same tool, which copies everything from the dedicated database (including writes made since the switch) and switches `db_key` back to `shared`:
  1. If the source was not purged, first delete the tenant's stale rows from the shared database, in a transaction with `SET LOCAL session_replication_role = replica`. The tool refuses a target that already has rows for the tenant.
  2. Run the tools task with the command `["node","dist/move-tenant.mjs","<tenantId>","shared"]`. Add `"--purge-source"` to remove the dedicated copy in the same run.

## Retiring a dedicated database

Do this only after every tenant on it has moved back, when `SELECT count(*) FROM registry.tenants WHERE db_key = '<key>'` returns 0. Remove the entry from `infra/config/<env>.json` and deploy the cell. This deletes a cloud resource and its data, so ask first (CLAUDE.md). In production the cluster has deletion protection and is retained when it leaves the stack. In other environments a final snapshot is taken.
