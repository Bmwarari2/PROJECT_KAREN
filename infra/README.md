# infra — AWS CDK for Thapsus-HR

Stacks per environment (`dev`, `staging`, `prod`; settings in `config/<env>.json`):

| Stack | Region | Contents |
| --- | --- | --- |
| `ThapsusHr-<env>-global` | eu-west-2 | Tenant directory (DynamoDB, no personal data), global sign-in API + marketing web on Fargate behind ALB + WAF, Route 53 zone (only when `domain` is set), Stripe/billing placeholders |
| `ThapsusHr-<env>-cell-uk` | eu-west-2 | Regional cell (below) |
| `ThapsusHr-<env>-cell-eu` | eu-central-1 | Regional cell |
| `ThapsusHr-<env>-cell-us` | us-east-2 | Regional cell |
| `ThapsusHr-<env>-backup-copy-eu` | eu-west-1 | Backup copy vault for the EU cell |
| `ThapsusHr-<env>-backup-copy-us` | us-west-1 | Backup copy vault for the US cell |

The UK cell has no backup copy (London only). No stack ever targets us-east-1 or us-west-2, and
there is no CloudFront (ADR-0001). The region map comes from `packages/core/src/regions.ts`.

A cell holds: VPC (3 AZs, flow logs), KMS `data` + `vault` keys, Aurora PostgreSQL 17 Serverless v2
(writer + reporting reader, RDS Proxy with TLS), Valkey (Multi-AZ, TLS, KMS), S3 files + logs buckets,
SQS `jobs`/`webhooks` (+ DLQs), EventBridge bus + Scheduler group, SES configuration set, ECS
Fargate `api`/`worker`/`web` + a `migrator` task definition, ALB + WAF, AWS Backup (continuous +
daily), CloudWatch alarms → SNS, and a monthly AWS Budget filtered by the `cell` tag.

## Commands

```sh
pnpm --filter @thapsus/infra synth                 # all environments
pnpm --filter @thapsus/infra cdk synth -c env=staging --quiet
pnpm exec vitest run --project unit infra          # assertions (from the repo root)
npx tsc --noEmit -p infra                          # typecheck
```

Synth does not build images; deploy builds `apps/{api,worker,web}/Dockerfile` with the repo root as
the context (linux/amd64).

## Deploy order (per environment — production deploys need explicit approval)

1. `cdk bootstrap` in eu-west-2, eu-central-1, us-east-2, eu-west-1, us-west-1 only.
2. `ThapsusHr-<env>-backup-copy-eu` and `-backup-copy-us` (the cells' backup plans copy into them).
3. `ThapsusHr-<env>-global`.
4. `ThapsusHr-<env>-cell-uk`, `-cell-eu`, `-cell-us`.
5. Copy the global `thapsus-hr/<env>/internal-token` value into the same-named secret in each cell
   region (secrets cannot be referenced across regions), fill `thapsus-hr/<env>/vapid` (and
   `thapsus-hr/<env>/mock-idp` outside prod), then force a new deployment of the services.
6. Run the migrator in each cell with the stack outputs:
   `aws ecs run-task --cluster <EcsClusterName> --task-definition <MigratorTaskDefinitionArn> --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[<MigratorSubnetIds>],securityGroups=[<MigratorSecurityGroupId>]}"`.

## Parameters (only while `domain` / certificates are not configured)

| Parameter | Stack | Meaning |
| --- | --- | --- |
| `CertificateArn` | global, cells | ACM certificate for the HTTPS listener in that region (staging: imported self-signed). Omitted when `certificateArn` is set in config. |
| `GlobalBaseUrl` | cells | Public URL of the global ALB (`https://<global AlbDnsName>`). |
| `ApiUrlUK/EU/US`, `AppUrlUK/EU/US` | global | Public URLs of each cell ALB. |

Once `domain` is set, the global stack creates the hosted zone; put its id in `hostedZoneId` and
the cells add `app.<cell>.<domain>` / `api.<cell>.<domain>` records.

## Notes

- The `cell` cost-allocation tag must be activated in Billing for the budgets to filter correctly.
- The logs bucket uses SSE-S3 because S3 server access logging and ALB access logs do not support
  SSE-KMS targets; it holds request metadata only. All other data is SSE-KMS.
