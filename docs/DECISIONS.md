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

## ADR-0012 — Visual-regression server from the host's pinned playwright-core; optional local Chromium override (2026-10-18)

**Context.** `scripts/visual.mjs` started the Playwright run-server inside the official container with `npx -y playwright@<version>`, which downloads the package at run time. In sandboxed environments (and any CI runner without registry access from containers) the container has no network, so the server never started and every visual test failed with `ECONNREFUSED`. Separately, some development containers ship a pre-installed Chromium but do not allow `playwright install`.

**Decision.** The visual script mounts the host's lockfile-pinned `playwright-core` read-only into the container and runs `node /opt/playwright-core/cli.js run-server`, so the container needs no network and the server always matches the client version. Screenshots are still rendered by the container's Chromium (ADR-0009 is unchanged). The functional e2e project and the Lighthouse script accept an optional `PW_CHROMIUM_PATH` to use a pre-installed Chromium; CI keeps using `playwright install`.

**Consequences.** Visual runs are deterministic and offline-capable. Baselines are unchanged.

## ADR-0041 — Prettier enforced once the stacked phase branches are merged (2026-10-18)

**Context.** Prettier is configured (`.prettierrc.json`, `pnpm format`), but 147 files on the Phase 0 branch were never formatted. Phases 1–4 are stacked branches that touch most of those files, and several of them were being finished in parallel.

**Decision.** The repository is formatted in one commit, and `prettier --check .` is added to the verify lint step, right after Phases 0–4 are merged to `main`. That way no phase branch has to absorb a whole-repository reformat in the middle of a merge.

**Consequences.** Until then ESLint (including the hard-coded UI string rule) is the enforced style gate. After that commit, every later phase is formatted on every run.

## ADR-0042 — Shared configuration lives at the repository root (2026-10-18)

**Context.** PROGRESS 0.1 mentions "shared config packages". The shared TypeScript settings (`tsconfig.base.json`, strict mode, extended by every package), ESLint (`eslint.config.mjs` plus the custom rule in `tools/eslint`), Prettier (`.prettierrc.json`) and Vitest (`vitest.config.ts`, one config with named projects) are each defined once at the root.

**Decision.** Keep them at the root instead of wrapping each one in a `packages/config-*` workspace. A wrapper package would add indirection without a second consumer: every workspace already lives in this repository.

**Consequences.** One place to change each tool. If an external package ever needs them, they can be published as a `@thapsus/config` package then.

## ADR-0043 — Per-region GitHub OIDC deploy roles and a single deploy script (2026-10-18)

**Context.** The deploy workflow called a `scripts/deploy.mjs` that did not exist, and the OIDC stack that HUMAN_TODO told the owner to deploy did not exist either. The global stack and the UK cell both created a secret named `thapsus-hr/<env>/internal-token` in eu-west-2, so the second deploy would have failed (synth cannot catch that).

**Decision.**
- `ThapsusHr-<env>-ci` creates the GitHub OIDC provider and one role per deploy region. Each role is trusted only for `repo:<owner>/<repo>:environment:<staging|production>`. It may only assume that region's CDK bootstrap roles and, in cell regions, run the post-deploy steps.
- The single documented cross-region permission is reading the global internal service token, which is not personal data.
- `scripts/deploy.mjs` (planner in `scripts/deploy-plan.ts`, unit-tested) deploys in dependency order and runs the post-deploy steps. It refuses us-east-1 and us-west-2, refuses credentials for the wrong region, and refuses production without explicit approval.
- Cells now keep their copy of the token as `thapsus-hr/<env>/<cell>/internal-token`. An infra test fails if two stacks create a same-named secret in one region.

**Consequences.** CI needs only `AWS_ACCOUNT_<env>` variables. Deploys are repeatable from a workstation with `--dry-run` first.

## ADR-0044 — `pnpm dev` passes the caller's environment through Turborepo (2026-10-18)

**Context.** Turborepo 2 runs tasks in strict environment mode, so variables set by the caller (for example a different `DATABASE_URL`) were silently dropped, and the apps fell back to `.env`.

**Decision.** The dev script runs `turbo run dev --env-mode=loose`. Builds and other cached tasks keep strict mode.

**Consequences.** Local dev and the dev smoke check (`scripts/dev-smoke.mjs`, a verify step) honour explicit environment overrides.
