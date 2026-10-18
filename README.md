# Thapsus-HR

A multi-tenant HR platform for UK, EU and US employers, from 10 to 200,000+ employees. Each customer's data stays in the home region it chooses at sign-up (London, Frankfurt or Ohio).

- Scope: [`docs/BUILD_BRIEF.md`](docs/BUILD_BRIEF.md) · Status: [`docs/PROGRESS.md`](docs/PROGRESS.md) · Rules: [`CLAUDE.md`](CLAUDE.md)
- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Design: [`docs/DESIGN.md`](docs/DESIGN.md) · Security: [`docs/SECURITY.md`](docs/SECURITY.md) · Decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md)

## Prerequisites

- Node.js 24 and pnpm 12 (`corepack enable`)
- Docker (Postgres 17, Valkey, S3 mock, ElasticMQ and Mailpit run locally)
- For visual regression: Docker can pull `mcr.microsoft.com/playwright`

## Quick start

```bash
pnpm install
docker compose up -d                    # local services
pnpm setup                              # writes .env (local-only secrets), creates databases, migrates
pnpm db:seed                            # fictional demo company (workspace "demo")
pnpm dev                                # web :3000 (proxies /v1 to the api :4000), api, worker
```

Open http://localhost:3000/signin and use workspace `demo`, `owner@demo.example.test`, password `Demo-Password-2026` (local only). Other personas: `hr@`, `manager@`, `employee@`, `payroll@`. Mail goes to Mailpit at http://localhost:8025. SSO can be tried against the built-in mock IdP at `/__mock-idp`, which is enabled only outside production.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run web, api and worker with hot reload |
| `pnpm verify` | Full gate: lint, typecheck, unit, integration, contract, tenant isolation, residency, build, e2e + axe, visual regression, Lighthouse, security scan, `cdk synth`. Ends with a pass/fail table (`.verify/summary.txt`). |
| `pnpm db:migrate` / `pnpm db:seed` | Apply migrations / seed the demo company |
| `pnpm synth:enterprise` | Generate the 200,000-employee, 50-entity synthetic tenant (workspace `enterprise`) |
| `pnpm smoke:staging` | End-to-end smoke test against staging in each region |
| `pnpm loadtest` | k6 scenarios against a temporary load-test environment (torn down afterwards) |
| `pnpm --filter @thapsus/api openapi` | Regenerate the published OpenAPI document |

## Repository layout

```
apps/web        Next.js marketing site + app (PWA)
apps/api        Fastify API (OpenAPI 3.1, /v1), auth, SSO, SCIM, global mode
apps/worker     Outbox, idempotent jobs, audit sealing, schedules
packages/core   Regions/residency, time, money, i18n, permissions, logging
packages/db     SQL migrations, RLS tenant context, routing, tenant move tool
packages/rules  Jurisdiction packs
packages/ui     Design tokens and components
packages/sdk    OpenAPI document + TypeScript SDK
infra           AWS CDK (cell, global, backup copy stacks)
docs            Brief, progress, decisions, design, security, runbooks, guides
```
