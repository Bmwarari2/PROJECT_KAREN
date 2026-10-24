# Performance

Brief §3 sets the scale targets. This file records how each one is measured and the latest result. Local numbers come from a development container, not from AWS. The staging and load-test numbers in §3 are filled in by `pnpm loadtest` (Phase 12) against a temporary environment that is torn down after each run.

## 1. Targets (brief §3)

| Target                                                                           | How it is proven                                                                   | Status                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| One tenant with 200,000 employees and 50 legal entities across the UK, EU and US | `pnpm synth:enterprise` (§2.1); the generator test `apps/api/test/cli.int.test.ts` | Generated locally (§2.1)                            |
| 5,000 concurrent users per tenant                                                | k6 `concurrent-users` scenario in `pnpm loadtest`                                  | Pending the AWS load-test run (Phase 12)            |
| 20,000 clock-ins within 10 minutes                                               | k6 `clock-in-burst` scenario in `pnpm loadtest`                                    | Pending the AWS load-test run (Phase 12)            |
| p95 < 300 ms for common reads, < 1 s for paginated lists at that size            | Local benchmarks per phase (§2) plus k6 thresholds                                 | Local p95 within budget (§2.3); AWS run pending     |
| 200,000-employee bulk import and large reports as background jobs with progress  | Phase 1 import benchmark (§2.3), Phase 7 report jobs                               | Import: 386 s for 200,000 rows with progress (§2.3) |
| 99.9 % availability, Multi-AZ, RPO ≤ 15 min, RTO ≤ 4 h                           | CDK assertions (Multi-AZ, continuous backup) plus the Phase 12 drills              | Drills pending (Phase 12)                           |

## 2. Local measurements

**Machine:** 4 vCPU, 15 GB RAM Linux container. PostgreSQL 17 (Docker, `postgres:17-alpine`, `shared_buffers=128MB`). Node 24.22. Other build and test jobs shared the machine during these runs, so treat the numbers as upper bounds.

### 2.1 Synthetic enterprise tenant (Phase 0)

Command: `SYNTH_EMPLOYEES=200000 SYNTH_USERS=6000 pnpm synth:enterprise` on a fresh, migrated database. The data is bulk-loaded with `COPY`.

| Date       | Employees | Legal entities | Locations | Sign-in users | Generator runtime | Wall clock (incl. tsx start-up) | Database size |
| ---------- | --------- | -------------- | --------- | ------------- | ----------------- | ------------------------------- | ------------- |
| 2026-10-18 | 200,000   | 50             | 150       | 6,000         | 171.7 s           | 2 m 53 s                        | 740 MB        |

Phases of the run:

- 0.3 s — organisation (50 entities, 150 locations, 10 departments)
- 14.4 s — employees
- 144.8 s — effective-dated history and reporting lines
- 171.7 s — sign-in users and roles

The output is deterministic: two runs with the same size produce byte-identical employee data, which the `cli.int.test.ts` digest test checks.

### 2.2 Lighthouse, mobile (Phase 0)

`pnpm verify` → `scripts/lighthouse.mjs`: median of three runs on a production build with default mobile throttling. Thresholds are performance ≥ 90 and accessibility ≥ 95. Latest results are below; `.verify/lighthouse.json` holds the newest run.

| Page                     | Performance | Accessibility | Best practices | LCP      | CLS   | TBT   |
| ------------------------ | ----------- | ------------- | -------------- | -------- | ----- | ----- |
| Marketing home           | 98          | 96            | 96             | 2,180 ms | 0.000 | 78 ms |
| Sign in                  | 100         | 96            | 96             | 1,613 ms | 0.000 | 43 ms |
| Sign up                  | 98          | 100           | 96             | 2,058 ms | 0.000 | 99 ms |
| App home (signed in)     | 100         | 100           | 96             | 964 ms   | 0.000 | 84 ms |
| App security (signed in) | 100         | 100           | 96             | 957 ms   | 0.000 | 53 ms |

#### Key marketing pages and app screens (Phase 12, PROGRESS 12.7, ADR-0143)

`scripts/lighthouse.mjs` now audits the key marketing pages and app screens below (median of three mobile runs, default simulated throttling, production build, a fresh fictional workspace owner). Measured on 2026-10-23 on the shared 4-core build machine at a load average of about 1. Every page passes with margin; total blocking time is the metric most sensitive to machine load, so a page that fails only on it is re-run before being treated as a regression. `LIGHTHOUSE_DEBUG=1` prints the largest-paint element, first paint, page weight, main-thread time, the costliest scripts and any accessibility audit not passed.

| Page                                  | Performance | Accessibility | Best practices | LCP      | CLS   | TBT    |
| ------------------------------------- | ----------- | ------------- | -------------- | -------- | ----- | ------ |
| Marketing home `/`                    | 99          | 100           | 100            | 2,120 ms | 0.000 | 27 ms  |
| Pricing `/pricing`                    | 98          | 100           | 100            | 2,418 ms | 0.000 | 24 ms  |
| Trust centre `/trust`                 | 99          | 100           | 100            | 2,165 ms | 0.000 | 29 ms  |
| Status page `/status`                 | 99          | 100           | 100            | 1,977 ms | 0.000 | 29 ms  |
| Developers `/developers`              | 98          | 100           | 100            | 2,274 ms | 0.000 | 65 ms  |
| Sign in `/signin`                     | 99          | 100           | 100            | 2,260 ms | 0.000 | 27 ms  |
| Sign up `/signup`                     | 99          | 100           | 100            | 2,116 ms | 0.000 | 28 ms  |
| App home `/app`                       | 100         | 100           | 100            | 1,860 ms | 0.000 | 35 ms  |
| Me hub `/app/me`                      | 100         | 100           | 100            | 1,216 ms | 0.000 | 48 ms  |
| People `/app/people`                  | 99          | 100           | 100            | 1,718 ms | 0.000 | 67 ms  |
| Time off `/app/time-off`              | 98          | 100           | 100            | 1,958 ms | 0.000 | 120 ms |
| Rota `/app/rota`                      | 96          | 100           | 100            | 2,415 ms | 0.006 | 152 ms |
| Timesheets `/app/timesheets`          | 97          | 100           | 100            | 1,866 ms | 0.000 | 178 ms |
| Reports catalogue `/app/reports`      | 97          | 100           | 100            | 2,614 ms | 0.008 | 51 ms  |
| Report builder `/app/reports/builder` | 98          | 100           | 100            | 2,307 ms | 0.000 | 91 ms  |
| Settings `/app/settings`              | 98          | 100           | 100            | 2,282 ms | 0.000 | 55 ms  |
| Notifications `/app/notifications`    | 100         | 100           | 100            | 1,815 ms | 0.006 | 39 ms  |
| Security `/app/security`              | 98          | 100           | 100            | 2,409 ms | 0.000 | 40 ms  |

What moved the numbers: per-route message scoping (ADR-0150) removed about 55 KB of compressed HTML from every page; each page renders its heading and intro before its data in the same elements as the loaded page (the rota's draft-shift explanation moved next to its heading, as the late largest paint there); the Inter font is preloaded; the app top bar no longer uses a backdrop filter; and fixing skipped heading levels took app screens from 98 to 100 for accessibility. On the same machine under heavy load from other jobs (load average 6 to 11) the rota, timesheets and report builder screens dropped to 84 to 89 on total blocking time alone; they are the first candidates for code splitting if CI numbers fall.

#### Payslips and the document viewer (ADR-0167, ADR-0168)

`scripts/lighthouse.mjs` also audits the payslip list, one payslip and the document viewer, opened last: the fresh owner is linked to a fictional employee record with a shared one-page contract and a September payslip from a fictional provider. Measured on 2026-10-24 on the shared 4-core machine while other agents' jobs ran (load average 2 to 6), with the Me hub as the control in the same runs (100 at load 1 on 2026-10-23):

| Page                                 | Performance | Accessibility | LCP               | CLS   | TBT           | Load average |
| ------------------------------------ | ----------- | ------------- | ----------------- | ----- | ------------- | ------------ |
| Me hub `/app/me` (control)           | 94 to 96    | 100           | 1,374 to 1,673 ms | 0.000 | 244 to 272 ms | 3.6 to 5.5   |
| Payslips `/app/payslips`             | 93          | 100           | 2,880 ms          | 0.000 | 180 ms        | 3.6          |
| Payslip `/app/payslips/:id`          | 91 to 93    | 100           | 2,539 to 3,193 ms | 0.000 | 93 to 286 ms  | 3.6 to 5.5   |
| Document viewer `/app/documents/:id` | 79 to 89    | 100           | 2,918 to 3,222 ms | 0.000 | 279 to 560 ms | 3.6 to 5.5   |

What moved the numbers:

- The three pages fetch their first data on the web server (`serverApiView`), so the observed largest paint is the first paint (150 to 225 ms).
- The viewer keeps its controls and a page-shaped placeholder in place while PDF.js loads, which took its CLS from 0.154 to 0. The payslip list no longer moves the payroll panel below it when the list arrives, which took it from 0.087 to 0.

The viewer is the page closest to the threshold. Evaluating the PDF.js display library costs about 350 ms of main thread on this machine (one long task), on top of the shell. That is the price of drawing PDFs in the page on phones that have no inline PDF viewer. Re-run it at a quiet moment before treating a failure as a regression. If CI numbers fall below 90, the next steps are moving the text layer after first paint and scoping the documents layout's message namespaces per page.

#### Sign-in and security screens after security hardening P0 (Phase 15)

The forgot-password page joined the audited pages. Measured on 2026-10-24 with `LIGHTHOUSE_ONLY=/signin,/forgot-password,/app/security,/app/settings` on the shared build machine at a load average of about 6 (other jobs running), so the performance scores are lower than the quiet-machine run above; all pass.

| Page                               | Performance | Accessibility | Best practices | LCP      | CLS   | TBT    |
| ---------------------------------- | ----------- | ------------- | -------------- | -------- | ----- | ------ |
| Sign in `/signin`                  | 95          | 100           | 100            | 2,961 ms | 0.000 | 61 ms  |
| Forgot password `/forgot-password` | 99          | 100           | 100            | 1,607 ms | 0.000 | 107 ms |
| Settings `/app/settings`           | 94          | 100           | 100            | 3,065 ms | 0.000 | 46 ms  |
| Security `/app/security`           | 93          | 100           | 100            | 3,076 ms | 0.000 | 124 ms |

#### Message catalogue in the page payload (Phase 12, ADR-0150)

Client components used to receive the whole flattened catalogue (about 5,000 messages) on every page. Each route segment's layout now sends only the namespaces its pages use. Measured on 2026-10-19 with a production build (`next start`) and a fresh, signed-in fictional workspace owner: HTML is `GET` with `Accept: text/html`, RSC is `GET` with `RSC: 1` (the full tree, as on a hard navigation; a client-side navigation between features sends only the changed segments). gz is gzip at the default level. Lighthouse was not re-run for this change.

| Page                     | HTML before           | HTML after           | RSC before            | RSC after            |
| ------------------------ | --------------------- | -------------------- | --------------------- | -------------------- |
| Marketing home `/`       | 277.1 KB (69.4 KB gz) | 51.8 KB (9.8 KB gz)  | 235.1 KB (63.7 KB gz) | 25.1 KB (6.5 KB gz)  |
| App home `/app`          | 265.8 KB (66.8 KB gz) | 42.5 KB (8.8 KB gz)  | 218.6 KB (60.5 KB gz) | 10.4 KB (3.9 KB gz)  |
| Assets `/app/assets`     | 268.3 KB (67.2 KB gz) | 48.1 KB (10.1 KB gz) | 219.0 KB (60.6 KB gz) | 13.6 KB (4.8 KB gz)  |
| Time off `/app/time-off` | 268.4 KB (67.3 KB gz) | 47.4 KB (9.8 KB gz)  | 219.0 KB (60.6 KB gz) | 12.9 KB (4.5 KB gz)  |
| Reports `/app/reports`   | 264.9 KB (66.7 KB gz) | 73.5 KB (17.1 KB gz) | 219.0 KB (60.6 KB gz) | 40.6 KB (12.1 KB gz) |

Reports keeps the whole `reports` namespace (and the compliance groups its ready-made reports use) because report definitions, columns and enum values arrive from the API as message keys.

### 2.3 Core HR at 200,000 employees (Phase 1)

These runs use the API in-process (Fastify `inject`, so no network hop). They show the order of magnitude and catch regressions; production latency comes from `pnpm loadtest` (§3).

#### Method

| Step                     | Command                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthetic tenant         | `pnpm synth:enterprise`                                     | Deterministically generates the 200,000-employee tenant "enterprise": 50 legal entities (UK, EU, US), 150 locations, 10 departments, effective-dated personal, job, pay and contract history (every fifth person has a promotion record), an 8-wide manager tree per entity plus dotted lines, and 6,000 sign-in users. Bulk-loaded with COPY.                                                                                                      |
| Core HR reads            | `node --env-file=.env --import tsx scripts/bench-corehr.ts` | Signs in as the owner (MFA) and as a manager of a 4,000-person entity, then runs each request 30 times after 3 warm-ups and reports p50, p95 and max. **Exits 1 if any p95 is over its budget.** Results go to `.verify/bench-corehr.json`.                                                                                                                                                                                                         |
| Org chart in the browser | Playwright functional test `e2e/corehr.spec.ts` › org chart | Times in-app navigation from home to the org chart until the first level is rendered, and expanding a node until its children are rendered (3 runs, median). Asserts < 1 s and < 300 ms. Results go to `.verify/org-chart-client-timing.json`.                                                                                                                                                                                                      |
| Bulk import              | `node --env-file=.env --import tsx scripts/bench-import.ts` | Creates a fresh fictional tenant and generates a 200,000-row CSV (manager hierarchy, 9 invalid rows). It uploads the file, runs the validation preview, then runs the import job on the real worker engine while polling `GET /v1/jobs/:id`. It checks the error report, re-runs the same batch (same job reused) and uploads the same file again (nothing must change). **Exits 1 if any check fails.** Results go to `.verify/bench-import.json`. |

Budgets (p95): people list, search, filters and profile < 1,000 ms (PROGRESS 1.1). Org chart first
render < 1,000 ms and node expand < 300 ms (PROGRESS 1.2).

#### Machine

|          |                                                                                         |
| -------- | --------------------------------------------------------------------------------------- |
| Date     | 2026-10-18                                                                              |
| CPU      | 4 vCPU, Intel Xeon @ 2.80 GHz, **shared with four other development workloads**         |
| Memory   | 16 GB                                                                                   |
| OS       | Linux 6.18                                                                              |
| Database | PostgreSQL 17.11 in Docker (default settings: `shared_buffers` 128 MB, `work_mem` 4 MB) |
| Runtime  | Node.js 24.22                                                                           |

#### Results — 2026-10-18

##### Synthetic 200,000-employee tenant

| Step                                                                                              | Result      |
| ------------------------------------------------------------------------------------------------- | ----------- |
| `pnpm synth:enterprise` (200,000 employees, 235,466 job records, 50 entities, 6,000 users)        | **173.9 s** |
| Phase 1 migrations 0007b–0007i applied on top of that data (FK validation, exclusion constraints) | < 1 s       |

##### Core HR reads on 200,000 employees (`scripts/bench-corehr.ts`, 30 runs each)

| Request                                               | p50 ms | p95 ms | max ms | p95 budget | Result |
| ----------------------------------------------------- | -----: | -----: | -----: | ---------: | ------ |
| People list, first page (50)                          |     14 |     23 |     23 |      1,000 | pass   |
| People list, page ~4,000 deep (200, cursor)           |     20 |     32 |     33 |      1,000 | pass   |
| People list as a manager (own team of ~4,000, 50)     |     59 |     69 |     70 |      1,000 | pass   |
| Search by name (full text + substring + trigram)      |     31 |     42 |     46 |      1,000 | pass   |
| Fuzzy search, misspelt name (`Averyy`, 4,387 matches) |     33 |     41 |     43 |      1,000 | pass   |
| Filter by country                                     |     15 |     21 |     23 |      1,000 | pass   |
| Profile as of today (field-level filtered)            |     26 |     33 |     33 |      1,000 | pass   |
| Org chart first render (roots)                        |     11 |     14 |     17 |      1,000 | pass   |
| Org chart expand node                                 |     12 |     14 |     15 |        300 | pass   |
| Org chart focus on a person                           |     15 |     19 |     20 |      1,000 | pass   |
| Org chart search                                      |     24 |     35 |     35 |      1,000 | pass   |
| Directory search                                      |     18 |     27 |     28 |      1,000 | pass   |

##### Org chart in the browser (Playwright, Chromium, production build)

The client was measured with a 33-person org (root, 8 leads with 3 reports each) against the real API.
The 200,000-person server timings are in the table above. Both stay within budget.

| Measure                                                                   | Runs (ms)                |         Median |         Budget |
| ------------------------------------------------------------------------- | ------------------------ | -------------: | -------------: |
| In-app navigation to the org chart until the first level is on screen     | 102, 121, 146            |     **121 ms** |       1,000 ms |
| Expand a node until its children are on screen                            | 68, 70, 65               |      **68 ms** |         300 ms |
| Re-run on the same machine with no other workloads: first render / expand | 84, 111, 98 / 46, 36, 35 | **98 / 36 ms** | 1,000 / 300 ms |

##### Bulk import of 200,000 employees (`scripts/bench-import.ts`)

This was a fresh tenant, a 200,000-row CSV (21 MiB) and the real worker engine. The same database already held the
200,000-person enterprise tenant.

| Step                                                                                           |                                                            First import |                Same file uploaded again |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------: | --------------------------------------: |
| Upload (multipart, parsed, stored)                                                             |                                                                   1.6 s |                                   2.2 s |
| Validation preview of every row (row-level errors)                                             |                                                                   3.9 s |                                   4.2 s |
| Background job, rows phase (400 chunks of 500)                                                 |                                                                   114 s |                                       — |
| Background job, total (rows, statistics refresh, 199,999 manager links, current-value refresh) |                                                               **386 s** |                                **26 s** |
| Outcome                                                                                        | 199,991 created, 9 invalid rows and 8 links to them in the error report | 0 created, 0 updated, 199,991 unchanged |
| Progress seen through `GET /v1/jobs/:id` (polled every 2 s)                                    |                          57 distinct updates, ending at 200,000/200,000 |                                      13 |

Checks, all passed: the job succeeded; every valid row was created; invalid rows were reported and
not imported; progress increased monotonically while the job ran; `POST /v1/imports/:id/run` on the
same batch returned the same job (`created: false`); the second import changed nothing.

Earlier the job ran statement by statement for every row. It measured 2,000 rows in 55 s, which
extrapolates to more than 1.5 hours for 200,000. Its final tenant-wide refresh took 160 s for 20,000
people and hit the 30 s statement timeout. ADR-0019 records the set-based rewrite that produced the
numbers above.

##### Re-running

```sh
pnpm synth:enterprise                                    # once; ~3 minutes
node --env-file=.env --import tsx scripts/bench-corehr.ts  # ~15 s, exits 1 over budget
node --env-file=.env --import tsx scripts/bench-import.ts  # ~7 minutes (IMPORT_ROWS=20000 for ~35 s)
```

Use a database that the test suites do not reset: the integration suites drop and recreate
`thapsus_test`.

### 2.4 Rota at 10,000 workers (Phase 4)

Target: the rota for 10,000+ shift workers in one tenant stays responsive (brief §6.3, PROGRESS 4.1). Measured on 2026-10-18 on a shared 4-core / 15 GB cloud container with PostgreSQL 17 in Docker. Other agents' workloads were running at the same time, so these are conservative upper bounds.

#### API (`scripts/bench-rota.ts`)

The benchmark seeds a fresh database with one fictional tenant: 10,000 shift workers across 20 stores and one week of 50,000 shifts. It then calls the API in-process (Fastify `inject`, real PostgreSQL, forced RLS, the full permission scope predicate). Raw output goes to `.verify/bench-rota.json`.

```
TEST_PG_OWNER_URL=postgres://thapsus_owner:…@127.0.0.1:5437 BENCH_DB=thapsus_bench_rota npx tsx scripts/bench-rota.ts
```

| Operation                                                 | Samples | p50   | p95   | Max    | Notes                                                                |
| --------------------------------------------------------- | ------- | ----- | ----- | ------ | -------------------------------------------------------------------- |
| Rota grid, first page (200 people + total + open shifts)  | 20      | 62 ms | 80 ms | 87 ms  |                                                                      |
| Rota grid, every keyset page (200 people with their week) | 150     | 42 ms | 69 ms | 105 ms | 3 full walks of 10,000 people / 50,000 shifts; ~522 KB JSON per page |
| Rota grid, one store (~500 people)                        | 3       | 52 ms | 65 ms | 65 ms  |                                                                      |
| Rota grid, name search                                    | 20      | 39 ms | 58 ms | 75 ms  |                                                                      |
| Shift list, every keyset page (500 shifts)                | 100     | 29 ms | 45 ms | 102 ms | `(shift_date, starts_at, id)` keyset                                 |
| Publish the whole week (50,000 drafts)                    | 1       | —     | —     | 4.1 s  | one statement; notifications are per employee with a user account    |

Seeding 10,000 employees and 50,000 shifts took 6.1 s.

#### Browser (`apps/web/e2e/rota-bench.spec.ts`)

This runs in the Playwright functional project in headless Chromium. It serves 10,000 fictional workers × 5 shifts through the real `/v1/rota` paging contract, intercepted in the browser so that only client rendering is measured.

| Measure                                                   | Result                        |
| --------------------------------------------------------- | ----------------------------- |
| Navigation to first rows rendered                         | 0.95–1.2 s                    |
| Jump to row 5,000 (25 keyset pages loaded in order)       | 1.5–1.6 s                     |
| Frame time while scrolling 10 rows per frame (180 frames) | median 24–25 ms, p95 41–48 ms |
| Rows in the DOM (top, middle, after scrolling)            | 27 / 27 / 27 of 10,000        |

The spec fails if more than 80 rows are ever in the DOM, if first render takes more than 15 s, or if the p95 frame time exceeds 100 ms. Before Intl formatters were cached, the median frame was 129 ms (ADR-0034).

#### Follow-ups

- A grid page is ~2.6 KB per person. Response compression, or a compact grid shape for shifts, would cut transfer on slow mobile networks. Check with `pnpm loadtest` in staging.
- Publishing notifies each affected employee inside the publish transaction. For tens of thousands of users, move the fan-out to a background job (the dedupe key already makes it idempotent).

## 3. Load tests against AWS (`pnpm loadtest`)

Not run yet. The owner's machine runs it after the staging deploy (see `docs/HANDOVER.md`). Results go here, one table per run, with the environment, its size and the teardown confirmation.

## 4. Resilience drills

PROGRESS 12.8. Both drills run on staging (the AWS phase; see `docs/HANDOVER.md`). Add one row per drill run.

| Drill                     | Procedure                            | Pass criteria                                                                                                                                                                                                       | Date | Result      |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------- |
| Backup restore            | `docs/runbooks/backup-restore.md` §5 | Restored cluster holds the data at the restore point and not after it; the audit chain verifies; RPO ≤ 15 min; RTO ≤ 4 h                                                                                            | —    | Not run yet |
| Availability-zone failure | `docs/runbooks/az-failure.md` §2     | Aurora failover, Valkey failover and losing one AZ's ECS tasks under load: k6 failed requests < 1 %, no data loss (audit chain verifies, clock events present exactly once), each component back in under 2 minutes | —    | Not run yet |
