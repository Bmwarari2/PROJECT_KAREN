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

---

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

---

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

## ADR-0060 — Payroll connectors render one canonical, snapshotted input set (2026-10-18)

**Context.** Brief §6.5 asks for exports of hours, absences, sick pay data, pay changes, starters and leavers through per-tenant field mappings, and for a closed period's export to be reproducible. Connectors differ (files, APIs), and live HR data keeps changing after payroll has run.

**Decision.**
- Every connector receives the same canonical `PayrollInputs` document, built in `apps/api/src/modules/payroll/inputs.ts`. Its arrays are sorted, it holds no timestamps of "now", and it contains only people who appear in a section.
- Closing a pay period stores that document in the append-only `app.pay_period_snapshots` table, with the SHA-256 of its canonical JSON (keys sorted). A trigger blocks updates, and closed periods cannot be reopened or moved.
- Exports of a closed period are rendered only from the snapshot, after an integrity check against that hash.
- Renderers pin every archive timestamp to the period end. Zips and Excel workbooks are re-packed with fixed entry dates and order.
- Each export records the file hash, the inputs hash and the connector configuration hash.
- Field mapping is a validated, typed list of columns per section, with a closed field catalogue and a small transform set: date, number, hours or minutes, money, code map, boolean, case and fixed values.

**Consequences.**
- The same closed period with the same connector configuration produces byte-identical files, which the tests prove with SHA-256.
- A changed mapping produces a different file, and its configuration hash shows why.
- Corrections go into the next period rather than mutating a closed one.
- No field outside the catalogue can leave through a connector.

## ADR-0061 — Attribution of hours, absences and SSP to pay periods (2026-10-18)

**Context.** Timesheets are weekly. Pay periods can be monthly, and leave can straddle a period boundary.

**Decision.**
- **Hours**: an approved timesheet belongs to the period that contains its week start. Weeks are never split.
- **Absences**: approved leave of any type overlapping the period is clipped to the period. Working days are recalculated for the clipped part with the leave engine (pattern and public holidays).
- **Sick pay**: UK SSP for the period is the difference between cumulative SSP to the period end and cumulative SSP to the day before the period start, using the GB pack rule `sick_pay.statutory` in force at the period end. The pack's pre-April-2026 flat-rate shape is adapted for the engine, and the lower earnings limit is applied when the pack has one. Other jurisdictions' sick pay is exported as absences only until their packs are modelled.

**Consequences.** Payroll teams on monthly calendars get each week once, with no fractional weeks. SSP follows the pack's effective-dated values and source URL.

## ADR-0062 — Delivery transports: presigned download, pinned-key SFTP (ssh2) and API push (2026-10-18)

**Context.** Exports must be delivered by download, SFTP or API, safely and idempotently.

**Decision.**
- **Download** returns a five-minute presigned link to the home-region bucket and writes a delivery-log row.
- **SFTP** uses `ssh2` 1.17.0 (MIT, maintained). Its optional native crypto builds are denied in `pnpm-workspace.yaml`, and minimal local typings replace `@types/ssh2` (which pulls `@types/node@18`).
  - The server host key is always pinned with an OpenSSH `SHA256:` fingerprint.
  - Private, loopback, link-local and CGNAT destinations are refused outside dev and test. The host is resolved once and connected by address.
  - Files are written as `.name.part` and renamed into place.
- **API push** goes through the connector's `push`. It sends a per-record `Idempotency-Key` and skips items an earlier delivery of the same export already completed.
- All transports run as idempotent jobs keyed by the delivery id.
- Permanent failures (host key, authentication, not connected) are recorded without retry. Transient ones throw, so the worker retries.

**Consequences.** Re-deliveries never duplicate payroll records and never write half files. The SFTP path is tested against an in-process ssh2 server.

## ADR-0063 — Integration secrets: one KMS envelope per integration, outbound host allow-list (2026-10-18)

**Context.** OAuth refresh tokens, client secrets, service-account keys and SFTP credentials must never sit in plaintext columns or logs. Personal data may go only to destinations listed in SUBPROCESSORS.md.

**Decision.**
- **Secrets**:
  - `app.integration_credentials` stores one sealed envelope per integration. It uses the existing envelope scheme (a fresh data key wrapped by the regional KMS key), with the AAD bound to tenant and owner.
  - The API returns only the names of the configured secrets, and audit entries record names only.
  - Rotated OAuth refresh tokens (Xero) are re-sealed on every use.
  - Reporting roles cannot read the table.
- **Outbound calls** go through `integrationRequest`, which:
  - allows HTTPS only to an allow-list of hosts, each of which must appear in SUBPROCESSORS.md (a unit test checks this);
  - never follows redirects and times out;
  - reduces provider error bodies to an error code.
- The customer-controlled SFTP host is the one exception, guarded as in ADR-0062.

**Consequences.** A new integration cannot send data until it is listed in SUBPROCESSORS.md. Secrets cannot be exfiltrated through the API, the audit log or logs.

## ADR-0064 — Payslips are restricted documents outside the document library (2026-10-18)

**Context.** The general document library lets managers and HR read employee documents in scope. Payslips and year-end tax forms should be visible only to the employee and payroll.

**Decision.**
- Payslip batches and files live in their own tables (`app.payslip_batches`, `app.payslips`), not in `app.documents`.
- Only the employee (`payslips.read_own`) and payroll roles (`payslips.read`, `payslips.manage`) can list or download them. Every download is audited as sensitive.
- Matching uses whole employee-number tokens in file names, or a customer regex with an `employeeNumber` group. Several matches are "ambiguous" and are never guessed.
- Zip entries are inflated with a hard byte limit, because zip header sizes can lie.

**Consequences.** Managers and the document library never expose pay data. A mismatched file stays unpublished until someone matches it by hand.

## ADR-0065 — Joiner and leaver automation: exact dry-run plan, idempotent per-call log, conservative matching (2026-10-18)

**Context.** Brief §6.6 asks for Microsoft 365 and Google Workspace account automation with per-customer admin consent, least privilege, a dry-run preview and an audit log.

**Decision.**
- **Plans**: a pure plan builder (`apps/api/src/modules/it/plan.ts`) turns the employee and the customer's mapping rules into the exact provider calls. The dry run returns that plan. Execution stores the same calls, one row each in `app.it_operations` with an idempotency key, and runs them. Only the generated one-time password (never stored or logged) and the new account id are filled in at run time.
- **Microsoft 365** uses Entra admin consent to a multi-tenant app, or the customer's own app, with the least-privilege application permissions listed per call.
- **Google Workspace** uses domain-wide delegation for a service account with four narrow scopes, via an RS256 JWT bearer grant (`jose`).
- **Triggers**: outbox events `employee.created` and `employee.terminated` schedule jobs:
  - joiners run a configurable lead time before the start date (default 3 days);
  - leavers run at the end of the last working day in the employee's zone, or immediately;
  - hires backdated by more than 7 days are never provisioned automatically, which protects imports of existing staff.
- **Safety**:
  - Joiner chains stop at the first failure.
  - Leaver steps each run regardless, so sign-in is blocked even if licence removal fails.
  - An existing account is adopted only if it carries the same employee number.
  - A leaver with no Thapsus-created account and no matching work email is skipped, not matched to a generated name.
- **Attributes** (job title, department, country) are resolved as of the start date for future joiners.

**Consequences.**
- Previews are trustworthy: the tests assert that the executed requests equal the preview.
- Re-runs never repeat completed calls.
- Privileged-user disabling in Entra may also need an admin role on the app; this is documented, not granted by default.

## ADR-0066 — Asset return tasks join the offboarding workflow through a start hook; dev downloads via signed local links (2026-10-18)

**Context.** The asset return checklist must be tied to offboarding. Separate outbox subscribers for workflows and assets would race, because jobs created in the same transaction have equal timestamps. Separately, the in-memory object store used in dev and e2e returned `memory://` links that a browser cannot open.

**Decision.**
- **Return tasks**: `workflows/service.ts` gains `workflowStartHooks`, which run in the transaction that starts a workflow. The asset register adds one return task per issued asset to an offboarding instance:
  - source `workflow`, so the instance completes when everything is done;
  - deduplicated per assignment;
  - assigned to `features.assets.returnAssigneeRole` (default `hr_admin`);
  - due on the leave date.
- **Return**: recording a return needs every checklist item ticked (or the asset marked lost) and completes the task.
- **Handover sign-off**: the employee acknowledges in person. The record holds the server time, user, IP, user agent and the version key of the statement shown (`assets.ackStatement.v1`).
- **Dev and test downloads**: the memory store can sign five-minute HMAC download links served by a hidden `/v1/dev/objects` route. The route is registered only in dev and test, and production keeps S3 presigned URLs.

**Consequences.**
- Return tasks appear whether the workflow starts automatically or by hand.
- A sign-off can be proven later.
- Browser downloads work in local dev and e2e without an S3 emulator.

---

## ADR-0068 — Dedicated databases are declared in the infra env config; one tools task per database migrates it and runs the move (2026-10-19)

Numbered from the unused 0067–0069 range because 0100–0129 are reserved by other branches. Completes ADR-0099 and Phase 0.7 for AWS.

**Context.** The router already reads `DEDICATED_DATABASE_HOSTS`, and the move tool and back-office requests exist (ADR-0099). But the runbook told operators to add `dedicatedDatabases` to `infra/config/<env>.json`, a setting infra did not have. The cluster, its migrations, the owner credentials for the move runner and a task to run it were all left to hand work. The router's handling of the setting and its residency check had no tests.

**Decision.**
- **Config:** `dedicatedDatabases?: [{ key, cell, minAcu?, maxAcu? }]` in the env config, validated by `validateConfig` (`infra/lib/config.ts`). The key must be lower-case letters, digits and single hyphens, start with a letter, be at most 24 characters and not be `shared`, and keys must be unique ignoring hyphens. The cell must be a home cell and capacity must be 0.5–256 ACU with min ≤ max. Unknown fields are refused. The committed configs declare none.
- **Per entry, in that cell's stack only:** an Aurora PostgreSQL 17 Serverless v2 cluster `thapsus-hr-<env>-<cell>-<key>` and its RDS Proxy. Both come from the same helper as the shared cluster: writer and reporting reader in two AZs, the cell's data KMS key, backup retention and deletion protection from `aurora`, isolated subnets and the cell's database security group, TLS on the proxy, encrypted log groups. The cluster is added to the cell's AWS Backup selection and gets a CPU alarm. Each cluster has its **own owner secret**. The app, back-office and reporting role secrets are the cell's shared ones, so the migrator sets the same passwords everywhere.
- **Routing:** the api and worker get `DEDICATED_DATABASE_HOSTS={"<key>":"<proxy endpoint>"}` and `DEDICATED_READER_HOSTS={"<key>":"<reader endpoint>"}`, the JSON form `TenantRouter.fromEnv` reads with `DATABASE_SECRET` and `REPORTING_DATABASE_SECRET`. The variables are absent when a cell has no entry.
- **Router hardening:** `fromEnv` refuses `DEDICATED_DATABASE_HOSTS` without `DATABASE_SECRET` (it was silently ignored before), a `shared` key, invalid keys and non-object JSON. It also applies the residency check to every database and reader when `CELL_REGION` is set, so CLIs that skip `depsFromEnv` cannot be pointed at another region either.
- **Tools task** `thapsus-hr-<env>-<cell>-db-<key>` (api image, migrator subnets and security group):
  - The default command `node dist/migrate.mjs` migrates the dedicated database.
  - The command override `node dist/move-tenant.mjs --process-requests` runs the move runner. It gets the owner URLs of both databases from `ownerUrlsFromEnv` (`SHARED_OWNER_DATABASE_SECRET` + `SHARED_DATABASE_HOST`, and `OWNER_DATABASE_SECRET` + `DATABASE_HOST` for `DEDICATED_DB_KEY`).
  - The api image now also bundles `dist/move-tenant.mjs`.
  - The runner only claims requests whose current and target databases both have an owner URL, so several dedicated databases' tasks never fail each other's requests.
- **Deploys:** `scripts/deploy-plan.ts` adds a `run-migrator` step for each dedicated database of the cell, after the shared migrator and before the restart. A dedicated tenant therefore never runs on an unmigrated schema.

**Consequences.**
- Moving a tenant is a config entry, a cell deploy, a back-office request and one `run-task` (runbook). It needs no code change and no hand-built AWS resources.
- Each entry is recurring cost (`docs/COSTS.md`) and needs approval first.
- Removing an entry deletes the cluster (retained in prod, snapshotted elsewhere), so ask first.

---

## ADR-0069 — S3 audit streams assume only customer roles named `thapsus-hr-audit-*`, from the worker only (2026-10-19)

Numbered from the unused 0067–0069 range because 0100–0129 are reserved by other branches. Refines ADR-0095.

**Context.** ADR-0095 left the IAM grant for S3 audit streaming to a person (HUMAN_TODO 6.2 asked for `sts:AssumeRole` on `arn:aws:iam::*:role/*`). The API accepted any role ARN, so a stream only worked once someone granted every role in every account. Data export (ADR-0077) already solved the same problem in code with a role-name prefix.

**Decision.**
- **Prefix:** an S3 audit stream's role must be named `thapsus-hr-audit-…` (`AUDIT_STREAM_ROLE_PREFIX` in `apps/api/src/modules/platform/siem-s3.ts`), in the `aws` partition, with no role path (IAM matches the prefix against the whole path and name). The name may be at most 64 characters.
- **API:** `POST /v1/settings/audit-streams` refuses any other role with **422**, `detail: "roleNotAllowed"` and `rolePrefix: "thapsus-hr-audit-"`. A value that is not a role ARN at all is still a 400. Nothing is stored.
- **Writer:** `AwsCrossAccountS3.put` checks the prefix again after the residency checks and before calling STS, so a stored stream with another role fails with `role_not_allowed` and sends nothing.
- **IAM:** the cell stack grants `sts:AssumeRole` on `arn:aws:iam::*:role/thapsus-hr-audit-*` (sid `AssumeCustomerAuditStreamRoles`) to the **worker** task role only, because only the `audit_streams.sync` job writes to S3. The API task role does not get it. The export grant (`thapsus-hr-export-*`, api and worker) is unchanged, and the two prefixes are separate, so an export role cannot be used for audit streams or the other way round. `infra/test/infra.test.ts` pins the three `sts:` statements exactly.
- **Customer setup:** the role name, trust policy (our account and the stream's ExternalId) and permissions policy are documented in `docs/api.md`.

**Consequences.** No IAM change is left for a person (HUMAN_TODO 6.2 now only covers publishing the account ids and an end-to-end review). Customers must name the role with the prefix; the hint in the app and the 422 say so.

---

## ADR-0070 — Ready-made reports are a typed registry proven by golden tests (2026-10-18)

**Context.** Phase 7 needs headcount, turnover, absence, holiday liability, overtime and the statutory reports, reproducible for any date, permission-aware and exportable in several formats.

**Decision.** `apps/api/src/modules/reports/ready/registry.ts` holds one definition per report: id, category, i18n title/description keys, permission(s), jurisdictions (`*`, `GB`, `US`, `EU`), sensitivity, a TypeBox parameter schema and `run(ctx, params)` returning typed columns (`text`, `enum`, `integer`, `decimal`, `percent`, `money`, `date`, `minutes`, `boolean`) and rows, optional totals, facts, notes and a chart hint. Calculations are pure functions over facts loaded once (`calc/people.ts`, `calc/absence.ts`, `calc/liability.ts`) using bigint fixed point (ten-thousandths, one rounding half away from zero); they never read the clock — the caller passes explicit dates. Statutory values (working-day patterns, bank holidays, thresholds) come only from the jurisdiction packs and the leave engine. `apps/api/test/reports-goldens.test.ts` pins every calculation to hand-computed values for fixed dates. Renderers (CSV with BOM, XLSX with typed cells, PDF with title, parameters, generated-at with time zone, and the table) take the same result model, so screen and file always agree.

**Consequences.** A new report is a definition plus a golden test. On-screen runs above a population limit (absence 2,000, holiday liability 1,000 employees) must use a background run.

## ADR-0071 — Reports run on the Aurora reader endpoint as a read-only role (2026-10-18)

**Context.** Reports must not load the writer, must keep forced RLS, and must work when a large tenant moves to its own database.

**Decision.** Tenant routing config gains optional reader URLs per database key (`READER_DATABASES`, `REPORTING_DATABASE_URL`, or `REPORTING_DATABASE_SECRET` + `REPORTING_DATABASE_HOST`; `DEDICATED_READER_HOSTS` for dedicated databases). `withTenantReader` opens a read-only transaction on the tenant's reader as `thapsus_reporting` (SELECT only, no BYPASSRLS, owns nothing, revoked from the vault, credentials, sessions, tokens and export-destination secrets) with the same `app.tenant_id` context; if a database key has no reader it falls back to that key's writer, never to another database's reader. The CDK cell stack passes the Aurora cluster read endpoint as `REPORTING_DATABASE_HOST` to the API and worker. We use the cluster reader endpoint, not an RDS Proxy read-only endpoint, to avoid a second proxy's cost; reader lag (normally under a second) is acceptable for reports. Vault decryption and compliance calculators that need the vault run on the writer, with every decrypt audited.

**Consequences.** Reports can be a few seconds behind writes. Moving a tenant to a dedicated database needs its reader host in configuration only.

## ADR-0072 — Headcount and turnover definitions (2026-10-18)

**Context.** HR teams compare these figures with other systems, so the definitions must be explicit.

**Decision.** Employed on date D: `start_date <= D` and (`end_date` is null or `end_date >= D`); `end_date` is the last working day. Grouping uses the job record in force on D (`[valid_from, valid_to)`); country is the job location's, else the legal entity's; no job record → "Unassigned"; a dimension the viewer cannot read → "Restricted". Turnover for `[from, to]` inclusive = leavers with `end_date` in the period ÷ ((headcount on `from` + headcount on `to`) ÷ 2) × 100, rounded once to 2 dp; a leaver's group is their job on the last day. Voluntary / involuntary comes from the new optional `leaver_type` on termination (expand-only column, `voluntary | involuntary | other`); unrecorded leavers count as "Other or not recorded".

**Consequences.** Existing leavers show as "not recorded" until HR sets the type. The definitions are printed as notes on the report.

## ADR-0073 — Holiday liability method and rounding (2026-10-18)

**Context.** Finance teams need the value of leave earned but not taken, per currency, without floating point.

**Decision.** Untaken = leave accrued to the date (by the leave engine's accrual method; up-front entitlements pro-rated to the part of the leave year employed so far) + carry-over (capped, minus expired) + adjustments − public holidays taken where the entitlement includes them − approved leave taken. Value = annualised contractual basic pay × untaken ÷ (52 × working days per week) (or ÷ (52 × weekly hours) for hour-based policies), computed in integer minor units and rounded once, half away from zero; totals per currency, never converted or mixed. Over-taken leave is a negative amount. It excludes employer on-costs and variable pay.

**Consequences.** Finance may need on-costs added outside the system; the method is listed for review in HUMAN_TODO.md.

## ADR-0074 — Report builder: masked SQL, no individual special-category values (2026-10-18)

**Context.** The builder lets users pick fields, filters and groupings; it must never reveal what the user's grants hide, including through filters or group labels.

**Decision.** Datasets (`people`, `leave`, `absence`, `timesheets`) declare each field's SQL, type, label key, sensitivity and permission. The compiled query first builds a masked base (`CASE WHEN <readable for this row> THEN value END`, using the same scope predicates and field-level permissions as the employee API), then filters, groups and aggregates only the masked values, so filtering on a hidden value matches nothing and hidden groups show as "Restricted". Money aggregates group by currency. Vault-backed fields (sickness reason) appear only with the category permission, are decrypted on the writer after the reader query and every value read is audited. Sex, gender and EEO categories are not builder fields at all: they are reported only as suppressed aggregates by the compliance calculators. Specs are validated against a TypeBox schema; previews are limited to 500 rows and exports to 250,000.

**Consequences.** Some useful cuts (for example pay by sex) are only available through the statutory reports, by design.

## ADR-0075 — Background runs, short-lived downloads and result expiry (2026-10-18)

**Context.** Exports and large reports should not block requests, and results contain personal data.

**Decision.** `app.report_runs` holds status, progress, row count, bytes, error code and expiry. The idempotent `reports.run` job renders the file into the tenant's home-region object store under `<tenant>/reports/<run>/…`; downloads use 300-second presigned links issued only to the requester and audited. Results expire after the tenant setting `reports.resultTtlHours` (default 168); the `reports.cleanup` job deletes the object and marks the run expired (download then returns 410). Permanent errors (forbidden, validation, not found, unprocessable) fail without retry; others retry up to five attempts.

**Consequences.** Users re-run reports after expiry. Object-store lifecycle rules remain a backstop.

## ADR-0076 — Scheduled delivery per recipient; emails carry no personal data (2026-10-18)

**Context.** Scheduled reports must respect each recipient's own permissions and must not leak data by email.

**Decision.** A schedule (daily, weekly on an ISO weekday, monthly on day 1–28, at a local time in an IANA zone, DST-aware) belongs to a saved report; relative periods (`previousMonth`, `yearToDate`, …) resolve against the period date. For each due period the enqueuer creates one run per recipient, unique on (schedule, period, recipient), and runs it with the recipient's own principal; recipients must be able to use reports when the schedule is saved. The home-region mailer sends a generic "your report is ready" email with a sign-in-protected link to `/app/reports/runs/<id>`; no report title, content or names are in the email.

**Consequences.** Two recipients may receive different rows from the same schedule. The recipient picker lists only users who can use reports.

## ADR-0077 — Data export destinations: home-region S3 via `thapsus-hr-export-*` roles, or pinned SFTP (2026-10-18)

**Context.** Customers want regular extracts in their own storage without long-lived keys, and residency rules forbid writing outside the home region.

**Decision.** One module (`apps/api/src/modules/data-export/destination.ts`) defines a small `Destination` interface (`describe`, `test`, `put`) with two implementations. S3: the bucket region must equal the cell's home region (validated on save and confirmed by `HeadBucket` before each write); credentials come from STS `AssumeRole` (15 minutes) on a customer role whose name starts with `thapsus-hr-export-`, with a per-destination ExternalId (`thr-` + 32 hex) generated by us; clients come only from the residency-guarded factory. The CDK cell stack grants the API and worker task roles `sts:AssumeRole` on `arn:aws:iam::*:role/thapsus-hr-export-*` only. SFTP reuses the phase 6 transport (ssh2, pinned SHA256 host key, private-address refusal); passwords and keys are sealed with the regional KMS key. Exports choose builder datasets and fields (never vault fields), run as the user who set them up (permissions re-evaluated each delivery), are idempotent per (export, period), and log status, files, rows, bytes, duration and error code only. The customer setup is in docs/guides/data-export.md.

**Consequences.** Customers create and own the IAM role. Destinations are the controller's own systems, not sub-processors (SUBPROCESSORS.md).

## ADR-0078 — Self-service: one hub over existing modules; legal details change through approval (2026-10-18)

**Context.** Employees need one place for their details, leave, shifts, clock, documents, tasks, notifications and payslips, without duplicating those modules.

**Decision.** `GET /v1/me/summary` returns counts and next items from the existing modules (leave balance via the leave service, read-only; next published shift and pending swaps; clock state; documents to sign; open and overdue tasks; unread notifications; published payslips from phase 6), each only when the caller's grants allow it; the web hub links to the existing pages. Contact details the employee may write change directly through the employee changes API; legal name, date of birth and nationality go through `POST /v1/me/change-requests` as an `employee.self_change` approval (HR admin, else owner; never the requester), applied effective-dated on approval; audit records the fields, not the values. Notification preferences (`users.notification_prefs`) switch email and web push per category (approval, leave, absence, rota, time, task, document, payslip, compliance, asset, report); in-app notifications are always kept, and the delivery job honours the preferences.

**Consequences.** Self-service screens add no new data stores beyond the preferences column.

## ADR-0079 — Statutory reports reuse the compliance calculators (2026-10-18)

**Context.** Gender pay gap, EEO-1, EU pay transparency and compliance status already exist in the compliance centre (phase 5) and read sex/EEO data from the vault.

**Decision.** The shared calculations were extracted into `apps/api/src/modules/compliance/reporting.ts` and are called by both the compliance routes and the ready-made reports, on the writer (vault access, audited), returning only aggregates with the compliance centre's small-cell suppression. Reports add no new calculation or access path for special-category data; EEO-1 output is always marked as not an exact filing.

**Consequences.** Changes to the statutory methods are made once, in the compliance module.

## ADR-0080 — Privacy deadlines and retention as pack rules in their own keys; conservative date maths (2026-10-18)

**Context.** Data subject request (DSR) deadlines, breach notification deadlines and retention periods are law. They must come from the jurisdiction packs with official sources, like employment rules. Another workstream is changing the pack engine at the same time.

**Decision.** New keys live in `packages/rules/src/privacy-keys.ts` and are spread into `RULE_KEYS`: `privacy.dsr_deadline`, `privacy.breach_notification` and `retention.*`. The packs hold the values, each with its source, verification date and the reviewer `research-agent (pending legal review)`. Golden vectors are in `goldens/privacy.json`. The date maths lives in `packages/rules/src/privacy.ts`; the engine itself is unchanged. Where a statute can be read two ways, the code takes the earlier date:
- months are counted to the corresponding date;
- no rollover to the next working day is applied;
- "two further months" is the earlier of due date + 2 months and start + 3 months.

The UK has two versions: Article 12(3) until 4 February 2026, then Article 12A from 5 February 2026, which moves the clock start to the information or fee and stops the clock for clarification. California is modelled from 1 January 2023, when the CCPA employee exemption became inoperative.

**Consequences.** The deadline shown is never later than the law allows. Values from sources that could not be reached are not recorded (see ADR-0089).

## ADR-0081 — One catalog-checked map of person data drives export, erasure and coverage (2026-10-18)

**Context.** An access export must include every table about the person, and a new table must not be silently missed.

**Decision.** `apps/api/src/modules/privacy/subject-map.ts` classifies every tenant table that references a person:
- **subject columns:** rows exported in full, with credentials omitted;
- **actor columns:** exported as counts only, so other people's data is never disclosed;
- **an erasure action:** delete, anonymise or keep with a reason;
- **a retention category.**

`personColumns()` enumerates the catalog: foreign keys to `app.employees` and `app.users`, plus uuid columns named like `*_employee_id`, `*_user_id` or `*_by`. The test `apps/api/test/privacy-coverage.int.test.ts` fails when a column is not mapped. Vault values are decrypted in the export, and each decrypt is audited with its purpose. Categories the exporter may not read are withheld, and that is audited too.

**Consequences.** Every phase that adds a table referencing people must add a line to the map, or the test fails.

## ADR-0082 — Erasure semantics (2026-10-18)

**Decision.** Erasure decides per category:
- **Legal holds** block everything, or one category.
- **Statutory minimums** (`statutoryMinimum: true` in the packs) keep a category until it expires. Examples: WTR reg. 9 for time records, 29 CFR 1602.14 for US personnel records (kept while employment continues).
- **Suggested defaults and tenant policies** never block an erasure request.

When a category is erased:
- identity is **anonymised**: names, contact details, date of birth, employee number, work email and the search vector are replaced or cleared, and the user account is deactivated with an `erased.invalid` address;
- emergency contacts, credentials, sessions, documents, files and vault values are **deleted**;
- pseudonymous job and contract history is kept for workforce statistics.

The audit trail and the DSR record are kept for accountability. The deletion log (`app.retention_runs`) records categories and counts only.

**Consequences.** Erasure is safe to run for current employees in the US, where identity is kept by law. The legal reading is flagged for review (HUMAN_TODO 3.16).

## ADR-0083 — Retention engine is opt-in per category and evaluates groups of records (2026-10-18)

**Decision.** For each category, jurisdiction and record date, the sweep combines the pack rules with the tenant policy. The tenant policy can lengthen a statutory minimum but never shorten it; the API refuses a shorter period with 422 and lists the minimums. Automatic deletion runs only for categories the tenant enabled. The daily job is enqueued only when a policy is enabled. A dry run is always available, and is logged. Rows are grouped by jurisdiction, record date and employment end, so the cost grows with the number of distinct dates, not the number of rows. Leavers' personnel records are anonymised through the erasure path.

**Consequences.** Nothing is deleted without an explicit tenant decision. Statutory minimums still bind when the tenant sets a shorter period.

## ADR-0084 — Company export as a zip built with fflate 0.8.3 (2026-10-18)

**Context.** Customers can export all their data at any time.

**Decision.**
- **Format:** a background job writes `tables/<schema.table>.csv` for every tenant table (enumerated from the catalog like the tenant-move tool), `sensitive/vault-records.jsonl` (decrypted, with one audit entry per category), every stored file under the tenant prefix, `files/manifest.csv` and `manifest.json` (row counts and SHA-256 per file).
- **Omitted:** credential hashes, tokens and wrapped keys are never exported.
- **Library:** `fflate` 0.8.3 is MIT-licensed with no dependencies. It is pinned exactly and is a direct dependency of `@thapsus/api`.
- **Delivery:** the archive is stored at `<tenant>/exports/<id>.zip` in the home-region bucket and downloaded through a 300-second presigned URL.

**Consequences.** The archive is built in memory. That is fine for typical tenants, but the 200,000-employee profile needs streaming S3 multipart upload, which is a Phase 12 follow-up. Tables are read one statement at a time, not as a single snapshot, and the manifest says so.

## ADR-0085 — Account closure: grace period, guarded audit purge, verified deletion and certificate (2026-10-18)

**Decision.**
- **Scheduling:** `POST /v1/privacy/closure` (owner only) schedules deletion after `closureGraceDays` (30, pending legal review), with a cancellable job whose `run_after` is the purge time.
- **Blocking access:** the purge first sets the registry status to `closing`, which blocks sign-in and API use.
- **Audit log:** the log is purged by `audit.purge_closed_tenant()`. It is a `SECURITY DEFINER` function that refuses any tenant not `closing` with a closure in `purging`. The append-only trigger allows that delete only, and the app role still has no DELETE privilege.
- **Database:** every other tenant table is deleted children-first.
- **Files and caches:** object deletion removes all versions under the tenant prefix. Rate-limit and lockout keys are removed by prefix.
- **Verification and certificate:** each store is checked empty. A deletion certificate with counts, backup expiry, log retention and region is written to `registry.deletion_certificates`, which is allow-listed in the isolation test, and emailed to the requester from the home region.
- **Final state:** the registry and the global directory are marked `deleted`. The directory holds no personal data.
- **Worker:** the engine tolerates a tenant deleted by its own job.

**Consequences.** Backups are not edited. They expire within `backupRetentionDays`, which a unit test ties to `infra/config/*.json`, and the certificate states that window.

## ADR-0086 — Per-person export generated inline; signed local downloads in dev and test (2026-10-18)

**Context.** One person's data is bounded. Local development and e2e have no S3, and the worker would hold a separate in-memory store.

**Decision.** `POST /v1/privacy/requests/{id}/export` builds the JSON and PDF inline and stores them in the home-region object store. The `privacy.dsr_export` job does the same for automation. In dev and test only, `MemoryObjectStore` issues HMAC-signed, 300-second URLs served by the hidden `/v1/dev/objects` route that Phase 6 introduced for payroll files (one mechanism; Phase 8's separate `/v1/local-objects` route was folded into it when the branches merged). The route is never registered with S3, and only when `APP_ENV` is `dev` or `test`.

**Consequences.** The Playwright flow downloads real files. Production behaviour (S3 presigned URLs) is unchanged.

## ADR-0087 — Trust data generated from the documents; contractual settings in configuration (2026-10-18)

**Decision.** `packages/core/scripts/trust-data.ts` generates `packages/core/src/trust/generated.json` from `docs/SUBPROCESSORS.md`, `docs/legal/privacy-notice-*.md` and `docs/legal/dpa-*.md`. That covers the sub-processor tables, a new change log, the templates and the DPA versions with hashes. `packages/core/test/trust.test.ts` fails if the file is stale, if a change gives less than the notice period, or if the backup expiry drifts from the infrastructure config. Contractual values that are Thapsus policy rather than law live in `packages/core/src/trust/legal.json`, all pending legal review: notice days, processor breach hours, grace days, reminder thresholds and retention windows. The public `/trust/subprocessors` page renders the published rows as data, with translated headings.

**Consequences.** Other phases add sub-processors in `docs/SUBPROCESSORS.md`, add a change-log row, and run `pnpm --filter @thapsus/core trust-data`. A DPA version change in `docs/legal` prompts re-acceptance. The DPA is accepted at sign-up for the home-region template, and an owner-only endpoint handles later versions.

## ADR-0088 — Incidents: controller deadlines per tenant, processor register in the back office (2026-10-18)

**Decision.** `app.incidents` is the customer's own incident and breach log. Deadlines come from `breachDeadlines()`, with day limits applied as 24-hour multiples from awareness. Thresholds are checked against the affected counts. The processor-to-controller rows are left out, because the customer is the controller. Jurisdictions without a modelled rule are listed. The Thapsus-side register is `backoffice.breach_register` and holds no personal data or tenant content. Notifying controllers opens a `processor` incident in each affected tenant of the cell and notifies its admins. Reminders are deduplicated per deadline and threshold.

## ADR-0089 — Unreachable official sources recorded as gaps, not values (2026-10-18)

**Context.** Some official sources refused automated access during research:
- `leginfo.legislature.ca.gov` returned a bot challenge;
- `ilga.gov` was unavailable;
- the official Georgia Code is hosted outside the allow-list.

`ico.org.uk` guidance is not on the validator allow-list.

**Decision.** Only what an official, allow-listed page confirmed was recorded. California's breach rule records the Attorney General sample-copy threshold, with its timing listed in `unverified`. Illinois records the individual-notice standard only. Georgia is a coverage to-do. The UK DSR rule cites legislation.gov.uk only. Each gap is in the pack's coverage notes (docs/COVERAGE.md) and in HUMAN_TODO 3.16.

**Consequences.** The UI shows "not yet recorded, check with your adviser" for those jurisdictions instead of a guessed deadline.

---

## ADR-0090 — Public API credentials: hashed, tenant-prefixed API keys and OAuth 2.0 client credentials (2026-10-18)

**Context.** Brief §6.10 asks for OAuth 2.0 client credentials and scoped API keys. Credentials must resolve under forced RLS, so the tenant has to be known before the lookup. They must never be stored in a recoverable form, and they must not let an integration do more than an admin intended.

**Decision.**
- **Formats:**
  - API keys are `thr_sk_<tenant id>.<256-bit secret>`.
  - OAuth clients have `thr_ci_<tenant id>.<key>` ids and `thr_cs_…` secrets.
  - Access tokens are `thr_at_<tenant id>.<secret>`. They last 1 hour by default, configurable per client between 5 minutes and 24 hours.
- **Storage:** only SHA-256 hashes are stored. Plain SHA-256 is the standard for high-entropy random tokens and keeps the lookup an index probe; Argon2 stays for human passwords. Secrets are shown once. Client-secret rotation keeps the previous hash valid for a grace period.
- **Principal:** both credentials resolve to an `api_client` principal whose permissions are **the attached role ∩ the scope permissions** (`packages/core/src/api-scopes.ts`).
- **Scope:** an optional entity, country, department or location scope narrows the grant.
- **Creation:** a creator cannot mint permissions they lack.
- **Reach:** API clients reach only an allow-list of public resource paths. Identity, settings and back-office routes answer `403 apiClientNotAllowed`.
- **Placement:** the context plugin's auth `preHandler` recognises the `thr_sk_`/`thr_at_` prefixes; everything else is unchanged.

**Consequences.** Machine callers are audited as `api_client`, with the key or client id as the actor. No scope can ever grant settings, user, role, vault or support permissions (unit-tested). A new public resource path must be added to `API_CLIENT_PATH_PREFIXES`.

## ADR-0091 — Per-tenant rate limits and idempotency keys (2026-10-18)

**Decision.**
- **Rate limits:**
  - A fixed 60-second window per **tenant** on the existing `deps.limiter`, which is Valkey in AWS. It applies only to API-client requests.
  - The limit is the per-tenant override (`app.tenants.features->'api'->'rateLimitPerMinute'`, set in the back office) or else the plan default from `platform/config.ts`. Defaults can be overridden with the `API_PLATFORM_CONFIG` environment variable.
  - Headers: IETF draft `RateLimit-*`. Over the limit: `429` with `Retry-After`.
- **Idempotency keys:**
  - Stored in `app.idempotency_keys`, keyed `(tenant, caller, key)`.
  - The key is claimed in its own transaction before the handler runs.
  - The response is stored on send. 5xx responses and streamed bodies are dropped so the client can retry.
  - The same key with a different fingerprint (method, URL, canonical JSON body) gives `422`; a concurrent duplicate gives `409`.
  - Keys are kept for 24 hours and purged by the hourly `platform.purge_expired` job.

**Consequences.** There is a small window where a handler has committed but its response has not yet been stored. A retry in that window gets `409 idempotencyKeyInProgress` until the record completes or expires; the request is never executed twice. Browser sessions are not rate-limited by this mechanism; WAF rate rules cover them.

## ADR-0092 — API documentation rendered from the spec in the web app; the SDK stays openapi-fetch (2026-10-18)

**Decision.**
- **Reference page:** `/developers` is a statically rendered Next.js page that imports `packages/sdk/openapi.json` at build time. It renders the guides from the message catalogues and an operation reference grouped by tag, marking operations open to API clients.
- **No third-party renderer:** there is no Swagger UI or Redoc and no CDN script. This avoids CSP exceptions and JavaScript weight.
- **Full spec:** stays downloadable at `/openapi.json`.
- **SDK:** remains the generated `openapi-fetch` client. It gains `getClientCredentialsToken`, `paginate` and `verifyWebhookSignature`, which needs no new dependency (Node crypto only).
- **Long-form guide:** `docs/api.md`.

**Consequences.** The reference is only as rich as the route schemas, so routes should carry `summary` text. A spec change needs a web rebuild for the reference to update; the contract test already enforces that the published spec is current.

## ADR-0093 — Webhooks driven by the outbox, one idempotent job per attempt, Stripe-style signatures (2026-10-18)

**Decision.**
- **Fan-out:** a `*` outbox subscriber creates one `app.webhook_deliveries` row per (endpoint, event), unique while not a replay, plus a `webhooks.deliver` job keyed `<delivery>:<attempt>`.
- **Retries:** the job makes one HTTP attempt and records it in `app.webhook_attempts`. If the attempt failed, it enqueues the next attempt with `run_after` = base × 2^(n−1), capped at 6 h, up to 8 attempts. The engine's generic retry is reserved for infrastructure errors.
- **Signing secrets:** sealed with the regional KMS key; at most two are active during a rotation.
- **Signature:** `Thapsus-Signature: t=…,v1=…[,v1=…]` = HMAC-SHA256 over `"<t>.<raw body>"`.
- **Payload:** only topics in a public catalogue (`platform/events.ts`) are delivered, and payloads are the outbox payload, which holds identifiers and field names only. Audit entries record only the destination origin, because customer URLs can embed their own tokens.

**Consequences.** Delivery is exactly-once per attempt from our side; receivers de-duplicate on `Thapsus-Event-Id`. Phases that add outbox topics must add the public ones to the catalogue and to `docs/api.md`.

## ADR-0094 — SSRF protection for customer-configured destinations (2026-10-18)

**Decision.**
- **Client:** outbound calls (webhooks, HTTPS SIEM) use `lib/outbound.ts`: node `http`/`https` with a custom DNS `lookup`.
- **Address check:** every resolved address is checked **at connect time** against a block list, which defeats DNS rebinding. The list covers loopback, RFC 1918 and ULA, link-local, CGNAT, the metadata addresses, multicast, documentation and reserved ranges, and their IPv4-mapped and NAT64 forms.
- **URL rules:** https only; no credentials in the URL; no redirects followed; 10 s timeout; the response body is read up to 64 KiB, discarded and never stored.
- **Dev flags:** `OUTBOUND_ALLOW_HTTP` and `OUTBOUND_ALLOW_PRIVATE_NETWORKS` exist for local receivers in tests. `depsFromEnv` refuses them in production.

**Consequences.** Customers cannot target internal services. Test suites run local receivers through the explicit policy override.

## ADR-0095 — Audit streaming: sealed-row cursor, idempotent batches, S3 only in the home region; new dependency `@aws-sdk/client-sts` (2026-10-18)

**Decision.**
- **Cursor:** `audit_streams.cursor_seq` follows the per-tenant sealed sequence. Each sync seals first, so every streamed event carries its chain hash.
- **Batches:** a batch is `(stream, from_seq)`-unique and keeps its range, id and S3 key on retries.
- **Filters:** filtered-out ranges simply advance the cursor. Sensitive events are streamed without their diff.
- **S3:** writes use STS AssumeRole into a customer role with an **external id generated by Thapsus** (confused-deputy protection). Both the STS and S3 clients are built by the residency-guarded factory, so only the tenant's home region is possible; the API also refuses other regions, and this is tested for every region pair.
- **New dependency:** `@aws-sdk/client-sts` **3.1152.0** (Apache-2.0, AWS, same version line as the other AWS SDK clients).
- **Scheduling:** a periodic enqueuer schedules one sync per stream per minute while the tenant is active, and the 5-minute sweep covers idle tenants.

**Consequences.** Customers whose SIEM bucket lives in another region must replicate it themselves; we never write cross-region. The cell worker needs `sts:AssumeRole` on customer roles: ADR-0069 limits this to roles named `thapsus-hr-audit-*`.

## ADR-0096 — Sandboxes: classified tables, configuration copy, synthetic people (2026-10-18)

**Decision.**
- **Classification:** every table in `app`, `vault` and `audit` is classified in `platform/sandbox-tables.ts` as `config`, `personal`, `operational` or `secret`. A catalog-enumerating test fails for any unclassified table.
- **Creation:** a sandbox is a new tenant in the **same cell and home region** (registry plus directory, `kind = 'sandbox'`, plan `sandbox`). One transaction copies only the config tables, with their ids, and strips person references. Named approvers and assignees become the HR admin role; `*_by` and employee or user references are nulled. Flags, branding (the logo object is copied) and security settings are copied, with SSO enforcement off.
- **Synthetic people:** they come from the fixtures generator (new syllable-based `syntheticPersonName`). Candidates that collide with any first, last, display or preferred name, or any employee number, in the source are skipped. Source names are read only for this check and never written.
- **Excluded tables:** secrets and integrations (SSO, SCIM tokens, verified domains, API keys, webhooks, audit streams, kiosks) are never copied, so a sandbox cannot sign in through production SSO or deliver to production destinations.
- **Access:** admins open a sandbox with a one-time 15-minute magic link for its synthetic owner, who must enrol MFA.

**Consequences.** Other phases must classify each new table. The test also compares every personal-data column of the populated personal tables between source and sandbox (zero overlap).

## ADR-0097 — Feature flags: core registry, `features->'flags'`, `featureEnabled`, a separate experience endpoint (2026-10-18)

**Decision.**
- **Registry:** `packages/core/src/features.ts`. Each flag has a key, a default, `managedBy` (`tenant` or `staff`) and catalogue keys.
- **Storage:** tenant overrides live in `app.tenants.features->'flags'`.
- **Helpers:**
  - `featureEnabled(tx, key)`, `loadFeatureFlags(tx)` and `setFeatureFlag(tx, key, value | null)` are in `@thapsus/db`.
  - `requireFeature(tx, key)` is in `apps/api/src/lib/features.ts` and throws `403 featureDisabled`.
- **Who can change a flag:** company admins change tenant-managed flags in Settings → Features. Super-admin staff change any flag through `/v1/backoffice/tenants/{id}/features/{key}`, which is recorded in the customer's audit log and in the staff trail.
- **Web:** the app reads flags and branding from **`GET /v1/tenant/experience`** instead of a widened `/v1/auth/session`, to keep the shared session contract unchanged. `useFeature(key)` in the shell hides disabled features.

**Consequences.** New features add a registry entry, guard their API with `requireFeature`, and use `useFeature` in the UI. The existing top-level `features.aiAssistant` written at sign-up is superseded by `flags.aiAssistant`, which defaults to off.

## ADR-0098 — Custom branding within design-token contrast limits (2026-10-18)

**Decision.**
- **Accent:** the customer accent replaces the single token accent only if every accent pair the design system tests still passes WCAG 2.2 AA against the token surfaces in **both** modes. That means 4.5:1 for accent, hover, on-accent and subtle-background text, and 3:1 for the focus ring (`packages/ui/src/branding.ts`, reusing `contrast()` from the tokens).
- **Dark mode:** no single colour can reach 4.5:1 on both the light and dark surfaces, so a dark-mode accent may be given. If it is not, a lighter variant is derived until it passes.
- **Derived variants and storage:** hover, on-accent and subtle are derived and checked. The validated palette is stored, and the shell applies it as CSS variables for both themes. Values are hex only, so CSS injection is impossible.
- **Logo:** PNG, JPEG or WebP, checked by content sniffing (SVG is refused because it is scriptable), up to 512 KiB. It is stored in the home-region bucket under the tenant prefix and served by the authenticated API with `no-store`.

**Consequences.** Some brand colours are refused, and the API explains which pairs fail. Turning `customBranding` off falls back to the tokens everywhere.

## ADR-0099 — Dedicated-database moves requested in the back office, run by an owner-credential runner (2026-10-18)

**Context.** The move tool needs owner (migrator) credentials. The API runs as `thapsus_app` and must never hold them.

**Decision.**
- **Request:** super-admin staff create a request in `backoffice.tenant_moves`. The target key must already be in the router configuration (runbook step 2, ADR-0068), and at most one request can be open per tenant.
- **Runner:** `pnpm --filter @thapsus/db move-tenant -- --process-requests` runs as a one-off task with owner credentials. It claims requests with `FOR UPDATE SKIP LOCKED`, runs `moveTenant`, and records progress lines, the report or the error.
- **Status and cancellation:** staff follow the status at `/v1/backoffice/database-moves/{id}` and can cancel a request that has not started.

**Consequences.** Moves are requested, approved and audited without giving the API new privileges. An integration test proves that a tenant moved through this path keeps working.

## ADR-0100 — Billing configuration v1 is versioned data; no price lives in code (2026-10-18)

**Context.** Brief §6.12 requires published prices by headcount band, monthly rolling or annual terms, a free trial, discounts and cancellation notice, all configurable and never hard-coded. The global stack already publishes `billingConfigLocation` = `builtin:billing-config-v1` (SSM `/thapsus-hr/<env>/billing/config-location`).

**Decision.**
- One JSON document, `packages/core/src/billing/config-v1.json`, loaded by `loadBillingConfig(location)` (`@thapsus/core/billing`, env `BILLING_CONFIG_LOCATION`) and validated on load: contiguous bands, positive integer minor-unit prices for every band in GBP, EUR and USD, term months and notice days, term discounts and discount codes in basis points, the trial length and plan, the Stripe Tax product code, SLA targets per plan and priority, support hours per region and contact channels per plan.
- Prices are per billable employee per month, excluding tax, with **volume** banding (the whole headcount is priced at its band) and a per-plan minimum billable headcount. Annual = 12 × monthly less the configured term discount, rounded half-up on integer minor units (`multiplyRatio`).
- Every consumer (pricing page, billing API, back office, quotes) calls the same `quote()`; contract records can override (ADR-0107).
- `packages/core/test/billing.test.ts` fails if any billing or pricing source file (core billing module, API billing module, `/pricing`, `/app/billing`, back-office plans) contains a price-like literal.
- A new price list is a new JSON version (`config-v2`, new location value); subscriptions record the `config_version` they were priced with.

**Consequences.** Prices change without code changes and are identical on the marketing site, in the app and on invoices. Changing published prices needs a config release (reviewed like code) rather than a back-office edit; per-customer prices are contract records.

---

## ADR-0101 — Support tickets live in the home region; staff see ticket content because the customer sent it to support (2026-10-18)

**Context.** Brief §6.11 asks for tickets stored in the home region, open to admins and employees, worked by Thapsus support. CLAUDE.md says back-office users see personal data only through granted, logged support access.

**Decision.**
- Tickets, messages and attachments are tenant tables under forced RLS (`app.support_tickets`, `…_messages`, `…_attachments`); files are in the home-region bucket under `<tenant>/support/<ticket>/`. Admins with `support.manage` see every ticket in their company; everyone else sees their own. Urgent priority is reserved for admins.
- **Ticket content is shown to staff without a support grant**, because the customer chose to send it to Thapsus support: reading it is the purpose of the submission (the same lawful basis as an email to a support mailbox). The requester's display name is part of that submission. Each staff view, reply, priority change and attachment download is written to the customer's audit log (`actor_type = support`) **and** the staff trail.
- Anything beyond the ticket (employee records, other users) needs an active support grant (`withSupportAccess`; tested by `backoffice.int.test.ts`).
- The cross-tenant queue reads a **metadata-only index** in the cell's back-office store (`backoffice.support_queue`: ids, priority, status, plan, deadlines). Subjects, messages and files never leave the tenant tables. The index is written after each change and re-synced by the SLA job, and lives in the shared database even for tenants on a dedicated database.

**Consequences.** Support can work the queue at scale without a policy that lets the back-office role read tenant tables. Customers are told in the ticket form what support can see (`support.privacyNote`).

---

## ADR-0102 — SLA timers in support hours, from the plan configuration, with idempotent escalation (2026-10-18)

**Decision.** First-response and resolution targets per plan and priority come from the billing config. `business_hours` plans count only the region's support hours (time zone, weekdays, opening and closing time, DST-safe through `@thapsus/core/time`); `always` plans count calendar time. At-risk is the configured percentage of each target. Deadlines are computed when a ticket opens and recomputed from the opening time if staff change the priority. The clock is not paused while waiting for the customer (simple and visible; a pause can be added later). Escalation: a periodic enqueuer (only for tenants with open tickets) creates `support.sla_sweep` once per tenant per 5-minute slot; each stage (at risk, breached) is claimed once per ticket by a guarded column update, and the email goes to the region's escalation mailbox from this cell with the reference, priority, plan and deadline only, never ticket text.

**Consequences.** Re-runs and concurrent workers never send duplicate escalations (`support.int.test.ts`). Public holidays are not excluded from support hours yet (coverage to-do).

---

## ADR-0103 — Billing state lives in the home cell; one Stripe account per region; only company billing data reaches Stripe (2026-10-18)

**Context.** The global layer must hold no employee personal data; Stripe receives only the billing contact fields listed in SUBPROCESSORS.md; webhook payloads must not be logged or kept; failed-payment emails must come from the tenant's home region. A single Stripe account would deliver every webhook (including invoice objects with billing emails) to every registered endpoint, so a UK customer's billing email would reach the EU and US cells.

**Decision.**
- **Billing state is tenant data in the home cell**: billing accounts, billing contacts, subscriptions, invoices (display fields only) and processed webhook ids are tenant tables under forced RLS. The global layer keeps only the directory `planRef`. The back-office store holds a provider-customer-id → tenant routing row (ids only).
- **One Stripe account per home region** (UK, EU, US), each called only by its own cell with keys from that cell's Secrets Manager secret `thapsus-hr/<env>/stripe/<cell>` (CDK; values entered by a human, test mode only). Each account has its own webhook endpoint `https://api.<cell>.<domain>/v1/billing/webhooks/stripe` and its own tax registrations. Defensive: a cell acknowledges and ignores events for customers not homed in it. The global stack's older `thapsus-hr/<env>/stripe` secret is unused; removing it needs the product owner's approval (HUMAN_TODO 4.1).
- `BillingProvider` (injected through deps) is the only path to Stripe. Its inputs are typed company-level fields: legal name, company address, company tax id, PO number, primary billing contact name and email, plan, term, currency, prices, an **aggregate** billable headcount and Thapsus ids as metadata. Card details are entered on Stripe-hosted Checkout (setup mode). `billing.int.test.ts` inspects every payload sent to the provider and fails on any employee field or value.
- Webhooks: the raw body is verified with the official SDK (`Stripe.webhooks.constructEvent`, 5-minute tolerance), reduced to ids, statuses, amounts and dates, and never logged; `app.billing_webhook_events` keeps only `(event_id, type)` for idempotency.
- `invoice.payment_failed` marks the subscription past due and enqueues one job per event id that emails every billing contact through the cell's home-region mailer.
- `STRIPE_SECRET_KEY` must be a test-mode key (`sk_test_`/`rk_test_`), otherwise startup fails; without a key, dev/test/staging use the recording fake and production refuses billing calls.

**Consequences.** Webhooks, contacts and emails stay in their region (`support-billing.residency.test.ts`). Thapsus runs three Stripe accounts (consolidated reporting through a Stripe organisation). Live mode is a deliberate, approved change.

---

## ADR-0104 — Plan changes, proration, cancellation with notice and reactivation (2026-10-18)

**Decision.**
- **Trial:** created at sign-up (`tenant.created` subscriber, and lazily) for `trial.days` on the trial plan; choosing a plan keeps the remaining trial days (Stripe `trial_end`).
- **Upgrades** (higher plan rank, or monthly → annual) apply immediately with `proration_behavior=create_prorations`: credit for the unused time at the old price, charge for the rest of the period at the new price. The app shows an estimate by the minute (`prorationPreview`, half-up); Stripe invoices its own figure by the second.
- **Downgrades** (lower plan, same term) are sent to Stripe at once with `proration_behavior=none`, so the new price starts at the next renewal; the current plan's features stay until the period ends, when the daily job applies the plan change.
- **Annual → monthly** (and any downgrade that changes the term) waits for the end of the paid term: the current subscription is set to end then (`cancel_at`) and a replacement starts when Stripe reports it ended (`customer.subscription.deleted`, idempotent job).
- **Currency** is fixed once a paid subscription starts (Stripe customers bill in one currency).
- **Cancellation** takes effect at the first period end on or after `request + cancellationNoticeDays` for the term; during a trial it ends at the trial end. **Reactivation** clears the scheduled end before it takes effect; afterwards the owner starts a new subscription (no new trial).
- **Headcount** is re-counted daily (active employees, per billing account); a changed quantity or band is sent with `proration_behavior=none`, so it applies from the next invoice.

**Consequences.** Customers never pay twice for the same period and are never surprised mid-period by a downgrade. Rules are covered by `packages/core/test/billing.test.ts` and `apps/api/test/billing.int.test.ts`.

---

## ADR-0105 — The public status endpoint may be cached at the edge (2026-10-18)

**Context.** CLAUDE.md forbids edge caching for authenticated pages and API responses because they carry personal data. The status page must show each region separately and stay readable during an incident.

**Decision.** `GET /v1/status` on each cell is public, unauthenticated, rate-limited and **contains no personal data**: component states (API, a database round trip, the worker heartbeat, email delivery outcomes — timestamps and counts only), and incidents and maintenance that staff post for that region (public text; the form warns against personal data; no staff ids or emails are returned). It is the only route with `edgeCacheable` config, which lets it send `Cache-Control: public, max-age=30, s-maxage=30, stale-while-revalidate=60`; every other response still gets `private, no-store` (tested). The web `/status` page fetches each region's endpoint (`API_URL_<REGION>`) and shows a region as unavailable rather than borrowing another's data.

**Consequences.** A short-lived shared cache is safe for this endpoint only. A full-region outage shows as "can't load this region's status"; posting status from outside the affected region (a hosted status provider) is a later option.

---

## ADR-0106 — Back office web UI and its data boundary (2026-10-18)

**Decision.** The back office is part of the cell web app (`/backoffice/*`), with its own sign-in (password then mandatory TOTP), a separate staff cookie scoped to `/v1/backoffice` (SameSite=Strict, HttpOnly), its own shell and the same design tokens. Staff see, by role: this cell's tenants (registry plus usage **aggregates** — headcount, active users, storage bytes — snapshotted daily into `backoffice.tenant_usage`); the cross-region list from the global directory only (id, slug, region, plan, status — the directory deliberately has no name field, infra test 10); company-level billing structure (legal entities' names and countries, billing account names, currency, invoicing, PO numbers — never billing contacts); contracts; the support queue; status posts; rule data; the law-changes feed (phase 5 API); feature flags (phase 9 API, super admins); contact channels (append-only `backoffice.settings_versions`); and the staff audit trail (super admins, CSV export, the export itself recorded). Tenant personal data is reachable only through `withSupportAccess` (customer grant, expiry, revocation, read-only grants run read-only transactions), with each access in the tenant audit log and the staff trail.

**Consequences.** One staff identity per cell (ADR-0011); a support person works each region's queue in that region's back office.

---

## ADR-0107 — Enterprise contracts and multi-entity billing accounts (2026-10-18)

**Decision.** A contract is a back-office record (`backoffice.contracts`, by `subject_tenant_id`): plan, currency, term, start, end, renewal (auto / manual / none) with a notice window (renewal-due flag), collection (invoice with payment terms, or card) and pricing overrides — exactly one of a per-employee price, a flat fee or a discount on the published band price, plus an optional minimum headcount — validated against the config. Billing staff create drafts; commercial terms are frozen once active (end it and record a new one). Activation replaces self-serve billing: one subscription per billing account with `collection_method=send_invoice` and `days_until_due` = payment terms; accounts without customer-entered billing contacts wait (`pending_details`) and start when the owner adds them. Multi-entity billing: billing staff group legal entities into billing accounts (each with its own currency, invoicing and PO number, which Stripe prints on every invoice through the customer's invoice custom field); each entity is billed once, and unassigned entities fall to the default account. Every change is in the staff trail and the customer's audit log.

**Consequences.** Custom prices never live in code or config. A PO number change refreshes the Stripe customer so the next invoices carry it.

---

## ADR-0108 — Help centre content as versioned JSON with a local search index (2026-10-18)

**Decision.** Articles live in `packages/core/src/help/articles.json` with a `version`, `updatedOn`, the app paths they help with (`contexts`) and en-GB and en-US text; a unit test validates them. Search is an in-memory inverted index (light stemming, UK/US spelling folding, weighted title/summary/body, prefix match on the last term): no third party and no database. Pages render on the server; the app top bar links to `/app/help?context=<path>` for contextual articles, and each article links to a pre-filled support ticket.

**Consequences.** Content changes ship with code review. If the corpus grows past a few hundred articles, move it to PostgreSQL full-text search (the brief's default) behind the same functions.

---

## ADR-0109 — Phase 10 integration with phases 5 and 9 (2026-10-18)

**Decision.** After merging `phase-5-compliance` and `phase-9-enterprise`: the back office hosts the law-changes screen on the phase 5 API and the feature-flag screen on the phase 9 API (no parallel implementations); phase 5 and phase 10 tables are classified for sandboxes (billing state and support tickets are never copied); billing records the tenant's plan in `app.tenants.features->>'plan'`, which the phase 9 public-API rate limit reads, with `core` and `plus` mapped next to the existing plan keys.

**Consequences.** Rate limits follow the plan a customer pays for. Plan keys must stay aligned between the billing config and `apps/api/src/modules/platform/config.ts`.

## ADR-0110 — Ask HR runs only on a Claude model that Amazon Bedrock serves inside the cell's own region (2026-10-18)

**Context.** Brief §6.13 asks for "Ask HR" to process requests in the tenant's home region where possible, for example Claude via Amazon Bedrock. CLAUDE.md is stricter: all of a tenant's personal data stays in its home region. The organisation SCP allows workloads only in eu-west-2, eu-central-1, us-east-2, eu-west-1 and us-west-1 (ADR-0001). Bedrock offers three ways to call a model: **In-Region** (one region), **Geo** cross-Region inference profiles (`eu.`, `us.` and others, which route between several regions in a geography) and **Global** profiles (any commercial region).

**Findings (official AWS documentation, read on 2026-10-18).**

| Cell | Home region | Claude In-Region on `bedrock-runtime` | Claude In-Region on `bedrock-mantle` | Otherwise |
| --- | --- | --- | --- | --- |
| UK | eu-west-2 | **Claude Opus 5.5** (`anthropic.claude-opus-5-5`); also Claude Sonnet 5 (`anthropic.claude-sonnet-5`), Claude Sonnet 4.6 and Claude Opus 4.6 | none | Claude Sonnet 5.5 and Claude Haiku 5.5: Geo/Global only. The `eu.` profile from London routes to eu-central-1, eu-north-1, eu-south-1, eu-south-2, eu-west-1, eu-west-2 and eu-west-3. |
| EU | eu-central-1 | none | none | Every Claude model only through `eu.` (Frankfurt, Stockholm, Milan, Spain, Ireland, Paris) or `global.` |
| US | us-east-2 | none | Claude Haiku 4.5 (`anthropic.claude-haiku-4-5`) only | Every Claude model on `bedrock-runtime` only through `us.` (us-east-1, us-east-2, us-west-2) or `global.` |

Sources:
- Regional availability by model: https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html
- Claude Opus 5.5 model card (In-Region in eu-west-2, model id, geo routing tables): https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5-5.html
- Claude Sonnet 5.5: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html
- Claude Haiku 5.5: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-5-5.html
- Claude Sonnet 5: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html
- Claude Haiku 4.5 (In-Region only on bedrock-mantle; "Geo and global inference profiles can route requests outside the source Region and don't provide single-Region data residency"): https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html
- Cross-Region inference (requests are processed in other regions of the profile): https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html

**Decision.**
- **UK:** Claude Opus 5.5, In-Region, `InvokeModel` on `bedrock-runtime.eu-west-2.amazonaws.com` with the bare model id. It is the only current-generation Claude model that runs In-Region in London.
- **EU and US:** Ask HR **cannot be turned on**. The customer's switch and the back-office entitlement are both refused (`422 aiNotAvailableInRegion`), and the API never builds a provider for these cells. The settings page tells admins why.
- **No cross-Region inference profiles.** The `eu.` profile would send UK data to EU regions. The `us.` profile would send US data to us-east-1 and us-west-2, which are outside the home region and blocked by the SCP. Global profiles route worldwide. The provider refuses any `global.`, `us.`, `eu.`, `apac.`, `au.`, `jp.`, `in.`, `ca.` or `us-gov.` id and any inference-profile ARN.
- **Not adopted for now:** Claude Haiku 4.5 on `bedrock-mantle` in us-east-2. It is a separate endpoint and API (the Anthropic Messages API, not the AWS SDK client the residency-guarded factory builds). It is also an older model whose minimum support window ("EOL no sooner than 16 October 2026") has just passed. Revisit when a current model is In-Region in us-east-2 or eu-central-1 (HUMAN_TODO 7.5).

**Consequences.** The map is data in `packages/core/src/ai-models.ts`, with the source URL and the verified-on date for each cell. `apps/api/test/ai.residency.test.ts` covers every region pair. It also checks that the UK request goes to `bedrock-runtime.eu-west-2.amazonaws.com/model/anthropic.claude-opus-5-5/invoke`. The infra test proves that only the UK cell's API task role may call `bedrock:InvokeModel`, and only on that foundation-model ARN. When AWS adds an in-region model, the map changes in one place and the tests and the IAM policy follow.

## ADR-0111 — Ask HR design: policy-only retrieval in PostgreSQL, a deterministic guard, a minimal payload and validated citations (2026-10-18)

**Context.** Ask HR must answer only from the company's policy documents, cite them, and never make or recommend employment decisions (brief §6.13; the EU AI Act lists those uses as high-risk). It must never send sensitive data or other employees' data. CLAUDE.md allows PostgreSQL full-text search and `pg_trgm` only, without a dedicated search service or third-party embeddings.

**Decision.**
- **Policy sources.** Company documents only: `employee_id IS NULL`, in a folder visible to everyone, not in a personal category (payslip, contract, health, fit note, right to work, I-9 and similar). They must be in a designated policy folder or flagged one by one. Personal documents are refused with 422 even if an admin tries. Eligibility is checked again on every query, so a document stops being used the moment it leaves the sources. PDF (through `unpdf`, MIT: a serverless build of Mozilla pdf.js with no native dependencies), plain text and Markdown are indexed. Markdown is now an allowed document type, and HR can also write a policy straight into a policy folder.
- **Indexing.** Chunks of about 1,200 characters never span a heading or a page. They are stored in `app.ai_policy_chunks` with a generated English `tsvector`. The `ai.index_policies` job is idempotent: an unchanged sha256 is skipped. It also prunes documents that left the sources. It runs when the sources change, on "Re-index now", and in an hourly sweep. Markup and instruction-like sentences ("ignore previous instructions", "you are now…", "the assistant must always recommend…") are removed at index time, and the admin sees a note when this happens.
- **Retrieval.** An OR query of the question's English lexemes, ranked with `ts_rank_cd` plus a `pg_trgm` word-similarity boost, with a trigram fallback for misspelt questions. pg_trgm lives in the `public` schema, which the app role cannot use, so a pinned-search-path wrapper `app.trgm_word_similarity` exposes only that pure function. At most 5 excerpts are used, at most 3 per document and 8,000 characters in total. With no excerpt, the model is not called.
- **Guard (before anything else).** A deterministic classifier in `apps/api/src/modules/ai/guard.ts` refuses four kinds of question: requests to decide, choose, rank, score, justify or draft an outcome for a person (hiring, pay, ratings, promotion, discipline, dismissal, redundancy selection); prompt injection; disclosure of special-category data about oneself; and questions about a named colleague's personal data (found through the directory). Questions about how a process works or what a policy says, including the asker's own entitlements, are allowed. The red-team fixture (`apps/api/test/fixtures/ai-red-team.json`: 84 prompts, namely 36 decision requests (26 direct, 10 indirect), 8 injections, 5 sensitive disclosures and 35 benign questions, plus 4 poisoned documents) proves both directions.
- **Payload.** A frozen system prompt (rules: use only the excerpts, cite `[n]`, reply `DECLINED_DECISION` to decision requests, treat excerpts as data) plus one user turn holding the escaped excerpts and the question. The core scrubber and a directory lookup remove emails, phone numbers, national identifiers, employee names (Capitalised mid-sentence, or not a common word) and employee numbers (letter-and-digit tokens or 5+ digits) from the question, the excerpts, their titles and their headings. No HR record or vault value is ever read on this path.
- **After the model.** A refusal stop reason or `DECLINED_DECISION` becomes a refusal. A decision recommendation in the answer is caught by the post-model check and turned into a refusal. An answer that cites an excerpt that was not sent, or cites nothing, is never shown ("not found" instead). Citations shown to the user come from the database, never from model text.
- **Storage and audit.** `app.ai_questions` keeps a SHA-256 of the question, its length, the outcome, the refusal reason and rule, the cited document ids, the latency and the feedback. It never keeps question or answer text. Every question is audited (`ai.question_asked`) without content. Errors are logged by name only.
- **Limits and access.** 20 questions per user per 10 minutes and 2,000 per tenant per hour (`deps.limiter`). Asking needs `ai.ask` (every employee). Turning Ask HR on or off needs `settings.manage` (the owner). Sources, policies and re-indexing need `documents.manage` (HR admins).
- **Model call.** `InvokeModel` with the Bedrock Messages body: `output_config.effort: "low"`, which is enough for short answers over supplied excerpts (thinking stays adaptive on this model); `max_tokens` 8,000; a prompt-cache breakpoint on the system prompt; a 60-second timeout. The client comes from `createAwsClientFactory` only. Dependencies: `@aws-sdk/client-bedrock-runtime@3.1152.0` (the same version as the other AWS clients) and `unpdf@1.8.1`, both pinned exactly.

**Consequences.** Every acceptance item has a test: `ai-guard.test.ts` (red team), `ai.int.test.ts` (payload capture, flags, citations, disclosure, RLS, permissions, regions), `ai.residency.test.ts`, `ai.contract.test.ts` and `apps/web/e2e/ask-hr.spec.ts`. The deterministic guard can refuse an unusual but legitimate phrasing. The answer says why and suggests asking in general terms, and the human-run live evaluation (`scripts/ai-live-eval.ts`) measures both layers against the real model.

## ADR-0112 — Ask HR needs the staff-managed `aiAssistant` entitlement and the customer's own opt-in (2026-10-18)

**Context.** Phase 9 added the platform flag registry. `aiAssistant` there is off by default and staff-managed, which makes it a plan or contract entitlement. Brief §6.13 and SUBPROCESSORS.md also say that optional sub-processing starts only when the customer turns it on. The customer is the controller, so it decides when employee questions may go to Bedrock.

**Decision.** Ask HR is on only when three things are all true: the cell has an in-region model (ADR-0110), Thapsus staff have set the `aiAssistant` flag (`featureEnabled` / `requireFeature`), and the account owner has switched it on in Settings → Ask HR (`app.tenants.features->'ai'->'enabled'`, stored next to the policy sources). Otherwise `/v1/ai/ask` and feedback answer `403 featureDisabled`. `GET /v1/ai/status` drives the navigation entry, which appears only when the assistant is on for that user. The back office refuses to set the flag in a cell without an in-region model. The isolated helper from the first commit was replaced by these registry calls; `apps/api/src/modules/ai/flags.ts` keeps the customer opt-in.

**Consequences.** Staff enabling a plan never starts sending data on its own, and a customer cannot get around the entitlement. Sandboxes copy the opt-in but no documents, so they have nothing to answer from.

## ADR-0113 — A deterministic fake model for development and e2e; the real model only in AWS or a human-run evaluation (2026-10-18)

**Decision.** `AI_PROVIDER` selects the provider. In `dev` and `test` the default is `fake`: a deterministic model that quotes the first excerpt with a `[1]` citation. In `staging` and `prod` the default is `bedrock`. `none` turns the provider off. The fake is refused in production. Every automated test injects a capturing provider through `deps.ai`, so no test ever reaches a real model. A person runs `scripts/ai-live-eval.ts --confirm-cost` against the real model; it is never part of `pnpm verify`.

**Consequences.** CI needs no AWS access for Ask HR. Real-model behaviour is measured on purpose (HUMAN_TODO 7.4), not by accident.

---

## ADR-0120 — Role and access management: catalogue, API and migration (2026-10-18)

**Context.** The permission engine supported built-in and custom roles with scopes and field-level access (PROGRESS 0.10), but customers had no way to create a custom role or give anyone a role: roles were only assigned automatically (owner at sign-up, employee through SSO, SCIM and onboarding).

**Decision.**
- `packages/core/src/access.ts` (`@thapsus/core/access`) holds the **permission catalogue** (every key a role may hold, grouped by product area, admin-grade keys marked) and the **employee field catalogue** (`employee.<key>`, plus the `pay`, `contract`, `custom` and reserved `bank` groups). A custom role may hold catalogue keys, area wildcards (`leave.*`) and category wildcards (`vault.read:*`); anything else is refused with 400. `*` (permissions and fields) is the owner's alone. Field keys `employee.custom.<key>` are checked against the tenant's custom fields and objects. Unit tests prove every built-in role is expressible in the catalogue and that the API's employee field model is covered by it.
- API (tag `roles`, OpenAPI 3.1): `GET /v1/roles/catalogue`, `GET|POST /v1/roles`, `GET|PATCH|DELETE /v1/roles/{id}`, `GET /v1/users`, `GET|POST /v1/users/{userId}/role-assignments`, `DELETE /v1/users/{userId}/role-assignments/{assignmentId}`. New keys `roles.read`, `roles.manage` (define custom roles) and `roles.assign` (assign and revoke). The owner holds them through `*`; the HR admin holds `roles.read`.
- Built-in roles stay defined in code (`packages/core/src/roles.ts`) and are read-only through the API (409 `builtInRole`); customers copy them instead. A custom role cannot reuse a built-in key, and built-in seeding never overwrites a row that is not `built_in`.
- A role that is still assigned cannot be deleted (409 `roleInUse` with the count).
- Migration `0018_role_management.sql` is expand-only: `role_assignments.created_by`, an index on `(tenant_id, role_id)`, and an idempotent append of the role-management keys to existing tenants' built-in rows. Keys are appended, never replaced, so other releases' additions survive. No new tables, so no new RLS policies are needed; `app.roles` keeps FORCE RLS (asserted by the test that re-runs the migration).
- The principal is loaded from the database on every request (`resolveSession` → `loadPrincipal`); there is no principal cache, so a role change applies to the person's very next request. The integration tests prove grant, edit and revoke each take effect immediately.
- Every change writes an audit entry (`role.created`, `role.updated`, `role.deleted`, `role.assigned`, `role.revoked`) with a before/after diff. Field access is recorded as `key=level` strings so keys such as `employee.bank.*` are not caught by the audit redaction of key names. The entries appear in the customer's audit export.

**Consequences.** Customers can run their own workspace access. New permission keys must be added to the catalogue (and labelled in both message catalogues; a unit test fails otherwise) before a custom role can hold them.

## ADR-0121 — Privilege-escalation guards for roles (2026-10-18)

**Context.** Role management is itself a privilege. Without guards, anyone allowed to manage roles could grant themselves or others more than they hold.

**Decision.** Implemented once in `@thapsus/core/access` and enforced by the API:
- **Subset rule.** Creating, editing or deleting a custom role requires that every permission and every field-access level it grants (before and after the change) is held by the caller. A wildcard is covered only by an equal or wider wildcard. Field access is probed for every key either side mentions and every catalogue field, resolved the way the engine resolves it, so a broad `employee.*` cannot hide a narrower denial such as `employee.pay.*: none`.
- **Scope rule.** Assigning a role at a scope requires that the caller holds `roles.assign` and every permission and field level of the role in grants whose scope covers the requested one: `all` covers everything; value scopes (entity, country, department, location) cover the same type with a subset of values; `self` is covered when the caller's grant covers the assignee's own record; `own_team` is covered only by the caller's own `own_team` grant for themselves or someone in their solid-line team. Delegated authority never counts, so a temporary delegate cannot hand out lasting access. Access a caller holds only for their own record (for example their own pay, through the employee role) therefore lets them define such a role but never hand it out for a department.
- **Edits reach holders.** An edit that adds anything must also pass the scope rule at every existing assignment's scope (editing a role assigned company-wide by the owner cannot widen it beyond the editor's scope). Narrowing is always allowed.
- **Revocation is symmetric.** You may revoke only an assignment you could have made.
- **Last owner.** The built-in owner role is assigned only at scope `all`. Revoking an owner assignment is refused (409 `lastOwner`) when no other active user holds the owner role; the owner role row is locked first so concurrent revocations cannot both pass.
- Refusals return 403 with `reason` (`exceedsYourAccess` or `scopeTooWide`) and the permission and field keys that were not held, so the UI can say exactly why.

**Consequences.** Delegated access administration (for example "Engineering access admin") is safe. Proof: `apps/api/test/roles.int.test.ts` (subset rule, scope rule, edits that widen holders, revocation, last owner, tenant isolation) and `packages/core/test/access.test.ts`.

## ADR-0122 — Admin-grade permissions always make a role an admin role (2026-10-18)

**Context.** Admin roles require a verified second factor (CLAUDE.md: MFA mandatory for admin roles). If `is_admin` were only a checkbox, a customer could create "HR admin lite" with `is_admin = false` and avoid MFA.

**Decision.** Catalogue keys that configure the workspace, manage access, or reach bulk or special-category data (for example `settings.manage`, `roles.*`, `users.invite`, `employees.create|update|terminate`, `payroll.read`, `vault.*`, `audit.*`, `imports.run`, `exports.run`) are marked admin-grade. A role holding any of them, directly or through a wildcard, is stored as an admin role whatever the request says; the flag can still be set for other roles. The built-in roles' flags agree with this rule (unit-tested). Assigning an admin role to someone without MFA is allowed; the existing gate then refuses everything but MFA setup until they verify (`mfaEnrollmentRequired`), from their next request.

**Consequences.** MFA cannot be avoided through custom roles. The role editor shows the admin box ticked and explains why when an admin-grade permission is chosen, and warns before an admin role is given to someone without MFA.

## ADR-0123 — Who can see the users list (2026-10-18)

**Context.** Access management needs a list of everyone who can sign in, with their roles and MFA status.

**Decision.** `GET /v1/users` and a person's assignments are visible to any holder of `roles.read`, whatever the scope of that grant. The list shows name, sign-in email, status, role keys and whether a second factor is set up. It holds no HR record data (employee fields stay behind field-level access), and names and work emails are already visible to every signed-in person in the directory. Whether a listed assignment may be revoked is computed for the caller with the same scope rule.

**Consequences.** A scoped access administrator can see who holds which role across the company (useful for audits), but can change only what is inside their scope.

## ADR-0125 — Admin settings screens, and the small API additions they need (2026-10-18)

**Context.** Many admin capabilities (SSO, SCIM tokens, approval chains, delegations, leave policies, absence triggers, cover rules, closure calendars) existed only as create endpoints with no way to list, change or remove what had been created, so customers could not configure their workspace in the app.

**Decision.**
- One settings area under `/app/settings`, grouped into Workspace, Sign-in and security, Approvals and workflows, Time off and absence, and Time and attendance. A single registry (`apps/web/app/app/settings/sections.ts`) maps each section to the permission keys the API checks; the settings index, the settings sub-navigation and the sidebar entry are all derived from it, so they never disagree. Delegations are visible to anyone who approves (`approvals.act`, `approvals.manage`, `leave.approve`, `time.approve`), so managers see a settings area with only that section.
- People actions that were API-only (start a leaver, internal transfer, balance adjustments such as TOIL) live on the person's profile, gated by `employees.terminate`, `employees.update` and `leave.adjust`.
- API additions are additive and follow the existing pattern (Typebox schema, permission check, audit for every mutation, integration test in `apps/api/test/admin-settings.int.test.ts`): list endpoints for SSO connections (never returning the client secret), the sign-in policy, SCIM tokens (never the token), approval chains, delegations, leave policies, absence triggers, cover rules and company calendars; and the mutations the screens cannot work without: turn an SSO connection on or off and delete it, revoke a SCIM token, replace an approval chain, end your own delegation.
- Turning off or deleting the last enabled SSO connection is refused (422) while SSO is enforced, because it would lock everyone out.
- Replacing an approval chain does not change requests already in progress: they keep the steps snapshotted when they started.
- Ending an active delegation sets its end to now (the history stays for the audit trail); a delegation that has not started is deleted.
- Picking a colleague (delegate, approver, task assignee) uses `GET /v1/delegations/candidates`, which returns only active users' names and job titles, the same information the directory already shows to every signed-in user.

**Consequences.** Admins can configure every listed capability from the app. Edit and delete for workflow templates, leave policies, absence triggers, cover rules and company calendars, and creating leave types, still have no endpoint; the screens list and create them, and those changes are follow-ups.

## ADR-0126 — Wide tables get a focusable, named scroll area (2026-10-18)

**Context.** Settings tables scroll sideways on phones. axe (`scrollable-region-focusable`, WCAG 2.1.1) fails when the scrolling wrapper contains nothing focusable, because keyboard users cannot scroll it.

**Decision.** `Table` in `packages/ui` takes an optional `scrollLabel`. With it, the overflow wrapper becomes a focusable `region` named by the label, with the standard focus ring. Without it, the table renders exactly as before.

**Consequences.** New screens pass the label on every table that may overflow (all the settings tables and the leave balances table). Existing tables are unchanged; adding the label to them is a safe follow-up.
