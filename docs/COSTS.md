# Cost estimates

These are on-demand list-price estimates (USD per month, about 730 hours, October 2026) for the CDK stacks in `infra/`. Every cell stack has an AWS Budgets alarm at 80% and 100% of its line here. Anything that would push recurring cost past these estimates needs the product owner's approval first (CLAUDE.md).

## Staging (cost-lean: Aurora Serverless v2 at 0.5 ACU minimum, 1 NAT gateway, one task per service)

| Item | Per cell region (UK, EU, US) |
| --- | --- |
| RDS Proxy (Serverless v2 bills a minimum of 8 ACU) | ~$88 |
| Aurora Serverless v2: writer and reporting reader at 0.5 ACU, plus storage and I/O | ~$95–110 |
| Fargate: web, api and worker at 0.5 vCPU / 1 GB, one task each, plus the ADOT sidecar | ~$55–62 |
| NAT gateway ×1, plus data processing | ~$33–38 |
| ElastiCache Valkey `cache.t4g.micro` ×2 (Multi-AZ) | ~$25 |
| Application Load Balancer | ~$22–25 |
| Public IPv4 addresses | ~$15 |
| AWS WAF (web ACL and 5 rules) | ~$10 |
| CloudWatch logs, metrics, alarms and Container Insights | ~$10–25 |
| Secrets Manager, KMS, Backup, S3, SQS, EventBridge, SES, SNS | ~$10 |
| **Total per cell** | **~$350–400** |
| **Budget alarm per cell** | **$400** |

| Stack | Staging per month |
| --- | --- |
| Cell UK (eu-west-2) | ~$350–400 |
| Cell EU (eu-central-1) | ~$350–400 |
| Cell US (us-east-2) | ~$340–390 |
| Global (eu-west-2): 2 small Fargate tasks, ALB, WAF, DynamoDB on demand | ~$75–90 (budget $100) |
| Backup copy vaults (eu-west-1, us-west-1) | ~$2, plus copy storage and transfer |
| **Staging total** | **~$1,120–1,290** |

The main ways to reduce staging cost are dropping RDS Proxy in staging (about −$88 per cell), logging only rejected traffic in VPC flow logs, and using a smaller reader. The load-test environment is temporary: it is torn down after each run and costs roughly $15–40 per run (see PERFORMANCE.md).

## Production (Multi-AZ everywhere, 3 NAT gateways, at least 2 tasks per service)

| Item | Per cell region, baseline |
| --- | --- |
| Aurora Serverless v2, 2–64 ACU writer and reader (baseline about 4 ACU each) | ~$700 |
| RDS Proxy | ~$170 |
| Fargate: at least 2 tasks each for web, api and worker (1 vCPU / 2 GB), autoscaling | ~$350 at baseline |
| NAT gateways ×3 | ~$100, plus data processing |
| ElastiCache Valkey `cache.r7g.large` with 2 replicas | ~$480 |
| ALB, WAF, CloudWatch, Backup (35-day retention, continuous point-in-time recovery), KMS, Secrets Manager, S3 | ~$250 |
| **Total per cell** | **~$2,050**, scaling with load |

The global stack in production costs about $150. Production is not deployed until the product owner approves.

## Development

The dev environment matches staging but is only deployed on demand. The default is local Docker, which costs nothing.

## Optional: Ask HR (Amazon Bedrock, UK cell only)

There is no fixed cost. Bedrock bills per token through AWS Marketplace, and only for workspaces that are entitled and opted in. One question sends about 2,000–3,500 input tokens (system prompt plus up to 5 excerpts) and gets about 150–400 output tokens back. Check the current Claude Opus 5.5 rates for eu-west-2 on https://aws.amazon.com/bedrock/pricing/ before enabling it. The per-user limit (20 questions per 10 minutes) and the per-tenant limit (2,000 per hour) cap the spend. Enabling it for customers needs the product owner's approval (HUMAN_TODO 7).

