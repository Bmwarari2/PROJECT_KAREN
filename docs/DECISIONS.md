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

---

## ADR-0006 — PostgreSQL-backed job queue; EventBridge for fan-out (2026-10-18)

**Context.** The brief lists SQS and EventBridge for events and jobs. Every job must run inside the tenant's own RLS context, record progress, and be idempotent by key. It must also move with the tenant when the tenant moves to a dedicated database.

**Decision.** Jobs live in `app.jobs` with a unique `(tenant_id, kind, idempotency_key)`. They are claimed with `FOR UPDATE SKIP LOCKED`, retried with exponential backoff and marked failed after N attempts. Workers find work through `registry.work_signals`, so they never scan tenant data. Domain events go to the transactional outbox, then to in-process subscribers (in the same transaction), then to the regional EventBridge bus, carrying only identifiers. SQS queues with DLQs are provisioned for webhook delivery and external consumers. Periodic work, such as future-dated changes, reminders and escalations, is enqueued idempotently per tenant and per date or slot by the worker's scheduler sweep, which EventBridge Scheduler also triggers.

**Consequences.** One transactional system of record for job state and progress. Jobs and outbox move with the tenant. SQS is not on the critical path.

## ADR-0007 — Effective-dating semantics (2026-10-18)

**Decision.** Records cover half-open `[valid_from, valid_to)` ranges and exclusion constraints forbid overlaps. A change at date D splits the record that covers D. A change on a record's own start date corrects it in place. A change dated before an existing future record propagates the changed fields into later records **only where they still hold the old value**; values a later record changed explicitly are kept. `app.employees` holds denormalised current values, refreshed after each write and by a daily idempotent job for future-dated changes.

## ADR-0008 — Motion with CSS and IntersectionObserver instead of the Motion library (2026-10-18)

**Context.** The brief's default is Motion for animation. The Lighthouse target of ≥90 mobile performance on low-cost phones makes JavaScript weight matter.

**Decision.** Scroll reveals and the sticky feature showcase use CSS transitions driven by `IntersectionObserver`, and app transitions use CSS. Durations come from the motion tokens and drop to 0 under `prefers-reduced-motion`. Motion can be added later for a specific interaction if CSS cannot achieve it.

## ADR-0009 — Visual regression rendered in the official Playwright Linux container (2026-10-18)

**Decision.** Screenshot tests drive a Chromium that runs in `mcr.microsoft.com/playwright:v<version>-noble` via `playwright run-server`, while the app runs on the host. Baselines are therefore identical on Windows, macOS and Linux CI. Inter is self-hosted, so the fallback font is the same everywhere.

## ADR-0010 — Jurisdiction rule data researched by agents against official sources (2026-10-18)

**Decision.** Pack values were gathered by research agents that fetched official sources. Each value records its URL, a `verifiedOn` date and the reviewer `research-agent (pending legal review)`. Golden vectors were copied from official dated lists where they exist (gov.uk bank holidays JSON, OPM, the German BALM 2026 list, Service-Public, BOE, citizensinformation.ie). Where no official dated list exists, the vector says it was derived from the statute. The US rule goldens repeat the pack values, so they test the engine rather than independently verify the values; only the US holiday goldens are independent. Legal review of every pack is a human step (HUMAN_TODO.md). Values that could not be verified from an allow-listed official source were left out and listed as coverage to-dos rather than filled from memory.

## ADR-0011 — Back-office staff accounts per regional cell (2026-10-18)

**Decision.** Thapsus staff accounts, sessions and the staff audit trail live in each cell's `backoffice` schema and are reached only through the `thapsus_backoffice` role. Staff sign in with a password and a mandatory TOTP code. Back-office rule edits are append-only `backoffice.rule_versions` rows layered over the pack data, and the newest edit wins where periods overlap. Staff reach tenant personal data only through customer-granted support access (ADR-0003 and SECURITY.md).

## ADR-0012 — Visual-regression server from the host's pinned playwright-core; optional local Chromium override (2026-10-18)

**Context.** `scripts/visual.mjs` started the Playwright run-server inside the official container with `npx -y playwright@<version>`, which downloads the package at run time. In sandboxed environments (and any CI runner without registry access from containers) the container has no network, so the server never started and every visual test failed with `ECONNREFUSED`. Separately, some development containers ship a pre-installed Chromium but do not allow `playwright install`.

**Decision.** The visual script mounts the host's lockfile-pinned `playwright-core` read-only into the container and runs `node /opt/playwright-core/cli.js run-server`, so the container needs no network and the server always matches the client version. Screenshots are still rendered by the container's Chromium (ADR-0009 is unchanged). The functional e2e project and the Lighthouse script accept an optional `PW_CHROMIUM_PATH` to use a pre-installed Chromium; CI keeps using `playwright install`.

**Consequences.** Visual runs are deterministic and offline-capable. Baselines are unchanged.

## ADR-0013 — Lettered migrations; USAGE (not CREATE) on schema public (2026-10-18)

**Context.** Phase 1 fixes need migrations after `0007` but before Phase 2's `0008`. The loader only accepted `\d{4}_name.sql`, so a file named `0007b_…` would have been skipped without any error. Separately, trigram word similarity (`<%`) failed for the application role: extensions live in schema `public`, on which 0001 revoked everything from PUBLIC, so extension operators did not resolve. `citext` comparisons from the app role were silently falling back to case-sensitive `text` equality for the same reason.

**Decision.** The loader accepts an optional lowercase letter after the number (`0007b_…`); ASCII order puts it between `0007_…` and `0008_…`. A unit test proves both the order and that every repository migration is loaded and passes the expand-and-contract lint. Migration 0007g grants `USAGE` (never `CREATE`) on `public` to the three application roles. The isolation suite asserts USAGE without CREATE, and that `schema_migrations` stays unreadable. Where a migration must fix data in a table with forced RLS, it lifts `FORCE` only inside its own transaction, which holds an exclusive lock. Only the owner is affected, because the application role never owns tables.

**Consequences.** Email lookups through `citext` columns are now case-insensitive for the app role, as the schema intended. Later lettered files must keep the `\d{4}[a-z]?_` shape.

## ADR-0014 — Emergency contacts are effective-dated by priority slot (2026-10-18)

**Decision.** Each contact row has `[valid_from, valid_to)`. An exclusion constraint on (employee, priority, period) means each slot (1, 2, …) holds one contact on any date, so "the list on date D" is well defined. `PUT /v1/employees/:id/emergency-contacts?effectiveDate=D` replaces the list in force from D. Contacts that cover D are closed on D, or replaced if they start on D. The new list runs until the next future-dated list, which is kept. `GET` takes `?asOf=`, and `/history` includes contacts. Rows from before this change start at `-infinity`. Earlier releases allowed duplicate priorities, so 0007b renumbers them before adding the constraint.

## ADR-0015 — Document folder visibility rules (2026-10-18)

**Decision.** Folder visibility controls lists and downloads in exactly the same way. A shared SQL predicate and a matching row check implement it, and one test exercises both against every visibility.

| Folder | Document about a person | Company document |
| --- | --- | --- |
| none | the person, and whoever may read their documents (managers, HR) | HR (`documents.manage`) |
| `employee` | the person, managers, HR | everyone signed in |
| `managers` | managers and HR, **not** the person (e.g. manager notes) | anyone with `documents.read`/`manage` |
| `hr` | HR who manage that person's documents only | HR |
| `everyone` | everyone signed in | everyone signed in |

Without HR rights, a person may only file their own upload in no folder, an `employee` folder or an `everyone` folder, so they can still see it afterwards.

## ADR-0016 — Exports of list views (2026-10-18)

**Decision.** `/v1/exports/{employees,tasks,approvals,documents}?format=csv|xlsx` uses the same query functions as the list endpoints (`employeeListWhere`, `listTasks`, `listApprovals`, `listDocuments`), so an export contains exactly the rows the list shows the caller. The people export accepts the same filters as the list and blanks any column the caller cannot read, row by row. Approval exports name the changed fields but never their values; approvers see values in the app, but a file can travel. Exports need `exports.run` because bulk data leaves the product. They are capped at 10,000 rows (beyond that: a background report) and audited as `export.<list>`. List rows now carry the full manager chain for team-scoped callers, as `loadTarget` does, so a skip-level manager sees the same fields in the list, the export and the profile.

## ADR-0017 — Pre-start portal, invitations and person-assigned tasks (2026-10-18)

**Decision.**
- `POST /v1/employees/:id/invite` (`users.invite`, in scope) gives a person a self-service sign-in linked to their employee record. The address defaults to work email, then personal email. The optional extra role is limited to `manager`; admin roles are assigned through role settings, which require MFA. The person is emailed a one-time link from the home region, valid for 7 days, using the magic-link mechanism. When the tenant enforces SSO, the email points to the sign-in page instead. Re-inviting sends a new link and keeps the account.
- Workflow tasks for the joiner or their manager record `assignee_employee_id` (migration 0007e). Tasks created before the person can sign in are handed to them when they are invited. `GET /v1/me/onboarding` and `/app/welcome` show documents to sign, two built-in forms (personal details, emergency contact) and the joiner's own checklist, with progress. Before the start date, form answers are effective from the start date, because the records begin then.
- Each task stores `reminder_days_before` from its template. Previously the field was accepted and then ignored. The reminder job sends one due-soon reminder at that lead time (default 2 days) and one overdue reminder.
- `MAIL_TRANSPORT=file` writes emails as JSON files for local development and e2e tests (to follow links). It is refused outside `dev` and `test`.

**Consequences.** Configurable portal forms (beyond the two built-ins) are future work. The e2e stack runs no worker, so the portal e2e test starts the workflow explicitly.

## ADR-0018 — Dispatching "call integration" automation actions (2026-10-18)

**Decision.** The action emits `integration.requested` to the outbox, as before. A subscriber now records an `app.integration_calls` row, one per event, which is the execution log. It also enqueues an idempotent `integrations.dispatch` job, which runs the handler registered for that integration id and stores the result (`GET /v1/automation/integration-calls`). Later phases register connectors in the same registry. Two handlers are built in:
- `log` makes no external call.
- `http` POSTs identifiers only (rule, event, employee id, date) as JSON to a public `https` URL. It is signed with a per-tenant HMAC key derived from `INTEGRATION_SIGNING_KEY`. If that key is not configured, the handler refuses to run rather than signing with a placeholder (webhooks still do).

Rules are validated when saved. Unknown integrations are rejected, as are non-https, loopback, private, link-local and internal targets (for webhooks too). Redirects are not followed. External calls are mocked in tests.

**Consequences.** Infrastructure must generate `INTEGRATION_SIGNING_KEY` per cell in Secrets Manager and inject it into the API and worker. Customers need a way to see their derived key, and webhook signing should move to the same key; both are follow-ups. The customer endpoint is chosen by the controller and receives no personal data beyond identifiers, so it is not a Thapsus sub-processor.

## ADR-0019 — Bulk import at 200,000 rows (2026-10-18)

**Context.** The import job made about 15 sequential statements per row and 5 per manager link: 2,000 rows took 55 s. It ended with a tenant-wide refresh whose `UPDATE … FROM` self-join planned as a quadratic nested loop: 20,000 people took 160 s, above the 30 s statement timeout. Right after a bulk insert, planner statistics still describe the tenant as tiny, so set-based joins picked whole-table scans per row.

**Decision.**
- New people are created per 500-row chunk with one `INSERT … SELECT FROM unnest` per table, grouped by the set of fields present. Existing people are compared with a bulk read of the values in force; numbers compare numerically, so `30` equals `30.00` and re-imports stay idempotent. Any constraint failure in a chunk rolls back to a savepoint and replays that chunk row by row, which gives exact row errors. Duplicate numbers in a file, updates, and rows without required fields always take the row-by-row path.
- Manager links for people without a reporting line are inserted in bulk. The current manager is kept up to date as links are written. An in-memory check plus a SQL check (both covering links to existing people) send any cycle to the per-row path, which rejects it with a row error. This also fixes a gap where two rows naming each other could create a cycle, because `assertNoCycle` reads current managers that the import had not refreshed.
- `app.refresh_employees_current(ids[])` (0007h) is a correlated per-row UPDATE and runs in linear time. `refresh_employee_current` keeps its contract on top of it. The job refreshes only the people it wrote, 2,000 at a time.
- After 1,000 or more creates, the job calls `app.analyze_core_hr()` (0007i). It is a parameterless `SECURITY DEFINER` function with a fixed table list, executable only by the app role. The isolation suite allow-lists definer functions.

**Consequences.** See `docs/PERFORMANCE.md` for 200,000-row timings. The validation preview still reads the whole file in the request (a few seconds at 200,000 rows). Moving the preview to a job is future work if files grow further.

## ADR-0020 — Every rule version must have a golden vector (2026-10-18)

**Context.** The audit of phase 2 found 24 rule versions with no golden vector dated inside their effective period, so "every rule has golden tests" was a convention, not a check. ADR-0010 also noted that the US rule goldens only repeated the pack values.

**Decision.** `packages/rules/test/goldens.test.ts` has a `golden coverage` suite. It resolves every rule vector that asserts a value and fails if any pack (jurisdiction, key, version) is not answered by at least one vector. It also fails when a pack with holidays has no holiday vector, or when a declared subdivision (GB-ENG, GB-WLS, GB-SCT, GB-NIR) has none. Vectors may assert the answering pack (`expectJurisdiction`) to prove layering, and carry `source` and `notes`. Expected values come from an official source independent of the pack where one exists: eCFR point-in-time text, the DOL WHD state minimum wage history table, WAC 296-128-545, the Colorado PAY CALC orders, gov.uk and nidirect guidance, legislation.gov.uk point-in-time versions. Where only the pack's own source exists, the vector's `notes` say it is derived from the same statute or page. The DOL history table is not used for states whose rates change mid-year (Florida, Oregon): its values there contradict the state schedules.

**Consequences.** A new pack version cannot be merged without a vector. This supersedes the ADR-0010 remark that US rule goldens only repeat pack values: most now cite an independent official source.

## ADR-0021 — Locality layer and hyphen-ancestor resolution (2026-10-18)

**Context.** The engine reduced any unknown code straight to its country (`US-NY-NYC` → `US`), so a city lookup skipped state law, and the API rejected three-part codes. City ordinances (paid sick leave, minimum wage) are a large part of US coverage.

**Decision.** Locality codes are `<ISO 3166-2>-<code>` with a 1–3 character alphanumeric code (`US-NY-NYC`); ISO 3166-2 has no city codes, so the suffix is ours and is documented per pack. Resolution starts at the most specific hyphen ancestor that has a pack and then follows `parent` (`US-NY-NYC` → `US-NY` → `US`; an unknown `US-NY-BUF` → `US-NY` → `US`). The validator requires a hyphenated pack's `parent` to be its hyphen ancestor and limits codes to three segments. The rules API accepts `^[A-Z]{2}(-[A-Z0-9]{1,3}){0,2}$`. The first locality pack is New York City (Protected Time Off Law, from the NYC DCWP site), modelled from 22 February 2026 only; earlier dates fall back to New York State.

**Consequences.** `RuleBook.chain()` and `resolve()` keep their signatures; callers that pass a work-location code get locality law automatically. Leave and time modules should pass the most specific code they know for a work location. Holiday lookups are unchanged (country plus optional region).

## ADR-0022 — UK nations: rule-version extent and a Northern Ireland pack (2026-10-18)

**Context.** `GB-NIR` lookups silently returned Great Britain law, but Northern Ireland has its own employment legislation (Working Time Regulations (NI) 2016, Employment Rights (NI) Order 1996, its own social security Act). Some GB rules are UK-wide (minimum wage, right to work), most are not.

**Decision.** A pack may declare `subdivisions`. Every rule version in such a pack must then list the `regions` it was verified for (validator-enforced). The extent comes from the legislation.gov.uk extent markers: WTR 1998, ERA 1996, SSCBA 1992 s.157 and the family-leave regulations are E+W+S; the National Minimum Wage Act 1998 and the Immigration, Asylum and Nationality Act 2006 are UK-wide. A lookup for a subdivision uses its own pack first (new `GB-NIR` pack, parent `GB`), then only GB versions that list it; otherwise it falls through and fails with `RuleNotFoundError` (404 in the API). A bare `GB` lookup keeps returning the Great Britain default law, for compatibility. Back-office edits on a subdivided pack keep the scope of the pack version they amend; a rule that exists only as a back-office edit answers the bare code, not a subdivision. Resolved rules and the API return `regions` so callers can see the extent. Bank holidays stay in the GB pack per region.

**Consequences.** Northern Ireland maternity, paternity, irregular-hours accrual and gender pay gap lookups now fail explicitly until NI law is researched (COVERAGE.md lists them). Tenants with staff in Northern Ireland must pass `GB-NIR`, not `GB`, for those employees; the leave and time modules must map work locations to nation codes.

## ADR-0023 — Official-source allow-list additions and EURES as a fallback (2026-10-18)

**Context.** Bavarian Epiphany was verified on gesetze-bayern.de but left out because the domain was not allow-listed. The Lithuanian (e-tar.lt, e-seimas.lrs.lt) and Romanian (legislatie.just.ro, cdep.ro, gov.ro, mmuncii.ro) legal portals block or refuse automated fetching.

**Decision.** Add `gesetze-bayern.de` (BAYERN.RECHT, the Bavarian State Chancellery's official Land-law portal) to the validator allow-list with a comment; every future addition must be a government, parliament, official gazette or EU-institution domain and carry a comment. Where a national legal portal cannot be fetched, the European Commission's EURES "Living and working conditions" pages (eures.europa.eu, already allowed) may be used for a single stable value, with the version's notes saying the primary text was not reachable, `effectiveFrom` set to the verification date, and a HUMAN_TODO entry to confirm it. EURES is not used where it is visibly inconsistent or out of date: the Lithuanian holiday lists disagree with each other and the Romanian list lacks days reported as added to the Labour Code, so LT and RO holidays stay unmodelled.

**Consequences.** LT and RO annual leave are now modelled from EURES; CY, LT and RO holidays remain coverage to-dos for a person to check manually.

## ADR-0024 — Pack versions are enforced with a content-hash manifest (2026-10-18)

**Context.** Pack `version` is returned with every resolved rule (`packVersion`) but was never bumped when pack JSON changed, so consumers could not tell two different data sets apart.

**Decision.** `packages/rules/pack-manifest.json` records, per pack, an append-only history of `(version, updatedOn, contentHash)`, where the hash is sha256 of the canonical (key-sorted) pack JSON without `version` and `updatedOn`. `pnpm --filter @thapsus/rules manifest -- --write` appends an entry only if the content changed and the version went up; otherwise it fails. `test/manifest.test.ts` fails when a pack's hash or version does not match its latest entry, when versions do not strictly increase, or when a pack is missing from the manifest.

**Consequences.** Any pack edit needs a version bump, a manifest entry and a regenerated COVERAGE.md in the same commit. The packs edited in this change are at version 2 (GB, DE, LT, RO, CY, US-NY, US-CO); GB-NIR and US-NY-NYC start at version 1. Rewriting manifest history by hand is still possible, so code review must reject edits to existing entries.

## ADR-0025 — Per-rule verification log in COVERAGE.md (2026-10-18)

**Context.** COVERAGE.md showed only the latest verification date per jurisdiction, so a stale individual value could hide behind a recent one.

**Decision.** The generator adds a verification log with one row per rule version (jurisdiction, key, effective period, regions, `verifiedOn`, source URL), a per-pack summary of holiday verification dates, and, for packs with subdivisions, a table of which nations each rule answers for. The existing staleness test keeps the file in step with the packs.

**Consequences.** COVERAGE.md is longer (one row per rule version) and changes whenever any value is re-verified.

## ADR-0027 — Statutory sick pay uses the rule version in force on each day (2026-10-18)

**Context.** UK SSP changed on 6 April 2026 (no waiting days, one-day PIW, no lower earnings limit, lower of £123.25 and 80% of NWE). The engine read only the post-April shape, so a 2025-26 rule (flat rate, three waiting days, four-day PIW, LEL) produced `NaN`. Spells and periods of entitlement often span the change, and S.I. 2026/373 regs. 3–6 govern that.

**Decision.** `ukSsp` takes a function returning the GB `sick_pay.statutory` version for a date and applies it per qualifying day. A spell is a PIW if it meets the shortest `minPeriodOfIncapacityDays` among the versions in force during it. PIWs separated by no more than `linkingPeriodWeeks` (gap of days between them, s.152(3)) link. Waiting days are served once per period of entitlement. Days below a version's LEL are not payable. The pack's `transitional` protected rate (reg. 4) applies to the spell that began before the change, continues after it and already had SSP paid before it, for NWE inside the protected band. This reproduces regs. 3 and 5 (post-6 April days payable; sub-LEL earners paid from 6 April). Payment is grouped by weekly rate: whole weeks at the weekly rate, odd days at weekly ÷ qualifying days rounded up to the penny.

**Consequences.** Pre- and post-April vectors are golden-tested against the real pack. Not modelled: the reg. 5/6 Schedule 11 exclusion (continuous sickness from 21 September 2025), Northern Ireland, and NWE derivation from the eight-week pay history (the route uses current pay or an explicit `normalWeeklyEarningsMinor`). Listed in HUMAN_TODO 3.4.

## ADR-0028 — EU employer sick-pay shapes and their assumptions (2026-10-18)

**Context.** The member-state packs hold different `sick_pay.statutory` shapes. The engine only read DE/NL (percent and weeks) and IE (days per year), so FR, ES and PL returned meaningless numbers.

**Decision.** `employerContinuedPay(rule, input)` detects the shape and returns a common result (scheme, eligibility, paid days and basis, percent, amounts, bands, notes):
- **DE/NL:** percentage for the first N weeks of the incapacity, counted from the first sick day, once the qualifying service is served. Paid working days × daily pay (weekly pay ÷ working days).
- **IE:** days per calendar year at a percentage with a daily cap, after the qualifying service. Earlier spells in the year count.
- **ES:** the employer window is days `from`–`to` of the incapacity (calendar days). The benefit percentage is not in the pack, so no amount is computed.
- **FR:** the employer complement after `minServiceYears`, `waitingDays` per stoppage (none for listed causes), then the service band's 90% and 66.66% durations, treated as calendar days. Days paid in the previous 12 months are deducted. The employer amount is the guaranteed percentage of gross daily pay (weekly ÷ 7) less the IJSS estimated at the pack's 50% from its own waiting period.
- **PL:** calendar days per calendar year at 80% (100% for the pack's listed causes), at weekly pay ÷ 7.

Values the pack does not hold are flagged in `notes`, never invented: NL minimum-wage floor and wage cap, FR IJSS daily cap, ES benefit percentage, and the PL age-50 limit when the caller does not supply `age50Plus`. The route does not read date of birth, so the limit is flagged `assumedUnder50`.

**Consequences.** Golden tests per held member state (DE, ES, FR, IE, NL, PL) against pack values. Interpretations needing legal review are in HUMAN_TODO 3.4.

## ADR-0029 — Leave-year entitlement is summed over policy and FTE periods (2026-10-18)

**Context.** `balanceFor` used only the policy in force on the balance date and ignored assignment dates. So a mid-year policy change or FTE change re-rated the whole year.

**Decision.** The service splits the leave year at every assignment boundary, default-policy validity boundary and job-record (FTE) boundary. It resolves the policy for each slice (assignment first, then entity → country → any default) and the engine sums unrounded entitlement per slice. Rounding is applied once, using the policy in force on the balance date, which also supplies unit, carry-over, cap, waiting period and negative allowance. Future-dated assignments are included, so the whole-year figure is the same before and after the change date. Policy day amounts are full-time days (five-day week), pro-rated by FTE. For hours-unit policies they are converted at the full-time day length, (weekly hours ÷ FTE) ÷ 5. So 5.6 weeks becomes 5.6 × weekly hours however the part-time week is shaped. Adjustments, carry-over, caps and the negative allowance are in the policy unit. Requests, public holidays and balance checks use hours for hours-unit policies.

**Consequences.** Every slice is assumed to share the leave-year start of the policy in force on the balance date. Monthly accrual counts whole months within each slice.

## ADR-0030 — Source of hours worked (2026-10-18)

**Context.** Per-hour-worked accrual, FMLA's 1,250-hour test and US paid sick leave need actual hours. Timesheets arrive with phase 4 (`app.timesheets`, weekly minutes), which is not on this branch.

**Decision.** `hoursWorked(employee, from, to)` uses this precedence:
1. Approved timesheets whose week starts in the range, if `app.timesheets` exists (checked with `to_regclass`, so no code change is needed when phase 4 merges).
2. Otherwise `app.worked_hours`: new table, forced RLS, recorded by HR via `POST /v1/leave/worked-hours` (audited), pro-rated by days for partial overlaps.
3. Otherwise, for FMLA and US sick leave only, an estimate from the contracted working pattern over the days employed. Leave accrual never estimates: no recorded hours means nothing accrued.

For FMLA, an HR-provided `hoursPrior12Months` takes precedence. Every result reports its `hoursSource` (`provided`, `timesheets`, `recorded`, `estimated` or `none`). Where no accurate hours record exists, the employer must show the hours (29 CFR 825.110(c)), so an estimate is labelled as one.

**Consequences.** This code depends on phase 4's column names (`regular_minutes`, `overtime_minutes`, `double_minutes`, `status = 'approved'`, `week_start`). Re-check them at merge time.

## ADR-0031 — US state paid sick leave modelling (2026-10-18)

**Context.** `usSickAccrual` ignored annual and 12-month caps, employer-size paid thresholds and the dates when use may begin. A locality (city or county) layer is being added on another branch.

**Decision.**
- **Accrual period:** the calendar year to the balance date.
- **Accrual:** whole increments of `hoursEarned` per `perHoursWorked`.
- **Caps:** the lowest of the balance cap (CA, greater or lesser of hours and days × hours per day), `annualCapHours` (CO, MA, OR), `capHoursPer12Months` (IL) and the NY size tier.
- **Paid or unpaid:** paid unless `paidIfEmployeesAtLeast` (tenant active headcount) or a `paidIf<State>EmployeesAtLeast` key (active employees whose region is the state) is not met.
- **When use may begin:** "after N days" (`useBeginsAfterDays`, `useBeginsCalendarDay`, CA `employmentPeriodDaysBeforeUse`) means start date + N. This follows the official wording: DIR "90-day employment period before", L&I "90 calendar days after your first day", IL "after 90 days". "Until the Nth calendar day of employment" (`useMayBeDeferredUntilCalendarDay`, OR) means start date + N − 1.
- **CA 30-day rule:** working days in the last 365 days.
- **Localities:** keys that depend on one (`…Location`, `…ordinance…`) are returned in `notEvaluated`, and the result is computed without them.

**Consequences.** Usage, carry-over and front-loading are not tracked yet (the result is an accrual figure). Employer-defined 12-month periods (IL/NY alternatives) are not configurable yet.

## ADR-0032 — FMLA leave years, coverage, worksite and usage (2026-10-18)

**Context.** The route enum used `rolling_backward` while the pack says `rolling_backward_from_leave_date`. The window maths lived in the route and used 365-day years. Coverage counted today's headcount instead of the "50 employees in 20+ workweeks" test.

**Decision.**
- **Leave-year method:** validated against `family_leave.fmla.leaveYearMethods`. The database only checks the format (migration `0009b`), and the legacy value is read as the pack name. The pack's `leaveYearMethodMustBeUniform` is enforced against the company setting (`PUT /v1/settings/absence`, `fmla.leaveYearMethod`) and existing cases. `fmlaLeaveYear` in the engine computes the window for the four pack methods using calendar months (DOL Fact Sheet #28H). A fixed 12-month year starts on the company `fixedYearStart`, else the hire anniversary. Military caregiver leave uses its single 12-month period.
- **Coverage:** for each ISO workweek of the current and preceding calendar year, count US employees employed for the whole week (29 CFR 825.105 payroll method, as a conservative reading). All US employees in the tenant are treated as one employer. Public agencies are covered when the company setting says so.
- **Worksite:** active employees at locations within the pack's `radiusMiles` of the employee's location, using geofence coordinates. Without coordinates only the same location counts.
- **Usage:** approved (and, for the booking check, pending) leave requests carrying `fmlaCaseId`, in hours. The leave type can be any type, because paid leave may run concurrently. Usage is attributed by request start date. Part-day requests need an intermittent case. A request that exceeds the remaining hours is refused. Usage is summed across the employee's cases; caregiver usage is kept separate.

**Consequences.** Not modelled: the combined 26-week caregiver period including other FMLA leave, the 60-day notice to change method, and joint or integrated employer tests across tenants. Listed for legal review in HUMAN_TODO 3.4.

## ADR-0033 — Sensitive absence visibility, medical detail and calendar tokens (2026-10-18)

**Context.** Masking of sensitive leave types used "has absence.read anywhere". So a manager with any absence permission saw sickness for everyone they could see on the calendar. There was no way to read medical detail. A user could "revoke" another user's ICS token: the request got a 204 and a false audit row.

**Decision.**
- Calendar and request lists compute, per row, whether the viewer has `absence.read` in scope for that employee (the same scope predicate as reads). Otherwise sickness, family and FMLA show as "away" with no note.
- `GET /v1/sickness` lists dates and status only.
- `GET /v1/sickness/:id/medical` decrypts reason, fit note name and return-to-work answers only with `vault.read:sickness` (HR), or for the employee's own record (self-disclosure). Managers are refused. The refusal is audited in a committed transaction, and each decrypted field is audit-logged.
- `DELETE /v1/leave/ics-tokens/:id` returns 404 unless the token belongs to the caller.
- A token naming an unknown or other tenant is 404.

This work also fixed `scopePredicate`: an all-scope grant after a narrower grant left unused SQL parameters behind, which caused a 500.

**Consequences.** Absence settings (fit-note threshold, FMLA) live in `tenants.features.absence`.

## ADR-0034 — Rota grid: own windowing over keyset pages, no virtualisation dependency (2026-10-18)

**Context.** The rota must stay responsive for 10,000+ shift workers in one tenant on low-cost phones (brief §6.3). Rendering every employee × day cell is out of the question, and the API must page by keyset rather than offset.

**Decision.** The grid (`apps/web/app/app/rota/rota-grid.tsx`) renders only the rows in view plus an overscan, using a small in-repo hook (`apps/web/lib/use-virtual.ts`: fixed 48 px rows, passive scroll listener coalesced to one update per animation frame, `ResizeObserver`). We did not add `@tanstack/react-virtual`: fixed-height rows need about 40 lines of code and no new dependency. Rows are memoised. `GET /v1/rota` returns employees ordered by `(display_name, id)` with their week of shifts, the total on the first page and open shifts. The client sizes the scroll area from the total, shows skeleton rows for pages not yet loaded, and fetches keyset pages in order until the window is covered (so a jump to row 5,000 loads 25 pages of 200 in sequence). The grid uses ARIA grid semantics (`aria-rowcount`, `aria-rowindex`) so screen readers announce the full size. Intl formatters are cached in `@thapsus/core/i18n` (constructing them per cell cost ~100 ms per frame).

**Consequences.** Only ~27 rows are ever in the DOM (proved by `apps/web/e2e/rota-bench.spec.ts`). A far jump costs one request per 200 rows skipped. Variable-height rows (more than one shift per day are shown as "+n") would need measured heights.

## ADR-0035 — Working-time checks: statutory findings follow the tenant setting; cost and policy signals only warn (2026-10-18)

**Context.** Brief §6.3 and PROGRESS 4.3 ask for working-time rules from the packs, surfaced as warnings or blocks per tenant configuration, with the UK 48-hour opt-out and daily time recording where a country requires it.

**Decision.**
- Statutory limits from the packs (daily rest, weekly rest, rest breaks, the averaged maximum week) are *violations*. With `features.time.enforcement = 'block'` a shift that adds one is refused with 422 and the violations. With `'warn'` (the default) it is saved and they come back as warnings. Each finding carries the rule's official source URL.
- Only findings the change *adds* are reported, so an existing breach does not block unrelated edits. The averaged maximum is the exception: a shift inside the reference window always adds to it.
- Projected overtime (US FLSA weekly, state daily and seventh-day tiers) and availability conflicts are always warnings. Overtime is a cost, not a breach.
- Claims and swaps are re-checked when the manager approves. A block then refuses the approval and the request stays pending. Applying a template leaves a slot open (and reports it) rather than assigning a blocked person.
- The 48-hour opt-out is honoured only where the pack's `working_time.max_weekly_hours.optOutAvailable` is true. Records can be created only where `working_time.opt_out.permitted` is true (GB), and notice is capped by `maxAgreedTerminationNoticeMonths`.
- Daily time recording: Spain (Estatuto de los Trabajadores art. 34.9, from 12 May 2019) and Germany (BAG 1 ABR 22/21) now have employer-level rules. `bundesarbeitsgericht.de`, the Federal Labour Court's official site, was added to the validator's allow-list (gesetze-im-internet.de returned 503 during research). Other member states resolve to the EU baseline (CJEU C-55/18), and the timesheet shows which jurisdiction the flag came from. Scheduled days with no recorded time are flagged.

**Consequences.** Tenants choose strictness without code changes. The legal review of these rules is tracked in HUMAN_TODO 3.13.

## ADR-0036 — PWA clock: device-side queue with client event ids and idempotent batch sync (2026-10-18)

**Decision.** Punches are written to `localStorage` (per user) before any network call. They are sent in batches of up to 200 to `POST /v1/clock/events` with a client-generated `clientEventId`, and the insert is `ON CONFLICT (tenant_id, employee_id, client_event_id) DO NOTHING`. The response reports `created`, `duplicate` or `rejected` per event, and every answered event leaves the queue. Sync runs on load, on the `online` event, after each punch and from a "Sync now" button. We do not use the Background Sync API (not supported in Safari/iOS), and the service worker still never caches API responses. Events from the future (beyond a 5-minute clock skew) or older than the tenant's `clock.maxOfflineHours` (default 72) are rejected and shown to the worker. The kiosk does not queue offline because its PIN must be checked by the server.

**Consequences.** Lost responses and retries never duplicate punches (`apps/web/e2e/clock.spec.ts` replays a queue). The queue holds only the worker's own punches on their own device.

## ADR-0037 — Geofencing is opt-in per country, with notice, and location is otherwise never collected (2026-10-18)

**Decision.** Geofencing is off by default. A tenant enables it per country (`features.time.geofence.countries`). Enabling a country requires notice text (per locale) that workers see on the clock screen; the API refuses the setting without it. The browser asks for location only when the worker's country is enabled *and* their location has a fence. The server stores coordinates (rounded to 4 decimal places, about 11 m) and `within_geofence` only in that case. Coordinates sent in any other case are discarded before the insert. Coordinates are never logged, never written to the audit trail and never returned by the API: only the within/outside flag is.

**Consequences.** This meets workplace-monitoring expectations (UK GDPR/ICO, EU works-council rules) by default. Outside-the-fence punches are recorded and flagged on the timesheet, not refused, because offline punches cannot be refused at the time they happen.

## ADR-0038 — Shared kiosk: hashed device token plus employee number and Argon2id PIN, lockout without enumeration (2026-10-18)

**Decision.**
- A kiosk is registered by a time manager and receives a `kio_<tenant>.<secret>` token. The token is shown once as a pairing link and only its SHA-256 is stored. It can be revoked.
- The kiosk sends `Authorization: Kiosk <token>` to the public `POST /v1/kiosk/clock`, together with the employee number and PIN. PINs are 4–8 digits, Argon2id-hashed (the password parameters), and trivial sequences are refused.
- Throttles: per IP (120/min) and per kiosk (`kiosk.attemptsPerMinute`, default 30).
- After `kiosk.maxFailedAttempts` failures (default 5) the PIN locks for `kiosk.lockoutMinutes`. Failures for real employees are counted in `kiosk_pins`. Failures for unknown numbers are counted in the rate limiter under the same thresholds, and both paths burn an Argon2 verification. Unknown numbers and wrong PINs therefore get identical answers (401, then 423), and timing is similar.
- The transaction always commits the counters, and the error is raised after the commit. Every success and failure is audited as a system actor with the kiosk id.

**Consequences.** A stolen kiosk token alone cannot clock anyone in. Lockout state is per employee, not per kiosk.

## ADR-0039 — Timesheet snapshots and the payroll export feed (2026-10-18)

**Decision.** A timesheet is computed live: recorded time from clock events not superseded by a manager correction, compared day by day with the published rota. Variances beyond `timesheets.varianceToleranceMinutes` (default 15) are flagged. Overtime and findings come from the packs. Submitting freezes a snapshot (days, totals, findings, sources) and starts a `timesheet` approval, using a manager policy created on first use as for leave. While a week is submitted or approved, corrections to it are refused. A manager can reopen a week only if it has not been exported. `GET /v1/timesheets/export` returns the approved snapshots of a week as CSV:
- ordered by employee number;
- hours with two decimals, derived from integer minutes;
- spreadsheet formula injection neutralised.

Each export is recorded in `app.timesheet_exports` with a SHA-256 checksum, which is also returned as `X-Content-SHA256`. The export sets `exported_at` and is audited.

**Consequences.** Re-exporting a closed week returns identical bytes. Phase 6's payroll connectors can consume the same snapshot.

## ADR-0040 — Letter-suffixed migration names (2026-10-18)

**Context.** Phases are developed on stacked branches. A follow-up migration for Phase 4 must not take the number another phase may already use (`0011_…`). The loader's `^\d{4}_` pattern would have silently ignored a file named `0010b_…`.

**Decision.** Migration names may carry one letter after the number (`NNNNx_slug.sql`) and sort between their neighbours (`0010_` < `0010b_` < `0011_`). A unit test (`packages/db/test/migrate.test.ts`) asserts that every `.sql` file in the folder is loaded and passes the expand-and-contract lint.

**Consequences.** Branches can add migrations without renumbering. Applied names never change.

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

## ADR-0050 — Compliance centre: one module, shared status calculations, one idempotent daily job (2026-10-18)

**Context.** Phase 5 adds right-to-work checks, Form I-9, the compliance matrix, service alerts, reports and the law-changes feed. The list pages, the dashboard and the reminders must never disagree about what is due.

**Decision.** Everything lives in `apps/api/src/modules/compliance`: pure calculators over pack values in `engine.ts` (golden tests in `apps/api/test/compliance-engine.test.ts`), status calculations shared by the list endpoints, the dashboard and the job in `status.ts`, and one `compliance.daily` job per tenant and date. Every notification and task carries a dedupe key naming the record, the due date and the reminder offset (`rtwcheck:<id>:<offset>`, `i9-rev:<id>:<due>:<offset>`, `matrix:<record>:<offset>`, `probation:<employee>:<date>:<offset>`, `lawchange:<id>`), so a re-run or retried job sends nothing twice. A new right-to-work check or matrix record closes the tasks raised for the record it replaces. Statutory values are resolved from the packs on the relevant date and the rule source is stored with computed dates (`rule_source`).

**Consequences.** Reminder behaviour is proven by integration tests that run the job twice for the same date. The job reads every employee of a tenant each day; for very large tenants it should be split per entity (not needed for the current load targets).

## ADR-0051 — Compliance settings are product settings with documented defaults (2026-10-18)

**Context.** Reminder lead times, the small-cell threshold and the business days used for I-9 deadlines are not law, but CLAUDE.md forbids hard-coding anything configurable.

**Decision.** They are tenant settings in `app.tenants.features->'compliance'` (`GET/PUT /v1/settings/compliance`, audited). Defaults in `compliance/service.ts`: right-to-work and I-9 reminders 90, 30, 7 and 0 days before the due date (90 matches the USCIS advance-notice suggestion already in the US pack), matrix 60/30/7/0 unless a requirement sets its own, probation 14/0, unfair-dismissal qualifying date 30/0, small-cell threshold 5, business weekdays Monday–Friday (USCIS does not define "business days"; the pack records that), gender pay gap sector private and voluntary.

**Consequences.** Customers can change every default; legal review of the defaults is HUMAN_TODO 3.11.

## ADR-0052 — INPS on the official-source allow-list; Italian notice from EURES (2026-10-18)

**Context.** Italian sick pay and notice were coverage to-dos because inps.it and normattiva.it were not allow-listed. normattiva.it still resets automated connections.

**Decision.** Add `inps.it` (Istituto Nazionale della Previdenza Sociale, the public social security institute) to the validator allow-list, with a comment, under the ADR-0023 rule. Italian sick pay (INPS indemnity bands) comes from the INPS information page (updated 21 September 2026). Italian notice uses the EURES fallback of ADR-0023: Civil Code art. 2118 leaves notice to collective agreements, so the pack records "no statutory minimum, set by the CCNL", effective from the verification date, with HUMAN_TODO 3.5 to confirm against normattiva.it.

**Consequences.** DE, FR, NL, ES, IE and IT (and PL) now have notice and sick-pay rules. The leave module's statutory-pay endpoint returns an empty employer-continued-pay result for IT because its rule describes an INPS benefit, not employer pay (owner of the leave module to decide how to show it).

## ADR-0053 — Sensitive data for compliance reporting stays in the vault; only aggregates leave it (2026-10-18)

**Context.** EEO-1 needs race/ethnicity and sex; the UK gender pay gap and the EU Pay Transparency Directive need the sex used for pay reporting; right-to-work and I-9 records involve immigration documents.

**Decision.** EEO-1 voluntary self-identification (race/ethnicity, sex, veteran and disability status, or "declined") is stored only in the vault, category `eeo`; employees can submit their own through a self-disclosure grant. The sex used for pay reporting is in category `diversity` (field `pay_reporting`). Report endpoints decrypt one value per person through `Vault.read`, so every decrypt is audited and a reader without `vault.read:<category>` for a person gets 403; responses contain aggregates only. EEO-1 cells below the threshold are withheld, plus one complementary cell per job category when only one would be withheld, and row totals below the threshold; exact counts for filing need the separate `compliance.reports_exact` permission and the view is audited as sensitive. Right-to-work document details, share codes, evidence files and I-9 citizenship attestations are vault category `immigration`; files go to the home-region bucket under the tenant prefix. Follow-up and reverification dates stay in `app.rtw_checks` / `app.i9_records` because the reminder job needs them; list views of those tables are audited as sensitive.

**Consequences.** Large reports decrypt one value per person (one KMS data-key unwrap each); for very large tenants the report should move to a background job. Observer identification for EEO-1 is not offered.

## ADR-0054 — Unfair dismissal qualifying date is selected by the effective date of termination (2026-10-18)

**Context.** ERA 2025 s.25 cuts the qualifying period from two years to six months from 1 January 2027, and S.I. 2026/559 reg. 4 applies the new period by effective date of termination (EDT).

**Decision.** The alert date is the earliest EDT on which the employee has the qualifying period in force on that EDT, walking the effective-dated rule versions (an employee short of two years on 31 December 2026 but with six months qualifies on 1 January 2027). Continuous employment counts the start day and the EDT (ERA 1996 s.211(1)), so two years from 15 January 2024 completes on 14 January 2026. The statutory-notice extension of the EDT (s.97(2)) and automatically unfair reasons are not modelled. Northern Ireland uses its own one-year rule; jurisdictions without the rule get no alert.

**Consequences.** Golden tests cover both sides of 1 January 2027 and GB-NIR.

## ADR-0055 — Pay-gap statistics: exact inputs, display rounding, stated interpretations (2026-10-18)

**Context.** Means, medians and percentages are not money, but they are computed from money.

**Decision.** Inputs are integer minor units. UK hourly rates follow reg. 6 (pay × 7 / days in the pay period, a month = 30.44 days) and are carried as integer thousandths of a minor unit; percentages are computed once at the end and rounded to one decimal place only for display. UK figures come from payroll data loaded for the snapshot (`PUT /v1/compliance/pay-report-inputs`); without it, current pay records are used with no bonus data and daily-rate employees are excluded (the page says which). EU Pay Transparency: the gap in complementary or variable components is taken over workers who receive them, quartile remainders go to the lower bands, and a category with a gap of at least the pack's 5% is flagged for a possible joint pay assessment; these are interpretations pending national transposition (HUMAN_TODO 3.10).

**Consequences.** The GOV.UK Acme Ltd examples are reproduced exactly by the golden tests.

## ADR-0056 — Law-changes feed lives in each cell's back office (2026-10-18)

**Context.** Staff must publish entries; tenants must see only relevant ones and record who acknowledged them; no personal data may sit in the global layer.

**Decision.** `backoffice.law_changes` (no personal data: jurisdiction, effective date, localised title/summary/what to do, linked back-office rule version ids and pack rule references, source URL, status) is written through the `thapsus_backoffice` role by staff with MFA (`rules_editor`), every change in `backoffice.staff_audit`; entries can be corrected, published or withdrawn. Linked rule references are validated against `backoffice.rule_versions` and the packs. The application role reads published entries; relevance is the lineage and pack parents of every jurisdiction code of the tenant's entities, locations and employees (`GB-ENG` → GB; `DE` → EU; `US-NY-NYC` → US-NY → US). Read and acknowledged state is per user in `app.law_change_reads` (forced RLS); acknowledging is audited. The daily job notifies HR admins once per entry.

**Consequences.** Staff publish an entry in each regional cell that needs it (as with back-office rule versions, ADR-0011).

## ADR-0057 — Compliance views read the leave module instead of duplicating it (2026-10-18)

**Context.** SSP, sickness, FMLA and leave policies belong to the leave module, which another phase owns.

**Decision.** The SSP view calls the existing `GET /v1/sickness/{employeeId}/statutory-pay` in-process (`app.inject` with the caller's credentials, so its permission checks apply) for each GB employee with sickness in the last year. The irregular-hours check and the leave coverage page read `leave_policies`, `leave_policy_assignments` and `fmla_cases` read-only. The reg. 15B accrual calculator lives in the compliance module because the leave engine's per-hour accrual does not apply the reg. 15B(5) rounding. FLSA overtime eligibility is exposed at `GET /v1/compliance/flsa/{employeeId}/overtime-eligibility` for the time module to consume; the time module is not changed.

**Consequences.** No leave or time code changed. The time module should read the eligibility endpoint (or `classifyExemption`) when it computes overtime.

## ADR-0058 — Compliance queries fall back to the first job record for people who have not started (2026-10-18)

**Context.** Right-to-work checks and Form I-9 Section 1 happen before the first day, but the denormalised current values on `app.employees` (entity, location, country) are empty until the start date.

**Decision.** Compliance employee queries coalesce the current values with the employee's first job record (and its location and entity) so starters appear with their jurisdiction from the day they are hired.

**Consequences.** Entity- or location-scoped admins only see starters once the current values are refreshed (scope predicates use the current columns).

## ADR-0059 — Compliance records refuse dates the packs do not model (2026-10-18)

**Context.** The right-to-work rules are modelled from the 1 October 2026 guidance, and the I-9 rules from their modelling baseline.

**Decision.** Recording a check or I-9 on a date with no rule in force fails with 422 instead of applying later guidance to an earlier check. A new expiry date on an I-9 opens the next reverification cycle (the completed Supplement B stays in the audit trail).

**Consequences.** Customers migrating older checks need the earlier guidance versions added to the packs first (coverage to-do).
