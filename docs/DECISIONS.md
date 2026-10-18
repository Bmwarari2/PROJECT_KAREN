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

---

## ADR-0060 — Payroll connectors render one canonical, snapshotted input set (2026-10-18)

**Context.** Brief §6.5 asks for exports of hours, absences, sick pay data, pay changes, starters and leavers through per-tenant field mappings, and for a closed period's export to be reproducible. Connectors differ (files, APIs), and live HR data keeps changing after payroll has run.

**Decision.**
- Every connector receives the same canonical `PayrollInputs` document, built in `apps/api/src/modules/payroll/inputs.ts`. Its arrays are sorted, it holds no timestamps of "now", and it contains only people who appear in a section.
- Closing a pay period stores that document in the append-only `app.pay_period_snapshots` table, with the SHA-256 of its canonical JSON (keys sorted). A trigger blocks updates, and closed periods cannot be reopened or moved.
- Exports of a closed period are rendered only from the snapshot, after an integrity check against that hash.
- Renderers pin every archive timestamp to the period end. Zips and Excel workbooks are re-packed with fixed entry dates and order.
- Each export records the file hash, the inputs hash and the connector configuration hash.
- Field mapping is a validated, typed list of columns per section, with a closed field catalogue and a small transform set: date, number, hours or minutes, money, code map, boolean, case and fixed values.

**Consequences.**
- The same closed period with the same connector configuration produces byte-identical files, which the tests prove with SHA-256.
- A changed mapping produces a different file, and its configuration hash shows why.
- Corrections go into the next period rather than mutating a closed one.
- No field outside the catalogue can leave through a connector.

## ADR-0061 — Attribution of hours, absences and SSP to pay periods (2026-10-18)

**Context.** Timesheets are weekly. Pay periods can be monthly, and leave can straddle a period boundary.

**Decision.**
- **Hours**: an approved timesheet belongs to the period that contains its week start. Weeks are never split.
- **Absences**: approved leave of any type overlapping the period is clipped to the period. Working days are recalculated for the clipped part with the leave engine (pattern and public holidays).
- **Sick pay**: UK SSP for the period is the difference between cumulative SSP to the period end and cumulative SSP to the day before the period start, using the GB pack rule `sick_pay.statutory` in force at the period end. The pack's pre-April-2026 flat-rate shape is adapted for the engine, and the lower earnings limit is applied when the pack has one. Other jurisdictions' sick pay is exported as absences only until their packs are modelled.

**Consequences.** Payroll teams on monthly calendars get each week once, with no fractional weeks. SSP follows the pack's effective-dated values and source URL.

## ADR-0062 — Delivery transports: presigned download, pinned-key SFTP (ssh2) and API push (2026-10-18)

**Context.** Exports must be delivered by download, SFTP or API, safely and idempotently.

**Decision.**
- **Download** returns a five-minute presigned link to the home-region bucket and writes a delivery-log row.
- **SFTP** uses `ssh2` 1.17.0 (MIT, maintained). Its optional native crypto builds are denied in `pnpm-workspace.yaml`, and minimal local typings replace `@types/ssh2` (which pulls `@types/node@18`).
  - The server host key is always pinned with an OpenSSH `SHA256:` fingerprint.
  - Private, loopback, link-local and CGNAT destinations are refused outside dev and test. The host is resolved once and connected by address.
  - Files are written as `.name.part` and renamed into place.
- **API push** goes through the connector's `push`. It sends a per-record `Idempotency-Key` and skips items an earlier delivery of the same export already completed.
- All transports run as idempotent jobs keyed by the delivery id.
- Permanent failures (host key, authentication, not connected) are recorded without retry. Transient ones throw, so the worker retries.

**Consequences.** Re-deliveries never duplicate payroll records and never write half files. The SFTP path is tested against an in-process ssh2 server.

## ADR-0063 — Integration secrets: one KMS envelope per integration, outbound host allow-list (2026-10-18)

**Context.** OAuth refresh tokens, client secrets, service-account keys and SFTP credentials must never sit in plaintext columns or logs. Personal data may go only to destinations listed in SUBPROCESSORS.md.

**Decision.**
- **Secrets**:
  - `app.integration_credentials` stores one sealed envelope per integration. It uses the existing envelope scheme (a fresh data key wrapped by the regional KMS key), with the AAD bound to tenant and owner.
  - The API returns only the names of the configured secrets, and audit entries record names only.
  - Rotated OAuth refresh tokens (Xero) are re-sealed on every use.
  - Reporting roles cannot read the table.
- **Outbound calls** go through `integrationRequest`, which:
  - allows HTTPS only to an allow-list of hosts, each of which must appear in SUBPROCESSORS.md (a unit test checks this);
  - never follows redirects and times out;
  - reduces provider error bodies to an error code.
- The customer-controlled SFTP host is the one exception, guarded as in ADR-0062.

**Consequences.** A new integration cannot send data until it is listed in SUBPROCESSORS.md. Secrets cannot be exfiltrated through the API, the audit log or logs.

## ADR-0064 — Payslips are restricted documents outside the document library (2026-10-18)

**Context.** The general document library lets managers and HR read employee documents in scope. Payslips and year-end tax forms should be visible only to the employee and payroll.

**Decision.**
- Payslip batches and files live in their own tables (`app.payslip_batches`, `app.payslips`), not in `app.documents`.
- Only the employee (`payslips.read_own`) and payroll roles (`payslips.read`, `payslips.manage`) can list or download them. Every download is audited as sensitive.
- Matching uses whole employee-number tokens in file names, or a customer regex with an `employeeNumber` group. Several matches are "ambiguous" and are never guessed.
- Zip entries are inflated with a hard byte limit, because zip header sizes can lie.

**Consequences.** Managers and the document library never expose pay data. A mismatched file stays unpublished until someone matches it by hand.

## ADR-0065 — Joiner and leaver automation: exact dry-run plan, idempotent per-call log, conservative matching (2026-10-18)

**Context.** Brief §6.6 asks for Microsoft 365 and Google Workspace account automation with per-customer admin consent, least privilege, a dry-run preview and an audit log.

**Decision.**
- **Plans**: a pure plan builder (`apps/api/src/modules/it/plan.ts`) turns the employee and the customer's mapping rules into the exact provider calls. The dry run returns that plan. Execution stores the same calls, one row each in `app.it_operations` with an idempotency key, and runs them. Only the generated one-time password (never stored or logged) and the new account id are filled in at run time.
- **Microsoft 365** uses Entra admin consent to a multi-tenant app, or the customer's own app, with the least-privilege application permissions listed per call.
- **Google Workspace** uses domain-wide delegation for a service account with four narrow scopes, via an RS256 JWT bearer grant (`jose`).
- **Triggers**: outbox events `employee.created` and `employee.terminated` schedule jobs:
  - joiners run a configurable lead time before the start date (default 3 days);
  - leavers run at the end of the last working day in the employee's zone, or immediately;
  - hires backdated by more than 7 days are never provisioned automatically, which protects imports of existing staff.
- **Safety**:
  - Joiner chains stop at the first failure.
  - Leaver steps each run regardless, so sign-in is blocked even if licence removal fails.
  - An existing account is adopted only if it carries the same employee number.
  - A leaver with no Thapsus-created account and no matching work email is skipped, not matched to a generated name.
- **Attributes** (job title, department, country) are resolved as of the start date for future joiners.

**Consequences.**
- Previews are trustworthy: the tests assert that the executed requests equal the preview.
- Re-runs never repeat completed calls.
- Privileged-user disabling in Entra may also need an admin role on the app; this is documented, not granted by default.

## ADR-0066 — Asset return tasks join the offboarding workflow through a start hook; dev downloads via signed local links (2026-10-18)

**Context.** The asset return checklist must be tied to offboarding. Separate outbox subscribers for workflows and assets would race, because jobs created in the same transaction have equal timestamps. Separately, the in-memory object store used in dev and e2e returned `memory://` links that a browser cannot open.

**Decision.**
- **Return tasks**: `workflows/service.ts` gains `workflowStartHooks`, which run in the transaction that starts a workflow. The asset register adds one return task per issued asset to an offboarding instance:
  - source `workflow`, so the instance completes when everything is done;
  - deduplicated per assignment;
  - assigned to `features.assets.returnAssigneeRole` (default `hr_admin`);
  - due on the leave date.
- **Return**: recording a return needs every checklist item ticked (or the asset marked lost) and completes the task.
- **Handover sign-off**: the employee acknowledges in person. The record holds the server time, user, IP, user agent and the version key of the statement shown (`assets.ackStatement.v1`).
- **Dev and test downloads**: the memory store can sign five-minute HMAC download links served by a hidden `/v1/dev/objects` route. The route is registered only in dev and test, and production keeps S3 presigned URLs.

**Consequences.**
- Return tasks appear whether the workflow starts automatically or by hand.
- A sign-off can be proven later.
- Browser downloads work in local dev and e2e without an S3 emulator.
