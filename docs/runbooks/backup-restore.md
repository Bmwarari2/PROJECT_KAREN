# Runbook: backup restore (and the restore drill)

**Targets (brief §3):** RPO ≤ 15 minutes, RTO ≤ 4 hours, per cell.

**What protects each store:**

| Store                              | Protection                                                                                          | Where copies live                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Aurora PostgreSQL                  | Continuous backup (point-in-time restore, 5-minute granularity) plus daily snapshots via AWS Backup | The cell's own region. Copies: EU → eu-west-1, US → us-west-1, UK → none, London only across AZs (ADR-0001). |
| S3 files bucket                    | Versioning (noncurrent versions kept 30–90 days) plus AWS Backup                                    | Same as above                                                                                                |
| DynamoDB tenant directory (global) | Point-in-time recovery                                                                              | eu-west-2                                                                                                    |
| Valkey                             | Cache, rate limits and sessions only. Not backed up: sessions are re-created at sign-in.            | —                                                                                                            |

Backups never leave the tenant's jurisdiction. A restore is always performed in the home region, or for EU and US only, in the permitted backup region if the home region is down.

## 1. Find a recovery point

```sh
aws backup list-recovery-points-by-backup-vault --region <cell-region> --backup-vault-name thapsus-hr-<env>-<cell> \
  --query 'RecoveryPoints[].{arn:RecoveryPointArn,type:ResourceType,at:CreationDate,status:Status}'
```

For Aurora point-in-time restore, any second within the retention window is valid. `aws rds describe-db-clusters` shows `EarliestRestorableTime` and `LatestRestorableTime`.

## 2. Restore Aurora (whole cell)

1. Declare an incident (`incident-and-breach-response.md`). Stop the writers:
   - scale `…-worker` to 0;
   - put the ALB maintenance rule in front of `/v1/*`, or scale `…-api` to 0.
2. Restore to a NEW cluster at the chosen time:
   ```sh
   aws rds restore-db-cluster-to-point-in-time --region <r> --source-db-cluster-identifier thapsus-hr-<env>-<cell> \
     --db-cluster-identifier thapsus-hr-<env>-<cell>-restore-<yyyymmddhhmm> --restore-to-time <ISO-8601> \
     --use-latest-restorable-time=false --kms-key-id <DataKeyArn> --db-subnet-group-name <cluster subnet group> --vpc-security-group-ids <db sg>
   aws rds create-db-instance --region <r> --db-cluster-identifier …-restore-… --db-instance-identifier …-restore-…-writer \
     --engine aurora-postgresql --db-instance-class db.serverless
   ```
3. Validate the restored cluster (connect as the owner role through a bastion ECS task):
   - Run `SELECT audit.verify_chain(tenant_id)` for a sample of tenants. It must report the chain intact up to the restore point.
   - Check row counts and the most recent `audit.events.at`. The gap to the incident time is the actual RPO.
4. Switch over by pointing RDS Proxy's target at the restored cluster, or swap the cluster identifiers. Then redeploy the cell (`deploy.md`) so the migrator runs against it.
5. Bring the api back, then the worker. Run `pnpm smoke:staging --regions <cell>` in staging. In production, do read-only checks.
6. Keep the old cluster, with deletion protection on, until the review is done. Deleting it needs the owner's approval.

### One tenant only

Do not roll back the whole cell for one tenant:

1. Restore to a new cluster, as above.
2. Use `packages/db` move-tenant tooling in read-only export mode against the restored cluster to extract that tenant's rows.
3. Have the customer, as controller, confirm the scope.
4. Re-import into the live cluster within that tenant's RLS context.
5. Record every step in the tenant's audit log.

## 3. Restore files (S3)

- **A single object:** restore a noncurrent version.
  ```sh
  aws s3api list-object-versions --bucket <FilesBucketName> --prefix <tenant>/…
  aws s3api copy-object --copy-source <bucket>/<key>?versionId=<v> --bucket <bucket> --key <key>
  ```
- **A larger restore:** start an AWS Backup restore job for the bucket's recovery point into a new bucket, then copy the tenant prefix back.

## 4. Restore the tenant directory (global)

```sh
aws dynamodb restore-table-to-point-in-time --region eu-west-2 \
  --source-table-name thapsus-hr-<env>-tenant-directory --target-table-name thapsus-hr-<env>-tenant-directory-restore --restore-date-time <ISO>
```

Then point the global stack's `DIRECTORY_TABLE` at the restored table and redeploy global. The directory holds no personal data.

## 5. Drill: quarterly, and before launch (PROGRESS 12.8)

1. In staging, write a marker:
   - create a fictional tenant `drill-<date>`;
   - add 3 employees;
   - note the time T0.
2. Wait 10 minutes, then add 2 more employees (T1).
3. Restore Aurora to T0 + 5 minutes into a new cluster (§2), timing every step.
4. **Pass criteria:**
   - the restored cluster has the 3 employees and not the 2;
   - the audit chain is intact;
   - total time from "declare" to "serving from the restored cluster" ≤ 4 h (RTO);
   - restore point to T0 ≤ 15 min (RPO).
5. Record the date, the timings, the RPO and RTO achieved, and any issues in `docs/PERFORMANCE.md → Resilience drills`.
6. Delete the drill cluster afterwards. Staging only; never delete production resources without approval.
