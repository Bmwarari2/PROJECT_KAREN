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
