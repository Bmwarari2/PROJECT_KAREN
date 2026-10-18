# Performance

Benchmarks for the scale targets in `docs/PROGRESS.md`. **All numbers are local measurements**: a
Docker PostgreSQL on a shared development machine, with the API in-process (Fastify `inject`, so no
network hop). They show the order of magnitude and catch regressions. They are not production latency,
which `pnpm loadtest` (k6, a temporary AWS environment) will measure.

## Method

| Step | Command | What it does |
| --- | --- | --- |
| Synthetic tenant | `pnpm synth:enterprise` | Deterministically generates the 200,000-employee tenant "enterprise": 50 legal entities (UK, EU, US), 150 locations, 10 departments, effective-dated personal, job, pay and contract history (every fifth person has a promotion record), an 8-wide manager tree per entity plus dotted lines, and 6,000 sign-in users. Bulk-loaded with COPY. |
| Core HR reads | `node --env-file=.env --import tsx scripts/bench-corehr.ts` | Signs in as the owner (MFA) and as a manager of a 4,000-person entity, then runs each request 30 times after 3 warm-ups and reports p50, p95 and max. **Exits 1 if any p95 is over its budget.** Results go to `.verify/bench-corehr.json`. |
| Org chart in the browser | Playwright functional test `e2e/corehr.spec.ts` › org chart | Times in-app navigation from home to the org chart until the first level is rendered, and expanding a node until its children are rendered (3 runs, median). Asserts < 1 s and < 300 ms. Results go to `.verify/org-chart-client-timing.json`. |
| Bulk import | `node --env-file=.env --import tsx scripts/bench-import.ts` | Creates a fresh fictional tenant and generates a 200,000-row CSV (manager hierarchy, 9 invalid rows). It uploads the file, runs the validation preview, then runs the import job on the real worker engine while polling `GET /v1/jobs/:id`. It checks the error report, re-runs the same batch (same job reused) and uploads the same file again (nothing must change). **Exits 1 if any check fails.** Results go to `.verify/bench-import.json`. |

Budgets (p95): people list, search, filters and profile < 1,000 ms (PROGRESS 1.1). Org chart first
render < 1,000 ms and node expand < 300 ms (PROGRESS 1.2).

## Machine

| | |
| --- | --- |
| Date | 2026-10-18 |
| CPU | 4 vCPU, Intel Xeon @ 2.80 GHz, **shared with four other development workloads** |
| Memory | 16 GB |
| OS | Linux 6.18 |
| Database | PostgreSQL 17.11 in Docker (default settings: `shared_buffers` 128 MB, `work_mem` 4 MB) |
| Runtime | Node.js 24.22 |

## Results — 2026-10-18

### Synthetic 200,000-employee tenant

| Step | Result |
| --- | --- |
| `pnpm synth:enterprise` (200,000 employees, 235,466 job records, 50 entities, 6,000 users) | **173.9 s** |
| Phase 1 migrations 0007b–0007i applied on top of that data (FK validation, exclusion constraints) | < 1 s |

### Core HR reads on 200,000 employees (`scripts/bench-corehr.ts`, 30 runs each)

| Request | p50 ms | p95 ms | max ms | p95 budget | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| People list, first page (50) | 14 | 23 | 23 | 1,000 | pass |
| People list, page ~4,000 deep (200, cursor) | 20 | 32 | 33 | 1,000 | pass |
| People list as a manager (own team of ~4,000, 50) | 59 | 69 | 70 | 1,000 | pass |
| Search by name (full text + substring + trigram) | 31 | 42 | 46 | 1,000 | pass |
| Fuzzy search, misspelt name (`Averyy`, 4,387 matches) | 33 | 41 | 43 | 1,000 | pass |
| Filter by country | 15 | 21 | 23 | 1,000 | pass |
| Profile as of today (field-level filtered) | 26 | 33 | 33 | 1,000 | pass |
| Org chart first render (roots) | 11 | 14 | 17 | 1,000 | pass |
| Org chart expand node | 12 | 14 | 15 | 300 | pass |
| Org chart focus on a person | 15 | 19 | 20 | 1,000 | pass |
| Org chart search | 24 | 35 | 35 | 1,000 | pass |
| Directory search | 18 | 27 | 28 | 1,000 | pass |

### Org chart in the browser (Playwright, Chromium, production build)

The client was measured with a 33-person org (root, 8 leads with 3 reports each) against the real API.
The 200,000-person server timings are in the table above. Both stay within budget.

| Measure | Runs (ms) | Median | Budget |
| --- | --- | ---: | ---: |
| In-app navigation to the org chart until the first level is on screen | 102, 121, 146 | **121 ms** | 1,000 ms |
| Expand a node until its children are on screen | 68, 70, 65 | **68 ms** | 300 ms |
| Re-run on the same machine with no other workloads: first render / expand | 84, 111, 98 / 46, 36, 35 | **98 / 36 ms** | 1,000 / 300 ms |

### Bulk import of 200,000 employees (`scripts/bench-import.ts`)

This was a fresh tenant, a 200,000-row CSV (21 MiB) and the real worker engine. The same database already held the
200,000-person enterprise tenant.

| Step | First import | Same file uploaded again |
| --- | ---: | ---: |
| Upload (multipart, parsed, stored) | 1.6 s | 2.2 s |
| Validation preview of every row (row-level errors) | 3.9 s | 4.2 s |
| Background job, rows phase (400 chunks of 500) | 114 s | — |
| Background job, total (rows, statistics refresh, 199,999 manager links, current-value refresh) | **386 s** | **26 s** |
| Outcome | 199,991 created, 9 invalid rows and 8 links to them in the error report | 0 created, 0 updated, 199,991 unchanged |
| Progress seen through `GET /v1/jobs/:id` (polled every 2 s) | 57 distinct updates, ending at 200,000/200,000 | 13 |

Checks, all passed: the job succeeded; every valid row was created; invalid rows were reported and
not imported; progress increased monotonically while the job ran; `POST /v1/imports/:id/run` on the
same batch returned the same job (`created: false`); the second import changed nothing.

Earlier the job ran statement by statement for every row. It measured 2,000 rows in 55 s, which
extrapolates to more than 1.5 hours for 200,000. Its final tenant-wide refresh took 160 s for 20,000
people and hit the 30 s statement timeout. ADR-0019 records the set-based rewrite that produced the
numbers above.

### Re-running

```sh
pnpm synth:enterprise                                    # once; ~3 minutes
node --env-file=.env --import tsx scripts/bench-corehr.ts  # ~15 s, exits 1 over budget
node --env-file=.env --import tsx scripts/bench-import.ts  # ~7 minutes (IMPORT_ROWS=20000 for ~35 s)
```

Use a database that the test suites do not reset: the integration suites drop and recreate
`thapsus_test`.
