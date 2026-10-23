# Runbook: deploy

Applies to `dev`, `staging` and `prod` (and the temporary `loadtest` environment; see `load-test.md`). Every command runs from the repository root. AWS access is always a short-lived role session (GitHub OIDC in CI, or an SSO session on a workstation); there are no AWS keys.

**Production rule:** nobody deploys production without the product owner's explicit approval. In GitHub the `production` environment enforces it with required reviewers. `scripts/deploy.mjs` refuses `--env prod` without `--approved`, or without the `production` GitHub environment.

## 1. One-time setup per environment (owner)

Follow HUMAN_TODO 1.5:

1. `cdk bootstrap` in the five allowed regions only: eu-west-2, eu-central-1, us-east-2, eu-west-1 and us-west-1.
2. Deploy `ThapsusHr-<env>-ci` from a workstation.
3. Set the GitHub variables `AWS_ACCOUNT_<env>` and `DEPLOY_PARAMS_*`.
4. Create the `staging` and `production` GitHub environments.

Never deploy anything to us-east-1 or us-west-2 (ADR-0001). The planner refuses those regions.

## 2. Normal path: GitHub Actions

1. Merge a pull request to `main`. CI (`pnpm verify`) runs on the merge commit.
2. When CI is green and `AUTO_DEPLOY_STAGING=true`, the Deploy workflow deploys staging in order:
   1. the backup-copy vaults (eu-west-1, us-west-1);
   2. global (eu-west-2);
   3. the UK cell (eu-west-2);
   4. the EU cell (eu-central-1);
   5. the US cell (us-east-2).
      The matrix runs one target at a time. Each one uses the deploy role of its own region.
3. **Production:** Actions → Deploy → Run workflow → `environment: prod`. Approve the run in the `production` environment. The same targets deploy in the same order.

## 3. From a workstation

```sh
# plan only — prints every command, touches nothing
node --import tsx scripts/deploy.mjs --env staging --only all --dry-run

# one target; the credentials must be for that target's region
AWS_REGION=eu-central-1 node --import tsx scripts/deploy.mjs --env staging --only cell-eu \
  --param CertificateArn=arn:aws:acm:eu-central-1:<acct>:certificate/<id> --param GlobalBaseUrl=https://<global-alb> --self-signed-tls
```

For each cell, `deploy.mjs` runs these steps:

1. `cdk deploy`
2. copy the internal token from global
3. fill the VAPID keys and, in dev and staging only, the mock IdP keys, if they are empty
4. run the migrator task (stops if it exits non-zero)
5. force a new deployment of the api, worker and web services
6. wait for them to be stable
7. `GET /health`

Stack outputs are written to `.deploy/<stack>.json` (git-ignored).

## 4. Database migrations (expand and contract)

- Migrations run before new code serves traffic, in step 4 above. They must be expand-only, so the previous release keeps working against the new schema. That is what makes rollback safe (`rollback.md`).
- Destructive changes (`DROP`, `ALTER … TYPE`, `NOT NULL` on existing columns) need a `-- contract:` header. They go in a later release, after no deployed code uses the old shape. The migration lint in verify enforces this.

## 5. Verify a deploy

1. `GET https://<cell>/health` returns `{ ok: true, region, role, bootId }`. The `bootId` changes after a restart.
2. Run `pnpm smoke:staging`, or `--regions uk` for one region. Pass `--insecure-tls` until staging has a trusted certificate.
3. CloudWatch: the alarms are all OK, the ECS deployment shows no task restarts, and no 5xx spike shows up on the ALB.
4. In production, do not use a smoke tenant. Check health, alarms and one read-only sign-in by the owner.

## 6. When a deploy fails

| Symptom                             | Action                                                                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cdk deploy` fails                  | CloudFormation rolls back by itself. Read the stack events, fix the cause and redeploy. Nothing else changed.                                                                                                               |
| Migrator exits non-zero             | The new task definition is not serving traffic yet; the services still run the previous image. Fix the migration and redeploy. If a partial migration needs undoing, follow `backup-restore.md` §2 (PITR) in staging first. |
| Services unstable after the restart | ECS deployment circuit breaker rolls back automatically; otherwise follow `rollback.md`.                                                                                                                                    |
| Health check fails                  | Look at the service logs (`/thapsus-hr/<env>/<cell>/api`) and roll back if users are affected.                                                                                                                              |
