# CLAUDE.md — ROCHE (an HR platform by Thapsus)

ROCHE is a production-grade, multi-tenant HR platform for UK, EU and US employers of every size (10 to 200,000+ employees). This file holds the rules that apply to every change. The full brief is `docs/BUILD_BRIEF.md` (source of truth for scope); delivery status and acceptance criteria are in `docs/PROGRESS.md`.

## How to work in this repo

- Work the phases in order (`docs/PROGRESS.md`). One branch per phase: `phase-<n>-<slug>` (e.g. `phase-0-foundations`). Small, focused commits using Conventional Commits (`feat(api): …`, `test(db): …`).
- **Do not stop to ask the product owner questions.** Make the most reasonable choice, record it in `docs/DECISIONS.md` (dated ADR entry: context, decision, consequences) and carry on.
- Anything only a human can do (accounts, domain, keys, app registrations, partner programmes, SES production access, Stripe live mode, legal review) goes in `docs/HUMAN_TODO.md` with exact, numbered steps. Build against mocks or test mode meanwhile and keep going.
- **Always ask first before:** deploying to production, deleting any cloud resource or data, or adding recurring cost beyond the `docs/COSTS.md` estimate.
- End of every phase: `pnpm verify` passes → docs updated → `docs/PROGRESS.md` ticked → commit → print the verify pass/fail summary in the conversation.
- Never tick a PROGRESS.md item whose acceptance criteria are not proven by a test, a check in `pnpm verify`, or (for human-only items) an entry in HUMAN_TODO.md. Report failures and skipped steps honestly.

## Scope guardrails

Out of scope — do not build: running payroll or filing payroll taxes, global payroll, Employer of Record, PEO, benefits brokerage, MDM or hardware purchase/shipping, corporate cards and spend management, acting as an identity provider for other apps, native iOS/Android apps (ship an installable PWA instead).

## Non-negotiables

### Privacy and data residency
- Comply with EU GDPR, UK GDPR + Data Protection Act 2018 (as amended by the Data (Use and Access) Act 2025), and US state privacy laws covering employee data (e.g. CCPA/CPRA). ROCHE is the **processor**; customers are **controllers**.
- Each tenant picks a home region at sign-up: **UK = eu-west-2 (London)**, **EU = eu-central-1 (Frankfurt)**, **US = us-east-2 (Ohio)**. All of that tenant's personal data, files, backups, logs, search indexes, caches, queues and emails stay in that region.
- Backup copies only within the same jurisdiction: **EU → eu-west-1**, **US → us-west-2**, **UK → none** (London only, across AZs). This map lives in one config module and is enforced by tests.
- The global layer (marketing site, tenant directory mapping tenant ID/slug → region, billing) holds **no employee personal data**.
- Authenticated pages and API responses are served from the home region with `Cache-Control: private, no-store` and are **never cached at an edge/CDN**.
- No personal data goes to a third party unless it is listed in `docs/SUBPROCESSORS.md` (purpose + location, per region). Add the entry *before* writing the integration.

### Security
- Tenant isolation is enforced in PostgreSQL with **Row Level Security** (enabled *and forced*) and proven by automated tests. The app connects as a role without `BYPASSRLS` that does not own the tables.
- The data layer must allow moving a very large tenant to its own dedicated database **without code changes** (tenant → database routing is configuration).
- Sensitive data (health, sickness and fit notes, disability, diversity/EEO, immigration and work-authorisation documents) lives in a separate store, **field-level encrypted with per-region KMS keys**, visible only to roles that need it, and **every access is audit-logged**.
- MFA mandatory for admin roles; customers can enforce SSO; sessions expire (idle + absolute); sign-in is rate-limited with lockout.
- **Append-only audit log** for every change and every view of sensitive data; customers can export it.
- OWASP ASVS level 2. Secrets only in AWS Secrets Manager (local dev: `.env` files that are git-ignored). Least-privilege IAM. No long-lived AWS keys in CI (GitHub OIDC only).

### Quality
- Accessibility: WCAG 2.2 AA (covers Section 508). Must work well on low-cost phones.
- i18n from day one: **no hardcoded user-facing strings** — all text goes through message catalogues (en-GB and en-US at launch). Locale-aware dates, numbers, currencies (GBP, EUR, USD and more), full IANA time zone support.
- **Employment rules are never hardcoded from memory.** They are versioned, effective-dated data in jurisdiction packs (`packages/rules`), each value carrying its official source URL and verified-on date, checked against official government sources while building, editable in the back office, and covered by golden tests.

### Design (inspired by Apple.com — principles only, never its assets)
- Calm, premium, uncluttered. Never copy Apple logos, images, icons, wording or exact layouts. Never bundle SF Pro or use SF Symbols.
- Font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif`. Large bold headlines with tight tracking (marketing); 17px body; clear hierarchy.
- Mostly white / soft grey surfaces, near-black text, **one accent colour** for links and buttons, full-width dark sections for contrast. Full light and dark mode.
- Generous white space, centred reading width, alternating full-width sections, large rounded cards, pill buttons, subtle shadows.
- Marketing: slim sticky translucent blurred top bar, scroll-triggered reveals, sticky feature showcases. App: clean sidebar + simple top bar, quick gentle transitions, dense but readable tables at enterprise scale.
- 60fps; fully respect `prefers-reduced-motion`. Open-source thin-line icon set (Lucide). Images optimised (AVIF/WebP, responsive, lazy).
- Lighthouse (mobile): **≥90 performance, ≥95 accessibility** on key marketing pages and app screens.
- `docs/DESIGN.md` is the design contract. Build every screen from its tokens — no ad-hoc colours, sizes, radii, shadows or durations.

## Engineering rules

- **Tests first** for money, time and compliance logic, for tenant isolation, and for data residency. Residency tests must prove a tenant's data never reaches another region's resources, for **every region pair** (UK↔EU, UK↔US, EU↔US).
- **Fictional test data only.** Never real people's data, real NI numbers/SSNs, or real customer names.
- **Data access**: all tenant-scoped queries run inside the tenant-context helper from `packages/db` (sets `app.tenant_id` per transaction via `set_config(..., true)`). Never use the owner/migrator connection from application code.
- **New tenant-scoped table checklist**: `tenant_id uuid not null`, RLS enabled + forced, tenant policy, index leading with `tenant_id`, audit coverage. The isolation test suite enumerates every table and fails if any is missing a policy.
- **Effective dating** for core HR data: `valid_from` / `valid_to` (half-open) with exclusion constraints preventing overlaps; future-dated changes are first-class.
- **Money**: integer minor units + ISO 4217 code; never floating point. **Time**: instants as `timestamptz` (UTC); calendar dates as `date` interpreted with an explicit IANA zone; use the shared time utilities, no ad-hoc `Date` arithmetic.
- **Nothing configurable is hardcoded**: employment rules (jurisdiction packs), prices/bands/discounts (billing config), feature flags, the product domain (`ROCHE_DOMAIN` env/config — not yet chosen).
- **API**: OpenAPI 3.1 first. Route schemas are the source of the spec; the spec is published and contract-tested; public API is versioned (`/v1`).
- **Events**: write domain events to the transactional outbox in the same transaction as the change; background jobs must be idempotent (idempotency key per job).
- **Migrations**: expand-and-contract only (no destructive change in the same release that stops using a column); every migration runs in CI against real Postgres.
- **Observability**: use the shared logger/tracer, which scrubs personal data. Never log request bodies, names, emails, national identifiers or tokens.
- **AWS clients** are created only through the residency-guarded factory, which refuses any region other than the cell's home region (and the permitted backup region for backup tooling).
- **Search**: PostgreSQL full-text + `pg_trgm` only, unless load tests prove a dedicated service is needed (record in DECISIONS.md first).
- **Dependencies**: maintained, permissively licensed packages; pin via the lockfile; `pnpm audit` must pass at high severity.
- **Never commit secrets.** The secret scan in `pnpm verify` must pass.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install workspace dependencies |
| `pnpm dev` | Run web, api and worker locally |
| `pnpm verify` | Full gate: lint, typecheck, unit, integration, contract, tenant-isolation, residency, e2e, visual regression (light/dark × phone/desktop), Lighthouse, security scan (dependency audit + secret scan), build, `cdk synth`; ends with a pass/fail summary |
| `pnpm db:migrate` / `pnpm db:seed` | Apply migrations / seed the fictional demo company |
| `pnpm synth:enterprise` | Generate the 200,000-employee, 50-entity synthetic tenant |
| `pnpm smoke:staging` | E2E smoke against staging in each region |
| `pnpm loadtest` | k6 scenarios for the scale targets against a temporary, torn-down environment |

(Commands are implemented during Phase 0; update this table if any change.)

## Repository layout

```
apps/web        Next.js App Router — marketing site + app (PWA)
apps/api        Fastify — OpenAPI 3.1, versioned REST API, auth, SCIM
apps/worker     Background jobs and schedules (SQS / EventBridge Scheduler)
packages/db     Drizzle schema, migrations, RLS policies, tenant routing
packages/rules  Jurisdiction packs (versioned, effective-dated rule data + golden tests)
packages/ui     Design tokens and restyled shadcn/ui components
packages/sdk    Public TypeScript SDK (generated from OpenAPI)
infra           AWS CDK: regional cell stack + global stack
docs            Brief, progress, decisions, design, security, runbooks, …
```

## Key documents

`docs/BUILD_BRIEF.md` (scope) · `docs/PROGRESS.md` (status + acceptance criteria) · `docs/DECISIONS.md` · `docs/HUMAN_TODO.md` · `docs/DESIGN.md` · `docs/SECURITY.md` · `docs/ARCHITECTURE.md` · `docs/SUBPROCESSORS.md` · `docs/COVERAGE.md` · `docs/COSTS.md` · `docs/PERFORMANCE.md` · `docs/COMPLIANCE.md` · `docs/runbooks/`
