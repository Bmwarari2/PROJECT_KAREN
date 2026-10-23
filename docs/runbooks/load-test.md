# Runbook: load test (`pnpm loadtest`)

Proves the brief §3 targets:

- one tenant with 200,000 employees and 50 legal entities;
- 5,000 concurrent users;
- 20,000 clock-ins in 10 minutes;
- p95 latency under 300 ms for common reads and under 1 s for paginated lists.

Results are appended to `docs/PERFORMANCE.md` §3.

## 1. What it creates and costs

`pnpm loadtest --provision` deploys the temporary `loadtest` environment: `ThapsusHr-loadtest-global` plus `ThapsusHr-loadtest-cell-uk` (eu-west-2 only). It uses `infra/config/loadtest.json`.

**Sizing:**

- 6–40 api tasks;
- Aurora Serverless v2 at 2–64 ACU;
- a `cache.r7g.large` Valkey cluster;
- one NAT gateway.

**Load-test-only settings:**

- the WAF rate rule is raised;
- the per-IP sign-in throttles are multiplied by 1,000, so one load generator can sign in thousands of synthetic users;
- production refuses both settings.

**Data:** the synthetic tenant is generated inside the cell (deploy target `synth-uk`). It is fictional only: 200,000 employees, 50 entities, 26,000 sign-in users.

**Cost:** roughly $15–40 for a run of about 2 hours (docs/COSTS.md). The environment costs money until teardown finishes.

**Approval:** this is recurring cost and creates cloud resources, so run it only with the product owner's go-ahead.

## 2. Run

**Prerequisites:**

- an SSO session for the staging account;
- Docker (for the pinned `grafana/k6:1.3.0`) or a local `k6`;
- a load generator machine with ≥ 8 vCPU / 16 GB RAM for 5,000 VUs. An EC2 instance in eu-west-2 is best; a laptop is not enough.

```sh
# 1. validate the scripts against a local stack first (tiny profile)
pnpm loadtest --target http://127.0.0.1:3000 --profile smoke

# 2. the real run: provision → synthetic tenant → k6 → record → teardown (asks before deleting)
pnpm loadtest --provision --insecure-tls --param CertificateArn=<imported cert in eu-west-2> --param GlobalBaseUrl=https://<placeholder>
```

**Flags:**

- `--keep` leaves the environment up so you can re-run with `--target`;
- `--teardown-only` deletes it later;
- `--yes` skips the deletion prompt (CI-style runs).

**Scenarios** (`loadtest/k6/thapsus.js`):

| Scenario          | Load                                                                                                                                                                               | Threshold                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `common_reads`    | Ramps to 5,000 VUs over 5 min, holds 10 min. Each VU is a signed-in synthetic user reading its session, employee record, leave balances, shifts, clock status and org-chart focus. | p95 < 300 ms                |
| `paginated_lists` | 250 HR-admin VUs (the owner session with MFA) page through the 200,000-person list and search it.                                                                                  | p95 < 1 s                   |
| `clock_in_burst`  | During the 5,000-user plateau: a constant arrival rate of 34 clock-ins per second for 10 min, each a distinct synthetic employee (20,400 in total).                                | ≥ 20,000 created; p95 < 1 s |

**Failure gates:** failed requests must stay under 1 %, and checks must pass over 99 %. k6 exits 99 when a threshold fails; the runner records FAIL.

## 3. Teardown

The runner empties the files and logs buckets (all versions), deletes the backup recovery points, then runs `cdk destroy` on the cell and global stacks. In `loadtest`, every stateful resource has deletion policy Delete. KMS keys move to _pending deletion_ (7 days) and then disappear.

### Manual teardown (if the runner was interrupted)

1. `aws s3api list-object-versions` / `delete-objects` on:
   - `thapsus-hr-loadtest-eu-west-2-files-<acct>`;
   - `thapsus-hr-loadtest-eu-west-2-logs-<acct>`;
   - `thapsus-hr-loadtest-eu-west-2-global-logs-<acct>`.
2. `aws backup list-recovery-points-by-backup-vault --backup-vault-name thapsus-hr-loadtest-uk` → `delete-recovery-point` for each.
3. Destroy both stacks:
   - `AWS_REGION=eu-west-2 pnpm --filter @thapsus/infra exec cdk destroy ThapsusHr-loadtest-cell-uk -c env=loadtest --force`
   - then the same for `ThapsusHr-loadtest-global`.
4. In the console, confirm that no `thapsus-hr-loadtest-*` resources remain in eu-west-2:
   - CloudFormation;
   - RDS (clusters and snapshots);
   - ElastiCache;
   - NAT gateways and Elastic IPs.

## 4. Reading the results

Each run adds one row to `docs/PERFORMANCE.md` §3. Look at, in order:

1. the reads and lists p95 against their targets;
2. the clock-ins created;
3. the failed requests.

On a FAIL, open the k6 summary JSON (`.loadtest/summary-*.json`) and the CloudWatch dashboards (ALB latency, Aurora ACU and connections, ECS CPU). Record the fix in `docs/DECISIONS.md`, for example scaling limits or an index. If PostgreSQL search turns out to be the bottleneck, a dedicated search service needs an ADR first (CLAUDE.md).
