# infra — AWS CDK for Thapsus-HR

Stacks per environment (`dev`, `staging`, `prod`; settings in `config/<env>.json`):

| Stack                            | Region                    | Contents                                                                                                                                                                              |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ThapsusHr-<env>-global`         | eu-west-2                 | Tenant directory (DynamoDB, no personal data), global sign-in API + marketing web on Fargate behind ALB + WAF, Route 53 zone (only when `domain` is set), Stripe/billing placeholders |
| `ThapsusHr-<env>-cell-uk`        | eu-west-2                 | Regional cell (below)                                                                                                                                                                 |
| `ThapsusHr-<env>-cell-eu`        | eu-central-1              | Regional cell                                                                                                                                                                         |
| `ThapsusHr-<env>-cell-us`        | us-east-2                 | Regional cell                                                                                                                                                                         |
| `ThapsusHr-<env>-backup-copy-eu` | eu-west-1                 | Backup copy vault for the EU cell                                                                                                                                                     |
| `ThapsusHr-<env>-backup-copy-us` | us-west-1                 | Backup copy vault for the US cell                                                                                                                                                     |
| `ThapsusHr-<env>-ci`             | eu-west-2 (IAM is global) | GitHub OIDC provider + one deploy role per region (`thapsus-hr-<env>-deploy-<region>`), assumable only by this repository's matching GitHub environment                               |

The UK cell has no backup copy (London only). No stack ever targets us-east-1 or us-west-2, and
there is no CloudFront (ADR-0001). The region map comes from `packages/core/src/regions.ts`.

A cell holds: VPC (3 AZs, flow logs), KMS `data` + `vault` keys, Aurora PostgreSQL 17 Serverless v2
(writer + reporting reader, RDS Proxy with TLS), Valkey (Multi-AZ, TLS, KMS), S3 files + logs buckets,
SQS `jobs`/`webhooks` (+ DLQs), EventBridge bus + Scheduler group, SES configuration set, ECS
Fargate `api`/`worker`/`web` + a `migrator` task definition, ALB + WAF, AWS Backup (continuous +
daily), CloudWatch alarms → SNS, and a monthly AWS Budget filtered by the `cell` tag.

Optional `dedicatedDatabases: [{ "key", "cell", "minAcu"?, "maxAcu"? }]` in `config/<env>.json` adds,
per entry and only in that cell, an Aurora cluster + RDS Proxy built like the shared one, a
`<prefix>-db-<key>` tools task (migrate by default; `node dist/move-tenant.mjs --process-requests` as a
command override) and `DEDICATED_DATABASE_HOSTS` / `DEDICATED_READER_HOSTS` on the api and worker. The
committed configs have none: each entry is recurring cost (docs/COSTS.md, ADR-0068, runbook
docs/runbooks/move-tenant-to-dedicated-db.md).

## Commands

```sh
pnpm --filter @thapsus/infra synth                 # all environments
pnpm --filter @thapsus/infra cdk synth -c env=staging --quiet
pnpm exec vitest run --project unit infra          # assertions (from the repo root)
npx tsc --noEmit -p infra                          # typecheck
```

Synth does not build images; deploy builds `apps/{api,worker,web}/Dockerfile` with the repo root as
the context (linux/amd64).

## Deploy (per environment — production deploys need explicit approval)

`scripts/deploy.mjs` runs every step below; `--dry-run` prints the plan without touching AWS.

```sh
node --import tsx scripts/deploy.mjs --env staging --only all --dry-run       # the whole plan
node --import tsx scripts/deploy.mjs --env staging --only cell-uk             # one target (credentials for eu-west-2)
node --import tsx scripts/deploy.mjs --env prod --only global --approved       # production: only after approval
```

Targets in dependency order: `ci` → `backupcopy` (for the current AWS region: eu-west-1 or us-west-1) → `global` → `cell-uk` → `cell-eu` → `cell-us`. For each cell the script:

1. Runs `cdk deploy`.
2. Copies the global `thapsus-hr/<env>/internal-token` value into the cell's own `thapsus-hr/<env>/<cell>/internal-token`. The names differ because the UK cell shares eu-west-2 with the global stack.
3. Generates VAPID keys and, outside production only, the mock IdP signing key and certificate, if the secrets are still empty.
4. Runs the migrator task, then the tools task of each dedicated database of the cell, and fails if any exits non-zero.
5. Restarts the services.
6. Waits for `/health`.

Pass CloudFormation parameters with `--param Key=Value`, or with `DEPLOY_PARAMS=Key=Value,...` in CI. Add `--self-signed-tls` only for staging without a domain.

**One-time setup** (HUMAN_TODO 1.5):

1. Run `cdk bootstrap` in eu-west-2, eu-central-1, us-east-2, eu-west-1 and us-west-1 only.
2. Deploy `ThapsusHr-<env>-ci` once from a workstation.
3. Set the GitHub variables `AWS_ACCOUNT_<env>` and create the `staging` and `production` environments.

After that, `.github/workflows/deploy.yml` deploys staging from `main`, using OIDC and the per-region roles.

## Parameters (only while `domain` / certificates are not configured)

| Parameter                          | Stack         | Meaning                                                                                                                                |
| ---------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `CertificateArn`                   | global, cells | ACM certificate for the HTTPS listener in that region (staging: imported self-signed). Omitted when `certificateArn` is set in config. |
| `GlobalBaseUrl`                    | cells         | Public URL of the global ALB (`https://<global AlbDnsName>`).                                                                          |
| `ApiUrlUK/EU/US`, `AppUrlUK/EU/US` | global        | Public URLs of each cell ALB.                                                                                                          |

Once `domain` is set, the global stack creates the hosted zone; put its id in `hostedZoneId` and
the cells add `app.<cell>.<domain>` / `api.<cell>.<domain>` records.

## Notes

- The `cell` cost-allocation tag must be activated in Billing for the budgets to filter correctly.
- The logs bucket uses SSE-S3 because S3 server access logging and ALB access logs do not support
  SSE-KMS targets; it holds request metadata only. All other data is SSE-KMS.
