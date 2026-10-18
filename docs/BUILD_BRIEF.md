# BUILD BRIEF: Thapsus-HR, an HR platform by Thapsus

> Source of truth for scope and requirements. Saved verbatim from the product owner on 2026-10-17.
> Changes to this brief are made only by the product owner; implementation choices that differ from its defaults are recorded in docs/DECISIONS.md.
> Product renamed from "ROCHE" to "Thapsus-HR" by the product owner on 2026-10-18.
> Updated by the product owner on 2026-10-18 to match the AWS organisation SCP: US backups copy to us-west-1 (not us-west-2); the global stack runs in eu-west-2; no CloudFormation stacks in us-east-1 or us-west-2 (see DECISIONS.md ADR-0001).

You are the lead engineer building Thapsus-HR, a production-ready, multi-tenant HR platform built by Thapsus. It must serve companies of every size, from 10 employees to multinational enterprises with hundreds of thousands of employees, across the United Kingdom, the European Union and the United States.

First: save this brief as docs/BUILD_BRIEF.md, create CLAUDE.md containing the non-negotiables and engineering rules, create docs/PROGRESS.md listing every phase and feature with acceptance criteria, then show me your plan for Phase 0 and wait. I will start the build with /goal.

## 1. Product position
- Thapsus-HR is a simpler, fairer alternative to all-in-one platforms such as Rippling: transparent pricing on self-serve plans, no lock-in on monthly plans, responsive human support, compliance rules kept current per country, deep configurability, and customers can export all of their data at any time.
- Out of scope: running payroll or filing payroll taxes ourselves, global payroll, Employer of Record, PEO, benefits brokerage, device management (MDM) or buying/shipping hardware, corporate cards and spend management, acting as an identity provider for other apps, and native iOS/Android apps (build an installable PWA instead).

## 2. Non-negotiables

Privacy and data residency
- Comply with EU GDPR, UK GDPR and the Data Protection Act 2018 (as amended by the Data (Use and Access) Act 2025), and US state privacy laws that cover employee data (for example California's CCPA/CPRA). Thapsus-HR is the processor; customers are the controllers.
- Every customer chooses a home region at sign-up: UK (AWS eu-west-2, London), EU (AWS eu-central-1, Frankfurt) or US (AWS us-east-2, Ohio). All of that customer's personal data, files, backups, logs, search indexes, caches, queues and emails stay in that region. Backups may only be copied to another region in the same jurisdiction (EU to eu-west-1, US to us-west-1); UK backups stay in London across availability zones.
- The global layer (marketing site, the tenant directory that maps a tenant to its region, billing) holds no employee personal data.
- Authenticated pages and API responses are served from the home region and never cached on an edge network.
- No personal data goes to any third party unless it is listed in docs/SUBPROCESSORS.md with its purpose and location, per region.

Security
- Tenant isolation is enforced in the database with PostgreSQL Row Level Security and proven by automated tests. The data layer must also support moving a very large tenant to its own dedicated database without code changes.
- Sensitive data (health, sickness and fit notes, disability, diversity and EEO data, immigration and work-authorisation documents) is stored separately, encrypted at field level with per-region AWS KMS keys, visible only to roles that need it, and every access is audit-logged.
- MFA mandatory for admins; customers can enforce SSO; sessions expire; sign-in has rate limiting and lockout.
- Append-only audit log for every change and every view of sensitive data, exportable by customers.
- OWASP ASVS level 2. Secrets only in AWS Secrets Manager. Least-privilege IAM. No long-lived AWS keys in CI.

Quality
- Accessibility: WCAG 2.2 AA (also covers US Section 508 expectations). Works well on low-cost phones.
- Internationalisation from day one: all text externalised for translation, English (UK) and English (US) at launch, locale-aware dates, numbers and currencies (GBP, EUR, USD and more), full time zone support.
- Employment rules are never hardcoded from memory. Store them as versioned, effective-dated data in jurisdiction packs with the official source URL, verify current values against official government sources while building, and make them editable in the back office.

Design (look and feel inspired by Apple.com)
- The marketing site and the app must feel as polished as Apple.com: calm, premium and uncluttered. Follow its design principles, but never copy Apple's logos, images, icons, wording or exact page layouts.
- Typography: system font stack (-apple-system, BlinkMacSystemFont, "Segoe UI", with Inter as fallback). Do not bundle SF Pro or use SF Symbols, because Apple's licences restrict them. Large, bold headlines with tight letter-spacing on the marketing site, comfortable 17px body text, clear hierarchy.
- Colour: mostly white and soft grey backgrounds with near-black text, one accent colour for links and buttons, and full-width dark sections for contrast. Full light and dark mode.
- Layout: generous white space, centred content at a comfortable reading width, full-width sections that alternate in tone, large rounded cards, pill-shaped buttons and subtle shadows.
- Navigation: a slim sticky top bar with a translucent blurred background on the marketing site; a clean sidebar and simple top bar inside the app.
- Motion: smooth, subtle scroll-triggered reveals and sticky scrolling feature showcases on the marketing site; quick, gentle transitions in the app; 60fps; fully respects prefers-reduced-motion.
- Imagery: crisp screenshots and device mock-ups of Thapsus-HR itself, optimised (AVIF/WebP, responsive sizes, lazy loading), and an open-source icon set with a consistent thin line style.
- Inside the app, keep the same calm style but put clarity and speed first: dense tables and dashboards must stay readable at enterprise scale.
- Performance: Lighthouse scores of 90+ for performance and 95+ for accessibility on key marketing pages and app screens, measured on mobile.
- Write docs/DESIGN.md (design tokens, type scale, spacing, components, motion rules) before building screens, and build every screen from those tokens.

## 3. Scale targets (prove with load tests; record results in docs/PERFORMANCE.md)
- A single tenant with 200,000 employees and 50 legal entities operating across the UK, EU and US.
- 5,000 concurrent users per tenant; 20,000 clock-ins within 10 minutes.
- p95 API latency under 300 ms for common reads and under 1 second for paginated lists at that size.
- Bulk import of 200,000 employees and large reports run as background jobs with progress tracking.
- 99.9% availability target, Multi-AZ everywhere, RPO 15 minutes or better, RTO 4 hours or better.

## 4. Architecture and stack (defaults: record any change and the reason in docs/DECISIONS.md)
- TypeScript everywhere. pnpm + Turborepo monorepo: apps/web (Next.js App Router, Tailwind, shadcn/ui restyled to the design rules in section 2, Motion for animation, installable PWA with web push), apps/api (Fastify, OpenAPI 3.1 first, versioned public REST API), apps/worker (background jobs and schedules), packages/db (Drizzle ORM and migrations), packages/rules (jurisdiction packs), packages/ui, packages/sdk.
- A per-region "cell" deployed with AWS CDK (TypeScript): ECS Fargate services (web, api, worker) with autoscaling behind an Application Load Balancer with ACM TLS and AWS WAF; Aurora PostgreSQL with Multi-AZ, read replicas for reporting, and RDS Proxy; ElastiCache (Valkey/Redis) for caching, rate limits and sessions; SQS and EventBridge for events; S3 (private, versioned, SSE-KMS) via presigned URLs; SES for email; EventBridge Scheduler; Secrets Manager; KMS; CloudWatch, X-Ray and OpenTelemetry with personal data scrubbed; AWS Backup; AWS Budgets alarms.
- A global stack (deployed in eu-west-2, London): Route 53, the tenant directory (tenant ID and slug to home region, no personal data), region-aware sign-in routing, marketing site and billing.
- Transactional outbox for reliable events and webhooks. Idempotent background jobs. Expand-and-contract database migrations for zero-downtime deploys.
- Search with PostgreSQL full-text and trigram indexes; add a dedicated search service only if load tests prove it is needed.
- Effective-dated records for all core HR data (full history and future-dated changes).
- Auth: a maintained library (for example Better Auth) with organisations, roles, TOTP MFA, passkeys and magic links, plus SAML 2.0 and OIDC single sign-on, SCIM 2.0 inbound provisioning and verified domains. All auth data stays in the home region.
- Billing: Stripe Billing with Stripe Tax (VAT and US sales tax) in GBP, EUR and USD.
- Environments: dev, staging and production, in separate AWS accounts where possible. GitHub Actions CI/CD with OIDC to AWS.
- Testing: Vitest (unit and integration against real Postgres in Docker), contract tests against the OpenAPI spec, Playwright end-to-end tests on mobile and desktop, k6 load tests, and golden tests for every jurisdiction rule.
- Local dev: docker compose (Postgres, Valkey, S3 emulator, SQS emulator, mail catcher), a seed script with a small demo company, and a generator for a 200,000-employee synthetic enterprise.
- The Thapsus-HR domain name will be provided later; keep it in configuration.

## 5. Users and roles
Thapsus super-admin (back office), company owner, HR admin, country or entity HR admin, payroll admin, manager (own team, with delegation), employee (self-service). Custom roles with field-level permissions scoped by entity, country, department or location. Thapsus support can access a customer account only when the customer grants it, time-limited and audit-logged.

## 6. Features

6.1 Core HR
- Effective-dated employee records: personal details, jobs, positions, grades, pay history, cost centres, contracts, emergency contacts, custom fields and custom objects.
- Organisation model: multiple legal entities, countries, departments, locations, cost centres, matrix and dotted-line reporting, and an org chart that stays fast at 200,000 people.
- Documents: folders, templates with merge fields, click-to-sign with an audit trail (signer, time, IP, document hash), expiry tracking, bulk send.
- Bulk import and export (CSV and Excel) with validation preview and background processing.
- Onboarding, offboarding and internal transfer workflows with tasks, due dates, reminders and a pre-start portal.
- Approval chains (multi-step, conditional, delegated) and bulk actions.
- Automation rules. Triggers: record created or changed, date reached, document expiring, threshold hit. Actions: task, notification, workflow, webhook, integration.

6.2 Time off and absence
- Policy engine per entity and country: accrual, pro rata, carry-over, caps, waiting periods, negative balances, TOIL, unpaid and family leave types.
- Public holidays per country and region (UK nations, EU member states, US federal holidays) plus company calendars.
- Sickness absence with documents and return-to-work forms; statutory sick pay tracking where it applies (UK SSP, EU member-state rules held in jurisdiction packs, US state and local paid sick leave accruals).
- US FMLA eligibility and leave tracking.
- Absence analytics including Bradford factor, trigger alerts, team calendar, cover rules and ICS feeds.

6.3 Rotas and time tracking
- Rota builder, templates, availability, open shifts, swaps with approval, publish and notify. Must work for 10,000+ shift workers in one tenant.
- Clock in and out from the PWA with optional geofence (off by default and configurable per country, because workplace monitoring rules differ), an offline queue, and a shared kiosk mode with PIN.
- Working-time rules from jurisdiction packs: US FLSA weekly overtime and state daily overtime, EU Working Time Directive limits and rest periods, UK 48-hour week and opt-out records, and daily time recording where a country requires it.
- Timesheets compared with the rota, overtime calculation, approvals and payroll export.

6.4 Jurisdiction packs and compliance centre
- Pack framework: versioned rule data per country (and per US state or locality), effective dates, official sources, golden tests, and a coverage table in docs/COVERAGE.md.
- UK pack: right-to-work checks with follow-up dates and retention; holiday rules including irregular-hours accrual; SSP; probation and service-length alerts, including the six-month unfair dismissal qualifying period from 1 January 2027 under the Employment Rights Act 2025; gender pay gap data for employers with 250+ staff.
- US pack: Form I-9 tracking with reverification dates and retention calculation; exempt and non-exempt classification; FLSA and state overtime; state and local paid sick leave; FMLA; EEO-1 data (voluntary self-identification kept as sensitive data). Federal rules plus a state and local layer, with state coverage recorded in COVERAGE.md.
- EU pack: EU baseline (minimum four weeks' paid annual leave, working-time limits, GDPR) plus member-state data for public holidays and statutory leave. Deeper member-state rules (sick pay, notice periods) prioritised and tracked in COVERAGE.md. EU Pay Transparency Directive reporting data (check each member state's current implementation status).
- Compliance matrix for licences, certifications, background checks and training, with expiry tracking and reminders.
- Law-changes feed maintained in the back office that shows customers what changed and what to do.

6.5 Payroll handoff (Thapsus-HR never runs payroll)
- Connector framework with per-tenant field mapping, pay-period exports (hours, absences, sick pay data, pay changes, starters, leavers), and delivery by download, SFTP or API.
- First connectors: generic CSV/Excel, SFTP, and Xero Payroll (UK). Documented stubs for ADP, Workday, UKG, Gusto and DATEV, with the partner-programme steps listed in docs/HUMAN_TODO.md.
- Payslip and year-end document upload for employee self-service.

6.6 Joiners and leavers IT automation
- Microsoft 365 (Microsoft Graph) and Google Workspace (Admin SDK): create accounts, licences and groups on joining; block sign-in, revoke sessions and remove licences on leaving. Per-customer admin consent, least privilege, dry-run preview, audit log.
- Asset register with assignment, handover sign-off and a return checklist.

6.7 Reports and analytics
- Ready-made reports per jurisdiction: headcount, turnover, absence, holiday liability, overtime, compliance status, gender pay gap, EEO-1 and pay transparency data.
- Report builder with fields, filters, grouping and charts, running on read replicas; CSV, Excel and PDF export; scheduled delivery; permission-aware.
- Scheduled data export to the customer's own S3 bucket or SFTP for their data warehouse.

6.8 Employee self-service (PWA)
- Own details, leave, rota, shift swaps, clock-in, payslips, documents, signing, checklists, and notifications by email and web push, all localised.

6.9 Privacy and trust
- Data subject request handling: per-person access export (machine-readable plus PDF), correction and deletion, with deadlines tracked per law (GDPR, UK GDPR, CCPA/CPRA).
- Retention engine per data category and jurisdiction, with suggested defaults (documented with sources and marked for legal review), automatic deletion or anonymisation, and a deletion log.
- Full company data export at any time; account closure with a grace period, then verified deletion.
- DPA acceptance, sub-processor list per region, privacy notice templates per jurisdiction, and an incident and breach log with deadline reminders (72 hours under GDPR and UK GDPR; US state notification rules recorded).
- Public security and trust page. SOC 2 and ISO 27001 controls mapping in docs/COMPLIANCE.md.

6.10 Enterprise platform
- Public REST API with OAuth 2.0 client credentials, scoped API keys, per-tenant rate limits, idempotency keys, pagination, versioning and published docs, plus a TypeScript SDK.
- Signed webhooks with retries, replay and a delivery log.
- Audit log streaming and export for the customer's SIEM.
- Sandbox tenant created from production configuration with synthetic data.
- Per-tenant feature flags, custom branding, and the dedicated-database option for very large tenants.

6.11 Support and back office
- In-app help centre and support tickets (stored in the home region), open to admins and employees, with SLA timers per plan and configurable contact channels.
- Thapsus back office: tenants and regions, plans and contracts, usage, support, jurisdiction rule data, the law-changes feed, feature flags, and an audit trail of staff actions. Back-office users see personal data only through granted, logged support access.
- Public status page per region.

6.12 Pricing and billing
- Self-serve plans with published prices by headcount band, monthly rolling or annual, free trial, upgrade and downgrade, cancel with notice.
- Enterprise contracts configured in the back office: custom pricing, annual invoicing, purchase orders, multi-entity billing.
- All prices, bands and discounts configurable, never hardcoded. Multi-currency, tax handled by Stripe Tax, failed-payment emails.

6.13 Optional AI assistant (feature flag, off by default)
- "Ask HR" answers employee questions from the company's own policies, citing the source document.
- Never used to make or recommend employment decisions (hiring, performance, pay, dismissal), so it stays outside the EU AI Act's high-risk employment uses. Users are told clearly that they are talking to AI.
- Process requests in the tenant's home region where possible (for example Claude via Amazon Bedrock in that region, if available; verify) and list the provider as a sub-processor. Never send sensitive data or other employees' data.

## 7. Delivery phases (complete in order)
After each phase: `pnpm verify` passes, docs updated, PROGRESS.md ticked, commit.
0. Foundations: monorepo, CI/CD, local dev, CDK cell and global stacks, auth with SSO and SCIM, tenancy with RLS and dedicated-database routing, roles, audit log, i18n, design system, PWA shell, seed data and synthetic data generator.
1. Core HR and organisation model (6.1)
2. Jurisdiction pack framework with UK, US and EU packs (framework part of 6.4)
3. Time off and absence (6.2)
4. Rotas and time tracking (6.3)
5. Compliance centre content for all three packs (rest of 6.4)
6. Payroll handoff and IT automation (6.5, 6.6), with external APIs mocked in tests
7. Reports, analytics and self-service (6.7, 6.8)
8. Privacy and trust (6.9)
9. Enterprise platform (6.10)
10. Support, back office, pricing and billing (6.11, 6.12)
11. AI assistant behind a feature flag (6.13)
12. Scale and launch readiness: load tests against the section 3 targets, threat model, OWASP ASVS level 2 review, dependency and secret scanning, accessibility audit, visual polish pass against docs/DESIGN.md (light and dark mode, phone and desktop), Lighthouse targets met, backup restore and availability-zone failure drills, staging deployed in all three regions, runbooks.

## 8. Engineering rules
- One branch per phase, small commits, never commit secrets.
- Write tests first for money, time and compliance logic, for tenant isolation, and for data residency (tests must prove a UK tenant's data never reaches EU or US resources, and the same for every region pair).
- Fictional test data only, never real people's data.
- `pnpm verify`: lint, typecheck, unit, integration, contract, tenant-isolation, residency, e2e, visual regression (Playwright screenshots in light and dark mode on phone and desktop), Lighthouse checks, security scan (dependency audit and secret scan), build and `cdk synth`, ending with a pass/fail summary. Print the summary in the conversation at the end of every phase.
- `pnpm smoke:staging`: end-to-end checks against staging in each region (sign up, choose region, SSO login, add employee, request leave, clock in, export data).
- `pnpm loadtest`: k6 scenarios for the section 3 targets, run against a temporary load-test environment that is torn down afterwards.
- Do not stop to ask me questions. Make the most reasonable choice, record it in docs/DECISIONS.md and carry on.
- Anything that needs me (accounts, domain, keys, app registrations, partner programmes, SES production access, Stripe live mode, legal review) goes in docs/HUMAN_TODO.md with exact steps. Build against mocks or test mode meanwhile and keep going.
- Ask me before deploying to production, deleting any cloud resource or data, or adding recurring cost beyond the docs/COSTS.md estimate.

## 9. Documentation
README, ARCHITECTURE (with diagrams), DESIGN, SECURITY, DECISIONS, COSTS (per environment and region), PERFORMANCE, COVERAGE, SUBPROCESSORS, COMPLIANCE (SOC 2 and ISO 27001 mapping), HUMAN_TODO, API docs, runbooks (deploy, rollback, backup restore, incident and breach response, moving a tenant to a dedicated database), a DPIA template, a records of processing draft, DPA and privacy notice templates per jurisdiction marked "for legal review", and admin and employee guides.

## 10. Definition of done
- Every phase and feature is ticked in docs/PROGRESS.md.
- `pnpm verify` passes.
- Staging is deployed in all three regions and `pnpm smoke:staging` passes in each.
- `pnpm loadtest` meets the section 3 targets, with results in docs/PERFORMANCE.md.
- Production stacks are defined and ready to deploy on my approval.
- All section 9 documents exist.
- Every remaining human-only step is listed in docs/HUMAN_TODO.md.
When you believe this is met, print the final verify, smoke and load-test summaries and the PROGRESS.md checklist in the conversation.
