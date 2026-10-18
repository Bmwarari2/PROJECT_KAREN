# Handover — 2026-10-18

Work moved off a low-memory Windows machine (4 cores, ~4 GB RAM) to a cloud agent. Read `CLAUDE.md`,
`docs/BUILD_BRIEF.md` (§10 is the definition of done) and `docs/PROGRESS.md` before changing anything.

## Branches (stacked, each built on the previous; nothing merged to `main` yet)

| Branch | Tip | State |
| --- | --- | --- |
| `phase-0-foundations` | `2dc6663` | Code complete. Full `pnpm verify` has never gone green in one run (machine ran out of memory). Every suite has passed on its own. 2 visual baselines are missing (see below). |
| `phase-1-core-hr` | `247e0ae` | Code and integration tests written and passing. Also carries shared files (message catalogues, `apps/api/src/modules/index.ts`, lockfile) that already reference Phase 3 routes, so this commit only builds once Phase 3 is on top. |
| `phase-2-jurisdiction-packs` | `792d43c` | Packs, golden tests and back-office editing done. `apps/api/test/rules.int.test.ts` has **not been run**. |
| `phase-3-time-off` | `83bd1be` | Engine (42 unit tests pass), service, routes and `/app/time-off` UI done. `apps/api/test/leave.int.test.ts` has **not been run**; some of its expectations may need adjusting. |
| `phase-4-rotas-time` | `92242be`+ | WIP. `time/engine.ts` and its 12 tests pass. `time/service.ts` has not been type-checked. Migration `0010_rotas_time.sql` has not been applied. Routes and UI are not written. |

Work on `phase-4-rotas-time`. Merge to `main` in order (0 → 4) through PRs once `pnpm verify` passes on the stack.

## Immediate next steps

1. `pnpm install && docker compose up -d && pnpm run setup` (writes git-ignored `.env`, creates the DBs and runs migrations). Node ≥ 24, pnpm 12.14.
2. Run `pnpm typecheck`. Then run `pnpm test:integration` for `rules.int.test.ts` and `leave.int.test.ts`, and fix what fails.
3. Missing visual baselines `apps/web/e2e/__screenshots__/visual-desktop-{light,dark}/home.png`:
   - Generate them with `UPDATE_SNAPSHOTS=missing VISUAL_PROJECTS=visual-desktop-light,visual-desktop-dark node scripts/visual.mjs`. This uses the Playwright container, ADR-0009.
   - On the last attempt the `page /` test failed instantly (6 ms). Look at the error in the run output.
   - Note that `VISUAL_GREP` was not applied: every page ran.
4. Run the full `pnpm verify` with nothing else running. Fix failures. Tick Phase 0 in PROGRESS.md (only with proof). Then open a PR and merge it. Repeat for phases 1–3.
5. Finish Phase 4 (AC in PROGRESS.md §4). Write `apps/api/src/modules/time/routes.ts` and register it in `modules/index.ts`:
   - `GET/PUT /v1/settings/time`.
   - Rota templates, applying templates, shifts, and publishing shifts (notifies employees).
   - Open-shift claims and swaps through approvals (`approvalHandlers` / `rejectionHandlers` in `approvals/service.ts`).
   - Availability.
   - A working-time check on shift assignment, warn or block per tenant setting.
   - Clock batch sync: idempotent via `ON CONFLICT (tenant_id, employee_id, client_event_id)`. Geofence only for countries the tenant enabled, with notice text.
   - Kiosks with employee PINs: argon2 hash, `deps.limiter` rate limit and lockout.
   - Timesheets: build, submit, approve, and audited payroll CSV export.
   - 48-hour opt-out records.
   - Also: integration tests, a rota UI with a virtualised grid plus a 10k-shift benchmark, and a PWA offline clock queue.
6. Phases 5–12 per PROGRESS.md.
7. Docs from brief §9 still missing:
   - `README` (needs updating), `PERFORMANCE.md`, `COMPLIANCE.md`, API docs.
   - Runbooks: incident, backup restore, region failover, deploy.
   - DPIA, RoPA and DPA templates, and user guides.
8. `pnpm smoke:staging` and `pnpm loadtest` are declared in `package.json`, but `scripts/smoke-staging.mjs` and `scripts/loadtest.mjs` **do not exist yet**.

## Conventions that bite

- **Route handlers:**
  - Run DB work in `app.tenantTx(req, fn, {readOnly?})`.
  - Write audit entries with `app.audit(tx, req, {...})`.
  - Routes that write their own audit entries set `config: { selfAudited: true }` and `req.auditWritten = true`.
  - Check access with `requireAuth` / `authorize` / `can`.
  - Send notifications with `notify(tx, {userIds, kind, titleKey, params, link, dedupeKey})`.
- **Tenant settings** live in `app.tenants.features` jsonb, e.g. `features->'time'`.
- **Rules:**
  - Always come from `@thapsus/rules` (`book.resolve` / `tryResolve`), each with a source URL.
  - Never hardcode a statutory value.
- **i18n:** add strings to both `packages/core/src/i18n/messages/en-GB.json` and `en-US.json`. `scripts/i18n-merge.mjs` helps.
- **Time and IDs:**
  - Time maths uses `@thapsus/core/time` only (Temporal-based).
  - Composite PKs are `(tenant_id, id)`.
  - Every new table calls `app.enable_tenant_rls(...)`. The isolation suite fails otherwise.

## AWS (do not do this from the cloud agent — hand back to the owner's machine)

- **Regions:** the org SCP allows eu-west-2, eu-central-1, us-east-2, eu-west-1 and us-west-1 only. Never deploy stacks to us-east-1 or us-west-2.
- **Stacks:** the global stack goes in eu-west-2. CDK is bootstrapped in all 5 allowed regions.
- **Remaining for §10:**
  - CI OIDC stack and deploy script.
  - Staging in eu-west-2, eu-central-1 and us-east-2 within `docs/COSTS.md`.
  - `smoke:staging` in each region.
  - `loadtest` meeting brief §3, then tear down.
- Ask the owner before any production deploy, any deletion of cloud resources or data, or any cost above COSTS.md.
