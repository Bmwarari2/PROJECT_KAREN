# Thapsus-HR delivery progress

Status of every phase and feature in `docs/BUILD_BRIEF.md`, with acceptance criteria (AC). A feature is ticked only when **all** of its AC are proven by automated tests or checks in `pnpm verify`, or, for steps only a human can do, are listed in `docs/HUMAN_TODO.md` with the build running against mocks or test mode.

**Phase exit gate (every phase):** `pnpm verify` passes · affected docs updated · this file ticked · work committed on the phase branch · verify summary printed in the conversation.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done (AC met) · `[h]` done except human-only steps (see HUMAN_TODO.md)

## Summary

| Phase | Scope                                                          | Branch                       | Status                                |
| ----- | -------------------------------------------------------------- | ---------------------------- | ------------------------------------- |
| 0     | Foundations                                                    | `phase-0-foundations`        | [h]                                   |
| 1     | Core HR and organisation model (6.1)                           | `phase-1-core-hr`            | [x]                                   |
| 2     | Jurisdiction pack framework + UK, US, EU packs (6.4 framework) | `phase-2-jurisdiction-packs` | [h]                                   |
| 3     | Time off and absence (6.2)                                     | `phase-3-time-off`           | [x]                                   |
| 4     | Rotas and time tracking (6.3)                                  | `phase-4-rotas-time`         | [x]                                   |
| 5     | Compliance centre content (rest of 6.4)                        | `phase-5-compliance`         | [x]                                   |
| 6     | Payroll handoff and IT automation (6.5, 6.6)                   | `phase-6-payroll-it`         | [x]                                   |
| 7     | Reports, analytics and self-service (6.7, 6.8)                 | `phase-7-reports-ess`        | [x]                                   |
| 8     | Privacy and trust (6.9)                                        | `phase-8-privacy`            | [h]                                   |
| 9     | Enterprise platform (6.10)                                     | `phase-9-enterprise`         | [x]                                   |
| 10    | Support, back office, pricing and billing (6.11, 6.12)         | `phase-10-support-billing`   | [h]                                   |
| 11    | AI assistant behind a feature flag (6.13)                      | `phase-11-ai-assistant`      | [h]                                   |
| 12    | Scale and launch readiness                                     | `phase-12-launch`            | [~] (AWS runs left: 12.1, 12.8, 12.9) |

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

- [x] **5.1 UK compliance**
  - Right-to-work checks with follow-up dates and retention period.
  - Holiday rules including irregular-hours and part-year accrual.
  - SSP rules wired to sickness records.
  - Probation and service-length alerts, including the six-month unfair dismissal qualifying period from 1 January 2027 under the Employment Rights Act 2025 (rule effective-dated and verified against legislation.gov.uk / gov.uk).
  - Gender pay gap data for employers with 250+ staff (snapshot date per sector, calculations with golden tests).
  - _Evidence:_ `apps/api/test/compliance.int.test.ts` ("5.1 UK right-to-work checks": methods, document lists, follow-up and retention from the GB pack, evidence only in the vault with audited decrypts, idempotent reminders and tasks, two-year retention after leaving; "5.1 probation and service-length alerts" with the ERA 2025 qualifying period effective-dated; "5.1 holiday accrual and SSP": irregular-hours 12.07% check and the SSP view reading the leave module; "5.1 / 5.3 pay reporting": UK gender pay gap with sex decrypted from the vault and audited); `apps/api/test/compliance-engine.test.ts` (right-to-work follow-up dates, reg. 15B irregular-hours accrual, the unfair dismissal qualifying period on both sides of 1 January 2027 and for Northern Ireland, and the gender pay gap reproducing the GOV.UK worked example); GB pack v4 vectors in `packages/rules/goldens/gb.json`.
- [x] **5.2 US compliance**
  - Form I-9 tracking with reverification dates and retention calculation (golden tests).
  - Exempt and non-exempt classification with FLSA and state overtime.
  - State and local paid sick leave; FMLA.
  - EEO-1 data with voluntary self-identification stored as sensitive data.
  - State coverage table in COVERAGE.md.
  - _Evidence:_ `apps/api/test/compliance.int.test.ts` ("5.2 US Form I-9, FLSA, EEO-1 and leave coverage": Section 2 deadline, reverification, retention for leavers; California exempt threshold and duties attestation deciding overtime eligibility; EEO-1 self-identification only in the vault with small-cell suppression; state and local paid sick leave and FMLA coverage); `compliance-engine.test.ts` (I-9 dates including the USCIS retention example, federal and state exempt thresholds, EEO-1 aggregation); `packages/rules/test/coverage.test.ts` (the US state coverage table in COVERAGE.md lists every state and DC).
- [x] **5.3 EU compliance**
  - EU baseline rules plus member-state public holidays and statutory leave.
  - Deeper member-state rules (sick pay, notice periods) for prioritised states, tracked in COVERAGE.md.
  - EU Pay Transparency Directive reporting data, with each member state's implementation status verified and recorded.
  - _Evidence:_ member-state holidays and leave from Phase 2 (`goldens/eu-a.json`, `eu-b.json`); deeper rules for prioritised states (sick pay for DE, NL, IE, ES, FR, PL, IT; notice periods) with vectors and the priority list in `docs/COVERAGE.md`; `compliance.int.test.ts` ("EU pay transparency": indicators from payroll data with the member state's transposition status) and `compliance-engine.test.ts` ("EU Pay Transparency Directive"); `coverage.test.ts` (every member state has a recorded transposition status).
- [x] **5.4 Compliance matrix**
  - Licences, certifications, background checks and training per role/location with expiry tracking, reminders and a status dashboard.
  - _Evidence:_ `compliance.int.test.ts` ("5.4 compliance matrix": requirements per job title and location, records with expiry, status dashboard with filters, evidence documents checked per employee and scoped by role, idempotent expiry reminders to HR and the employee) and `compliance-engine.test.ts` ("compliance matrix"); `apps/web/e2e/compliance.spec.ts` (dashboard and matrix pages, axe in light and dark).
- [x] **5.5 Law-changes feed**
  - Back-office-maintained feed entries (jurisdiction, effective date, summary, what to do, linked rule versions); customers see entries relevant to their jurisdictions with read/acknowledged state.
  - _Evidence:_ `compliance.int.test.ts` ("5.5 law-changes feed": back-office entries posted with a staff passkey session and an approved `rules_publish` elevation, relevance by the tenant's entities, locations and employees, read and acknowledged state per admin with audit, other tenants and managers see nothing, withdrawal, one notification per new relevant entry); `apps/web/e2e/compliance.spec.ts` (an admin acknowledges a relevant law change).

---

## Phase 6 — Payroll handoff and IT automation (6.5, 6.6)

- [x] **6.1 Payroll connector framework**
  - Per-tenant field mapping; pay-period exports of hours, absences, sick pay data, pay changes, starters and leavers; delivery by download, SFTP or API.
  - Exports are reproducible for a closed period and audit-logged.
  - _Evidence:_ `apps/api/test/payroll.int.test.ts` ("validates the mapping…"; "a generic CSV connector with a per-tenant mapping exports hours, absences, sick pay, pay changes, starters and leavers"; "re-exporting a closed period is byte-identical (same SHA-256) even after live data changes"; "snapshots are append-only and closed periods cannot be reopened or moved"; "every export and download is audited and the download is in the delivery log"; permissions by role); delivery by SFTP in `payroll-sftp.int.test.ts` and by API in the Xero tests; rendering and determinism in `phase6-units.test.ts`; `apps/web/e2e/phase6.spec.ts` downloads an export and checks its SHA-256.
- [x] **6.2 First payroll connectors**
  - Generic CSV/Excel, SFTP and Xero Payroll (UK) connectors, tested against mocks.
  - Documented stubs for ADP, Workday, UKG, Gusto and DATEV; partner-programme steps in HUMAN_TODO.md.
  - _Evidence:_ CSV and Excel connectors in `payroll.int.test.ts` ("an Excel connector writes one typed sheet per section, reproducibly", "a single enabled section gives a plain CSV with a formula-injection guard"); SFTP in `payroll-sftp.int.test.ts` against an in-process ssh2 server (exact bytes to the pinned host, host-key mismatch refused, wrong credentials, SSRF guard); Xero Payroll UK against a mock of the official API shapes ("connects with OAuth 2.0…", "pushes timesheets per earnings rate and leave…", unmapped items reported, not offered to EU workspaces); ADP, Workday, UKG, Gusto and DATEV stubs ("documented stubs": 501 with a docs anchor) documented in `docs/integrations.md`; partner-programme steps in HUMAN_TODO 4.4.
- [x] **6.3 Payslip and year-end document upload**
  - Bulk upload with employee matching, employee self-service access and notifications.
  - _Evidence:_ `apps/api/test/payslips.int.test.ts` (matching a zip and loose PDFs by employee number; year-end documents by file-name pattern with ambiguous names flagged; only payroll roles upload; hand matching; publishing notifies each employee once; employees list and download only their own documents and every download is audited; withdrawal and discard); `apps/web/e2e/phase6.spec.ts` (an employee sees and downloads their own payslip, axe in light and dark).
- [x] **6.4 Microsoft 365 and Google Workspace joiner/leaver automation**
  - Joiners: create accounts, assign licences and groups. Leavers: block sign-in, revoke sessions, remove licences.
  - Per-customer admin consent, least-privilege scopes, dry-run preview, audit log; tested against mocked Graph and Admin SDK APIs.
  - _Evidence:_ `apps/api/test/it-automation.int.test.ts` against mocked Microsoft Graph and Google Admin SDK / Licensing endpoints (request shapes cited in `it/plan.ts`): per-customer admin consent with the secret sealed; "the dry run shows the exact Graph calls without calling Graph"; joiner jobs at the configured lead time; idempotent re-runs, failure and retry; safe adoption of existing accounts; backdated imports not provisioned; the leaver job "blocks sign-in, revokes sessions and removes licences"; Google domain-wide delegation with an RS256 JWT and least-privilege scopes; executions audited (`it.joiner_executed`); app registration steps in HUMAN_TODO 4.2 and 4.3; `apps/web/e2e/phase6.spec.ts` (integrations dry run).
- [x] **6.5 Asset register**
  - Assets with assignment, handover sign-off and a return checklist tied to offboarding.
  - _Evidence:_ `apps/api/test/assets.int.test.ts` (cost in minor units with a default return checklist per type; assignment with an acknowledgement request; only the employee can sign the handover, recording who, when and which statement; the offboarding workflow creates one return task per issued asset; a return needs every checklist item; lost assets close their task and the workflow completes); `apps/web/e2e/phase6.spec.ts` (asset acknowledgement, axe in light and dark).

---

## Phase 7 — Reports, analytics and self-service (6.7, 6.8)

- [x] **7.1 Ready-made reports per jurisdiction**
  - Headcount, turnover, absence, holiday liability, overtime, compliance status, gender pay gap, EEO-1 and pay transparency data; golden tests for calculations.
  - _Evidence:_ `apps/api/test/reports-goldens.test.ts` pins every calculation to explicit dates (headcount by entity and at month ends, turnover split voluntary/involuntary, absence by type with the Bradford factor S² × D, overtime, and holiday liability per currency in integer minor units); `apps/api/test/reports.int.test.ts` ("7.1 ready-made reports": effective-dated headcount, turnover, absence with the tenant-enabled Bradford factor, holiday liability per currency, overtime from approved timesheets, manager scope; "7.1 statutory reports from the compliance centre": gender pay gap, EEO-1, pay transparency and compliance status from the compliance calculators with small cells withheld). The holiday liability method is pending finance and legal review (HUMAN_TODO 3.15).
- [x] **7.2 Report builder**
  - Fields, filters, grouping and charts; runs on read replicas; permission-aware (field-level and scope); CSV, Excel and PDF export; scheduled delivery.
  - Large reports run as background jobs with progress tracking.
  - _Evidence:_ `reports.int.test.ts` ("7.2 report builder": catalogue by row permission, hidden fields null and not filterable, entity scope with money grouped by currency, audited vault reads, invalid specs refused; "7.2 reports run on the read replica": SQL on the reader pool as `thapsus_reporting` with forced RLS, writer fallback; "7.2 background runs": progress, home-region file, short-lived links, CSV/Excel/PDF, expiry; "7.2 saved reports and scheduled delivery": sharing, per-recipient permissions, once per period, email without personal data); `reports.isolation.test.ts` (reporting role has no BYPASSRLS, no writes, no vault or credentials); `reports-units.test.ts` (DST-safe schedules, relative periods, rendering); `infra/test/infra.test.ts` (`REPORTING_DATABASE_HOST` is the Aurora reader endpoint); `apps/web/e2e/reports-ess.spec.ts` (builder with a chart, saved report and delivery, axe in light and dark).
- [x] **7.3 Scheduled data export**
  - Scheduled export to the customer's own S3 bucket (cross-account role) or SFTP; delivery log.
  - _Evidence:_ `apps/api/test/exports.int.test.ts` (S3: ExternalId generated, other regions and roles outside `thapsus-hr-export-*` refused, delivery once per period by assuming the role, a bucket in another region refused before any write, run-as user permissions and no vault fields; SFTP: pinned host key, sealed password, key mismatch refused and logged without personal data; the delivery log); `reports-exports.residency.test.ts` (refusal for every region pair); `infra/test/infra.test.ts` ("data export": the API and worker may assume only customer roles named `thapsus-hr-export-*`); customer setup in `docs/guides/data-export.md`.
- [x] **7.4 Employee self-service (PWA)**
  - Own details, leave, rota, shift swaps, clock-in, payslips, documents, signing, checklists; notifications by email and web push; all localised; WCAG 2.2 AA and Lighthouse targets met on key ESS screens.
  - _Evidence:_ `apps/api/test/ess.int.test.ts` (the Me hub summarises leave, next shift, clock, documents to sign, tasks, notifications and payslips; notifications in the user's language; own details with contact changes applied directly and legal details sent to HR for approval; per-category email and push preferences honoured at delivery); leave, rota, shift swaps, clock-in, payslips, documents, signing and checklists are proven by their phase suites (Phases 1, 3, 4 and 6); `apps/web/e2e/reports-ess.spec.ts` (Me hub, my details with a change request and notification preferences, axe in light and dark); Lighthouse in `pnpm verify` covers `/app/me` and `/app/notifications`; visual baselines for `/app/me` and the reports screens.

---

## Phase 8 — Privacy and trust (6.9)

- [x] **8.1 Data subject requests**
  - Per-person access export (machine-readable JSON plus PDF), correction and deletion workflows; deadlines tracked per law (GDPR, UK GDPR, CCPA/CPRA) with extensions and reminders.
  - _Evidence:_ `apps/api/test/privacy-dsr.int.test.ts` ("uses the law of the subject: UK GDPR Art. 12A, CCPA 45 days, none in Texas"; "restarts the UK clock when identity information arrives and stops it for access clarification"; "allows one extension, only before the initial deadline, with a reason"; "sends deadline reminders once per threshold and an overdue notice (idempotent daily job)"; "exports every table about the person as JSON plus a PDF, decrypting vault values with an audit entry each"; "withholds vault categories the person running it cannot read…"; "applies the correction as an effective-dated change through the employees service, with audit"; "refuses while a legal hold applies, then erases what no statutory minimum keeps and logs counts only"); `packages/rules/test/privacy.test.ts` (UK before and after Article 12A, "EU member states use the GDPR baseline", "California: 45 days, extendable once by 45 days (90 in total)"); `privacy-coverage.int.test.ts` ("maps every person reference in the live catalog"); `privacy.residency.test.ts` (the export stays in the home cell for every region pair); `apps/web/e2e/privacy.spec.ts` ("an admin logs an access request with its legal deadline and downloads the export"). The rule values are pending legal review (HUMAN_TODO 3.16).
- [h] **8.2 Retention engine**
  - Retention rules per data category and jurisdiction with suggested defaults documented with sources and marked for legal review; automatic deletion or anonymisation jobs; deletion log.
  - _Evidence:_ `apps/api/test/privacy-retention.int.test.ts` ("lists pack rules per category and jurisdiction with sources, marked for legal review"; "rejects tenant periods below a statutory minimum but accepts longer ones and periods for suggested defaults"; "dry run counts what would go, deletes nothing and is logged"; "deletes only for enabled categories, honours legal holds and logs the rule version without personal data"; "anonymises leavers once the personnel-records period has passed"; "automatic retention (worker schedule)": no scheduled run until a policy is enabled, then exactly one per UTC date, which applies the policy and is logged); GB and US retention values in the packs with sources and `legalReview: pending` (review in HUMAN_TODO 3.16). _Human:_ EU member-state retention periods are a recorded coverage gap (`docs/COVERAGE.md`, HUMAN_TODO 3.16 step 7); until they are added, EU tenants get the engine with tenant-chosen periods and no statutory minimum.
- [x] **8.3 Company data export and account closure**
  - Full company data export at any time (background job, downloadable archive); account closure with a grace period, then verified deletion across database, files, caches, search and backups (backup expiry documented).
  - _Evidence:_ `apps/api/test/privacy-closure.int.test.ts` ("exports every tenant table, decrypted sensitive data and stored files as a zip with a manifest", run as the `privacy.company_export` job with a download link; "requires typing the workspace name, can be cancelled, and is owner-only", 30-day grace period; "after the grace period deletes the tenant everywhere, verifies it and issues a certificate": no rows in any tenant table, which also holds the PostgreSQL search columns, no files, no rate-limit cache keys, and the other tenant is untouched); `apps/worker/test/closed-tenant.int.test.ts` ("finishes without errors and the tenant is no longer processed"); backup expiry in `packages/core/test/trust.test.ts` ("the backup expiry stated to customers matches the longest backup retention in the infrastructure config").
- [x] **8.4 Legal and incident tooling**
  - DPA acceptance tracking; sub-processor list per region (public page + change notifications); privacy notice templates per jurisdiction (for legal review).
  - Incident and breach log with deadline reminders (72 hours under GDPR and UK GDPR; US state notification rules recorded).
  - _Evidence:_ `apps/api/test/privacy-legal.int.test.ts` ("records acceptance of the current version at sign-up, requires re-acceptance of a new version, owner only"; "serves the per-region list and notifies subscribed admins of changes once, for their region only"; "serves UK, EU and US templates marked for legal review and saves an editable tenant copy"; "computes deadlines per jurisdiction from the packs, flags unmodelled ones and reminds before they pass"; "records the Thapsus-side breach register (staff only) and notifies affected controllers in their own log"); `packages/rules/test/privacy.test.ts` ("72 hours from awareness under UK GDPR and GDPR; processor without undue delay", "US state day limits and thresholds"); `packages/core/test/trust.test.ts` (sub-processors for every region, notice period, DRAFT banners); `apps/web/e2e/privacy.spec.ts` ("the sub-processor list shows only the chosen region’s locations", axe in light and dark). Legal review of the drafts and rule values is HUMAN_TODO 3.3 and 3.16.
- [x] **8.5 Trust page and compliance mapping**
  - Public security and trust page; SOC 2 and ISO 27001 controls mapping in `docs/COMPLIANCE.md`.
  - _Evidence:_ `apps/web/e2e/privacy.spec.ts` ("/trust renders and passes axe (light and dark)"; "the trust page shows residency per region and links to the sub-processor list"); `docs/COMPLIANCE.md` maps the controls to the SOC 2 Trust Services Criteria and ISO/IEC 27001:2022 Annex A, with a status, evidence paths and test names for each control (all resolve) and a table of gaps with owners.

---

## Phase 9 — Enterprise platform (6.10)

- [x] **9.1 Public REST API and SDK**
  - OAuth 2.0 client credentials and scoped API keys; per-tenant rate limits; idempotency keys; cursor pagination; versioning; published API docs from the OpenAPI spec; TypeScript SDK generated and tested.
  - Contract tests prove the implementation matches the published spec.
  - _Evidence:_ `apps/api/test/public-api.int.test.ts` (scoped API keys "are shown once, prefix-identifiable, hashed at rest and resolve to an api_client principal", "get the intersection of the role and the scopes", "can never carry permissions the creator does not hold"; "list endpoints use cursor pagination (?cursor&limit → nextCursor)"; OAuth 2.0 client credentials "issues short-lived bearer tokens limited to the requested scopes; rotation keeps the old secret for the grace period"; per-tenant rate limits "returns 429 with Retry-After and RateLimit headers once the tenant limit is used up; other tenants are unaffected"; idempotency keys "replay the stored response for the same key and body, refuse a different body, and are scoped per caller"; versioning "formats RFC 9745 Deprecation, RFC 8594 Sunset and a deprecation Link"); `apps/api/test/sdk.int.test.ts` (the TypeScript SDK "reads and writes with a scoped API key, paginates, and sends idempotency keys" and "gets an OAuth 2.0 client-credentials token and calls the API with it"); `packages/sdk/test/generated-types.test.ts` ("the generated SDK types match openapi.json"); the contract project (`*.contract.test.ts`: responses validated against the published OpenAPI 3.1 document, which is checked for freshness); `apps/web/e2e/platform.spec.ts` ("the developer documentation is generated from the OpenAPI document and accessible"; API key shown exactly once).
- [x] **9.2 Webhooks**
  - Signed payloads (HMAC with rotation), retries with backoff, replay, delivery log; driven by the transactional outbox.
  - _Evidence:_ `apps/worker/test/webhooks.int.test.ts` ("are signed, driven by the outbox, retried with backoff, logged and replayable"; "give up after the maximum number of attempts"; "sign with both secrets while a rotation is in its grace period, then only the new one"; "are not created while the webhooks feature is off"; "refuses private, loopback, metadata and non-https destinations under the production policy"); `apps/api/test/outbound.test.ts` ("sign and verify with the reference verifier and the SDK verifier", "reject stale timestamps (replay protection)", "carry one v1 per active secret during a rotation", "retries with exponential backoff, capped", no redirects, DNS-rebinding block); `openapi.contract.test.ts` (webhook endpoints match the spec); `apps/web/e2e/platform.spec.ts` ("an admin adds a webhook endpoint, sees the signing secret once and finds it in the list", axe).
- [x] **9.3 Audit log streaming**
  - Streaming and export for customer SIEMs (e.g. HTTPS/S3 delivery) with filtering.
  - _Evidence:_ `apps/worker/test/audit-streams.int.test.ts` ("delivers new sealed events matching the filters in signed, idempotent batches and advances the cursor"; "streams sensitive-only and actor-type filtered views, without sensitive values"; "writes NDJSON objects with deterministic keys through STS AssumeRole with the external id"; "refuses a role whose name does not start with thapsus-hr-audit- (422 roleNotAllowed)…"; "stops when the feature is off"); `apps/api/test/audit-stream-roles.test.ts` ("accept only roles named thapsus-hr-audit-* in the aws partition, without a path"; "the cross-account S3 writer refuses a role outside thapsus-hr-audit-* without sending anything"); `infra/test/infra.test.ts` ("cross-account roles: … the worker only thapsus-hr-audit-* (S3 audit streams)"); `apps/api/test/enterprise.residency.test.ts` (S3 streams only to the home region, every region pair); export: `apps/api/test/platform.int.test.ts` ("every successful mutating call writes an audit entry, and exports are filtered by date in CSV and JSON").
- [x] **9.4 Sandbox tenants**
  - Sandbox created from a tenant's production configuration with synthetic data only (no personal data copied — tested).
  - _Evidence:_ `apps/api/test/sandbox.int.test.ts` ("classifies every tenant-scoped table…"; "copies configuration only and generates synthetic people", with person references removed from the copied configuration; "copies NO personal data: zero overlap in every personal-data column, and no source rows in personal, operational or secret tables"; "opens with a one-time sign-in link for the synthetic owner (MFA enrolment required) and shows only synthetic people"); `apps/api/test/outbound.test.ts` ("removes person references and turns named approvers into the HR admin role"); `enterprise.residency.test.ts` (the sandbox stays in the source's home region for every region pair). Legal review of the table classification is HUMAN_TODO 6.5.
- [x] **9.5 Feature flags, branding and dedicated databases**
  - Per-tenant feature flags; custom branding (logo, accent within contrast limits); dedicated-database option operational via runbook and tested.
  - _Evidence:_ `apps/api/test/tenant-platform.int.test.ts` (feature flags "resolve defaults, are toggled by company admins (tenant-managed only) and reach the app shell" and "are toggled by Thapsus staff in the back office (super admins only), audited in both trails"; custom branding "accepts an accent only when WCAG 2.2 AA contrast holds in light and dark mode" and "stores the logo in the home-region object store under the tenant prefix and serves it to signed-in users only"; "moves a tenant through a tracked back-office request and the tenant passes the same checks afterwards"); `apps/api/test/dedicated-db.int.test.ts` ("passes the same API suite before and after the move with no code change"; "refuses writes while a tenant is moving"); `packages/db/test/router.test.ts` (DEDICATED_DATABASE_HOSTS routing and refusal of unusable hosts); `packages/db/test/dedicated-db.residency.test.ts` (a dedicated database or reader in another region is refused, every region pair); `infra/test/infra.test.ts` (the committed configs declare no dedicated database; an entry creates an encrypted cluster and proxy in the cell's own region and wires DEDICATED_DATABASE_HOSTS into the api and worker); `scripts/test/deploy-plan.test.ts` (a cell deploy migrates its dedicated databases); the runbook `docs/runbooks/move-tenant-to-dedicated-db.md` matches these steps; `apps/web/e2e/platform.spec.ts` (brand accent rejected on failing contrast).

---

## Phase 10 — Support, back office, pricing and billing (6.11, 6.12)

- [x] **10.1 Help centre and support tickets**
  - In-app help centre; support tickets stored in the home region, open to admins and employees; SLA timers per plan; configurable contact channels.
  - _Evidence:_ `packages/core/test/help.test.ts` ("every article is versioned, linked from app pages and localised in en-GB and en-US"; search with UK/US spelling folding and prefix matching); `apps/api/test/support.int.test.ts` ("searches localised articles and returns contextual articles for an app page"; "employees see their own tickets; admins see every ticket in the company"; "only admins may raise urgent tickets"; "stores attachments in the home-region object store under the tenant prefix, with type and size limits"; "an employee raises a ticket; SLA deadlines come from the plan, priority and region support hours"; SLA escalation "…once when at risk and once when breached, without ticket text" from an idempotent job; "a support staff override replaces the configured channels for this region (append-only, audited)"); `packages/core/test/sla.test.ts` (support hours in the region time zone, DST-safe, deadlines and states per plan and priority); `packages/core/test/billing.test.ts` ("resolves contact channels per plan and region…"); `support-billing.residency.test.ts` (tickets and files stay in the home cell, every region pair); forced RLS on the ticket tables in `rls.isolation.test.ts`; `apps/web/e2e/support.spec.ts` (help search, a ticket with an attachment and a reply, with axe). Support mailboxes and phone numbers: HUMAN_TODO 4.7.
- [x] **10.2 Thapsus back office**
  - Tenants and regions, plans and contracts, usage, support, jurisdiction rule data editing, law-changes feed, feature flags, audit trail of staff actions.
  - Back-office users see personal data only through granted, logged support access (tested).
  - _Evidence:_ `apps/api/test/backoffice.int.test.ts` ("staff sign in only with a passkey: no password or code routes, a one-time enrolment link, and tenant sessions never work there", and staff roles enforced; "lists this cell's tenants with usage aggregates only (counts and bytes)"; "shows every region from the global directory only…"; tenant detail without billing contacts or employee data; plans from the billing config location; contracts; "super admins export the append-only staff trail as CSV; the export is itself recorded"; "personal data only through granted, logged support access": no grant, an expired grant or a revoked grant gives 403 and the denied attempt is logged, a read grant is written to the customer audit log and the staff trail and cannot write, a read-and-write grant is audited in both logs); `support.int.test.ts` ("staff work the queue: every view and reply is audited in the customer log and the staff trail"; the queue index holds routing metadata only); rule editing in `rules.int.test.ts` ("requires a staff passkey session and an approved elevation, appends versions (never overwrites) and takes effect for lookups") and "rules editors get the catalogue for the rule-editing screen"; law-changes entries posted and withdrawn by staff in `compliance.int.test.ts` ("5.5 law-changes feed"); feature flags in `tenant-platform.int.test.ts` ("are toggled by Thapsus staff in the back office (super admins only), audited in both trails"); `apps/web/e2e/backoffice.spec.ts` ("staff sign in with a passkey and work the support queue", with axe; a virtual WebAuthn authenticator).
- [x] **10.3 Status page**
  - Public status page per region.
  - _Evidence:_ `apps/api/test/status.int.test.ts` ("is public, describes only this region, carries no personal data and may be cached at the edge", while other responses stay `private, no-store`; email delivery health from recorded outcomes; "support staff post an incident with updates; the page shows it for this region; every post is audited"); `status.test.ts` (component health, posted incidents and maintenance, measured outages never hidden); `support-billing.residency.test.ts` (each cell's status speaks for its own region only, every region pair); `apps/web/e2e/status.spec.ts` ("renders each region separately, with posted incidents, and is accessible"); `/status` in Lighthouse and the visual baselines. `status.<domain>` DNS: HUMAN_TODO 4.8.
- [h] **10.4 Self-serve pricing and billing**
  - Published prices by headcount band (from configuration), monthly rolling or annual, free trial, upgrade/downgrade, cancel with notice.
  - Stripe Billing + Stripe Tax in GBP, EUR and USD (test mode); failed-payment emails; no employee personal data sent to Stripe.
  - _Evidence:_ `packages/core/test/billing.test.ts` (config v1 with prices for every band in GBP, EUR and USD, broken configs rejected; quotes per headcount band in integer minor units; annual term discount and discount codes; upgrades immediate and downgrades at period end, proration by the minute; "cancels at the first period end after the notice period (monthly rolling, annual, trial)"; "trial length comes from config"); `apps/api/test/billing.int.test.ts` (trial at sign-up; "publishes plans and prices from the billing configuration (public endpoint)"; start, upgrade, downgrade, annual to monthly, cancel with notice and reactivate against a recording provider; signed, idempotent webhooks; "records failed payments once per event id, marks the subscription past due and emails the billing contacts from the home region"; "every payload sent to the provider holds company-level data, ids and aggregate counts only"); `billing-stripe.test.ts` (Stripe Billing and Stripe Tax request shapes with automatic tax and the product tax code in each currency, Stripe-hosted card setup, webhook signatures with the official SDK, "accepts only test-mode keys until live mode is approved"); `support-billing.residency.test.ts` (webhooks and failed-payment emails stay in the home cell, every region pair); `infra/test/infra.test.ts` (each cell's Stripe keys come from its own secret); `apps/web/e2e/pricing.spec.ts` and `billing.spec.ts` (with axe); `/pricing` in Lighthouse and the visual baselines. _Human:_ the regional Stripe test-mode accounts, Stripe Tax registrations and keys (HUMAN_TODO 4.1) and the webhook endpoints (HUMAN_TODO 4.6); until then no test reaches Stripe's own test-mode API. Draft terms await commercial review (HUMAN_TODO 4.9).
- [x] **10.5 Enterprise contracts**
  - Custom pricing, annual invoicing, purchase orders, multi-entity billing configured in the back office; prices, bands and discounts never hardcoded.
  - _Evidence:_ `apps/api/test/backoffice.int.test.ts` ("enterprise contracts and multi-entity billing (configured in the back office)": legal entities grouped into a separately invoiced billing account with its own currency and PO number; draft contracts whose prices come from the contract record and are validated; activation bills each account by invoice with payment terms, custom pricing and PO numbers; active terms locked, renewal flagged within the notice window, ending stops billing at the end date; each step in the staff trail); `packages/core/test/billing.test.ts` ("uses back-office contract pricing overrides (unit, flat fee or discount) instead of the published price"; "billing and pricing source files contain no price literals"); `billing-stripe.test.ts` (invoice collection with payment terms, PO number as an invoice custom field).

---

## Phase 11 — AI assistant (6.13)

- [h] **11.1 "Ask HR"**
  - Behind a per-tenant feature flag, off by default.
  - Answers employee questions from the company's own policy documents with citations to the source document; clear "you are talking to AI" disclosure.
  - Refuses to make or recommend employment decisions (hiring, performance, pay, dismissal) — tested with a red-team prompt suite.
  - Never sends sensitive data or other employees' data (tested); processing in the tenant's home region where available (provider/region availability verified and recorded); provider listed in SUBPROCESSORS.md.
  - _Evidence:_ flag: `packages/core/test/platform.test.ts` ("the AI assistant is off by default (brief §6.13)"), `apps/api/test/ai.int.test.ts` ("is off for a new tenant: status says disabled and ask/feedback are refused (403 featureDisabled)"; "needs both the staff-managed entitlement and the customer's own opt-in"; only the owner turns it on, audited) and `tenant-platform.int.test.ts` (staff toggle, super admins only, audited in both trails); answers: `ai.int.test.ts` (Markdown and PDF policies indexed idempotently, personal and non-policy documents never indexed; "answers from policy excerpts, cites the real document, and discloses AI" in the asker's locale; citations of excerpts that were not sent are downgraded; no model call without a matching excerpt; only minimal metadata stored); red team: `ai-guard.test.ts` over `fixtures/ai-red-team.json` (84 prompts covering hiring, dismissal, pay, performance, promotion, discipline, redundancy and injection: 49 refused, 35 benign allowed; decisions in model output rejected; instructions hidden in documents removed) and the document-injection cases in `ai.int.test.ts`; data: "sends no other employee's name, email or number, no vault or HR records, and only policy-folder excerpts" (captured payload), colleague and sensitive questions refused without calling the model, RLS between tenants; region: `ai.residency.test.ts` (Bedrock client only in the home region for every region pair, cross-Region profiles refused, the UK request goes to `bedrock-runtime.eu-west-2` with the bare model id, no in-region model in EU or US), "regions without an in-region model" in `ai.int.test.ts` (EU and US cannot be turned on by the customer or staff), `infra/test/infra.test.ts` ("13. Bedrock (Ask HR) only for the in-region foundation model…"); availability recorded in ADR-0110 and `packages/core/src/ai-models.ts`; provider in `docs/SUBPROCESSORS.md`, kept in sync with the trust centre by `trust.test.ts`; `apps/web/e2e/ask-hr.spec.ts` (off by default, owner setup, disclosure, cited source, refusal, with axe). _Human:_ Bedrock model access in eu-west-2 (HUMAN_TODO 7.1), legal review of the disclosure and the agreements (7.3) and the live red-team run against the real model (7.4).

---

## Phase 12 — Scale and launch readiness

- [~] **12.1 Load tests** — k6 scenarios meet brief §3 targets (200,000 employees / 50 entities; 5,000 concurrent users; 20,000 clock-ins in 10 minutes; p95 < 300 ms common reads, < 1 s paginated lists); results in `docs/PERFORMANCE.md`; load-test environment torn down afterwards.
  - _Ready:_ `pnpm loadtest` (`scripts/loadtest.mjs`, scenarios in `loadtest/k6/thapsus.js`) with the §3 targets as k6 thresholds. `--provision` creates the temporary `loadtest` environment (global + UK cell), generates the 200,000-employee / 50-entity tenant in-region (`run-synth`), runs k6, records the results with `--record` and tears the environment down. The environment is defined and synthesized in verify (`infra/test/infra.test.ts`: stateful resources are deleted with the stack only for `loadtest`; `scripts/test/deploy-plan.test.ts`: synthetic data never in production). The `smoke` profile passed locally against a 3,000-employee synthetic tenant. Procedure: `docs/runbooks/load-test.md`.
  - _Remaining (AWS phase, out of scope for this pass):_ the run itself, its results in `docs/PERFORMANCE.md` §3, and the teardown (`docs/HANDOVER.md`).
- [x] **12.2 Threat model** — STRIDE threat model documented in `docs/SECURITY.md` with mitigations and owners.
  - _Evidence:_ `docs/SECURITY.md` → "Threat model (STRIDE)": assets, trust boundaries, and a threat table where every row has a STRIDE category, mitigations, a test or check as evidence, an owner and a status. Partial mitigations are listed under "Accepted risks and follow-ups", each with an owner. `scripts/test/docs.test.ts` fails if the section disappears.
- [x] **12.3 OWASP ASVS level 2 review** — checklist completed with evidence links; gaps fixed or recorded.
  - _Evidence:_ `docs/ASVS.md` covers all 253 ASVS 5.0.0 level 1 and 2 requirements: 145 met, 6 met by the platform, 47 fixed in this review (tests in `apps/api/test/asvs.int.test.ts`, `asvs-units.test.ts`, `mass-assignment.contract.test.ts`, `apps/web/test/csp.test.ts`, `apps/web/e2e/security-asvs.spec.ts`, `packages/db/test/tls.test.ts`), 40 not applicable and 15 gaps. Each gap is recorded under SECURITY.md → "Accepted risks and follow-ups", in HUMAN_TODO 1.7 (malware scanning) or HUMAN_TODO 5.2 (penetration test). Decisions are ADR-0130 to ADR-0136. `scripts/test/asvs-doc.test.ts` fails if a row is missing or a cited file or test name no longer exists.
- [x] **12.4 Dependency and secret scanning** — clean results in CI; process documented.
  - _Evidence:_ the verify `security` step runs in CI on every pull request and push to `main`. It covers `pnpm audit --audit-level high` over the whole lockfile (ADR-0152), the secret scan, and the CycloneDX SBOM, which is kept as a CI artifact. `scripts/test/secret-scan.test.ts` plants fake credentials of each kind and checks that the scan fails and names the file. `scripts/test/sbom.test.ts` checks the SBOM. The process (what runs, and what to do when a scan fails) is in SECURITY.md → "Dependency and secret scanning" and "Dependency remediation". _Human:_ GitHub secret scanning, push protection, Dependabot and the `main` ruleset (HUMAN_TODO 5.3); Amazon Inspector needs cost approval (HUMAN_TODO 5.4).
- [h] **12.5 Accessibility audit** — WCAG 2.2 AA audit of key flows (automated + manual checklist) with fixes.
  - _Evidence:_ `docs/ACCESSIBILITY.md` records the scope, method, automated checks, audit results and a manual checklist per key flow. `apps/web/e2e/a11y-sweep.spec.ts` (functional e2e, in verify) opens every `page.tsx` route, covering the public site, all app routes with fictional data, the kiosk and the back office. On each route it runs axe (WCAG 2.2 AA) in light, dark and at 320 px, and checks Tab reachability, visible and unobscured focus, skip link first, reflow, text spacing, reduced motion, consistent help, heading order and that no script errors occur. It fails on a new route that has no area. The flow specs run axe at each important state, and `packages/ui/test/contrast.test.ts` checks every token pair in both modes. The fixes are in ACCESSIBILITY.md §4: the focus ring, `Button asChild`, heading levels on 57 screens, 320 px reflow, scrollable tables reachable by keyboard, target sizes and wording (ADR-0140). _Human:_ screen-reader, forced-colours, zoom and speech-input passes on real devices, the kiosk in place, and a reviewed accessibility statement (HUMAN_TODO §8).
- [x] **12.6 Visual polish pass** — every screen checked against `docs/DESIGN.md` in light and dark mode on phone and desktop; visual regression baselines updated.
  - _Evidence:_ `apps/web/e2e/visual.spec.ts` has 348 baselines: 87 screens × light/dark × phone/desktop, covering every `page.tsx` route. Two exceptions are recorded in the spec with reasons: a support ticket with live deadlines, and the staff screens that list every test workspace; the accessibility sweep covers both. The spec fails if a new route has neither a baseline nor a recorded reason. Runs are repeatable (fixed clock, stand-ins for volatile text, greyscale text rendering, ADR-0141) and pass in verify. The polish fixes include the sidebar and settings lists scrolling on their own, an opaque app top bar (ADR-0142), and ad-hoc values replaced with `docs/DESIGN.md` tokens.
- [x] **12.7 Lighthouse targets** — mobile ≥90 performance and ≥95 accessibility on key marketing pages and app screens.
  - _Evidence:_ the verify `lighthouse` step (`scripts/lighthouse.mjs`) audits 18 pages and fails below either threshold: home, pricing, trust, status, developers, sign in, sign up, and the app's home, Me, people, time off, rota, timesheets, reports, report builder, settings, notifications and security. Median of three mobile runs on 2026-10-23: performance 96–100, accessibility 100 on every page (PERFORMANCE.md §2.2, ADR-0143).
- [~] **12.8 Resilience drills** — backup restore drill (RPO ≤ 15 min, RTO ≤ 4 h demonstrated) and availability-zone failure drill, results recorded.
  - _Ready:_ drill procedures and pass criteria are in `docs/runbooks/backup-restore.md` §5 and `docs/runbooks/az-failure.md` §2. Results go in PERFORMANCE.md §4 "Resilience drills". The infrastructure the drills rely on is asserted in `infra/test/infra.test.ts`: Multi-AZ Aurora with automated backups (point-in-time restore within the retention period) and production deletion protection; Valkey Multi-AZ with automatic failover; at least two tasks per service in production; and backup copies only to the permitted region.
  - _Remaining (AWS phase):_ run both drills on staging and record the results (`docs/HANDOVER.md`).
- [~] **12.9 Staging in all three regions** — staging deployed in UK, EU and US; `pnpm smoke:staging` passes in each (sign up, choose region, SSO login, add employee, request leave, clock in, export data).
  - _Ready:_ the staging stacks for eu-west-2, eu-central-1 and us-east-2, plus the global stack in eu-west-2, synthesize in verify. `scripts/deploy.mjs` deploys them in order (plan tested in `scripts/test/deploy-plan.test.ts`). `pnpm smoke:staging` (`scripts/smoke-staging.mjs`) covers sign-up with region choice, SSO through the staging mock IdP, add employee, request leave, clock in and export data, then schedules closure of the smoke tenant. It refuses production and passed end to end locally against the UK cell.
  - _Remaining (AWS phase):_ deploy staging in the three regions and run `pnpm smoke:staging` in each (`docs/HANDOVER.md`, `docs/runbooks/deploy.md`).
- [x] **12.10 Production readiness** — production stacks defined and ready to deploy on approval; runbooks complete.
  - _Evidence:_
    - **Stacks.** The `prod` global, cell, backup-copy and CI stacks synthesize in every verify run (`synth` step). `infra/test/infra.test.ts` asserts the production properties: deletion protection, at least two tasks per service, three NAT gateways, Multi-AZ, KMS-encrypted logs with retention, the regions in the allow-list only, and never a mock IdP.
    - **Approval.** Deploys run through the GitHub `production` environment, which needs manual approval (`.github/workflows/deploy.yml`). `scripts/deploy-plan.ts` refuses `prod` without `productionApproved` ("production needs explicit approval…").
    - **Runbooks.** deploy, rollback, backup restore, AZ failure, incident and breach response, moving a tenant to a dedicated database, and load test are in `docs/runbooks/`. `scripts/test/docs.test.ts` checks that they exist and that their links resolve.
    - Deploying to production is not done here; it needs the owner's approval (CLAUDE.md).

---

## Phase 13 — Google Cloud staging, one region (owner decision 2026-10-23; ADR-0156, ADR-0157, ADR-0158)

- [x] 13.1 One UK staging cell on Google Cloud (europe-west2) defined in OpenTofu, with every resource, backup, secret replica and log bucket in the cell's region.
  - _Evidence:_ `infra/gcp/staging/tests/staging.tftest.hcl` (offline, mock providers; `pnpm verify` step `gcp`) and `infra/test/gcp-staging.residency.test.ts` (region map parity with `packages/core/src/regions.ts`; residency step).
- [x] 13.2 Google Cloud adapters selected by configuration: Cloud Storage, Cloud KMS, Cloud SQL over its unix socket, mail to a bucket, the worker's drain endpoint, the client address behind Cloud Run, and Cloud Logging severity. Each checks the location of its resource against the cell, for every region pair.
  - _Evidence:_ `packages/core/test/gcp.test.ts`, `packages/core/test/residency.residency.test.ts`, `apps/api/test/gcs-object-store.test.ts`, `apps/api/test/gcp-kms.test.ts`, `apps/api/test/bucket-mailer.test.ts`, `packages/db/test/cloudsql.test.ts`, `packages/db/test/cloudsql-socket.int.test.ts`, `apps/worker/test/drain.test.ts`, `apps/worker/test/drain.int.test.ts` and `apps/web/test/proxy.test.ts`.
- [x] 13.3 Migrations apply as a managed-PostgreSQL migrator without SUPERUSER or BYPASSRLS, as on Cloud SQL.
  - _Evidence:_ `packages/db/test/managed-migrator.int.test.ts`.
- [x] 13.4 Fictional test organisation `kestrel`: about 300 employees in UK, Ireland and US entities, activity in every module, and five role sign-ins whose passwords come from Secret Manager.
  - _Evidence:_ `apps/api/test/seed-staging.int.test.ts` (sign-in per role, manager scope, employee refusal, encryption at rest, idempotent re-run) and `apps/api/test/seed-staging.test.ts`.
- [x] 13.5 The web, API and worker images build, start and resolve every import.
  - _Evidence:_ the deploy run of 2026-10-23 (https://github.com/Bmwarari2/PROJECT_KAREN/actions/runs/40034922405): the "The image starts" step passed for the web, API and worker images before they were pushed. Two existing bugs had been fixed on the way (the API and worker images could not start because of /etc/ssl permissions and nested dependencies, and the web image did not build).
- [x] 13.6 Deploys apply only an owner-approved plan, through Workload Identity Federation (`.github/workflows/deploy-gcp-staging.yml`).
  - _Evidence:_ the same run, which signed in to Google Cloud through Workload Identity Federation (no keys) and applied only the change set the owner approved on the `staging-gcp` environment. The first run failed safely in its first apply step (secret values not yet written), and PR #21 fixed that, with `infra/gcp/staging/tests/first-deploy.tftest.hcl` guarding against a repeat.
- [x] 13.7 Staging is deployed and smoke-tested.
  - _Evidence:_ the same run's smoke test (`/health` and `/signin` answer 200); the owner then tested the app on an iPhone (2026-10-23/24), which led to Phase 14.

## Phase 14 — Staging feedback, round 1 (owner testing on an iPhone, 2026-10-23/24)

The owner tested the staging app on an iPhone and asked for these fixes (ADR-0160 to ADR-0169, ADR-0180 to ADR-0182 and ADR-0185; migrations 0021 to 0023):

- [x] **14.1 Everything that names a thing opens it.**
  - Notifications carry a target and open it.
  - The top bar's bell shows the recent ones.
  - Inbox tasks and approvals open their item (with task and approval pages, approve and decline).
  - A person's name opens their profile when the viewer may see it.
  - List rows open their record, through new detail pages for right-to-work checks, assets, pay periods, timesheets and leave requests, with breadcrumbs.
  - Home tiles and charts open the list behind them.
  - _Evidence:_ `packages/core/test/links.test.ts`, `apps/api/test/actionable.int.test.ts` and `apps/web/e2e/actionable.spec.ts`. The e2e test signs in as each role and checks that names, notifications, tasks, approvals and rows are links, that they open real pages, and that no role is linked to a page it cannot open.
- [x] **14.2 Help and support by role.**
  - Help articles have an audience and are filtered everywhere (list, pages, search, contextual links).
  - Employees and managers contact their own HR team (a task in the HR inbox, with a page for its status).
  - Only admin roles contact Thapsus-HR support.
  - _Evidence:_ `packages/core/test/help.test.ts`, `apps/api/test/support.int.test.ts` ("shows each reader only the articles about what they may do (ADR-0162)") and `apps/web/test/workspace.test.ts`.
- [x] **14.3 Documents open in the app for review and signature, and download from there.**
  - PDFs render in the app with PDF.js (self-hosted, its own policy) on desktops and phones.
  - Every view and download is audited.
  - The documents list, onboarding and inbox tasks open the viewer.
  - _Evidence:_ `apps/web/e2e/documents-sign.spec.ts` ("the employee opens a document to sign, reads it in the app, signs it and downloads the signed copy"), `apps/web/e2e/security-asvs.spec.ts` (the page policy still blocks nothing) and `apps/web/test/pdfjs.test.ts`.
- [x] **14.4 Signing needs the company's approval.**
  - Contracts, offers and policies go to a countersigner through the approvals service, configurable per template.
  - The document is complete only after countersigning, and its copy carries both signatures.
  - _Evidence:_ `apps/web/e2e/documents-sign.spec.ts` ("a contract waits for the company: HR reviews it in the viewer and countersigns, then it is complete") and `apps/api/test/documents-attach.int.test.ts`.
- [x] **14.5 HR attaches documents to a person.**
  - Uploads are checked by their bytes, with a size limit and a scan hook.
  - Visibility is HR only, or HR and the person.
  - Right-to-work evidence is sealed with the regional key in the vault, with every view audited.
  - Expiry reminders.
  - _Evidence:_ `apps/api/test/documents-attach.int.test.ts`, `apps/api/test/documents-units.test.ts`, `apps/api/test/documents.residency.test.ts` (every region pair) and `apps/web/e2e/documents-sign.spec.ts` ("HR attaches right-to-work evidence and a driving licence; the employee sees only what was shared with them").
- [x] **14.6 Payslips with the provider's full content.**
  - Structured statements from the payroll provider: payments, deductions, employer contributions, year to date and net pay in minor units. A statement whose lines do not add up is refused.
  - A printable payslip page, and payslips listed by year.
  - Staging data comes from a clearly labelled fictional sample provider; Thapsus-HR never calculates tax.
  - _Evidence:_ `apps/api/test/payslip-statements.int.test.ts` and `apps/web/e2e/phase6.spec.ts` (payslip page and download).
- [x] **14.7 A phone-first UI on Apple's design principles.**
  - Grouped lists, tables that become lists on phones, one large title, segmented section controls, a light translucent bar and a phone tab bar (ADR-0180).
  - Settings as an index with back links (ADR-0181), and phone rules for every page (ADR-0182).
  - Every page fits a 320 px screen without sideways scrolling.
  - _Evidence:_ `apps/web/e2e/a11y-sweep.spec.ts` (all 12 areas, WCAG 2.2 AA), the visual baselines (light and dark, phone and desktop, re-baselined with this phase), `apps/web/test/workspace.test.ts` ("phone tab bar"), the Lighthouse step of `pnpm verify` and `scripts/phone-tour.mjs`.
- [x] **14.8 The staging test company can be rebuilt.**
  - `reset_test_data` on the deploy deletes the seeded fictional workspace through the verified purge and seeds it again. It never touches another workspace (ADR-0185).
  - _Evidence:_ `apps/api/test/seed-staging-reset.int.test.ts`.

## Phase 15 — Security hardening P0 (plan approved 2026-10-23: `docs/SECURITY_HARDENING.md`)

Identity half (plan §2.1, §2.2, §2.3.1; ADR-0170 to ADR-0174; migrations 0024 and 0025). The monitoring half (ADR-0175 to ADR-0179; migrations 0026 and 0027) is items 15.11 to 15.18. It covers the founder's console, detections, alerts, the security dashboard, honeytokens, the IDOR suite and the dependency cooldown, and it consumes the `auth.*` and `staff.*` security events of `apps/api/src/lib/security-events.ts`.

- [x] **15.1 Forgotten password**
  - Anyone can ask for a reset link from the sign-in page. The answer and its timing are the same whether or not the account exists; requests are throttled per account, per workspace and per IP.
  - The link is single-use, lasts 30 minutes, is stored only as a hash and is scoped to resetting (it never signs anyone in, and a sign-in link never resets). The new password must meet the password policy; the reset ends every session, clears a lockout, is audited and is followed by an email. Two-step verification is never bypassed.
  - Someone signed in with an emailed link may set a password without the current one within the re-authentication window (ADR-0171, ASVS V6.4.3).
  - _Evidence:_ `apps/api/test/password-reset.int.test.ts` ("answers the same, after the same time, whether or not the account exists"; "throttles requests per account, per workspace and per IP, and emits auth.throttled"; "a single-use, 30-minute, hashed token that only resets: it never signs in, and a sign-in link never resets"; "applies the password policy, ends every session, clears a lockout, is audited and told by email; the second factor stays"; "someone signed in with an emailed link sets a new password without the current one, within the re-authentication window"); `apps/web/e2e/password-reset.spec.ts` ("someone who forgot their password follows the emailed link, chooses a new one and still needs their authenticator", reading the emailed link with `MAIL_TRANSPORT=file`); `apps/web/e2e/security-asvs.spec.ts` ("someone signed in with an emailed link sets a new password without the old one (V6.4.3)").
- [x] **15.2 Admin-sent reset links and two-step verification resets**
  - "Send password reset link" and "Reset two-step verification" follow one authority rule: a company-wide role that manages settings and covers every permission the person holds, never for one's own account, after a recent re-authentication. The admin never sees or sets the password; each action is audited and emailed to the person. Who can do it is stated next to the actions and in the help centre.
  - _Evidence:_ `apps/api/test/password-reset.int.test.ts` ("only company-wide settings managers who cover the person may send one, never for themselves, after re-authenticating"; "the two-step verification reset follows the same rule"); `apps/web/e2e/password-reset.spec.ts` ("an admin sends a reset link from the person’s access page; they set a password and must set up two-step verification", with axe); help article `resetting-sign-in` in `packages/core/src/help/articles.json` (`packages/core/test/help.test.ts`).
- [x] **15.3 Two-step verification for everyone**
  - A workspace setting, on for every workspace created from now on (sign-up, the provisioning CLI, the staging seed and sandboxes); workspaces that existed before keep their behaviour (versioned defaults, ADR-0170). Turning it off needs a recent re-authentication.
  - _Evidence:_ `apps/api/test/identity-hardening.int.test.ts` ("is on in new workspaces: an employee with only a password must set up an authenticator before anything else"; "admins can turn it off after re-authenticating; employees then sign in with a password only"; "workspaces created before the change keep their behaviour (defaults version 1); new ones get version 2"); `apps/api/test/seed-staging.int.test.ts` ("lets every login sign in with its password; every login must enrol MFA first (two-step verification for everyone)"); `apps/web/e2e/settings-security.spec.ts` ("two-step verification for everyone is on in a new workspace; turning it off asks the admin to confirm it is them").
- [x] **15.4 SSO identity binding and IdP-asserted MFA**
  - After the first SSO sign-in the person is linked to the connection's (issuer, subject); a changed subject for the same email is refused and raises a high-severity event. An SSO sign-in counts as two-step only when the workspace trusts its IdP (off by default) and the IdP asserts MFA (`amr`/`acr`). Admins can unlink a person's SSO identity.
  - _Evidence:_ `apps/api/test/sso.int.test.ts` ("links the person to (connection, issuer, subject) at the first sign-in and refuses a changed subject for the same email"; "counts an SSO sign-in as two-step only when the workspace trusts its IdP AND the IdP asserts MFA (amr/acr); trust is off by default").
- [x] **15.5 Per-account and per-workspace throttles; auth security events**
  - Sign-in, emailed links, password resets and authenticator codes are limited per account and per workspace as well as per IP; failures, lockouts and refusals are `auth.*` events with keyed pseudonyms only.
  - _Evidence:_ `apps/api/test/identity-hardening.int.test.ts` ("sign-in: a workspace-wide failure budget stops stuffing spread over many addresses and accounts"; "sign-in: per account (10) and per IP (50) in 15 minutes; failures and lockouts are auth.* events"; "authenticator codes: limited per account, per IP and per workspace"; "emailed sign-in links: per account, per workspace and per IP, with the same answer for unknown accounts"); `password-reset.int.test.ts` ("throttles requests per account, per workspace and per IP, and emits auth.throttled").
- [x] **15.6 SSRF, SAML browser binding and URL tokens (closes ASVS V1.3.6)**
  - Automation webhooks and the `http` integration go through `postOutbound` (DNS-pinned, private ranges refused). A SAML response is accepted only in the browser that started the sign-in. Emailed links are scoped to one purpose; reset links last 30 minutes (24 hours when an admin sends one) and invitations 3 days.
  - _Evidence:_ `apps/api/test/corehr-flows.int.test.ts` ("webhooks and the http integration go through postOutbound: a public name that resolves inside is refused (ASVS V1.3.6)"; the invitation link's purpose and 3-day lifetime in "a joiner invited before their start date signs in and sees documents to sign, forms and their checklist"); `apps/api/test/sso.int.test.ts` ("binds SAML to the browser that started the sign-in: the hand-over without its cookie is refused"); `password-reset.int.test.ts` (30-minute and 24-hour links, above).
- [x] **15.7 Admin sessions**
  - Admin roles: 15 minutes idle and 8 hours absolute, whatever the workspace allows; employees keep the workspace limits. Admin sessions re-authenticate when the network (autonomous system) changes, when the cell has that signal; no cell has it yet (ADR-0170, SECURITY.md accepted risks).
  - _Evidence:_ `apps/api/test/identity-hardening.int.test.ts` ("end after 15 idle minutes and 8 hours whatever the workspace allows; employees keep the workspace limits"; "re-authenticate when the network (autonomous system) changes, when the cell has that signal").
- [x] **15.8 Staff sign in only with passkeys or security keys**
  - No staff passwords or authenticator codes. Accounts are bootstrapped by a one-time, 2-hour, hashed enrolment link from the operator CLI (`docs/runbooks/staff-access.md`, HUMAN_TODO 5.1). Staff sessions end after 15 idle minutes or 4 hours, and destructive actions need a key proof from the last 5 minutes. The browser test uses Chrome's virtual authenticator, with no test-only path in the app.
  - _Evidence:_ `apps/api/test/backoffice.int.test.ts` ("staff sign in only with a passkey: no password or code routes, a one-time enrolment link, and tenant sessions never work there"; "staff sessions end after 15 idle minutes or 4 hours, and destructive actions need a fresh key"); `apps/web/e2e/backoffice.spec.ts` ("staff sign in with a passkey and work the support queue").
- [x] **15.9 Just-in-time elevation for staff**
  - No standing access for super-admin actions, rule publishing or support-grant use: an elevation names a scope, a reason and a duration (up to 4 hours), needs a second staff member's approval (self-approval is refused by the database too), expires and can be ended early; every step is in the staff audit trail.
  - _Evidence:_ `apps/api/test/backoffice.int.test.ts` ("super admins hold no standing access: an elevation needs a reason, a second staff member and expires"; "support-grant use needs a support_grant elevation, even with the customer's grant"); `apps/api/test/rules.int.test.ts` ("requires a staff passkey session and an approved elevation, appends versions (never overwrites) and takes effect for lookups"); `apps/web/e2e/backoffice.spec.ts` ("a super admin asks for time-boxed access and another super admin approves it"; "a phone gets 44px controls and one column on the access page").
- [h] **15.10 Inviting the first staff member on Google Cloud staging**
  - The job `thapsus-stg-<cell>-staff-invite` creates a `super_admin` for the address in the repository variables (never in the code), writes the one-time link only to the London-only secret `thapsus-stg-<cell>-staff-invite` that only the jobs service account can use, never logs it, and runs once while no staff account exists (or by hand with `staff_invite`). Running it needs the owner: HUMAN_TODO §9.8.
  - _Evidence:_ `apps/api/test/staff-invite.int.test.ts` ("validates the invitee from the repository variables and skips when none is configured"; "creates the account once, writes only the link to the secret, and reissues on request"; "writes the secret version with the job identity, never with the link in the URL"); `infra/gcp/staging/tests/staging.tftest.hcl` (`uk_cell_stays_in_london`, `nothing_is_open_that_should_not_be`) and `first-deploy.tftest.hcl` (`the_first_deploy_step_writes_the_secret_values`).

- [x] **15.11 The founder's console: business overview and customers.**
  - Per cell: sign-ups, trials, conversion, churn, billing status, plans, MRR and ARR per currency, active users, employees under management, two-step adoption, support and incidents.
  - Across regions: counts from the global directory only.
  - Customers are searchable and filterable, with a health signal. Counts only, never personal data (ADR-0175).
  - _Evidence:_ `apps/api/test/founder-console.int.test.ts` ("counts sign-ups, trials, conversions, churn, usage and MRR/ARR per currency from the snapshot"; "holds counts only: no names, emails, slugs or tenant ids"; "companies in every region from the global directory only"; "filters this cell by plan, status, trial and health, sorts, and shows activity per row"); `packages/core/test/metrics.test.ts`; `apps/web/e2e/backoffice.spec.ts`.
- [x] **15.12 Platform performance per cell.**
  - Requests, server errors and 95th-percentile latency by route group, flushed once a minute without ids or paths.
  - Queue depth, oldest job, failures and database size (ADR-0176).
  - _Evidence:_ `apps/api/test/founder-console.int.test.ts` ("aggregates requests, server errors and latency per route group without any ids or paths"; "samples queue depth, oldest job age, failures and database size for every database of the cell").
- [x] **15.13 Detections and incidents.**
  - Security signals are kept in the cell with keyed pseudonyms only.
  - A versioned rule catalogue: 21 active rules (8 more planned for cloud sources), each with a severity, a MITRE ATT&CK id, a fixture and a near miss.
  - Incidents with dedupe windows (ADR-0177).
  - _Evidence:_ `packages/core/test/security-catalogue.test.ts`; `apps/api/test/security-engine.int.test.ts` ("every active rule fires once on its fixture and never on its near miss"; "records a detection and incident once, blocks the address, and extends rather than repeats within the dedupe window"; "stores pseudonymous values only").
- [x] **15.14 Containment, the back-office Security module and the customer's Security centre.**
  - Containment: block an address, end a person's sessions, suspend an API key, freeze a staff account. Unfreezing needs a second person; every action is audited and reversible.
  - The Security module is for security analysts and super admins.
  - Customer admins get a Security centre in Settings (ADR-0178).
  - _Evidence:_ `apps/api/test/security-module.int.test.ts` ("containment from the incident view"; "the Security module"; "the customer's Security centre"); `apps/web/e2e/security-centre.spec.ts`.
- [x] **15.15 Security alert emails.**
  - Critical and high alerts go at once, medium in an hourly digest and low daily.
  - Alerts carry no personal data, secrets or sign-in links.
  - A daily test alert, and a dead-man switch after 10 minutes without a detection run.
  - _Evidence:_ `apps/api/test/security-alerts.int.test.ts`.
- [x] **15.16 Honeytokens outside customer data.**
  - A decoy API key in the docs, honey endpoints that answer slowly, and decoy object keys.
  - Any touch raises a detection. No fake employees in customer workspaces (ADR-0179).
  - _Evidence:_ `apps/api/test/security-module.int.test.ts` ("honeytokens and blocks").
- [x] **15.17 IDOR/BOLA suite generated from the OpenAPI document.**
  - Every id-addressed operation is called as every built-in role with another workspace's real ids, and as the scoped roles with people outside their scope. The other workspace's rows must be unchanged afterwards. It runs in the isolation step of `pnpm verify`.
  - It found and fixed seven real bugs.
  - _Evidence:_ `apps/api/test/bola.isolation.test.ts`.
- [x] **15.18 Supply-chain cooldown.**
  - New dependency versions are installed only after 7 days (`minimumReleaseAge`), and install scripts only for an allowlist (`strictDepBuilds`).
  - `pnpm verify` fails if either setting is removed.
  - _Evidence:_ `scripts/test/supply-chain.test.ts` and the security step of `pnpm verify` (`scripts/supply-chain.mjs`).

## Phase 16 — Every task and approval leads to the work (owner review, 2026-10-24)

The owner reviewed the staging inbox and found that tasks and approvals named a job without the means to do it. Plan agreed on 2026-10-24, with defaults in ADR-0187. Each part ships with tests, an e2e run of its flows (with axe), phone layouts, visual baselines and Lighthouse; employment rules come only from the jurisdiction packs.

**A. Permissions and visibility**

- [ ] **16.1 One permission map.** Every page, settings section, navigation item and action names its permission in one map in `@thapsus/core`, used by the API and the app. A test fails when a UI action's permission differs from the permission of the API route it calls.
- [ ] **16.2 What you cannot do, you do not see.** Navigation, the settings index, search, buttons and links are filtered by the map. A page someone may view but not change is shown read-only, with no save controls. A sweep signs in as every role, opens every page and fails on any "no permission" response from a visible control.
- [ ] **16.3 IT admin role.** A built-in IT admin role holds the asset register, asset returns, the IT integrations and SCIM. It has no access to pay, contracts or sensitive records. HR keeps a read-only view of what a leaver holds. Device and access tasks go to IT admins, or to a role chosen in Settings → Workflows. The staging seed has an IT admin login.
- [ ] **16.4 Help by feature.** Every help article declares the features and permissions it covers. An article is shown only when the reader can see those features, the feature is on for the workspace and the country applies. The rule applies in the help centre, search, Ask HR and in-page help, is validated, and is tested for every role.

**B. Tasks that lead to the work**

- [x] **16.5 Every task explains itself.** Seeded workflow tasks and system-made tasks (compliance, assets, documents, approvals, absence) carry a description in the reader's language. The workflow and automation editors accept descriptions.
      _Evidence:_ system-made tasks store catalogue keys and parameters and the API renders them in the reader's locale (`apps/api/test/task-actions.int.test.ts` "16.5": en-GB "authorisation" vs en-US "authorization"; every compliance, asset, document, approval and absence task asserted with its description in the 16.7 cases); every seeded onboarding (UK, IE, US), offboarding and transfer task has a description (`apps/api/src/cli/staging/steps/workflows.ts`, `seed-staging.int.test.ts`); the workflow editor and the automation rule editor take descriptions (an automation rule's description reaches its task, same file; workflow editor e2e `settings-approvals.spec.ts`, `task-actions.spec.ts`). ADR-0193.
- [x] **16.6 Task actions.** A registry of action kinds gives each task a main button that opens the work with the person already chosen, plus a live status of the linked record. Mark as done stays as a fallback that asks for a note and is audited. The workflow editor has an action picker.
      _Evidence:_ the registry `packages/core/src/task-actions.ts` (generic kinds `open_link`, `open_person`, `open_record`; placeholder kinds with their contract hrefs and fallbacks) is unit-tested in `packages/core/test/task-actions.test.ts`; `apps/web/test/task-actions-routes.test.ts` proves every button (or fallback) opens a route of the app; `apps/api/test/task-actions.int.test.ts` "16.6" covers template validation and editing, the main button on the task page and the list, the fallback of a placeholder kind, and Mark as done with a note (stored and audited as `task.completed` `{ via: 'manual', note }`); the live record status is asserted for every wired record type in "16.7"; e2e `apps/web/e2e/task-actions.spec.ts` (description, main button, record status, the note dialog, the workflow editor's action picker and due fields, axe in light and dark, phone width), visual baselines of the task page (`apps/web/e2e/__screenshots__/*/app-tasks-id.png`) and the task page in the Lighthouse set (`scripts/lighthouse.mjs`). The workflow editor has an action picker per task (`apps/web/app/app/settings/workflows/task-fields.tsx`). ADR-0191.
- [x] **16.7 Tasks close themselves.** A task linked to a record closes when that record is complete. Each action kind proves this with a test.
      _Evidence:_ `completeTasksFor`, `completeTaskById` and `linkTaskRecord` (`apps/api/src/modules/tasks/completion.ts`); `apps/api/test/task-actions.int.test.ts` "16.7" proves each record type wired today closes its tasks and audits it: asset acknowledgement and return, a right-to-work check (missing-check task, the `rtw_check` onboarding step and the follow-up of a replaced check), a compliance-matrix record, Form I-9 Sections 1 and 2, a document signature, an approval decision, the return-to-work conversation and a request to HR resolved with a reply; e2e `task-actions.spec.ts` follows an asset task to its handover and back to the closed task. A unit test fails when a record type the task page promises to close has no closing call (`RECORD_TYPES_CLOSED_TODAY`). Kinds whose pages later parts build close through the same API when they land (ADR-0191 table). ADR-0192.
- [x] **16.8 Truthful labels and due dates.** "Comes from" names the real source and links to it. "Asked by" names the person who asked; "The system" is used only for automations. Due dates follow the person's own dates and the packs (for example the probation end date, or business days).
      _Evidence:_ `origin` names and links the real source (workflow by kind and name, approval, automation rule, Documents, Compliance, asset register, Absence, request to HR), asserted per source in `apps/api/test/task-actions.int.test.ts`; the return-to-work task comes from Absence (migration 0030 moves older rows); "Asked by" is `askedBy` (migration 0031) — a person even without a sign-in, "The system" only for automations, "Not recorded" otherwise ("16.8" case), and the seeded approvals record their asker; due dates follow the probation end date (and move when it changes) and count business days without the pack's bank holidays ("16.8" case and golden tests `apps/api/test/task-due.test.ts`, `packages/core/test/business-days.test.ts`); the seeded US Form I-9 Section 2 task takes its deadline from the US pack's `i9.completion_deadlines` rule (source USCIS M-274 §4.0, re-checked 2026-10-24; golden vector in `packages/rules/goldens/us.json`), equal to the I-9 record's deadline ("16.7" Form I-9 case). ADR-0193.

**C. Documents**

- [ ] **16.9 Templates in Settings.** Templates can be listed, created, edited and archived. Edits create a version; sent documents keep theirs. The editor has simple formatting, a field picker, a live preview with a fictional person and flags for unknown fields. The UK, Ireland and US starter templates are labelled as samples, and their legal review is in HUMAN_TODO.
- [ ] **16.10 Fields and layout.** New merge fields cover hours, holiday entitlement, notice, probation end, pay frequency and pay day, contract type, continuous employment, manager and employer address. Templates can ask for fields at send time. PDFs have a title, headings, page numbers and a signature block.
- [ ] **16.11 Send from a template.** From a person, choose a template, preview it in the viewer and send it for signature, countersignature or both, with a signing order, due date and message. Sending is blocked while values are missing. A bulk send screen offers filters and progress.
- [ ] **16.12 Signing status and the company signature.** A status timeline shows each step, with remind, void and replace, and resend. The company signs in the viewer: only authorised signatories (default HR admins and owners), after step-up, never on their own document. The signing order can be employee first (default), company first, or either.
- [ ] **16.13 Signatures on the document.** Signature blocks are filled in with the signature (typed in an open-licence handwriting font, or drawn), printed name, "for and on behalf of", date and reference. Uploaded PDFs get placed fields or a signature page. The certificate page covers both parties, and every version is kept with its hash.
- [ ] **16.14 Statement-of-terms task.** "Prepare and send" opens 16.11 with the template already chosen. The task closes when the document is signed and countersigned.

**D. Approvals with the facts**

- [ ] **16.15 Approval pages per subject.** Each subject shows its own facts and a steps timeline. Money is shown in currency, never as stored minor units.
- [ ] **16.16 Leave.** The page shows the balance before and after approval, the days counted, a staffing strip with the cover rule for each day, overlapping requests and the shifts affected (which can be released as open shifts). The approver can approve, decline with a reason, or suggest other dates. Colleagues outside the approver's scope show only as "off".
- [ ] **16.17 Shift swaps and open shift claims.** The page shows both people and both shifts, the colleague's acceptance, and checks: rest and maximum hours from the packs, young workers, skills, contract hours and overtime cost, and cover. Claimants are ordered by a setting and one is chosen. Auto-approval is off by default.
- [ ] **16.18 Employee changes.** Pay, job, manager, hours and location changes, and employees' own detail changes, show current and proposed values with the difference. For pay, the page also shows the percentage change, the period it lands in (with a cut-off warning), history, position in the pay range (optional ranges per job level) and a peer comparison for groups of five or more. The approver can approve a different amount or date. On approval, the dated record is created, the change appears in that period's payroll inputs and a change-of-terms letter is sent (on by default). In self-service changes, sensitive values are masked.
- [ ] **16.19 Timesheets.** The page shows recorded hours against the rota, overtime, breaks, rest-rule breaches and exceptions. The approver can approve line by line or the whole timesheet.

**E. Compliance**

- [ ] **16.20 Lists that find the problems.** The right-to-work and I-9 lists open on "Needs action" with status counts and filters by entity, location, department, start date and method. Filtered lists can be exported (audited), with bulk reminders and tasks. Overview tiles and alerts open the filtered list.
- [ ] **16.21 Right-to-work evidence when recording the check.** Several files can be uploaded, including from the phone camera. The evidence each method requires comes from the UK pack. A "needs evidence" status flags checks without it, and evidence can be viewed in the viewer. A follow-up date is set automatically, and the task opens the dialog.
- [ ] **16.22 Form I-9.** Employees complete Section 1 in self-service. HR completes Section 2: List A or List B and C, expiry dates, examiner and the method from the pack. The deadline counts business days from the US pack (this fixes the calendar-day count). Reverification has its own flow. Tasks close themselves.
- [ ] **16.23 Compliance renewals.** Renewal and missing-requirement tasks open a flow to upload evidence or record the renewal.

**F. Payroll hand-over (Thapsus-HR never runs payroll or calculates tax)**

- [ ] **16.24 Starter checklist.** What the payroll provider needs for a starter in each country comes from the packs; in the US, withholding forms are collected for the provider. Missing items are asked of the employee, and sensitive values go to the vault. The checklist shows the first period and pay date and has a "Send to payroll" button. The task closes on delivery.
- [ ] **16.25 Leaver summary for payroll.** Covers the last day, notice dates, holiday owed or overtaken (from the leave engine with the pack's accrual rules), unpaid absence, late pay changes and unreturned assets (for information). The summary goes to the period's Leavers section and the task closes on delivery. The task is renamed so that it no longer says "calculate final pay".

**G. Forms and conversations**

- [ ] **16.26 Forms engine.** Structured forms with question types and visibility rules. Sensitive answers go to the vault. Forms support employee confirmation, retention and audited views.
- [ ] **16.27 Return-to-work conversation.** Starts from the absence. Records fitness to return, adjustments, a phased return, the fit note under the pack rules, an occupational health referral and a review date. The employee confirms. Only the manager who held it and HR can see it. Follow-up tasks are created, and the due date is a setting.
- [ ] **16.28 Exit interviews.** A question set in Settings. The leaver completes it, or HR records it; the leaver may decline. A structured reason for leaving is saved on the leaver record. Answers are HR-only, and a reasons report suppresses small groups.
- [ ] **16.29 Probation reviews.** The outcome is pass, extend or not passed, and HR approves it. The contract is changed with an effective date and a letter is sent from a template. The due date follows the probation end date. "Not passed" starts offboarding with notice from the pack.
- [ ] **16.30 Check-ins and handovers.** Covers the 30-day check-in, buddy and first-week plan, handover plan and transfer welcome. Each is a short form that notifies the people involved.

**H. IT and offboarding**

- [ ] **16.31 IT requests.** "Order laptop, phone or site access card" opens an IT request in the IT admin queue. Fulfilling it assigns items from the asset register; the employee confirms receipt, and the task closes.
- [ ] **16.32 Access removal.** A live checklist covers connected accounts and their leaver steps, the Thapsus-HR sign-in ending at the end of the last day, assets to return, and manual items recorded with who and when. The task closes when everything is done. Access still active after the leave date raises an alert in the Security centre.

## Documentation (brief §9)

- [x] README
- [x] ARCHITECTURE (with diagrams)
- [x] DESIGN
- [x] SECURITY
- [x] DECISIONS
- [x] COSTS (per environment and region)
- [x] PERFORMANCE
- [x] COVERAGE
- [x] SUBPROCESSORS
- [x] COMPLIANCE (SOC 2 and ISO 27001 mapping)
- [x] HUMAN_TODO
- [x] API docs
- [x] Runbook: deploy
- [x] Runbook: rollback
- [x] Runbook: backup restore
- [x] Runbook: incident and breach response
- [x] Runbook: moving a tenant to a dedicated database
- [x] DPIA template
- [x] Records of processing draft
- [x] DPA templates per jurisdiction ("for legal review")
- [x] Privacy notice templates per jurisdiction ("for legal review")
- [x] Admin guide
- [x] Employee guide

_Evidence:_ `scripts/test/docs.test.ts` (unit, in verify) checks that every document above exists, has a title and content, and that its relative links resolve. It also checks that ARCHITECTURE has diagrams; that COSTS covers each environment (development, staging, production, load test) and each home region; that COMPLIANCE maps to SOC 2 and ISO 27001; that SECURITY holds the STRIDE threat model; and that the DPIA, RoPA, DPA and privacy notice templates are marked "for legal review". The API docs are `docs/api.md` together with the generated OpenAPI 3.1 document, which is contract-tested.

## Definition of done (brief §10)

- [ ] Every phase and feature above is ticked.
- [ ] `pnpm verify` passes.
- [ ] Staging deployed in all three regions and `pnpm smoke:staging` passes in each.
- [ ] `pnpm loadtest` meets the §3 targets, with results in `docs/PERFORMANCE.md`.
- [x] Production stacks defined and ready to deploy on approval (12.10).
- [x] All §9 documents exist (`scripts/test/docs.test.ts`).
- [x] Every remaining human-only step is listed in `docs/HUMAN_TODO.md` (sections 1–8; the AWS runs left for the original agent are in `docs/HANDOVER.md`).
