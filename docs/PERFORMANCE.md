# Performance

Measured results against the scale targets in the brief. Every number states how it was measured and on what machine; reruns update the table.

## Rota (Phase 4)

Target: the rota for 10,000+ shift workers in one tenant stays responsive (brief §6.3, PROGRESS 4.1). Measured on 2026-10-18 on a shared 4-core / 15 GB cloud container with PostgreSQL 17 in Docker. Other agents' workloads were running at the same time, so these are conservative upper bounds.

### API (`scripts/bench-rota.ts`)

The benchmark seeds a fresh database with one fictional tenant: 10,000 shift workers across 20 stores and one week of 50,000 shifts. It then calls the API in-process (Fastify `inject`, real PostgreSQL, forced RLS, the full permission scope predicate). Raw output goes to `.verify/bench-rota.json`.

```
TEST_PG_OWNER_URL=postgres://thapsus_owner:…@127.0.0.1:5437 BENCH_DB=thapsus_bench_rota npx tsx scripts/bench-rota.ts
```

| Operation | Samples | p50 | p95 | Max | Notes |
| --- | --- | --- | --- | --- | --- |
| Rota grid, first page (200 people + total + open shifts) | 20 | 62 ms | 80 ms | 87 ms | |
| Rota grid, every keyset page (200 people with their week) | 150 | 42 ms | 69 ms | 105 ms | 3 full walks of 10,000 people / 50,000 shifts; ~522 KB JSON per page |
| Rota grid, one store (~500 people) | 3 | 52 ms | 65 ms | 65 ms | |
| Rota grid, name search | 20 | 39 ms | 58 ms | 75 ms | |
| Shift list, every keyset page (500 shifts) | 100 | 29 ms | 45 ms | 102 ms | `(shift_date, starts_at, id)` keyset |
| Publish the whole week (50,000 drafts) | 1 | — | — | 4.1 s | one statement; notifications are per employee with a user account |

Seeding 10,000 employees and 50,000 shifts took 6.1 s.

### Browser (`apps/web/e2e/rota-bench.spec.ts`)

This runs in the Playwright functional project in headless Chromium. It serves 10,000 fictional workers × 5 shifts through the real `/v1/rota` paging contract, intercepted in the browser so that only client rendering is measured.

| Measure | Result |
| --- | --- |
| Navigation to first rows rendered | 0.95–1.2 s |
| Jump to row 5,000 (25 keyset pages loaded in order) | 1.5–1.6 s |
| Frame time while scrolling 10 rows per frame (180 frames) | median 24–25 ms, p95 41–48 ms |
| Rows in the DOM (top, middle, after scrolling) | 27 / 27 / 27 of 10,000 |

The spec fails if more than 80 rows are ever in the DOM, if first render takes more than 15 s, or if the p95 frame time exceeds 100 ms. Before Intl formatters were cached, the median frame was 129 ms (ADR-0034).

### Follow-ups

- A grid page is ~2.6 KB per person. Response compression, or a compact grid shape for shifts, would cut transfer on slow mobile networks. Check with `pnpm loadtest` in staging.
- Publishing notifies each affected employee inside the publish transaction. For tens of thousands of users, move the fan-out to a background job (the dedupe key already makes it idempotent).
