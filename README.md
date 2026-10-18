# Thapsus-HR

A multi-tenant HR platform for UK, EU and US employers, from 10 to 200,000+ employees. Each customer's data stays in the home region it chooses at sign-up (London, Frankfurt or Ohio).

- Scope: [`docs/BUILD_BRIEF.md`](docs/BUILD_BRIEF.md) · Status: [`docs/PROGRESS.md`](docs/PROGRESS.md) · Rules: [`CLAUDE.md`](CLAUDE.md)
- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Design: [`docs/DESIGN.md`](docs/DESIGN.md) · Security: [`docs/SECURITY.md`](docs/SECURITY.md) · Decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- Guides: [`docs/guides/admin-guide.md`](docs/guides/admin-guide.md) (admins and managers) · [`docs/guides/employee-guide.md`](docs/guides/employee-guide.md) (employees)

## Prerequisites

- Node.js 24 or later and pnpm 12.14 (`corepack enable`, or `npm i -g pnpm@12.14.0`)
- Docker (Postgres 17, Valkey, S3 mock, ElasticMQ and Mailpit run locally)
- For `pnpm verify`:
  - a Playwright Chromium for the e2e and Lighthouse steps: `pnpm --filter @thapsus/web exec playwright install chromium`, or point `PW_CHROMIUM_PATH` at an existing Chromium (ADR-0012);
  - Docker able to pull `mcr.microsoft.com/playwright` for visual regression.

## Quick start

```bash
pnpm install
docker compose up -d --wait             # local services, waits until Postgres is ready
pnpm run setup                          # writes .env (local-only secrets), creates databases, migrates
pnpm db:seed                            # fictional demo company (workspace "demo")
pnpm dev                                # web :3000 (proxies /v1 to the api :4000), api, worker
```

Use `pnpm run setup`, not `pnpm setup`: the latter is pnpm's own built-in command.

Open http://localhost:3000/signin and use workspace `demo`, `owner@demo.example.test`, password `Demo-Password-2026` (local only). Other personas: `hr@`, `manager@`, `employee@`, `payroll@`. Mail goes to Mailpit at http://localhost:8025. SSO can be tried against the built-in mock IdP at `/__mock-idp`, which is enabled only outside production.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run web, api and worker with hot reload |
| `pnpm verify` | Full gate: lint, typecheck, unit, integration, contract, tenant isolation, residency, build, e2e + axe, local-dev smoke, visual regression, Lighthouse, security scan, `cdk synth`. Ends with a pass/fail table (`.verify/summary.txt`). `VERIFY_ONLY=` / `VERIFY_SKIP=` select steps. |
| `pnpm db:migrate` / `pnpm db:seed` | Apply migrations / seed the demo company |
| `pnpm synth:enterprise` | Generate the 200,000-employee, 50-entity synthetic tenant (workspace `enterprise`) |
| `pnpm smoke:staging` | End-to-end smoke test against staging in each region (Phase 12) |
| `pnpm loadtest` | k6 scenarios against a temporary load-test environment, torn down afterwards (Phase 12) |
| `node --import tsx scripts/deploy.mjs --env <env> --only <target> [--dry-run]` | Deploy stacks (see `infra/README.md`); production needs explicit approval |
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
