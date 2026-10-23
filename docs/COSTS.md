# Cost estimates

These are on-demand list-price estimates (USD per month, about 730 hours, October 2026) for the CDK stacks in `infra/`. Every cell stack has an AWS Budgets alarm at 80% and 100% of its line here. Anything that would push recurring cost past these estimates needs the product owner's approval first (CLAUDE.md).

## Staging (cost-lean: Aurora Serverless v2 at 0.5 ACU minimum, 1 NAT gateway, one task per service)

| Item                                                                                                                                  | Per cell region (UK, EU, US) |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| RDS Proxy (Serverless v2 bills a minimum of 8 ACU)                                                                                    | ~$88                         |
| Aurora Serverless v2: writer and reporting reader at 0.5 ACU, plus storage and I/O                                                    | ~$95–110                     |
| Fargate: web, api and worker at 0.5 vCPU / 1 GB, one task each, plus the ADOT sidecar                                                 | ~$55–62                      |
| NAT gateway ×1, plus data processing                                                                                                  | ~$33–38                      |
| ElastiCache Valkey `cache.t4g.micro` ×2 (Multi-AZ)                                                                                    | ~$25                         |
| Application Load Balancer                                                                                                             | ~$22–25                      |
| Public IPv4 addresses                                                                                                                 | ~$15                         |
| AWS WAF (web ACL and 5 rules)                                                                                                         | ~$10                         |
| CloudWatch logs, metrics, alarms and Container Insights                                                                               | ~$10–25                      |
| Secrets Manager, KMS, Backup, S3, SQS, EventBridge, SES, SNS (includes the per-cell Stripe key secret added in Phase 10, about $0.40) | ~$10                         |
| **Total per cell**                                                                                                                    | **~$350–400**                |
| **Budget alarm per cell**                                                                                                             | **$400**                     |

| Stack                                                                   | Staging per month                   |
| ----------------------------------------------------------------------- | ----------------------------------- |
| Cell UK (eu-west-2)                                                     | ~$350–400                           |
| Cell EU (eu-central-1)                                                  | ~$350–400                           |
| Cell US (us-east-2)                                                     | ~$340–390                           |
| Global (eu-west-2): 2 small Fargate tasks, ALB, WAF, DynamoDB on demand | ~$75–90 (budget $100)               |
| Backup copy vaults (eu-west-1, us-west-1)                               | ~$2, plus copy storage and transfer |
| **Staging total**                                                       | **~$1,120–1,290**                   |

The main ways to reduce staging cost are dropping RDS Proxy in staging (about −$88 per cell), logging only rejected traffic in VPC flow logs, and using a smaller reader. The load-test environment is temporary: it is torn down after each run and costs roughly $15–40 per run (see PERFORMANCE.md).

## Production (Multi-AZ everywhere, 3 NAT gateways, at least 2 tasks per service)

| Item                                                                                                         | Per cell region, baseline      |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| Aurora Serverless v2, 2–64 ACU writer and reader (baseline about 4 ACU each)                                 | ~$700                          |
| RDS Proxy                                                                                                    | ~$170                          |
| Fargate: at least 2 tasks each for web, api and worker (1 vCPU / 2 GB), autoscaling                          | ~$350 at baseline              |
| NAT gateways ×3                                                                                              | ~$100, plus data processing    |
| ElastiCache Valkey `cache.r7g.large` with 2 replicas                                                         | ~$480                          |
| ALB, WAF, CloudWatch, Backup (35-day retention, continuous point-in-time recovery), KMS, Secrets Manager, S3 | ~$250                          |
| **Total per cell**                                                                                           | **~$2,050**, scaling with load |

The global stack in production costs about $150. Production is not deployed until the product owner approves.

## Dedicated databases (optional, none deployed by default)

A dedicated database is recurring cost **only when an operator adds an entry** to `dedicatedDatabases` in `infra/config/<env>.json` (ADR-0068, runbook `docs/runbooks/move-tenant-to-dedicated-db.md`). None of the committed env configs has an entry, so the estimates above include none. Each entry needs the product owner's approval first, like any cost beyond this document (CLAUDE.md). Raise that cell's `monthlyBudgetUsd` (its budget alarm) by the same amount in the same change.

Each entry adds, in the tenant's home cell only: an Aurora Serverless v2 cluster (writer and reporting reader), an RDS Proxy, one owner secret, two log groups, a CPU alarm, and AWS Backup storage for its snapshots (plus copies in the permitted backup region for EU and US).

| Per dedicated database                                                  | Staging (0.5 ACU minimum) | Production (baseline about 4 ACU each, writer and reader) |
| ----------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------- |
| Aurora Serverless v2: writer and reporting reader, plus storage and I/O | ~$95–110                  | ~$700, scaling with load up to `maxAcu`                   |
| RDS Proxy (Serverless v2 bills a minimum of 8 ACU)                      | ~$88                      | ~$170                                                     |
| Secrets Manager, CloudWatch logs and alarm, backup storage and copies   | ~$5                       | ~$20–60, growing with data size and retention             |
| **Total per entry**                                                     | **~$190–200**             | **~$890–930 baseline**                                    |

The tools task (migrations and the move runner) runs only during deploys and moves, so it costs cents. A very large tenant may need a higher `maxAcu` than the shared cluster; size it with the 200,000-employee profile and `pnpm loadtest` (`docs/PERFORMANCE.md`) before asking for approval.

## Development

The dev environment matches staging but is only deployed on demand. The default is local Docker, which costs nothing.

## Optional: Ask HR (Amazon Bedrock, UK cell only)

There is no fixed cost. Bedrock bills per token through AWS Marketplace, and only for workspaces that are entitled and opted in. One question sends about 2,000–3,500 input tokens (system prompt plus up to 5 excerpts) and gets about 150–400 output tokens back. Check the current Claude Opus 5.5 rates for eu-west-2 on https://aws.amazon.com/bedrock/pricing/ before enabling it. The per-user limit (20 questions per 10 minutes) and the per-tenant limit (2,000 per hour) cap the spend. Enabling it for customers needs the product owner's approval (HUMAN_TODO 7).

## Phase 10 additions

- One Secrets Manager secret per cell for that region's Stripe test-mode keys (`thapsus-hr/<env>/stripe/<cell>`): about $0.40 a month each, $1.20 a month per environment, inside the existing "Secrets Manager, KMS, …" line. No other AWS resource was added. Stripe itself bills per transaction (Billing and Tax fees) only in live mode, which needs the product owner's approval (HUMAN_TODO 4.1).

## Phase 12 ASVS review

- No AWS resource and no recurring cost were added. The SBOM uses pnpm's built-in generator in CI; the RDS CA bundle is downloaded at image build time; the HTTP-listener rules for API paths are free.
- Not added, pending approval: GuardDuty Malware Protection for S3 for uploaded files (HUMAN_TODO 1.7). It is billed per GB scanned and per object evaluated; estimate it from https://aws.amazon.com/guardduty/pricing/ against each cell's upload volume and add the line here before enabling it.

## Load test (temporary, per run)

`pnpm loadtest --provision` creates `ThapsusHr-loadtest-global` and `ThapsusHr-loadtest-cell-uk` (eu-west-2 only; `infra/config/loadtest.json`) and deletes them at the end of the run (`docs/runbooks/load-test.md`). Nothing is left running.

| Item (about 2 hours: provisioning, synthetic data, a 20-minute k6 run, teardown) | Per run     |
| -------------------------------------------------------------------------------- | ----------- |
| Fargate: 6–40 api tasks at 1 vCPU / 2 GB, plus worker and web                    | ~$5–15      |
| Aurora Serverless v2 scaling up to 64 ACU under load, plus RDS Proxy             | ~$6–15      |
| ElastiCache `cache.r7g.large` ×2, ALB, NAT gateway, WAF (pro-rated hourly)       | ~$2–4       |
| Load generator: one `c7i.2xlarge` EC2 instance in eu-west-2 for 2 hours, if used | ~$1         |
| **Total per run**                                                                | **~$15–40** |

The per-month budget alarm for the load-test cell is $300, so a forgotten teardown alerts within days. Run it only with the product owner's go-ahead.
