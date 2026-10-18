# Architecture decision records

Dated records of implementation choices, especially where they differ from the defaults in `docs/BUILD_BRIEF.md`. Newest last. Format: context → decision → consequences.

---

## ADR-0001 — AWS regions constrained by the organisation SCP (2026-10-18)

**Context.** The staging account (`247115937622`) sits in an AWS Organization whose service control policy (`p-muwhpaps`, set from the management account) first denied every regional API. The product owner then relaxed it. Workloads are now allowed in eu-west-2, eu-central-1, us-east-2, eu-west-1 and us-west-1. In us-east-1 only global services are allowed, and us-west-2 is blocked for workloads. The brief's original backup map sent US backups to us-west-2, and the usual home for CloudFront certificates and global stacks is us-east-1.

**Decision.** The product owner set these rules on 2026-10-18:
- Home regions are unchanged: UK = eu-west-2, EU = eu-central-1, US = us-east-2.
- Backup copies: EU → eu-west-1, **US → us-west-1** (was us-west-2), UK → none (London only, across AZs).
- The **global stack runs in eu-west-2**. That covers the tenant directory, region-aware sign-in, the marketing site and billing.
- **No CloudFormation stacks in us-east-1 or us-west-2.** Anything that genuinely needs us-east-1 is not worked around. Examples are an ACM certificate for a CloudFront distribution, or a CloudFront-scoped WAF web ACL. Such items go in `docs/HUMAN_TODO.md`.
- CDK is bootstrapped in the five allowed regions only.

**Consequences.** `packages/core/src/regions.ts` is the single source of the map. The unit tests, the residency matrix and the CDK assertions enforce it. BUILD_BRIEF.md, CLAUDE.md and PROGRESS.md were updated to say us-west-1. The marketing site is served from the eu-west-2 global stack behind a regional ALB. Putting CloudFront in front of it needs a us-east-1 certificate, which is a human step in HUMAN_TODO.md.

---

## ADR-0002 — SQL-first migrations and node-postgres instead of Drizzle ORM (2026-10-18)

**Context.** The brief's default is Drizzle ORM. The data layer leans on PostgreSQL features that ORMs model poorly: forced Row Level Security with per-transaction `set_config`, composite tenant-leading keys, exclusion constraints for effective dating, `SECURITY DEFINER` functions with tightly scoped roles, a hash-chained audit trigger and `COPY` for bulk loads of 200,000 rows.

**Decision.** Migrations are hand-written SQL files in `packages/db/migrations`, applied by a small checksum-tracked migrator. A lint enforces expand-and-contract: destructive statements need a `-- contract:` header. Queries use `pg` through a thin typed `Tx` wrapper, always inside `withTenant()`.

**Consequences.** We get full control of RLS, constraints and query plans, and fewer abstractions to keep in sync. There is no generated schema typing; row types are declared next to the queries. The catalog-driven isolation suite keeps new tables honest.

---

## ADR-0003 — Authentication built on maintained protocol libraries instead of Better Auth (2026-10-18)

**Context.** The brief suggests a library such as Better Auth. Our requirements cut across a generic auth library: all identity data must be tenant-scoped under forced RLS in the home region; idle and absolute session timeouts and lockout thresholds are per tenant; admins must be refused until MFA is verified; SSO can be enforced per tenant; and SCIM must provision into the same RLS-protected tables.

**Decision.** A thin auth module built on maintained, audited libraries: `@node-rs/argon2` (Argon2id), `otpauth` (TOTP), `@simplewebauthn/server` (passkeys), `openid-client` (OIDC), `@node-saml/node-saml` (SAML 2.0) and `jose`. Sessions are opaque random tokens; only their SHA-256 is stored. Tokens embed the tenant id, so the tenant context is set before the lookup. Each user belongs to exactly one tenant. "Find my workspace" uses a `SECURITY DEFINER` function owned by a NOLOGIN role that can read only `(tenant_id, email, status)`.

**Consequences.** We own the session and flow code, and the integration tests cover it. Crypto and protocol parsing stay in maintained libraries. A person in two companies has two accounts, which is the common pattern for employer-controlled HR identities.

---

## ADR-0004 — Audit hash chain sealed asynchronously (2026-10-18)

**Context.** Hash-chaining at insert time needs a per-tenant lock held until commit. That serialises every mutating transaction in a tenant, which is incompatible with 20,000 clock-ins in 10 minutes.

**Decision.** Rows are inserted unsealed. `audit.seal_pending()` assigns a per-tenant sequence and SHA-256 chain in id order. It runs from the worker every few seconds and before every export or verification. A trigger blocks UPDATE, DELETE and TRUNCATE for every role, the owner included. The one exception is the sealing function filling `seq`, `prev_hash` and `hash` on rows not yet sealed. The app role has no UPDATE or DELETE privilege at all.

**Consequences.** Writers never contend. Tampering with sealed rows is detected by `audit.verify_chain()`. The window in which a row is unsealed is seconds, and even then the row is protected by privileges and the trigger.

---

## ADR-0005 — Local emulators (2026-10-18)

**Context.** MinIO no longer publishes container images.

**Decision.** Local dev uses `adobe/s3mock` for S3, ElasticMQ for SQS, Mailpit for email, Valkey and Postgres 17. The KMS mock is an in-process AES-256-GCM key wrapper (`LocalKeyProvider`) behind the same `KeyProvider` interface as AWS KMS.

**Consequences.** All emulators are permissively licensed and lightweight enough for a 4 GB development machine.

---

## ADR-0006 — PostgreSQL-backed job queue; EventBridge for fan-out (2026-10-18)

**Context.** The brief lists SQS and EventBridge for events and jobs. Every job must run inside the tenant's own RLS context, record progress, and be idempotent by key. It must also move with the tenant when the tenant moves to a dedicated database.

**Decision.** Jobs live in `app.jobs` with a unique `(tenant_id, kind, idempotency_key)`. They are claimed with `FOR UPDATE SKIP LOCKED`, retried with exponential backoff and marked failed after N attempts. Workers find work through `registry.work_signals`, so they never scan tenant data. Domain events go to the transactional outbox, then to in-process subscribers (in the same transaction), then to the regional EventBridge bus, carrying only identifiers. SQS queues with DLQs are provisioned for webhook delivery and external consumers. Periodic work, such as future-dated changes, reminders and escalations, is enqueued idempotently per tenant and per date or slot by the worker's scheduler sweep, which EventBridge Scheduler also triggers.

**Consequences.** One transactional system of record for job state and progress. Jobs and outbox move with the tenant. SQS is not on the critical path.

## ADR-0007 — Effective-dating semantics (2026-10-18)

**Decision.** Records cover half-open `[valid_from, valid_to)` ranges and exclusion constraints forbid overlaps. A change at date D splits the record that covers D. A change on a record's own start date corrects it in place. A change dated before an existing future record propagates the changed fields into later records **only where they still hold the old value**; values a later record changed explicitly are kept. `app.employees` holds denormalised current values, refreshed after each write and by a daily idempotent job for future-dated changes.

## ADR-0008 — Motion with CSS and IntersectionObserver instead of the Motion library (2026-10-18)

**Context.** The brief's default is Motion for animation. The Lighthouse target of ≥90 mobile performance on low-cost phones makes JavaScript weight matter.

**Decision.** Scroll reveals and the sticky feature showcase use CSS transitions driven by `IntersectionObserver`, and app transitions use CSS. Durations come from the motion tokens and drop to 0 under `prefers-reduced-motion`. Motion can be added later for a specific interaction if CSS cannot achieve it.

## ADR-0009 — Visual regression rendered in the official Playwright Linux container (2026-10-18)

**Decision.** Screenshot tests drive a Chromium that runs in `mcr.microsoft.com/playwright:v<version>-noble` via `playwright run-server`, while the app runs on the host. Baselines are therefore identical on Windows, macOS and Linux CI. Inter is self-hosted, so the fallback font is the same everywhere.

## ADR-0010 — Jurisdiction rule data researched by agents against official sources (2026-10-18)

**Decision.** Pack values were gathered by research agents that fetched official sources. Each value records its URL, a `verifiedOn` date and the reviewer `research-agent (pending legal review)`. Golden vectors were copied from official dated lists where they exist (gov.uk bank holidays JSON, OPM, the German BALM 2026 list, Service-Public, BOE, citizensinformation.ie). Where no official dated list exists, the vector says it was derived from the statute. The US rule goldens repeat the pack values, so they test the engine rather than independently verify the values; only the US holiday goldens are independent. Legal review of every pack is a human step (HUMAN_TODO.md). Values that could not be verified from an allow-listed official source were left out and listed as coverage to-dos rather than filled from memory.

## ADR-0011 — Back-office staff accounts per regional cell (2026-10-18)

**Decision.** Thapsus staff accounts, sessions and the staff audit trail live in each cell's `backoffice` schema and are reached only through the `thapsus_backoffice` role. Staff sign in with a password and a mandatory TOTP code. Back-office rule edits are append-only `backoffice.rule_versions` rows layered over the pack data, and the newest edit wins where periods overlap. Staff reach tenant personal data only through customer-granted support access (ADR-0003 and SECURITY.md).

## ADR-0012 — Visual-regression server from the host's pinned playwright-core; optional local Chromium override (2026-10-18)

**Context.** `scripts/visual.mjs` started the Playwright run-server inside the official container with `npx -y playwright@<version>`, which downloads the package at run time. In sandboxed environments (and any CI runner without registry access from containers) the container has no network, so the server never started and every visual test failed with `ECONNREFUSED`. Separately, some development containers ship a pre-installed Chromium but do not allow `playwright install`.

**Decision.** The visual script mounts the host's lockfile-pinned `playwright-core` read-only into the container and runs `node /opt/playwright-core/cli.js run-server`, so the container needs no network and the server always matches the client version. Screenshots are still rendered by the container's Chromium (ADR-0009 is unchanged). The functional e2e project and the Lighthouse script accept an optional `PW_CHROMIUM_PATH` to use a pre-installed Chromium; CI keeps using `playwright install`.

**Consequences.** Visual runs are deterministic and offline-capable. Baselines are unchanged.

## ADR-0013 — Lettered migrations; USAGE (not CREATE) on schema public (2026-10-18)

**Context.** Phase 1 fixes need migrations after `0007` but before Phase 2's `0008`. The loader only accepted `\d{4}_name.sql`, so a file named `0007b_…` would have been skipped without any error. Separately, trigram word similarity (`<%`) failed for the application role: extensions live in schema `public`, on which 0001 revoked everything from PUBLIC, so extension operators did not resolve. `citext` comparisons from the app role were silently falling back to case-sensitive `text` equality for the same reason.

**Decision.** The loader accepts an optional lowercase letter after the number (`0007b_…`); ASCII order puts it between `0007_…` and `0008_…`. A unit test proves both the order and that every repository migration is loaded and passes the expand-and-contract lint. Migration 0007g grants `USAGE` (never `CREATE`) on `public` to the three application roles. The isolation suite asserts USAGE without CREATE, and that `schema_migrations` stays unreadable. Where a migration must fix data in a table with forced RLS, it lifts `FORCE` only inside its own transaction, which holds an exclusive lock. Only the owner is affected, because the application role never owns tables.

**Consequences.** Email lookups through `citext` columns are now case-insensitive for the app role, as the schema intended. Later lettered files must keep the `\d{4}[a-z]?_` shape.

## ADR-0014 — Emergency contacts are effective-dated by priority slot (2026-10-18)

**Decision.** Each contact row has `[valid_from, valid_to)`. An exclusion constraint on (employee, priority, period) means each slot (1, 2, …) holds one contact on any date, so "the list on date D" is well defined. `PUT /v1/employees/:id/emergency-contacts?effectiveDate=D` replaces the list in force from D. Contacts that cover D are closed on D, or replaced if they start on D. The new list runs until the next future-dated list, which is kept. `GET` takes `?asOf=`, and `/history` includes contacts. Rows from before this change start at `-infinity`. Earlier releases allowed duplicate priorities, so 0007b renumbers them before adding the constraint.

## ADR-0015 — Document folder visibility rules (2026-10-18)

**Decision.** Folder visibility controls lists and downloads in exactly the same way. A shared SQL predicate and a matching row check implement it, and one test exercises both against every visibility.

| Folder | Document about a person | Company document |
| --- | --- | --- |
| none | the person, and whoever may read their documents (managers, HR) | HR (`documents.manage`) |
| `employee` | the person, managers, HR | everyone signed in |
| `managers` | managers and HR, **not** the person (e.g. manager notes) | anyone with `documents.read`/`manage` |
| `hr` | HR who manage that person's documents only | HR |
| `everyone` | everyone signed in | everyone signed in |

Without HR rights, a person may only file their own upload in no folder, an `employee` folder or an `everyone` folder, so they can still see it afterwards.

## ADR-0016 — Exports of list views (2026-10-18)

**Decision.** `/v1/exports/{employees,tasks,approvals,documents}?format=csv|xlsx` uses the same query functions as the list endpoints (`employeeListWhere`, `listTasks`, `listApprovals`, `listDocuments`), so an export contains exactly the rows the list shows the caller. The people export accepts the same filters as the list and blanks any column the caller cannot read, row by row. Approval exports name the changed fields but never their values; approvers see values in the app, but a file can travel. Exports need `exports.run` because bulk data leaves the product. They are capped at 10,000 rows (beyond that: a background report) and audited as `export.<list>`. List rows now carry the full manager chain for team-scoped callers, as `loadTarget` does, so a skip-level manager sees the same fields in the list, the export and the profile.

## ADR-0017 — Pre-start portal, invitations and person-assigned tasks (2026-10-18)

**Decision.**
- `POST /v1/employees/:id/invite` (`users.invite`, in scope) gives a person a self-service sign-in linked to their employee record. The address defaults to work email, then personal email. The optional extra role is limited to `manager`; admin roles are assigned through role settings, which require MFA. The person is emailed a one-time link from the home region, valid for 7 days, using the magic-link mechanism. When the tenant enforces SSO, the email points to the sign-in page instead. Re-inviting sends a new link and keeps the account.
- Workflow tasks for the joiner or their manager record `assignee_employee_id` (migration 0007e). Tasks created before the person can sign in are handed to them when they are invited. `GET /v1/me/onboarding` and `/app/welcome` show documents to sign, two built-in forms (personal details, emergency contact) and the joiner's own checklist, with progress. Before the start date, form answers are effective from the start date, because the records begin then.
- Each task stores `reminder_days_before` from its template. Previously the field was accepted and then ignored. The reminder job sends one due-soon reminder at that lead time (default 2 days) and one overdue reminder.
- `MAIL_TRANSPORT=file` writes emails as JSON files for local development and e2e tests (to follow links). It is refused outside `dev` and `test`.

**Consequences.** Configurable portal forms (beyond the two built-ins) are future work. The e2e stack runs no worker, so the portal e2e test starts the workflow explicitly.

## ADR-0018 — Dispatching "call integration" automation actions (2026-10-18)

**Decision.** The action emits `integration.requested` to the outbox, as before. A subscriber now records an `app.integration_calls` row, one per event, which is the execution log. It also enqueues an idempotent `integrations.dispatch` job, which runs the handler registered for that integration id and stores the result (`GET /v1/automation/integration-calls`). Later phases register connectors in the same registry. Two handlers are built in:
- `log` makes no external call.
- `http` POSTs identifiers only (rule, event, employee id, date) as JSON to a public `https` URL. It is signed with a per-tenant HMAC key derived from `INTEGRATION_SIGNING_KEY`. If that key is not configured, the handler refuses to run rather than signing with a placeholder (webhooks still do).

Rules are validated when saved. Unknown integrations are rejected, as are non-https, loopback, private, link-local and internal targets (for webhooks too). Redirects are not followed. External calls are mocked in tests.

**Consequences.** Infrastructure must generate `INTEGRATION_SIGNING_KEY` per cell in Secrets Manager and inject it into the API and worker. Customers need a way to see their derived key, and webhook signing should move to the same key; both are follow-ups. The customer endpoint is chosen by the controller and receives no personal data beyond identifiers, so it is not a Thapsus sub-processor.

## ADR-0019 — Bulk import at 200,000 rows (2026-10-18)

**Context.** The import job made about 15 sequential statements per row and 5 per manager link: 2,000 rows took 55 s. It ended with a tenant-wide refresh whose `UPDATE … FROM` self-join planned as a quadratic nested loop: 20,000 people took 160 s, above the 30 s statement timeout. Right after a bulk insert, planner statistics still describe the tenant as tiny, so set-based joins picked whole-table scans per row.

**Decision.**
- New people are created per 500-row chunk with one `INSERT … SELECT FROM unnest` per table, grouped by the set of fields present. Existing people are compared with a bulk read of the values in force; numbers compare numerically, so `30` equals `30.00` and re-imports stay idempotent. Any constraint failure in a chunk rolls back to a savepoint and replays that chunk row by row, which gives exact row errors. Duplicate numbers in a file, updates, and rows without required fields always take the row-by-row path.
- Manager links for people without a reporting line are inserted in bulk. The current manager is kept up to date as links are written. An in-memory check plus a SQL check (both covering links to existing people) send any cycle to the per-row path, which rejects it with a row error. This also fixes a gap where two rows naming each other could create a cycle, because `assertNoCycle` reads current managers that the import had not refreshed.
- `app.refresh_employees_current(ids[])` (0007h) is a correlated per-row UPDATE and runs in linear time. `refresh_employee_current` keeps its contract on top of it. The job refreshes only the people it wrote, 2,000 at a time.
- After 1,000 or more creates, the job calls `app.analyze_core_hr()` (0007i). It is a parameterless `SECURITY DEFINER` function with a fixed table list, executable only by the app role. The isolation suite allow-lists definer functions.

**Consequences.** See `docs/PERFORMANCE.md` for 200,000-row timings. The validation preview still reads the whole file in the request (a few seconds at 200,000 rows). Moving the preview to a job is future work if files grow further.
