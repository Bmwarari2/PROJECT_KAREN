# Performance

Brief §3 sets the scale targets. This file records how each one is measured and the latest result. Local numbers come from a development container, not from AWS. The staging and load-test numbers in §3 are filled in by `pnpm loadtest` (Phase 12) against a temporary environment that is torn down after each run.

## 1. Targets (brief §3)

| Target | How it is proven | Status |
| --- | --- | --- |
| One tenant with 200,000 employees and 50 legal entities across the UK, EU and US | `pnpm synth:enterprise` (§2.1); the generator test `apps/api/test/cli.int.test.ts` | Generated locally (§2.1) |
| 5,000 concurrent users per tenant | k6 `concurrent-users` scenario in `pnpm loadtest` | Pending the AWS load-test run (Phase 12) |
| 20,000 clock-ins within 10 minutes | k6 `clock-in-burst` scenario in `pnpm loadtest` | Pending the AWS load-test run (Phase 12) |
| p95 < 300 ms for common reads, < 1 s for paginated lists at that size | Local benchmarks per phase (§2) plus k6 thresholds | See §2; AWS run pending |
| 200,000-employee bulk import and large reports as background jobs with progress | Phase 1 import benchmark, Phase 7 report jobs | See §2 |
| 99.9 % availability, Multi-AZ, RPO ≤ 15 min, RTO ≤ 4 h | CDK assertions (Multi-AZ, continuous backup) plus the Phase 12 drills | Drills pending (Phase 12) |

## 2. Local measurements

**Machine:** 4 vCPU, 15 GB RAM Linux container. PostgreSQL 17 (Docker, `postgres:17-alpine`, `shared_buffers=128MB`). Node 24.22. Other build and test jobs shared the machine during these runs, so treat the numbers as upper bounds.

### 2.1 Synthetic enterprise tenant (Phase 0)

Command: `SYNTH_EMPLOYEES=200000 SYNTH_USERS=6000 pnpm synth:enterprise` on a fresh, migrated database. The data is bulk-loaded with `COPY`.

| Date | Employees | Legal entities | Locations | Sign-in users | Generator runtime | Wall clock (incl. tsx start-up) | Database size |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-18 | 200,000 | 50 | 150 | 6,000 | 171.7 s | 2 m 53 s | 740 MB |

Phases of the run:
- 0.3 s — organisation (50 entities, 150 locations, 10 departments)
- 14.4 s — employees
- 144.8 s — effective-dated history and reporting lines
- 171.7 s — sign-in users and roles

The output is deterministic: two runs with the same size produce byte-identical employee data, which the `cli.int.test.ts` digest test checks.

### 2.2 Lighthouse, mobile (Phase 0)

`pnpm verify` → `scripts/lighthouse.mjs`: median of three runs on a production build with default mobile throttling. Thresholds are performance ≥ 90 and accessibility ≥ 95. Latest results are below; `.verify/lighthouse.json` holds the newest run.

| Page | Performance | Accessibility | Best practices | LCP | CLS | TBT |
| --- | --- | --- | --- | --- | --- | --- |
| Marketing home | 98 | 96 | 96 | 2,180 ms | 0.000 | 78 ms |
| Sign in | 100 | 96 | 96 | 1,613 ms | 0.000 | 43 ms |
| Sign up | 98 | 100 | 96 | 2,058 ms | 0.000 | 99 ms |
| App home (signed in) | 100 | 100 | 96 | 964 ms | 0.000 | 84 ms |
| App security (signed in) | 100 | 100 | 96 | 957 ms | 0.000 | 53 ms |

## 3. Load tests against AWS (`pnpm loadtest`)

Not run yet. The owner's machine runs it after the staging deploy (see `docs/HANDOVER.md`). Results go here, one table per run, with the environment, its size and the teardown confirmation.
