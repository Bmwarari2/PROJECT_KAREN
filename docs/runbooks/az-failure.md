# Runbook: availability-zone failure (and the AZ drill)

Every cell spans three availability zones:

- the VPC has subnets in 3 AZs;
- Aurora has a writer plus a reader in a different AZ, and fails over automatically;
- Valkey is Multi-AZ with automatic failover;
- ECS services spread their tasks across AZs;
- the ALB is in all AZs.

Losing one AZ should cost at most a short Aurora failover, under 60 s, and the in-flight requests at that moment.

## 1. During a real AZ event

1. Watch CloudWatch:
   - ALB `HTTPCode_Target_5XX_Count` and `HealthyHostCount` per AZ;
   - the RDS `FailoverEvent` events;
   - ECS service events.
2. Usually nothing needs doing: RDS Proxy reconnects to the new writer, and ECS replaces tasks in the healthy AZs.
3. If tasks stay pending because of capacity, raise the service's `maxCapacity` temporarily (`aws application-autoscaling register-scalable-target`) and follow up in config.
4. If the NAT gateway was in the failed AZ (staging has one NAT gateway, production has three), outbound calls from the private subnets fail:
   - email, webhooks and web push queue up and retry (idempotent jobs, ADR-0006);
   - nothing is lost.
5. Log the event and its impact in the incident log.

## 2. Drill (staging, before launch and twice a year; PROGRESS 12.8)

1. Start a steady background load against staging:
   ```sh
   pnpm loadtest --target <staging cell URL> --profile smoke --insecure-tls
   ```
   Or run a k6 run at about 50 VUs.
2. **Force an Aurora failover:**
   ```sh
   aws rds failover-db-cluster --region <r> --db-cluster-identifier thapsus-hr-staging-<cell>
   ```
   Note the time the error rate rises and the time the writer is available again.
3. **Valkey failover:**
   ```sh
   aws elasticache test-failover --region <r> --replication-group-id thapsus-hr-staging-<cell> --node-group-id 0001
   ```
4. **ECS task loss in one AZ:** stop every task in one AZ.
   ```sh
   aws ecs list-tasks …
   aws ecs stop-task …
   ```
   Confirm replacements start in the other AZs and that the ALB keeps serving.
5. **Pass criteria:**
   - k6 failed requests < 1 % over the drill window;
   - no data loss: the audit chain verifies afterwards, and clock events sent during the drill are present exactly once (idempotent sync);
   - recovery of each component under 2 minutes.
6. Record the results in `docs/PERFORMANCE.md → Resilience drills`.
