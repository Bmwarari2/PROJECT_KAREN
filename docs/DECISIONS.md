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

**Consequences.** Tenants choose strictness without code changes. The legal review of these rules is tracked in HUMAN_TODO 3.12.

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

**Consequences.** Customers whose SIEM bucket lives in another region must replicate it themselves; we never write cross-region. Cell task roles need `sts:AssumeRole` on customer role ARNs (HUMAN_TODO 6.2).

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
- **Request:** super-admin staff create a request in `backoffice.tenant_moves`. The target key must already be in the router configuration (runbook step 3), and at most one request can be open per tenant.
- **Runner:** `pnpm --filter @thapsus/db move-tenant -- --process-requests` runs as a one-off task with owner credentials. It claims requests with `FOR UPDATE SKIP LOCKED`, runs `moveTenant`, and records progress lines, the report or the error.
- **Status and cancellation:** staff follow the status at `/v1/backoffice/database-moves/{id}` and can cancel a request that has not started.

**Consequences.** Moves are requested, approved and audited without giving the API new privileges. An integration test proves that a tenant moved through this path keeps working.
