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
