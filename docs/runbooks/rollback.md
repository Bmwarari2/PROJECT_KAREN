# Runbook: rollback

Rolling back application code is safe at any time because migrations are expand-only (`deploy.md` §4): the previous release works against the current schema. Never "roll back" by restoring the database unless data itself is damaged (`backup-restore.md`).

## 1. Decide

Roll back when a release causes user-visible errors, data-integrity risk or a security regression and the fix is not minutes away. Record the decision in the incident log (`incident-response.md`).

## 2. Roll back the services (one cell or all)

Fastest path: redeploy the previous good commit. The image tags are content hashes, so the old images are still in ECR.

1. Find the last good commit on `main`, from the GitHub Actions deploy history.
2. In GitHub, go to Actions → Deploy → Run workflow and pick the last good commit's ref, or run it from a workstation:
   ```sh
   git checkout <good-sha>
   AWS_REGION=<cell-region> node --import tsx scripts/deploy.mjs --env <env> --only cell-<uk|eu|us>   # production also needs --approved
   ```
   The migrator runs, finds nothing new to apply and exits 0. The services restart on the old images.
3. Verify with `deploy.md` §5.

Emergency path, a few minutes, no CDK: point each ECS service at its previous task definition revision.
```sh
aws ecs update-service --region <region> --cluster thapsus-hr-<env>-<cell> --service thapsus-hr-<env>-<cell>-api --task-definition <family>:<previous-revision>
```
Repeat for `-worker` and `-web`, then follow up with the CDK path above, so the stack and the services agree again.

## 3. Turn a feature off instead

If only one feature misbehaves, turn it off for the affected tenants with its per-tenant feature flag (back office → tenants → flags). No deploy is needed.

## 4. Schema problems

- A migration that is wrong but harmless (for example a slow index) can stay in place. Fix it forward with a new migration.
- A migration that damaged data: stop the writers (scale the worker to 0, put the api into maintenance mode by scaling it to 0 behind the ALB's fixed-response maintenance rule), then follow `backup-restore.md` §2 to restore to just before the migration.

## 5. After a rollback

- Keep `main` deployable: revert the bad commit through a PR. Never force-push `main`.
- Write the post-incident review (`incident-response.md` §6).
