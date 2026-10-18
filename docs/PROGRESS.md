# Thapsus-HR delivery progress

Status of every phase and feature in `docs/BUILD_BRIEF.md`, with acceptance criteria (AC). A feature is ticked only when **all** of its AC are proven by automated tests or checks in `pnpm verify`, or, for steps only a human can do, are listed in `docs/HUMAN_TODO.md` with the build running against mocks or test mode.

**Phase exit gate (every phase):** `pnpm verify` passes · affected docs updated · this file ticked · work committed on the phase branch · verify summary printed in the conversation.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done (AC met) · `[h]` done except human-only steps (see HUMAN_TODO.md)

## Summary

| Phase | Scope | Branch | Status |
| --- | --- | --- | --- |
| 0 | Foundations | `phase-0-foundations` | [h] |
| 1 | Core HR and organisation model (6.1) | `phase-1-core-hr` | [x] |
| 2 | Jurisdiction pack framework + UK, US, EU packs (6.4 framework) | `phase-2-jurisdiction-packs` | [h] |
| 3 | Time off and absence (6.2) | `phase-3-time-off` | [x] |
| 4 | Rotas and time tracking (6.3) | `phase-4-rotas-time` | [x] |
| 5 | Compliance centre content (rest of 6.4) | `phase-5-compliance` | [ ] |
| 6 | Payroll handoff and IT automation (6.5, 6.6) | `phase-6-payroll-it` | [ ] |
| 7 | Reports, analytics and self-service (6.7, 6.8) | `phase-7-reports-ess` | [ ] |
| 8 | Privacy and trust (6.9) | `phase-8-privacy` | [ ] |
| 9 | Enterprise platform (6.10) | `phase-9-enterprise` | [ ] |
| 10 | Support, back office, pricing and billing (6.11, 6.12) | `phase-10-backoffice-billing` | [ ] |
| 11 | AI assistant behind a feature flag (6.13) | `phase-11-ai-assistant` | [ ] |
| 12 | Scale and launch readiness | `phase-12-launch` | [ ] |

---

## Phase 0 — Foundations

- [x] **0.1 Monorepo and tooling**
  - pnpm workspaces + Turborepo containing `apps/web`, `apps/api`, `apps/worker`, `packages/db`, `packages/rules`, `packages/ui`, `packages/sdk`, shared config packages and `infra`.
  - TypeScript strict mode everywhere; ESLint + Prettier; a clean clone runs `pnpm install && pnpm verify` without manual steps (beyond documented prerequisites).
  - `pnpm verify` runs every step listed in brief §8 (lint, typecheck, unit, integration, contract, tenant-isolation, residency, e2e, visual regression, Lighthouse, security scan, build, `cdk synth`) and ends with a pass/fail table; exit code is non-zero if any step fails.
  - _Evidence:_ `scripts/verify.mjs` (15 steps, pass/fail table, non-zero exit); strict `tsconfig.base.json`; shared config at the root (ADR-0042); Prettier configured, formatting gate added after the phase merges (ADR-0041).
- [h] **0.2 CI/CD**
  - GitHub Actions runs `pnpm verify` on every pull request and push to `main`.
  - Deploy workflow assumes per-account, per-region IAM roles via GitHub OIDC; repository contains no AWS access keys (secret scan proves it).
  - Staging deploys per region from `main`; production deploys only through a manual approval environment gate.
  - Dependency audit and secret scanning run in CI.
  - _Evidence:_ `.github/workflows/ci.yml` (verify on PR and push to main); `infra/lib/ci-stack.ts` + `infra/test/infra.test.ts` "CI stack" (OIDC, one role per region, no IAM users or keys); `scripts/deploy.mjs` with `scripts/test/deploy-plan.test.ts`; secret scan in verify. _Human:_ HUMAN_TODO 1.5 (deploy the CI stack, GitHub variables and the `production` approval environment).
- [x] **0.3 Local development**
  - `docker compose up` starts Postgres, Valkey, an S3 emulator, an SQS emulator and a mail catcher.
  - `pnpm dev` runs web, api and worker with hot reload; `pnpm db:migrate && pnpm db:seed` produce a working demo company.
  - Integration tests run against real PostgreSQL (Docker, or native binaries when Docker images are unavailable — see DECISIONS.md).
  - README quick start works from a clean clone.
  - _Evidence:_ verify `deps` (all five services, `--wait`) and `dev` (`scripts/dev-smoke.mjs`: migrate, seed, `pnpm dev`, sign-in through the web proxy, Mailpit delivery, api/worker hot reload).
- [x] **0.4 Regional cell stack (AWS CDK)**
  - One parameterised `CellStack` per environment × region (dev/staging/prod × UK/EU/US): VPC across 3 AZs; ECS Fargate services (web, api, worker) with autoscaling; ALB with ACM TLS and AWS WAF; Aurora PostgreSQL Multi-AZ with a reporting read replica and RDS Proxy; ElastiCache Valkey Multi-AZ; SQS (+ DLQs) and EventBridge; EventBridge Scheduler; S3 (private, versioned, SSE-KMS, block public access); SES configuration set; Secrets Manager; per-region KMS keys; CloudWatch logs (KMS-encrypted, retention set), X-Ray / OpenTelemetry collector; AWS Backup plan; AWS Budgets alarm.
  - CDK assertion tests prove: Multi-AZ and encryption on Aurora and Valkey; S3 public access blocked; WAF associated with every ALB; no CloudFront distribution in front of authenticated origins; every resource in the cell's home region; backup copy rules target only the permitted region (EU→eu-west-1, US→us-west-1, UK→none); IAM policies contain no `*` actions on `*` resources.
  - `cdk synth` succeeds for every environment × region combination.
  - _Evidence:_ `infra/test/infra.test.ts` (per env × cell: Multi-AZ/encryption, S3, WAF, no CloudFront, home region only, backup copy targets, IAM, logs, autoscaling, SQS DLQs, event bus, scheduler, SES, budget, 3 AZs, TLS certificate); verify `synth`.
- [x] **0.5 Global stack (AWS CDK)**
  - Route 53 hosted zone (domain from configuration), tenant directory, region-aware sign-in routing, marketing site hosting and billing service placeholders.
  - Tenant directory schema holds only tenant ID, slug, home region, status, plan reference and verified domains; a test fails if a personal-data field is added.
  - Marketing site may use a CDN; app and API hostnames are regional and bypass any edge cache (asserted in tests).
  - _Evidence:_ `infra/test/infra.test.ts` global stack tests; `apps/api/test/directory.test.ts` (directory schema is exactly the reviewed allow-list); `apps/api/test/auth.int.test.ts` (no-store).
- [x] **0.6 Tenancy with Row Level Security**
  - Every tenant-scoped table has `tenant_id`, RLS enabled and forced, and a tenant policy; the application role has no `BYPASSRLS` and owns no tables.
  - Isolation test suite enumerates all tables from the catalog and fails if any tenant-scoped table lacks RLS or a policy.
  - Tests prove a session for tenant A cannot select, insert, update or delete tenant B rows, and that a session with no tenant context sees zero rows.
  - Tenant context is set per transaction with `set_config('app.tenant_id', …, true)` (safe with RDS Proxy connection reuse); a test proves context does not leak between pooled transactions.
  - _Evidence:_ `packages/db/test/rls.isolation.test.ts`.
- [x] **0.7 Dedicated-database routing**
  - Tenant → database routing comes from configuration (regional tenant registry), not code.
  - Integration test: a tenant is moved from the shared database to a second database using the move script, routing is switched, and the same API test suite passes for that tenant with no code change.
  - Runbook draft `docs/runbooks/move-tenant-to-dedicated-db.md`.
  - _Evidence:_ `apps/api/test/dedicated-db.int.test.ts` (auth, MFA, domains incl. DNS verification, SCIM, preferences, push, magic link, audit export + chain verification — before and after the move); `docs/runbooks/move-tenant-to-dedicated-db.md`.
- [x] **0.8 Authentication**
  - Maintained auth library (default Better Auth) with organisations, email + password, TOTP MFA, passkeys and magic links; all auth data stored in the home-region database.
  - Sign-up flow asks for the home region and creates the tenant only in that region's cell.
  - MFA enforced for admin roles: admin routes are refused until a second factor is enrolled and verified (tested).
  - OIDC and SAML 2.0 SSO logins pass end-to-end tests against mock identity providers; a tenant can enforce SSO, after which password login is refused for its users (tested).
  - SCIM 2.0 inbound provisioning: `/Users` and `/Groups` support create, get, list with filter, PATCH and deactivate; bearer tokens scoped per tenant; conformance tests pass.
  - Verified domains via DNS TXT record (DNS lookup mocked in tests).
  - Sessions expire on idle and absolute timeouts (configurable per tenant); sign-in rate limiting and account lockout are tested.
  - _Evidence:_ `auth.int.test.ts`, `sso.int.test.ts`, `scim.int.test.ts`, `platform.int.test.ts` (passkeys); library choice in ADR-0003.
- [x] **0.9 Region-aware sign-in routing**
  - Global sign-in resolves slug or verified domain → home region and redirects to the regional host.
  - "Find my workspace" by email fans out to each region, which emails the user from that region; the global layer never stores the email address (tested).
  - A request for a tenant arriving at the wrong regional cell is refused/redirected without touching that tenant's data.
  - _Evidence:_ `platform.int.test.ts` "region-aware sign-in routing"; `apps/api/test/residency.residency.test.ts`.
- [x] **0.10 Roles and permissions**
  - Built-in roles seeded: Thapsus super-admin (back office), company owner, HR admin, country/entity HR admin, payroll admin, manager (own team, with delegation), employee.
  - Custom roles with field-level permissions (read/write/none per field) scoped by entity, country, department or location; deny by default; permission engine covered by unit tests including scope and delegation cases.
  - Thapsus support access model: customer-granted, time-limited, revocable, every action audit-logged; no back-office path to tenant personal data without an active grant (tested).
  - _Evidence:_ `apps/api/test/foundation.int.test.ts` (seeded built-in roles, delegation expiry); `packages/core/test/permissions.test.ts` (scopes incl. department and location, field-level); `platform.int.test.ts` (support access).
- [x] **0.11 Audit log**
  - Append-only: application role cannot UPDATE or DELETE audit rows (privileges revoked and trigger blocks it — tested); entries are hash-chained per tenant and a verification command detects tampering.
  - Every mutating API call writes an audit entry (actor, tenant, action, target, before/after diff with sensitive fields redacted, IP, user agent, request ID); every view of sensitive data writes an entry.
  - Customers can export the audit log (CSV and JSON) filtered by date range.
  - _Evidence:_ `packages/db/test/audit.int.test.ts`; `foundation.int.test.ts` (actor, IP, user agent, request id; the safety-net hook); `platform.int.test.ts` (export).
- [x] **0.12 Sensitive data vault (framework)**
  - Separate schema for sensitive categories with field-level envelope encryption using per-region KMS keys (local KMS mock in dev/test).
  - Raw table reads show ciphertext only (tested); roles without the sensitive-data permission cannot decrypt (tested); every decrypt writes an audit entry (tested).
  - _Evidence:_ `platform.int.test.ts` vault tests; KMS residency in `apps/api/test/residency.residency.test.ts`.
- [x] **0.13 Internationalisation**
  - Message catalogues for en-GB and en-US; lint fails on hardcoded user-facing strings in UI code.
  - Locale-aware formatting helpers for dates, numbers and currencies (GBP, EUR, USD plus at least SEK, PLN, DKK, CHF, CZK, HUF, RON) with unit tests.
  - Instants stored in UTC; users and locations carry IANA time zones; DST-boundary tests pass.
  - _Evidence:_ `packages/core/test/core.test.ts` (catalogue parity, money in 10 currencies, dates, numbers, date-times across DST); `tools/eslint/test`; `foundation.int.test.ts` (no `timestamp without time zone` columns).
- [x] **0.14 Design system**
  - `docs/DESIGN.md` written before any screen: tokens (colour, type scale, spacing, radii, shadows, motion), components, light/dark rules, motion and reduced-motion rules.
  - Tokens implemented as CSS variables consumed by Tailwind; `packages/ui` provides restyled shadcn/ui components (button, input, select, card, table, dialog, sheet, tabs, toast, sidebar, top bar, empty state, skeleton).
  - Automated contrast test proves every text/background token pair meets WCAG 2.2 AA in light and dark mode.
  - Component gallery page used for visual regression (light/dark × phone/desktop).
  - _Evidence:_ `docs/DESIGN.md`; `packages/ui` tokens and components; `packages/ui/test/tokens.test.ts` (contrast); `/design/gallery` in visual regression (4 projects) and e2e axe.
- [x] **0.15 PWA shell and marketing skeleton**
  - Installable PWA: web app manifest, service worker, offline fallback page, web push subscription (VAPID) with a test notification in dev.
  - App shell: sidebar + top bar, signed-in home, theme switch (system/light/dark), locale switch.
  - Marketing homepage skeleton: sticky translucent blurred nav, hero, alternating full-width sections, scroll reveals that respect `prefers-reduced-motion`.
  - Lighthouse mobile ≥90 performance and ≥95 accessibility on the marketing home page and app shell; axe checks pass in e2e.
  - _Evidence:_ `apps/web/e2e/foundation.spec.ts` (manifest, service worker, offline; theme and locale controls; scroll reveals vs reduced motion; axe); `foundation.int.test.ts` (push subscription + VAPID test notification); verify `lighthouse`.
- [x] **0.16 Observability and residency guard**
  - OpenTelemetry tracing and structured logging with personal-data scrubbing (unit tests cover emails, names in known fields, phone numbers, NI numbers, SSNs, tokens).
  - Residency-guarded AWS client factory refuses any region other than the cell's home region (and the permitted backup region for backup tooling).
  - Residency test matrix covers every region pair (UK↔EU, UK↔US, EU↔US) across database, object storage, cache, queues, email, logs and backups.
  - _Evidence:_ `packages/core/test/core.test.ts` (scrubbing, client factory); residency matrices in `packages/core/test/residency.residency.test.ts` and `apps/api/test/residency.residency.test.ts`.
- [x] **0.17 Seed data and synthetic enterprise generator**
  - `pnpm db:seed` creates a small fictional demo company (about 25 employees, UK-based, one legal entity).
  - `pnpm synth:enterprise` deterministically generates a 200,000-employee tenant with 50 legal entities across UK, EU and US (bulk COPY); runtime recorded in docs/PERFORMANCE.md.
  - _Evidence:_ `apps/api/test/cli.int.test.ts` (seed: 25 employees, 1 GB entity, idempotent; generator: deterministic, 50 entities); 200,000-employee runtime in `docs/PERFORMANCE.md` §2.1.
- [x] **0.18 Foundation documents**
  - First versions of README, ARCHITECTURE (with diagrams), DESIGN, SECURITY, DECISIONS, COSTS (per environment and region), SUBPROCESSORS (per region), HUMAN_TODO.
  - _Evidence:_ README, ARCHITECTURE (mermaid diagrams), DESIGN, SECURITY, DECISIONS, COSTS, SUBPROCESSORS and HUMAN_TODO in `docs/`.

---

## Phase 1 — Core HR and organisation model (6.1)

- [x] **1.1 Effective-dated employee records**
  - Personal details, jobs, positions, grades, pay history, cost centres, contracts and emergency contacts stored as effective-dated records with exclusion constraints preventing overlapping periods.
  - As-of queries return the correct state for any past, present or future date; future-dated changes take effect automatically on their date (scheduled job, idempotent); full history view per employee.
  - Custom fields (text, number, date, select, multi-select, boolean, currency, file) and custom objects with validation, field-level permissions and audit.
  - Field-level permissions enforced identically in API responses and UI.
  - Employee list for the 200,000-employee tenant: paginated p95 < 1 s locally (benchmark recorded); full-text + trigram search.
  - _Evidence:_ `apps/api/test/employees.int.test.ts` ("effective-dated employee records": as-of, past/present/future changes with full history, overlap rejection by the database, the idempotent daily job for future-dated changes; "every effective-dated section rejects overlapping periods"; "emergency contacts are effective-dated"; "positions, grades and cost centres on job records"; "custom fields and objects" and "custom fields: every type, validation, field-level permissions and audit"; "field-level permissions and scope"; "fuzzy search"); `apps/web/e2e/corehr.spec.ts` ("field-level permissions in the UI"); `scripts/bench-corehr.ts` (exits 1 over budget; list p95 23 ms, search 42 ms on 200,000 employees, `docs/PERFORMANCE.md` §2.3).
- [x] **1.2 Organisation model and org chart**
  - Multiple legal entities, countries, departments, locations and cost centres; solid-line, matrix and dotted-line reporting relationships, all effective-dated.
  - Reporting cycles are rejected; reassigning a manager with reports is handled explicitly.
  - Org chart loads lazily by subtree with search and focus; first render < 1 s and expanding a node < 300 ms for the 200,000-employee tenant.
  - _Evidence:_ `apps/api/test/employees.int.test.ts` ("reporting lines and org chart": cycles rejected, explicit reassignment when terminating a manager with reports, dotted and matrix lines; "organisation: cost centres, matrix reporting and org-chart search"); `apps/web/e2e/corehr.spec.ts` ("org chart": first level 121 ms, expand 68 ms, search and focus); `scripts/bench-corehr.ts` (roots p95 14 ms, expand 14 ms on 200,000 employees).
- [x] **1.3 Documents**
  - Folders with permissions; files stored in the home-region S3 bucket via presigned URLs; content-type and size validation.
  - Templates with merge fields rendered to PDF.
  - Click-to-sign with audit trail: signer, timestamp, IP address, SHA-256 of the exact document signed; signature certificate page; hash verification test.
  - Expiry tracking with reminders; bulk send to a filtered set of employees with progress tracking.
  - _Evidence:_ `apps/api/test/corehr-flows.int.test.ts` ("documents": uploads validated by type, size and content; templates with merge fields rendered to PDF and click-to-sign with signer, time, IP and SHA-256 plus the certificate page and hash verification; folder permissions; bulk send as a background job with progress; expiry reminders once per threshold).
- [x] **1.4 Bulk import and export**
  - CSV and Excel import with column mapping, validation preview (row-level errors), dry run and background processing with progress.
  - Importing 200,000 employees completes as a background job with progress updates and a downloadable error report; re-running the same file is idempotent.
  - CSV and Excel export of any permitted list, respecting field-level permissions.
  - _Evidence:_ `apps/api/test/corehr-flows.int.test.ts` ("bulk import and export": Excel import with typed cells, preview with row-level errors, background job with progress and a downloadable error report, idempotent re-run, exports of every list view respecting field-level permissions); `scripts/bench-import.ts` (200,000 rows in 386 s with 57 progress updates; re-import changes nothing, `docs/PERFORMANCE.md` §2.3); `apps/web/e2e/corehr.spec.ts` (download).
- [x] **1.5 Onboarding, offboarding and internal transfer workflows**
  - Workflow templates with tasks, assignees (role- or person-based), due dates relative to start/leave/transfer date, and reminders.
  - Pre-start portal for new joiners (documents, forms, checklist) before their start date.
  - Transfer workflow changes job/entity/location with effective dating.
  - _Evidence:_ `apps/api/test/corehr-flows.int.test.ts` ("workflows" and "workflow due dates, assignees and reminders": onboarding with relative due dates and role, manager and named-person assignees, reminders, offboarding on termination, transfers with effective dating; "pre-start portal"); `apps/web/e2e/corehr.spec.ts` ("pre-start portal", axe).
- [x] **1.6 Approval chains and bulk actions**
  - Multi-step, conditional (field-based) and delegated approvals with escalation on timeout; approval history in the audit log.
  - Bulk approve/reject and bulk edit with permission checks and a summary of results.
  - _Evidence:_ `apps/api/test/corehr-flows.int.test.ts` ("approvals": multi-step conditional approval with delegation, escalation on timeout, bulk decisions with a result summary, audit history; "bulk approvals and bulk edit": per-employee permission checks and summaries).
- [x] **1.7 Automation rules**
  - Triggers: record created or changed, date reached, document expiring, threshold hit.
  - Actions: create task, send notification, start workflow, call webhook, call integration.
  - Rules evaluated from outbox events by idempotent worker jobs; dry-run preview; execution log.
  - _Evidence:_ `apps/api/test/corehr-flows.int.test.ts` ("automation rules" and "automation triggers, actions and integrations": record created/changed, date reached, document expiring and threshold triggers; task, notification, workflow, signed webhook and integration actions; idempotent outbox-driven jobs, dry run and the execution log).
---

## Phase 2 — Jurisdiction pack framework (6.4 framework)

- [x] **2.1 Pack framework**
  - Rule data versioned per country (and per US state/locality), with effective-from/to dates, official source URL, verified-on date and reviewer.
  - Rule lookup by (jurisdiction, rule key, date) with layered resolution (EU baseline → member state; US federal → state → locality; UK → nation).
  - Every rule has golden tests (input → expected output) that run in `pnpm verify`.
  - `docs/COVERAGE.md` generated from pack data showing which rules exist per jurisdiction and their verification dates.
  - Edits create new versions (never overwrite); API for back-office editing (UI in Phase 10).
  - _Evidence:_ `packages/rules/src/schema.ts` + `scripts/validate.ts` (every version carries effective dates, an official https source, verified-on date and reviewer; `coverage.test.ts` runs the validator); `test/engine.test.ts` and `test/goldens.test.ts` "layered resolution" (EU → member state, US federal → state → locality, UK nations, explicit failures instead of guesses); `test/goldens.test.ts` "golden coverage" (fails if any rule version or holiday pack lacks a vector) plus the vectors in `packages/rules/goldens/*.json`, all in verify `unit`; `coverage.test.ts` (COVERAGE.md is generated from pack data, with a per-rule verification log); `test/manifest.test.ts` (content changes need a version bump); `apps/api/test/rules.int.test.ts` "back-office rule editing" (staff MFA, append-only versions that take effect for lookups).
- [x] **2.2 UK pack (base data)**
  - Public holidays for England and Wales, Scotland and Northern Ireland; statutory annual leave; SSP parameters; working-time limits; right-to-work document rules — each value verified against gov.uk / legislation.gov.uk with source URLs.
  - _Evidence:_ `packages/rules/packs/gb/gb.json` and `gb-nir.json` (sources on gov.uk, legislation.gov.uk and nidirect.gov.uk; each version lists the UK nations it was checked for); `packages/rules/goldens/gb.json` (bank holidays for England and Wales, Scotland and Northern Ireland, annual leave, SSP before and after 6 April 2026, working-time limits, right-to-work rules); `rules.int.test.ts` "keeps UK nations apart".
- [x] **2.3 US pack (base data)**
  - Federal holidays; FLSA overtime thresholds; FMLA parameters; Form I-9 retention rule; state/local layer structure with initial states recorded in COVERAGE.md — each value verified against dol.gov, uscis.gov, eeoc.gov or the relevant state source.
  - _Evidence:_ `packages/rules/packs/us/us.json`, `states/*.json` and `localities/us-ny-nyc.json` (sources on ecfr.gov, dol.gov, uscis.gov, eeoc.gov and state sites); `packages/rules/goldens/us.json` (federal holidays, FLSA thresholds, FMLA, I-9 retention, state values); initial states listed in `docs/COVERAGE.md`; `rules.int.test.ts` "accepts locality codes".
- [h] **2.4 EU pack (base data)**
  - EU baseline (minimum four weeks' paid annual leave, Working Time Directive limits) plus public holidays and statutory annual leave for all 27 member states, with official sources; deeper rules prioritised in COVERAGE.md.
  - _Evidence:_ the EU baseline (four weeks' leave, Working Time Directive limits, from eur-lex.europa.eu) statutory annual leave for all 27 member states, and public holidays for 24 of them, in `packages/rules/packs/eu/*.json` with vectors in `goldens/eu-a.json` and `eu-b.json`; deeper rules prioritised in `docs/COVERAGE.md`. _Human:_ Lithuanian, Romanian and Cypriot public holidays need a person, because their official portals block automated access (HUMAN_TODO 3.2, steps 1–6).
---

## Phase 3 — Time off and absence (6.2)

- [x] **3.1 Leave policy engine**
  - Policies per entity and country: accrual (annual, monthly, per hour worked), pro rata for part-time and mid-year joiners/leavers, carry-over with expiry, caps, waiting periods, negative balances, TOIL, unpaid and family leave types.
  - Tests first: balance calculations covered by table-driven tests including leap years, DST, part-time patterns and policy changes mid-year.
  - Requests, approvals (via approval chains), cancellations, balance adjustments with audit.
  - _Evidence:_ `apps/api/test/leave-engine.test.ts` (table-driven: leave years, pro rata for mid-year policy and FTE changes and joiners, monthly and per-hour accrual, working patterns and half days, a week across the clock change, a leap day, carry-over expiry, caps, negative balances, waiting periods, TOIL); `leave-policies.int.test.ts` (entity- and country-scoped policies, mid-year changes, per-hour accrual, carry-over, waiting period 422, TOIL, unpaid and family leave, request and cancel audit rows); `leave.int.test.ts` (requests through the approval chain, rejection, insufficient balance, audited HR adjustments); `apps/web/e2e/time-off.spec.ts` (request flow, axe).
- [x] **3.2 Public holidays and company calendars**
  - Public holidays from jurisdiction packs per country and region (UK nations, EU member states, US federal) plus company calendars; working patterns determine deductions.
  - _Evidence:_ `leave.int.test.ts` ("public holidays per region and calendars": Scottish bank holidays in leave counts, company closure days); `leave-engine.test.ts` ("request amounts with working patterns, holidays and DST", part-timers' non-working days not deducted).
- [x] **3.3 Sickness absence and statutory sick pay tracking**
  - Sickness records with fit notes/documents stored in the sensitive vault; return-to-work forms.
  - Statutory sick pay tracking from pack rules: UK SSP, EU member-state rules where held, US state and local paid sick leave accruals; golden tests per rule.
  - _Evidence:_ `leave.int.test.ts` (sickness reasons and fit notes in the vault, return-to-work, UK SSP for linked spells); `absence.int.test.ts` (fit notes required after the company threshold, medical detail readable by HR and the employee only with refusals audited, SSP per region); `leave-engine.test.ts` golden vectors ("UK statutory sick pay … both sides of 6 April 2026", "EU employer sick pay" per held member state, "US state paid sick leave" per state pack).
- [x] **3.4 US FMLA**
  - Eligibility checks (employer coverage, length of service, hours worked, worksite employee count) from pack data; leave year methods; intermittent leave tracking; golden tests.
  - _Evidence:_ `absence.int.test.ts` ("US FMLA": leave-year method from the pack, 75-mile worksite count, recorded or HR-provided hours, intermittent usage in hours, coverage from headcount history); `leave.int.test.ts` (eligibility from the US pack); `leave-engine.test.ts` (every leave-year method in the pack).
- [x] **3.5 Absence analytics**
  - Bradford factor, configurable trigger alerts, team calendar, cover rules (minimum staffing) and per-user ICS feeds with revocable tokens and no sensitive detail.
  - _Evidence:_ `leave-engine.test.ts` ("absence analytics": Bradford factor); `leave.int.test.ts` (trigger alerts deduplicated, minimum-cover block, team calendar hiding sensitive types, token-scoped revocable ICS); `absence.int.test.ts` (masking per viewer, ICS tokens tenant-bound and own-only revocation, trigger windows and manager notification); `leave-policies.int.test.ts` (cover rule that warns).
---

## Phase 4 — Rotas and time tracking (6.3)

- [x] **4.1 Rota builder**
  - Rota templates, availability, open shifts, shift swaps with approval, publish and notify (email + web push).
  - Rota view for 10,000+ shift workers in one tenant stays responsive (virtualised grid; benchmark recorded).
  - _Evidence:_ `apps/api/test/rota.int.test.ts` (templates: create and apply; availability self-service; published and open shifts for employees; claims and swaps with manager approval, declines and a working-time re-check on approval; publish notifies each affected employee once by email and web push; permission refusals and tenant isolation; the grid pages employees by keyset); `apps/web/e2e/rota.spec.ts`; `apps/web/e2e/rota-bench.spec.ts` and `scripts/bench-rota.ts` (10,000 workers, 50,000 shifts: grid page p95 80 ms, 27 rows in the DOM, `docs/PERFORMANCE.md` §2.4).
- [x] **4.2 Clock in and out**
  - Clock in/out from the PWA with an offline queue that syncs idempotently.
  - Optional geofence: off by default, configurable per country, with notice text shown to workers.
  - Shared kiosk mode with per-employee PIN (rate-limited, hashed).
  - _Evidence:_ `apps/api/test/time.int.test.ts` (the same offline batch twice gives no duplicates; geofence off by default with coordinates discarded, enabled per country with notice; kiosk token shown once and hashed, Argon2id PIN, lockout without enumeration, per-kiosk rate limit, own-tenant only; audited manager corrections); `apps/web/e2e/clock.spec.ts` (offline punches queued and replayed idempotently; location requested only when geofencing is on); `apps/web/e2e/kiosk.spec.ts`.
- [x] **4.3 Working-time rules**
  - From pack data: US FLSA weekly overtime and state daily overtime; EU Working Time Directive limits and rest periods; UK 48-hour week with opt-out records; daily time recording where a country requires it.
  - Golden tests for every rule; violations surfaced as warnings/blocks per tenant configuration.
  - _Evidence:_ `apps/api/test/rota.int.test.ts` (warn 201 or block 422 per tenant setting, citing the official source; the GB 48-hour average unless the worker opted out; projected US-CA daily overtime); `apps/api/test/timesheets.int.test.ts` (48-hour flag and opt-out records, CA 13-hour day, daily recording for Spain and Germany); golden vectors for every working-time and overtime rule version in `packages/rules/goldens/*.json` (enforced by the golden coverage test); `apps/api/test/time-engine.test.ts` (FLSA weekly and state daily overtime, shifts across zones and DST).
- [x] **4.4 Timesheets**
  - Timesheets compared with the rota (variances highlighted), overtime calculation, approvals and payroll export feed.
  - _Evidence:_ `apps/api/test/timesheets.int.test.ts` (rota vs recorded time with variances and overtime; the employee submits and the manager approves; the payroll export feed is reproducible, audited and permission-checked); `apps/web/e2e/timesheets.spec.ts`.
---

## Phase 5 — Compliance centre content (rest of 6.4)

- [ ] **5.1 UK compliance**
  - Right-to-work checks with follow-up dates and retention period.
  - Holiday rules including irregular-hours and part-year accrual.
  - SSP rules wired to sickness records.
  - Probation and service-length alerts, including the six-month unfair dismissal qualifying period from 1 January 2027 under the Employment Rights Act 2025 (rule effective-dated and verified against legislation.gov.uk / gov.uk).
  - Gender pay gap data for employers with 250+ staff (snapshot date per sector, calculations with golden tests).
- [ ] **5.2 US compliance**
  - Form I-9 tracking with reverification dates and retention calculation (golden tests).
  - Exempt and non-exempt classification with FLSA and state overtime.
  - State and local paid sick leave; FMLA.
  - EEO-1 data with voluntary self-identification stored as sensitive data.
  - State coverage table in COVERAGE.md.
- [ ] **5.3 EU compliance**
  - EU baseline rules plus member-state public holidays and statutory leave.
  - Deeper member-state rules (sick pay, notice periods) for prioritised states, tracked in COVERAGE.md.
  - EU Pay Transparency Directive reporting data, with each member state's implementation status verified and recorded.
- [ ] **5.4 Compliance matrix**
  - Licences, certifications, background checks and training per role/location with expiry tracking, reminders and a status dashboard.
- [ ] **5.5 Law-changes feed**
  - Back-office-maintained feed entries (jurisdiction, effective date, summary, what to do, linked rule versions); customers see entries relevant to their jurisdictions with read/acknowledged state.

---

## Phase 6 — Payroll handoff and IT automation (6.5, 6.6)

- [ ] **6.1 Payroll connector framework**
  - Per-tenant field mapping; pay-period exports of hours, absences, sick pay data, pay changes, starters and leavers; delivery by download, SFTP or API.
  - Exports are reproducible for a closed period and audit-logged.
- [ ] **6.2 First payroll connectors**
  - Generic CSV/Excel, SFTP and Xero Payroll (UK) connectors, tested against mocks.
  - Documented stubs for ADP, Workday, UKG, Gusto and DATEV; partner-programme steps in HUMAN_TODO.md.
- [ ] **6.3 Payslip and year-end document upload**
  - Bulk upload with employee matching, employee self-service access and notifications.
- [ ] **6.4 Microsoft 365 and Google Workspace joiner/leaver automation**
  - Joiners: create accounts, assign licences and groups. Leavers: block sign-in, revoke sessions, remove licences.
  - Per-customer admin consent, least-privilege scopes, dry-run preview, audit log; tested against mocked Graph and Admin SDK APIs.
- [ ] **6.5 Asset register**
  - Assets with assignment, handover sign-off and a return checklist tied to offboarding.

---

## Phase 7 — Reports, analytics and self-service (6.7, 6.8)

- [ ] **7.1 Ready-made reports per jurisdiction**
  - Headcount, turnover, absence, holiday liability, overtime, compliance status, gender pay gap, EEO-1 and pay transparency data; golden tests for calculations.
- [ ] **7.2 Report builder**
  - Fields, filters, grouping and charts; runs on read replicas; permission-aware (field-level and scope); CSV, Excel and PDF export; scheduled delivery.
  - Large reports run as background jobs with progress tracking.
- [ ] **7.3 Scheduled data export**
  - Scheduled export to the customer's own S3 bucket (cross-account role) or SFTP; delivery log.
- [ ] **7.4 Employee self-service (PWA)**
  - Own details, leave, rota, shift swaps, clock-in, payslips, documents, signing, checklists; notifications by email and web push; all localised; WCAG 2.2 AA and Lighthouse targets met on key ESS screens.

---

## Phase 8 — Privacy and trust (6.9)

- [ ] **8.1 Data subject requests**
  - Per-person access export (machine-readable JSON plus PDF), correction and deletion workflows; deadlines tracked per law (GDPR, UK GDPR, CCPA/CPRA) with extensions and reminders.
- [ ] **8.2 Retention engine**
  - Retention rules per data category and jurisdiction with suggested defaults documented with sources and marked for legal review; automatic deletion or anonymisation jobs; deletion log.
- [ ] **8.3 Company data export and account closure**
  - Full company data export at any time (background job, downloadable archive); account closure with a grace period, then verified deletion across database, files, caches, search and backups (backup expiry documented).
- [ ] **8.4 Legal and incident tooling**
  - DPA acceptance tracking; sub-processor list per region (public page + change notifications); privacy notice templates per jurisdiction (for legal review).
  - Incident and breach log with deadline reminders (72 hours under GDPR and UK GDPR; US state notification rules recorded).
- [ ] **8.5 Trust page and compliance mapping**
  - Public security and trust page; SOC 2 and ISO 27001 controls mapping in `docs/COMPLIANCE.md`.

---

## Phase 9 — Enterprise platform (6.10)

- [ ] **9.1 Public REST API and SDK**
  - OAuth 2.0 client credentials and scoped API keys; per-tenant rate limits; idempotency keys; cursor pagination; versioning; published API docs from the OpenAPI spec; TypeScript SDK generated and tested.
  - Contract tests prove the implementation matches the published spec.
- [ ] **9.2 Webhooks**
  - Signed payloads (HMAC with rotation), retries with backoff, replay, delivery log; driven by the transactional outbox.
- [ ] **9.3 Audit log streaming**
  - Streaming and export for customer SIEMs (e.g. HTTPS/S3 delivery) with filtering.
- [ ] **9.4 Sandbox tenants**
  - Sandbox created from a tenant's production configuration with synthetic data only (no personal data copied — tested).
- [ ] **9.5 Feature flags, branding and dedicated databases**
  - Per-tenant feature flags; custom branding (logo, accent within contrast limits); dedicated-database option operational via runbook and tested.

---

## Phase 10 — Support, back office, pricing and billing (6.11, 6.12)

- [ ] **10.1 Help centre and support tickets**
  - In-app help centre; support tickets stored in the home region, open to admins and employees; SLA timers per plan; configurable contact channels.
- [ ] **10.2 Thapsus back office**
  - Tenants and regions, plans and contracts, usage, support, jurisdiction rule data editing, law-changes feed, feature flags, audit trail of staff actions.
  - Back-office users see personal data only through granted, logged support access (tested).
- [ ] **10.3 Status page**
  - Public status page per region.
- [ ] **10.4 Self-serve pricing and billing**
  - Published prices by headcount band (from configuration), monthly rolling or annual, free trial, upgrade/downgrade, cancel with notice.
  - Stripe Billing + Stripe Tax in GBP, EUR and USD (test mode); failed-payment emails; no employee personal data sent to Stripe.
- [ ] **10.5 Enterprise contracts**
  - Custom pricing, annual invoicing, purchase orders, multi-entity billing configured in the back office; prices, bands and discounts never hardcoded.

---

## Phase 11 — AI assistant (6.13)

- [ ] **11.1 "Ask HR"**
  - Behind a per-tenant feature flag, off by default.
  - Answers employee questions from the company's own policy documents with citations to the source document; clear "you are talking to AI" disclosure.
  - Refuses to make or recommend employment decisions (hiring, performance, pay, dismissal) — tested with a red-team prompt suite.
  - Never sends sensitive data or other employees' data (tested); processing in the tenant's home region where available (provider/region availability verified and recorded); provider listed in SUBPROCESSORS.md.

---

## Phase 12 — Scale and launch readiness

- [ ] **12.1 Load tests** — k6 scenarios meet brief §3 targets (200,000 employees / 50 entities; 5,000 concurrent users; 20,000 clock-ins in 10 minutes; p95 < 300 ms common reads, < 1 s paginated lists); results in `docs/PERFORMANCE.md`; load-test environment torn down afterwards.
- [ ] **12.2 Threat model** — STRIDE threat model documented in `docs/SECURITY.md` with mitigations and owners.
- [ ] **12.3 OWASP ASVS level 2 review** — checklist completed with evidence links; gaps fixed or recorded.
- [ ] **12.4 Dependency and secret scanning** — clean results in CI; process documented.
- [ ] **12.5 Accessibility audit** — WCAG 2.2 AA audit of key flows (automated + manual checklist) with fixes.
- [ ] **12.6 Visual polish pass** — every screen checked against `docs/DESIGN.md` in light and dark mode on phone and desktop; visual regression baselines updated.
- [ ] **12.7 Lighthouse targets** — mobile ≥90 performance and ≥95 accessibility on key marketing pages and app screens.
- [ ] **12.8 Resilience drills** — backup restore drill (RPO ≤ 15 min, RTO ≤ 4 h demonstrated) and availability-zone failure drill, results recorded.
- [ ] **12.9 Staging in all three regions** — staging deployed in UK, EU and US; `pnpm smoke:staging` passes in each (sign up, choose region, SSO login, add employee, request leave, clock in, export data).
- [ ] **12.10 Production readiness** — production stacks defined and ready to deploy on approval; runbooks complete.

---

## Documentation (brief §9)

- [ ] README
- [ ] ARCHITECTURE (with diagrams)
- [ ] DESIGN
- [ ] SECURITY
- [ ] DECISIONS
- [ ] COSTS (per environment and region)
- [ ] PERFORMANCE
- [ ] COVERAGE
- [ ] SUBPROCESSORS
- [ ] COMPLIANCE (SOC 2 and ISO 27001 mapping)
- [ ] HUMAN_TODO
- [ ] API docs
- [ ] Runbook: deploy
- [ ] Runbook: rollback
- [ ] Runbook: backup restore
- [ ] Runbook: incident and breach response
- [ ] Runbook: moving a tenant to a dedicated database
- [ ] DPIA template
- [ ] Records of processing draft
- [ ] DPA templates per jurisdiction ("for legal review")
- [ ] Privacy notice templates per jurisdiction ("for legal review")
- [ ] Admin guide
- [ ] Employee guide

## Definition of done (brief §10)

- [ ] Every phase and feature above is ticked.
- [ ] `pnpm verify` passes.
- [ ] Staging deployed in all three regions and `pnpm smoke:staging` passes in each.
- [ ] `pnpm loadtest` meets the §3 targets, with results in `docs/PERFORMANCE.md`.
- [ ] Production stacks defined and ready to deploy on approval.
- [ ] All §9 documents exist.
- [ ] Every remaining human-only step is listed in `docs/HUMAN_TODO.md`.
