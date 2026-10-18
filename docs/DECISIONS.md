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

## ADR-0080 — Privacy deadlines and retention as pack rules in their own keys; conservative date maths (2026-10-18)

**Context.** Data subject request (DSR) deadlines, breach notification deadlines and retention periods are law. They must come from the jurisdiction packs with official sources, like employment rules. Another workstream is changing the pack engine at the same time.

**Decision.** New keys live in `packages/rules/src/privacy-keys.ts` and are spread into `RULE_KEYS`: `privacy.dsr_deadline`, `privacy.breach_notification` and `retention.*`. The packs hold the values, each with its source, verification date and the reviewer `research-agent (pending legal review)`. Golden vectors are in `goldens/privacy.json`. The date maths lives in `packages/rules/src/privacy.ts`; the engine itself is unchanged. Where a statute can be read two ways, the code takes the earlier date:
- months are counted to the corresponding date;
- no rollover to the next working day is applied;
- "two further months" is the earlier of due date + 2 months and start + 3 months.

The UK has two versions: Article 12(3) until 4 February 2026, then Article 12A from 5 February 2026, which moves the clock start to the information or fee and stops the clock for clarification. California is modelled from 1 January 2023, when the CCPA employee exemption became inoperative.

**Consequences.** The deadline shown is never later than the law allows. Values from sources that could not be reached are not recorded (see ADR-0089).

## ADR-0081 — One catalog-checked map of person data drives export, erasure and coverage (2026-10-18)

**Context.** An access export must include every table about the person, and a new table must not be silently missed.

**Decision.** `apps/api/src/modules/privacy/subject-map.ts` classifies every tenant table that references a person:
- **subject columns:** rows exported in full, with credentials omitted;
- **actor columns:** exported as counts only, so other people's data is never disclosed;
- **an erasure action:** delete, anonymise or keep with a reason;
- **a retention category.**

`personColumns()` enumerates the catalog: foreign keys to `app.employees` and `app.users`, plus uuid columns named like `*_employee_id`, `*_user_id` or `*_by`. The test `apps/api/test/privacy-coverage.int.test.ts` fails when a column is not mapped. Vault values are decrypted in the export, and each decrypt is audited with its purpose. Categories the exporter may not read are withheld, and that is audited too.

**Consequences.** Every phase that adds a table referencing people must add a line to the map, or the test fails.

## ADR-0082 — Erasure semantics (2026-10-18)

**Decision.** Erasure decides per category:
- **Legal holds** block everything, or one category.
- **Statutory minimums** (`statutoryMinimum: true` in the packs) keep a category until it expires. Examples: WTR reg. 9 for time records, 29 CFR 1602.14 for US personnel records (kept while employment continues).
- **Suggested defaults and tenant policies** never block an erasure request.

When a category is erased:
- identity is **anonymised**: names, contact details, date of birth, employee number, work email and the search vector are replaced or cleared, and the user account is deactivated with an `erased.invalid` address;
- emergency contacts, credentials, sessions, documents, files and vault values are **deleted**;
- pseudonymous job and contract history is kept for workforce statistics.

The audit trail and the DSR record are kept for accountability. The deletion log (`app.retention_runs`) records categories and counts only.

**Consequences.** Erasure is safe to run for current employees in the US, where identity is kept by law. The legal reading is flagged for review (HUMAN_TODO 3.4).

## ADR-0083 — Retention engine is opt-in per category and evaluates groups of records (2026-10-18)

**Decision.** For each category, jurisdiction and record date, the sweep combines the pack rules with the tenant policy. The tenant policy can lengthen a statutory minimum but never shorten it; the API refuses a shorter period with 422 and lists the minimums. Automatic deletion runs only for categories the tenant enabled. The daily job is enqueued only when a policy is enabled. A dry run is always available, and is logged. Rows are grouped by jurisdiction, record date and employment end, so the cost grows with the number of distinct dates, not the number of rows. Leavers' personnel records are anonymised through the erasure path.

**Consequences.** Nothing is deleted without an explicit tenant decision. Statutory minimums still bind when the tenant sets a shorter period.

## ADR-0084 — Company export as a zip built with fflate 0.8.3 (2026-10-18)

**Context.** Customers can export all their data at any time.

**Decision.**
- **Format:** a background job writes `tables/<schema.table>.csv` for every tenant table (enumerated from the catalog like the tenant-move tool), `sensitive/vault-records.jsonl` (decrypted, with one audit entry per category), every stored file under the tenant prefix, `files/manifest.csv` and `manifest.json` (row counts and SHA-256 per file).
- **Omitted:** credential hashes, tokens and wrapped keys are never exported.
- **Library:** `fflate` 0.8.3 is MIT-licensed with no dependencies. It is pinned exactly and is a direct dependency of `@thapsus/api`.
- **Delivery:** the archive is stored at `<tenant>/exports/<id>.zip` in the home-region bucket and downloaded through a 300-second presigned URL.

**Consequences.** The archive is built in memory. That is fine for typical tenants, but the 200,000-employee profile needs streaming S3 multipart upload, which is a Phase 12 follow-up. Tables are read one statement at a time, not as a single snapshot, and the manifest says so.

## ADR-0085 — Account closure: grace period, guarded audit purge, verified deletion and certificate (2026-10-18)

**Decision.**
- **Scheduling:** `POST /v1/privacy/closure` (owner only) schedules deletion after `closureGraceDays` (30, pending legal review), with a cancellable job whose `run_after` is the purge time.
- **Blocking access:** the purge first sets the registry status to `closing`, which blocks sign-in and API use.
- **Audit log:** the log is purged by `audit.purge_closed_tenant()`. It is a `SECURITY DEFINER` function that refuses any tenant not `closing` with a closure in `purging`. The append-only trigger allows that delete only, and the app role still has no DELETE privilege.
- **Database:** every other tenant table is deleted children-first.
- **Files and caches:** object deletion removes all versions under the tenant prefix. Rate-limit and lockout keys are removed by prefix.
- **Verification and certificate:** each store is checked empty. A deletion certificate with counts, backup expiry, log retention and region is written to `registry.deletion_certificates`, which is allow-listed in the isolation test, and emailed to the requester from the home region.
- **Final state:** the registry and the global directory are marked `deleted`. The directory holds no personal data.
- **Worker:** the engine tolerates a tenant deleted by its own job.

**Consequences.** Backups are not edited. They expire within `backupRetentionDays`, which a unit test ties to `infra/config/*.json`, and the certificate states that window.

## ADR-0086 — Per-person export generated inline; signed local downloads in dev and test (2026-10-18)

**Context.** One person's data is bounded. Local development and e2e have no S3, and the worker would hold a separate in-memory store.

**Decision.** `POST /v1/privacy/requests/{id}/export` builds the JSON and PDF inline and stores them in the home-region object store. The `privacy.dsr_export` job does the same for automation. In dev and test only, `MemoryObjectStore` can issue HMAC-signed, 300-second URLs served by a hidden `/v1/local-objects` route. The route is never registered with S3, and it is never registered when `APP_ENV` is `prod` or `staging`.

**Consequences.** The Playwright flow downloads real files. Production behaviour (S3 presigned URLs) is unchanged.

## ADR-0087 — Trust data generated from the documents; contractual settings in configuration (2026-10-18)

**Decision.** `packages/core/scripts/trust-data.ts` generates `packages/core/src/trust/generated.json` from `docs/SUBPROCESSORS.md`, `docs/legal/privacy-notice-*.md` and `docs/legal/dpa-*.md`. That covers the sub-processor tables, a new change log, the templates and the DPA versions with hashes. `packages/core/test/trust.test.ts` fails if the file is stale, if a change gives less than the notice period, or if the backup expiry drifts from the infrastructure config. Contractual values that are Thapsus policy rather than law live in `packages/core/src/trust/legal.json`, all pending legal review: notice days, processor breach hours, grace days, reminder thresholds and retention windows. The public `/trust/subprocessors` page renders the published rows as data, with translated headings.

**Consequences.** Other phases add sub-processors in `docs/SUBPROCESSORS.md`, add a change-log row, and run `pnpm --filter @thapsus/core trust-data`. A DPA version change in `docs/legal` prompts re-acceptance. The DPA is accepted at sign-up for the home-region template, and an owner-only endpoint handles later versions.

## ADR-0088 — Incidents: controller deadlines per tenant, processor register in the back office (2026-10-18)

**Decision.** `app.incidents` is the customer's own incident and breach log. Deadlines come from `breachDeadlines()`, with day limits applied as 24-hour multiples from awareness. Thresholds are checked against the affected counts. The processor-to-controller rows are left out, because the customer is the controller. Jurisdictions without a modelled rule are listed. The Thapsus-side register is `backoffice.breach_register` and holds no personal data or tenant content. Notifying controllers opens a `processor` incident in each affected tenant of the cell and notifies its admins. Reminders are deduplicated per deadline and threshold.

## ADR-0089 — Unreachable official sources recorded as gaps, not values (2026-10-18)

**Context.** Some official sources refused automated access during research:
- `leginfo.legislature.ca.gov` returned a bot challenge;
- `ilga.gov` was unavailable;
- the official Georgia Code is hosted outside the allow-list.

`ico.org.uk` guidance is not on the validator allow-list.

**Decision.** Only what an official, allow-listed page confirmed was recorded. California's breach rule records the Attorney General sample-copy threshold, with its timing listed in `unverified`. Illinois records the individual-notice standard only. Georgia is a coverage to-do. The UK DSR rule cites legislation.gov.uk only. Each gap is in the pack's coverage notes (docs/COVERAGE.md) and in HUMAN_TODO 3.4.

**Consequences.** The UI shows "not yet recorded, check with your adviser" for those jurisdictions instead of a guessed deadline.
