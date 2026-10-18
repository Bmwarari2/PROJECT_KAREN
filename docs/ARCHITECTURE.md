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

| Home region | AWS region | Backup copy |
| --- | --- | --- |
| UK | eu-west-2 (London) | none — London only, across availability zones |
| EU | eu-central-1 (Frankfurt) | eu-west-1 (Ireland) |
| US | us-east-2 (Ohio) | us-west-1 (N. California) |

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
- **Effective dating:** core HR records use `[valid_from, valid_to)` with exclusion constraints. `app.employees` holds denormalised *current* values for fast lists and search at 200,000 rows; a daily idempotent job refreshes them for future-dated changes.
- **Audit:** `audit.events` is append-only. Privileges and a trigger block changes, and asynchronous sealing builds a per-tenant SHA-256 chain (ADR-0004).
- **Sensitive data vault:** `vault.records` holds envelope-encrypted values with per-value data keys wrapped by the regional KMS vault key. The AAD binds each value to its tenant, subject, category and field. Every decrypt is audited.
- **Outbox:** domain events are written in the same transaction as the change. The worker dispatches them to in-process subscribers and EventBridge, exactly once per event id.

## 4. Services and packages

| Path | Role |
| --- | --- |
| `apps/web` | Next.js App Router: marketing site, app (installable PWA), sign-in and sign-up |
| `apps/api` | Fastify, OpenAPI 3.1 (`packages/sdk/openapi.json`), auth (password, TOTP, passkeys, magic links, OIDC/SAML SSO), SCIM 2.0, domain modules, global mode (`SERVICE_ROLE=global`) |
| `apps/worker` | Outbox dispatch, idempotent jobs with progress and retries, audit sealing, scheduled sweeps |
| `packages/core` | Regions, residency guard, time (Temporal), money (integer minor units), i18n catalogues and formatters, permission engine, PII scrubber, logger, tracer |
| `packages/db` | SQL migrations, tenant context, router, audit and outbox helpers, tenant move tool |
| `packages/rules` | Jurisdiction packs (versioned, effective-dated, sourced rule data, golden tests) |
| `packages/ui` | Design tokens (generated Tailwind theme) and components |
| `packages/sdk` | Published OpenAPI document and TypeScript SDK |
| `infra` | AWS CDK: cell, global and backup copy vault stacks |

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
