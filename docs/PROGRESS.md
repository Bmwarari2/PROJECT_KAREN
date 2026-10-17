# ROCHE delivery progress

Status of every phase and feature in `docs/BUILD_BRIEF.md`, with acceptance criteria (AC). A feature is ticked only when **all** of its AC are proven by automated tests or checks in `pnpm verify`, or, for steps only a human can do, are listed in `docs/HUMAN_TODO.md` with the build running against mocks or test mode.

**Phase exit gate (every phase):** `pnpm verify` passes · affected docs updated · this file ticked · work committed on the phase branch · verify summary printed in the conversation.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done (AC met) · `[h]` done except human-only steps (see HUMAN_TODO.md)

## Summary

| Phase | Scope | Branch | Status |
| --- | --- | --- | --- |
| 0 | Foundations | `phase-0-foundations` | [ ] |
| 1 | Core HR and organisation model (6.1) | `phase-1-core-hr` | [ ] |
| 2 | Jurisdiction pack framework + UK, US, EU packs (6.4 framework) | `phase-2-jurisdiction-packs` | [ ] |
| 3 | Time off and absence (6.2) | `phase-3-time-off` | [ ] |
| 4 | Rotas and time tracking (6.3) | `phase-4-rotas-time` | [ ] |
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

- [ ] **0.1 Monorepo and tooling**
  - pnpm workspaces + Turborepo containing `apps/web`, `apps/api`, `apps/worker`, `packages/db`, `packages/rules`, `packages/ui`, `packages/sdk`, shared config packages and `infra`.
  - TypeScript strict mode everywhere; ESLint + Prettier; a clean clone runs `pnpm install && pnpm verify` without manual steps (beyond documented prerequisites).
  - `pnpm verify` runs every step listed in brief §8 (lint, typecheck, unit, integration, contract, tenant-isolation, residency, e2e, visual regression, Lighthouse, security scan, build, `cdk synth`) and ends with a pass/fail table; exit code is non-zero if any step fails.
- [ ] **0.2 CI/CD**
  - GitHub Actions runs `pnpm verify` on every pull request and push to `main`.
  - Deploy workflow assumes per-account, per-region IAM roles via GitHub OIDC; repository contains no AWS access keys (secret scan proves it).
  - Staging deploys per region from `main`; production deploys only through a manual approval environment gate.
  - Dependency audit and secret scanning run in CI.
- [ ] **0.3 Local development**
  - `docker compose up` starts Postgres, Valkey, an S3 emulator, an SQS emulator and a mail catcher.
  - `pnpm dev` runs web, api and worker with hot reload; `pnpm db:migrate && pnpm db:seed` produce a working demo company.
  - Integration tests run against real PostgreSQL (Docker, or native binaries when Docker images are unavailable — see DECISIONS.md).
  - README quick start works from a clean clone.
- [ ] **0.4 Regional cell stack (AWS CDK)**
  - One parameterised `CellStack` per environment × region (dev/staging/prod × UK/EU/US): VPC across 3 AZs; ECS Fargate services (web, api, worker) with autoscaling; ALB with ACM TLS and AWS WAF; Aurora PostgreSQL Multi-AZ with a reporting read replica and RDS Proxy; ElastiCache Valkey Multi-AZ; SQS (+ DLQs) and EventBridge; EventBridge Scheduler; S3 (private, versioned, SSE-KMS, block public access); SES configuration set; Secrets Manager; per-region KMS keys; CloudWatch logs (KMS-encrypted, retention set), X-Ray / OpenTelemetry collector; AWS Backup plan; AWS Budgets alarm.
  - CDK assertion tests prove: Multi-AZ and encryption on Aurora and Valkey; S3 public access blocked; WAF associated with every ALB; no CloudFront distribution in front of authenticated origins; every resource in the cell's home region; backup copy rules target only the permitted region (EU→eu-west-1, US→us-west-2, UK→none); IAM policies contain no `*` actions on `*` resources.
  - `cdk synth` succeeds for every environment × region combination.
- [ ] **0.5 Global stack (AWS CDK)**
  - Route 53 hosted zone (domain from configuration), tenant directory, region-aware sign-in routing, marketing site hosting and billing service placeholders.
  - Tenant directory schema holds only tenant ID, slug, home region, status, plan reference and verified domains; a test fails if a personal-data field is added.
  - Marketing site may use a CDN; app and API hostnames are regional and bypass any edge cache (asserted in tests).
- [ ] **0.6 Tenancy with Row Level Security**
  - Every tenant-scoped table has `tenant_id`, RLS enabled and forced, and a tenant policy; the application role has no `BYPASSRLS` and owns no tables.
  - Isolation test suite enumerates all tables from the catalog and fails if any tenant-scoped table lacks RLS or a policy.
  - Tests prove a session for tenant A cannot select, insert, update or delete tenant B rows, and that a session with no tenant context sees zero rows.
  - Tenant context is set per transaction with `set_config('app.tenant_id', …, true)` (safe with RDS Proxy connection reuse); a test proves context does not leak between pooled transactions.
- [ ] **0.7 Dedicated-database routing**
  - Tenant → database routing comes from configuration (regional tenant registry), not code.
  - Integration test: a tenant is moved from the shared database to a second database using the move script, routing is switched, and the same API test suite passes for that tenant with no code change.
  - Runbook draft `docs/runbooks/move-tenant-to-dedicated-db.md`.
- [ ] **0.8 Authentication**
  - Maintained auth library (default Better Auth) with organisations, email + password, TOTP MFA, passkeys and magic links; all auth data stored in the home-region database.
  - Sign-up flow asks for the home region and creates the tenant only in that region's cell.
  - MFA enforced for admin roles: admin routes are refused until a second factor is enrolled and verified (tested).
  - OIDC and SAML 2.0 SSO logins pass end-to-end tests against mock identity providers; a tenant can enforce SSO, after which password login is refused for its users (tested).
  - SCIM 2.0 inbound provisioning: `/Users` and `/Groups` support create, get, list with filter, PATCH and deactivate; bearer tokens scoped per tenant; conformance tests pass.
  - Verified domains via DNS TXT record (DNS lookup mocked in tests).
  - Sessions expire on idle and absolute timeouts (configurable per tenant); sign-in rate limiting and account lockout are tested.
- [ ] **0.9 Region-aware sign-in routing**
  - Global sign-in resolves slug or verified domain → home region and redirects to the regional host.
  - "Find my workspace" by email fans out to each region, which emails the user from that region; the global layer never stores the email address (tested).
  - A request for a tenant arriving at the wrong regional cell is refused/redirected without touching that tenant's data.
- [ ] **0.10 Roles and permissions**
  - Built-in roles seeded: Thapsus super-admin (back office), company owner, HR admin, country/entity HR admin, payroll admin, manager (own team, with delegation), employee.
  - Custom roles with field-level permissions (read/write/none per field) scoped by entity, country, department or location; deny by default; permission engine covered by unit tests including scope and delegation cases.
  - Thapsus support access model: customer-granted, time-limited, revocable, every action audit-logged; no back-office path to tenant personal data without an active grant (tested).
- [ ] **0.11 Audit log**
  - Append-only: application role cannot UPDATE or DELETE audit rows (privileges revoked and trigger blocks it — tested); entries are hash-chained per tenant and a verification command detects tampering.
  - Every mutating API call writes an audit entry (actor, tenant, action, target, before/after diff with sensitive fields redacted, IP, user agent, request ID); every view of sensitive data writes an entry.
  - Customers can export the audit log (CSV and JSON) filtered by date range.
- [ ] **0.12 Sensitive data vault (framework)**
  - Separate schema for sensitive categories with field-level envelope encryption using per-region KMS keys (local KMS mock in dev/test).
  - Raw table reads show ciphertext only (tested); roles without the sensitive-data permission cannot decrypt (tested); every decrypt writes an audit entry (tested).
- [ ] **0.13 Internationalisation**
  - Message catalogues for en-GB and en-US; lint fails on hardcoded user-facing strings in UI code.
  - Locale-aware formatting helpers for dates, numbers and currencies (GBP, EUR, USD plus at least SEK, PLN, DKK, CHF, CZK, HUF, RON) with unit tests.
  - Instants stored in UTC; users and locations carry IANA time zones; DST-boundary tests pass.
- [ ] **0.14 Design system**
  - `docs/DESIGN.md` written before any screen: tokens (colour, type scale, spacing, radii, shadows, motion), components, light/dark rules, motion and reduced-motion rules.
  - Tokens implemented as CSS variables consumed by Tailwind; `packages/ui` provides restyled shadcn/ui components (button, input, select, card, table, dialog, sheet, tabs, toast, sidebar, top bar, empty state, skeleton).
  - Automated contrast test proves every text/background token pair meets WCAG 2.2 AA in light and dark mode.
  - Component gallery page used for visual regression (light/dark × phone/desktop).
- [ ] **0.15 PWA shell and marketing skeleton**
  - Installable PWA: web app manifest, service worker, offline fallback page, web push subscription (VAPID) with a test notification in dev.
  - App shell: sidebar + top bar, signed-in home, theme switch (system/light/dark), locale switch.
  - Marketing homepage skeleton: sticky translucent blurred nav, hero, alternating full-width sections, scroll reveals that respect `prefers-reduced-motion`.
  - Lighthouse mobile ≥90 performance and ≥95 accessibility on the marketing home page and app shell; axe checks pass in e2e.
- [ ] **0.16 Observability and residency guard**
  - OpenTelemetry tracing and structured logging with personal-data scrubbing (unit tests cover emails, names in known fields, phone numbers, NI numbers, SSNs, tokens).
  - Residency-guarded AWS client factory refuses any region other than the cell's home region (and the permitted backup region for backup tooling).
  - Residency test matrix covers every region pair (UK↔EU, UK↔US, EU↔US) across database, object storage, cache, queues, email, logs and backups.
- [ ] **0.17 Seed data and synthetic enterprise generator**
  - `pnpm db:seed` creates a small fictional demo company (about 25 employees, UK-based, one legal entity).
  - `pnpm synth:enterprise` deterministically generates a 200,000-employee tenant with 50 legal entities across UK, EU and US (bulk COPY); runtime recorded in docs/PERFORMANCE.md.
- [ ] **0.18 Foundation documents**
  - First versions of README, ARCHITECTURE (with diagrams), DESIGN, SECURITY, DECISIONS, COSTS (per environment and region), SUBPROCESSORS (per region), HUMAN_TODO.

---

## Phase 1 — Core HR and organisation model (6.1)

- [ ] **1.1 Effective-dated employee records**
  - Personal details, jobs, positions, grades, pay history, cost centres, contracts and emergency contacts stored as effective-dated records with exclusion constraints preventing overlapping periods.
  - As-of queries return the correct state for any past, present or future date; future-dated changes take effect automatically on their date (scheduled job, idempotent); full history view per employee.
  - Custom fields (text, number, date, select, multi-select, boolean, currency, file) and custom objects with validation, field-level permissions and audit.
  - Field-level permissions enforced identically in API responses and UI.
  - Employee list for the 200,000-employee tenant: paginated p95 < 1 s locally (benchmark recorded); full-text + trigram search.
- [ ] **1.2 Organisation model and org chart**
  - Multiple legal entities, countries, departments, locations and cost centres; solid-line, matrix and dotted-line reporting relationships, all effective-dated.
  - Reporting cycles are rejected; reassigning a manager with reports is handled explicitly.
  - Org chart loads lazily by subtree with search and focus; first render < 1 s and expanding a node < 300 ms for the 200,000-employee tenant.
- [ ] **1.3 Documents**
  - Folders with permissions; files stored in the home-region S3 bucket via presigned URLs; content-type and size validation.
  - Templates with merge fields rendered to PDF.
  - Click-to-sign with audit trail: signer, timestamp, IP address, SHA-256 of the exact document signed; signature certificate page; hash verification test.
  - Expiry tracking with reminders; bulk send to a filtered set of employees with progress tracking.
- [ ] **1.4 Bulk import and export**
  - CSV and Excel import with column mapping, validation preview (row-level errors), dry run and background processing with progress.
  - Importing 200,000 employees completes as a background job with progress updates and a downloadable error report; re-running the same file is idempotent.
  - CSV and Excel export of any permitted list, respecting field-level permissions.
- [ ] **1.5 Onboarding, offboarding and internal transfer workflows**
  - Workflow templates with tasks, assignees (role- or person-based), due dates relative to start/leave/transfer date, and reminders.
  - Pre-start portal for new joiners (documents, forms, checklist) before their start date.
  - Transfer workflow changes job/entity/location with effective dating.
- [ ] **1.6 Approval chains and bulk actions**
  - Multi-step, conditional (field-based) and delegated approvals with escalation on timeout; approval history in the audit log.
  - Bulk approve/reject and bulk edit with permission checks and a summary of results.
- [ ] **1.7 Automation rules**
  - Triggers: record created or changed, date reached, document expiring, threshold hit.
  - Actions: create task, send notification, start workflow, call webhook, call integration.
  - Rules evaluated from outbox events by idempotent worker jobs; dry-run preview; execution log.

---

## Phase 2 — Jurisdiction pack framework (6.4 framework)

- [ ] **2.1 Pack framework**
  - Rule data versioned per country (and per US state/locality), with effective-from/to dates, official source URL, verified-on date and reviewer.
  - Rule lookup by (jurisdiction, rule key, date) with layered resolution (EU baseline → member state; US federal → state → locality; UK → nation).
  - Every rule has golden tests (input → expected output) that run in `pnpm verify`.
  - `docs/COVERAGE.md` generated from pack data showing which rules exist per jurisdiction and their verification dates.
  - Edits create new versions (never overwrite); API for back-office editing (UI in Phase 10).
- [ ] **2.2 UK pack (base data)**
  - Public holidays for England and Wales, Scotland and Northern Ireland; statutory annual leave; SSP parameters; working-time limits; right-to-work document rules — each value verified against gov.uk / legislation.gov.uk with source URLs.
- [ ] **2.3 US pack (base data)**
  - Federal holidays; FLSA overtime thresholds; FMLA parameters; Form I-9 retention rule; state/local layer structure with initial states recorded in COVERAGE.md — each value verified against dol.gov, uscis.gov, eeoc.gov or the relevant state source.
- [ ] **2.4 EU pack (base data)**
  - EU baseline (minimum four weeks' paid annual leave, Working Time Directive limits) plus public holidays and statutory annual leave for all 27 member states, with official sources; deeper rules prioritised in COVERAGE.md.

---

## Phase 3 — Time off and absence (6.2)

- [ ] **3.1 Leave policy engine**
  - Policies per entity and country: accrual (annual, monthly, per hour worked), pro rata for part-time and mid-year joiners/leavers, carry-over with expiry, caps, waiting periods, negative balances, TOIL, unpaid and family leave types.
  - Tests first: balance calculations covered by table-driven tests including leap years, DST, part-time patterns and policy changes mid-year.
  - Requests, approvals (via approval chains), cancellations, balance adjustments with audit.
- [ ] **3.2 Public holidays and company calendars**
  - Public holidays from jurisdiction packs per country and region (UK nations, EU member states, US federal) plus company calendars; working patterns determine deductions.
- [ ] **3.3 Sickness absence and statutory sick pay tracking**
  - Sickness records with fit notes/documents stored in the sensitive vault; return-to-work forms.
  - Statutory sick pay tracking from pack rules: UK SSP, EU member-state rules where held, US state and local paid sick leave accruals; golden tests per rule.
- [ ] **3.4 US FMLA**
  - Eligibility checks (employer coverage, length of service, hours worked, worksite employee count) from pack data; leave year methods; intermittent leave tracking; golden tests.
- [ ] **3.5 Absence analytics**
  - Bradford factor, configurable trigger alerts, team calendar, cover rules (minimum staffing) and per-user ICS feeds with revocable tokens and no sensitive detail.

---

## Phase 4 — Rotas and time tracking (6.3)

- [ ] **4.1 Rota builder**
  - Rota templates, availability, open shifts, shift swaps with approval, publish and notify (email + web push).
  - Rota view for 10,000+ shift workers in one tenant stays responsive (virtualised grid; benchmark recorded).
- [ ] **4.2 Clock in and out**
  - Clock in/out from the PWA with an offline queue that syncs idempotently.
  - Optional geofence: off by default, configurable per country, with notice text shown to workers.
  - Shared kiosk mode with per-employee PIN (rate-limited, hashed).
- [ ] **4.3 Working-time rules**
  - From pack data: US FLSA weekly overtime and state daily overtime; EU Working Time Directive limits and rest periods; UK 48-hour week with opt-out records; daily time recording where a country requires it.
  - Golden tests for every rule; violations surfaced as warnings/blocks per tenant configuration.
- [ ] **4.4 Timesheets**
  - Timesheets compared with the rota (variances highlighted), overtime calculation, approvals and payroll export feed.

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
