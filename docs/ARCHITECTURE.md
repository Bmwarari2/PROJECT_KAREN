# Architecture

Thapsus-HR runs as three independent regional **cells** (UK, EU, US) and one small **global layer**. A customer's personal data lives only in its home cell. The global layer only knows which region a workspace lives in.

## 1. Regions and data residency

```mermaid
flowchart LR
  subgraph Global["Global layer — eu-west-2 (no employee personal data)"]
    DIR[(Tenant directory\nDynamoDB: id, slug, region,\nstatus, plan, verified domains)]
    GAPI[Global API\nresolve + find-workspace fan-out]
    MKT[Marketing site]
  end
  subgraph UK["UK cell — eu-west-2"]
    UKAPP[web · api · worker]
    UKDB[(Aurora PostgreSQL\nRLS per tenant)]
  end
  subgraph EU["EU cell — eu-central-1"]
    EUAPP[web · api · worker]
    EUDB[(Aurora PostgreSQL)]
  end
  subgraph US["US cell — us-east-2"]
    USAPP[web · api · worker]
    USDB[(Aurora PostgreSQL)]
  end
  EUB[(Backup copy\neu-west-1)]
  USB[(Backup copy\nus-west-1)]
  EUDB -. AWS Backup copy .-> EUB
  USDB -. AWS Backup copy .-> USB
  GAPI --> DIR
  GAPI -- find-workspace (email in transit only) --> UKAPP & EUAPP & USAPP
  UKAPP -- register slug/region --> DIR
```

| Home region | AWS region               | Backup copy                                   |
| ----------- | ------------------------ | --------------------------------------------- |
| UK          | eu-west-2 (London)       | none — London only, across availability zones |
| EU          | eu-central-1 (Frankfurt) | eu-west-1 (Ireland)                           |
| US          | us-east-2 (Ohio)         | us-west-1 (N. California)                     |

The map lives in one module (`packages/core/src/regions.ts`). It is enforced by:

- **AWS SDK clients:** the residency-guarded factory refuses any region except the home region, plus the backup region for backup tooling.
- **Startup:** each service checks every configured endpoint (database, cache, bucket, queues, KMS, logs, backup vaults) and refuses to start if one points outside its region.
- **Router:** the tenant router treats a tenant homed in another region as unknown.
- **Tests:** CDK assertions check every stack's region and backup copy rules, and the residency test matrix covers all six region pairs.
- **Organisation SCP:** CloudFormation is never deployed to us-east-1 or us-west-2 (ADR-0001).

Authenticated pages and API responses carry `Cache-Control: private, no-store` and are served directly by the cell's load balancer. There is no CDN in front of them.

## 2. A cell

```mermaid
flowchart TB
  user((Browser / PWA\nAPI client / IdP)) --> WAF[AWS WAF] --> ALB[ALB · TLS]
  ALB -- "/v1 /scim /global" --> API[api · Fastify\nECS Fargate, autoscaling]
  ALB -- "/*" --> WEB[web · Next.js\nECS Fargate]
  API --> PROXY[RDS Proxy] --> AUR[(Aurora PostgreSQL\nwriter + reporting reader\nMulti-AZ)]
  API --> VK[(ElastiCache Valkey\nrate limits)]
  API --> S3[(S3 files\nSSE-KMS, versioned)]
  API --> KMS[KMS\ndata key + vault key]
  API --> SES[SES]
  WORKER[worker\noutbox · jobs · audit sealing] --> PROXY
  WORKER --> EB[EventBridge bus] --> SQS[SQS + DLQ]
  SCHED[EventBridge Scheduler] --> WORKER
  AUR -. continuous PITR + daily .-> BK[AWS Backup vault]
  API & WEB & WORKER --> CW[CloudWatch logs · X-Ray via ADOT\n(personal data scrubbed)]
```

## 3. Data layer

- **Tenancy:** every tenant-scoped table has `tenant_id`, composite primary keys `(tenant_id, id)`, composite foreign keys (rows cannot point across tenants), and RLS that is enabled **and forced**. One policy, `tenant_id = app.current_tenant()`, applies to every command.
- **Tenant context:** `withTenant()` sets `app.tenant_id` with `set_config(..., true)`, so the setting is transaction-local and safe with RDS Proxy pooling. The app connects as `thapsus_app`, which has no `BYPASSRLS` and owns no tables.
- **Routing:** `registry.tenants.db_key` plus the configured database map send a tenant to the shared database or a dedicated one. Moving a tenant uses `packages/db/src/move-tenant.ts` and needs no code change (runbook: `docs/runbooks/move-tenant-to-dedicated-db.md`).
- **Effective dating:** core HR records use `[valid_from, valid_to)` with exclusion constraints. `app.employees` holds denormalised _current_ values for fast lists and search at 200,000 rows; a daily idempotent job refreshes them for future-dated changes.
- **Audit:** `audit.events` is append-only. Privileges and a trigger block changes, and asynchronous sealing builds a per-tenant SHA-256 chain (ADR-0004).
- **Sensitive data vault:** `vault.records` holds envelope-encrypted values with per-value data keys wrapped by the regional KMS vault key. The AAD binds each value to its tenant, subject, category and field. Every decrypt is audited.
- **Reporting reader:** reports and data exports run in read-only transactions on the Aurora reader endpoint as `thapsus_reporting` (SELECT only, no BYPASSRLS, no vault or credential tables), with the same tenant context and forced RLS. Reader URLs are per database key in the routing config; a key without a reader falls back to its own writer (ADR-0071).
- **Outbox:** domain events are written in the same transaction as the change. The worker dispatches them to in-process subscribers and EventBridge, exactly once per event id.

## 4. Services and packages

| Path             | Role                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web`       | Next.js App Router: marketing site, app (installable PWA), sign-in and sign-up                                                                                                 |
| `apps/api`       | Fastify, OpenAPI 3.1 (`packages/sdk/openapi.json`), auth (password, TOTP, passkeys, magic links, OIDC/SAML SSO), SCIM 2.0, domain modules, global mode (`SERVICE_ROLE=global`) |
| `apps/worker`    | Outbox dispatch, idempotent jobs with progress and retries, audit sealing, scheduled sweeps                                                                                    |
| `packages/core`  | Regions, residency guard, time (Temporal), money (integer minor units), i18n catalogues and formatters, permission engine, PII scrubber, logger, tracer                        |
| `packages/db`    | SQL migrations, tenant context, router, audit and outbox helpers, tenant move tool                                                                                             |
| `packages/rules` | Jurisdiction packs (versioned, effective-dated, sourced rule data, golden tests)                                                                                               |
| `packages/ui`    | Design tokens (generated Tailwind theme) and components                                                                                                                        |
| `packages/sdk`   | Published OpenAPI document and TypeScript SDK                                                                                                                                  |
| `infra`          | AWS CDK: cell, global and backup copy vault stacks                                                                                                                             |

Customer-directed integrations (payroll connectors, SFTP, Xero, Microsoft 365, Google Workspace), payslip publishing and the asset register are described in [integrations.md](integrations.md): data flows, scopes, credentials and logs.

## 5. Sign-in routing

```mermaid
sequenceDiagram
  participant U as User
  participant G as Global API (eu-west-2)
  participant C as Home cell
  U->>G: resolve(slug or email domain)
  G-->>U: region + regional app URL (from directory)
  U->>C: sign in (password / passkey / SSO / magic link)
  C-->>U: session cookie (tenant id + random token, hash stored)
  Note over U,C: A request for a tenant at the wrong cell is refused (421) with the right URL — no tenant data is read.
```

"Find my workspace" fans out from the global API to every cell. Each cell looks up the email with a narrowly scoped `SECURITY DEFINER` function that returns tenant ids only, then emails the user from its own region. The global layer stores nothing.

## 6. Delivery pipeline

```mermaid
flowchart LR
  PR[Pull request] --> CI[GitHub Actions CI\npnpm verify]
  CI -->|merge to main, green| D[Deploy workflow]
  D -->|OIDC, no keys| R1[thapsus-hr-env-deploy-eu-west-1]
  D --> R2[thapsus-hr-env-deploy-us-west-1]
  D --> R3[thapsus-hr-env-deploy-eu-west-2]
  D --> R4[thapsus-hr-env-deploy-eu-central-1]
  D --> R5[thapsus-hr-env-deploy-us-east-2]
  R1 --> BC1[backup-copy-eu]
  R2 --> BC2[backup-copy-us]
  R3 --> GL[global] --> UK[cell-uk]
  R4 --> EU[cell-eu]
  R5 --> US[cell-us]
  PROD{{production environment\nmanual approval}} -.-> D
```

`ThapsusHr-<env>-ci` holds the GitHub OIDC provider and one deploy role per region. Each role:

- is trusted only by this repository's matching GitHub environment;
- can only assume that region's CDK bootstrap roles;
- in cell regions, can also run the post-deploy steps.

`scripts/deploy.mjs` runs each target in dependency order: backup copy vaults, then global, then the cells. For each cell it runs `cdk deploy`, copies the internal token, fills the key material, runs the migrator task, restarts the services and checks health. Production refuses to run without explicit approval (ADR-0043).

## 7. Privacy operations

- **Data subject requests** (`apps/api/src/modules/privacy`):
  - Deadlines are computed from the jurisdiction packs for the person's jurisdiction (a US state where known, otherwise the country, then the home-region regime).
  - The table map in `subject-map.ts` drives the access export (JSON plus PDF, stored under `<tenant>/privacy/dsr/<id>/` in the home-region bucket) and erasure. A catalog test keeps the map complete.
- **Retention:** a daily job applies enabled tenant policies over the pack minimums and writes a counts-only deletion log.
- **Company export:** a background job writes a zip under `<tenant>/exports/` (CSV per table, decrypted vault values, files, manifest).
- **Account closure:**

```mermaid
sequenceDiagram
  participant O as Owner
  participant A as API (home cell)
  participant W as Worker
  participant R as Regional registry
  participant G as Global directory
  O->>A: POST /v1/privacy/closure {confirmWorkspace}
  A->>A: account_closures (grace period), job run_after = purge time
  A->>G: status closing (no personal data)
  W->>R: status closing (blocks sign-in)
  W->>A: audit.purge_closed_tenant(), delete every tenant table, all object versions, cache keys
  W->>W: verify every store is empty
  W->>R: deletion certificate, status deleted
  W->>G: status deleted
  W-->>O: certificate by email (home-region SES)
```

## 8. Enterprise platform (Phase 9)

```mermaid
flowchart LR
  C[Customer integration] -- "API key / OAuth token (thr_sk_, thr_at_)" --> API
  API -- role ∩ scopes, rate limit, Idempotency-Key --> DB[(tenant DB, RLS)]
  API -- change + outbox event (same tx) --> DB
  W[worker] -- outbox → webhooks subscriber → job per attempt --> DB
  W -- "signed POST (SSRF-guarded, home region)" --> WH[Customer webhook endpoint]
  W -- "sealed audit rows, idempotent batches" --> SIEM[Customer SIEM: HTTPS or S3 in home region via STS]
```

- **Public API:** API keys and OAuth clients resolve to an `api_client` principal in the context plugin. `platform/http.ts` adds per-tenant rate limits, idempotency replay and deprecation headers. The spec is the route schemas; the SDK and the `/developers` reference are generated from it (`docs/api.md`).
- **Webhooks and SIEM streams:** both are driven by the outbox and the job engine. Each attempt and each batch is idempotent. All outbound traffic goes through `lib/outbound.ts` (connect-time SSRF guard) from the tenant's home region.
- **Sandboxes:** a sandbox is a separate tenant in the same cell, built from the config-classified tables (`platform/sandbox-tables.ts`) with synthetic people.
- **Feature flags:** the registry is `packages/core/src/features.ts`, overrides are stored in `app.tenants.features->'flags'`, and the check is `featureEnabled(tx, key)`. The web shell reads `/v1/tenant/experience`.
- **Dedicated databases:** back-office move requests are run by `move-tenant --process-requests` (runbook).

## 9. Support, back office, status and billing (Phase 10)

```mermaid
flowchart LR
  subgraph Cell["Each cell (UK / EU / US)"]
    API[api] --> T[(tenant tables, forced RLS:\ntickets, billing accounts,\ncontacts, subscriptions, invoices)]
    API --> BO[(back-office store:\nqueue index, contracts, usage totals,\nstatus posts, staff trail)]
    W[worker] --> API
    API -- home-region SES --> MAIL[failed-payment and\nescalation emails]
  end
  STRIPE[(Stripe account\nfor this region)]
  API -- company billing data only --> STRIPE
  STRIPE -- signed webhooks --> API
  STATUS[/status page/] -- public, cacheable --> API
  DIR[(global directory:\nplanRef only)]
  API -- planRef --> DIR
```

- **Billing state is tenant data in the home cell** and each cell talks only to its region's Stripe account (ADR-0103). The global layer stores only the plan reference.
- **Support tickets** stay in the tenant tables; staff work a metadata-only queue and every ticket view is audited (ADR-0101). SLA timers and escalation follow ADR-0102.
- **Status:** each cell serves a public `/v1/status` (ADR-0105); the web `/status` page shows the three regions side by side.
- **Back office** (`/backoffice`): staff sessions with mandatory MFA; personal data only through customer-granted support access (ADR-0106).

## 10. Ask HR assistant (Phase 11)

```mermaid
sequenceDiagram
  participant E as Employee (web)
  participant A as API (home cell)
  participant D as Tenant DB (RLS)
  participant B as Amazon Bedrock (same region, In-Region)
  E->>A: POST /v1/ai/ask {question}
  A->>D: flag + opt-in + region check; rate limit
  A->>A: deterministic guard (decisions, injection, sensitive, colleagues)
  A->>D: directory redaction lookups; full-text + trigram retrieval over policy chunks
  A->>B: frozen system prompt + escaped excerpts + scrubbed question
  B-->>A: answer with [n] citations
  A->>A: post-model decision check; citation validation
  A->>D: ai_questions row (hash, length, outcome, cited ids) + audit (no content)
  A-->>E: answer, citations, AI disclosure
```

- **Where it runs:** only in cells with an In-Region Claude model on Bedrock (today the UK cell, eu-west-2, with Claude Opus 5.5; ADR-0110). The map lives in `packages/core/src/ai-models.ts`. The Bedrock client is built by the residency-guarded factory, and IAM allows `bedrock:InvokeModel` on that foundation model only.
- **Switches:** the staff-managed `aiAssistant` feature flag (entitlement) and the owner's opt-in, both off by default (ADR-0112).
- **Sources and index:** company documents in policy folders visible to everyone (never personal documents) are chunked into `app.ai_policy_chunks` by the idempotent `ai.index_policies` job. Retrieval is PostgreSQL full-text search plus `pg_trgm` only (ADR-0111).
- **Model interface:** `deps.ai` (`apps/api/src/modules/ai/provider.ts`): Bedrock in AWS, a deterministic fake in dev and e2e, a capturing mock in tests.
- **Code:** `apps/api/src/modules/ai` (guard, redaction, extraction, retrieval, prompt, routes), `apps/web/app/app/ask` (employees) and `apps/web/app/app/settings/ask-hr` (admins).
