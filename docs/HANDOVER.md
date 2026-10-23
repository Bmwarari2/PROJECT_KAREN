# Handover — 2026-10-23

Everything in brief §10 except the AWS work is done and merged to `main`. What remains is the AWS phase:

- staging in three regions;
- the staging smoke runs;
- the load test;
- the two resilience drills.

The product owner hands that back to the original agent on the owner's machine. Read `CLAUDE.md`, `docs/BUILD_BRIEF.md` §10 and `docs/PROGRESS.md` first.

## What is done

- **Phases 0–11** are merged to `main` with PROGRESS.md ticked from evidence. `[h]` means done except human-only steps, which are listed in `docs/HUMAN_TODO.md`.
- **Phase 12** (`phase-12-launch`) is merged:
  - 12.2 STRIDE threat model (`docs/SECURITY.md`).
  - 12.3 OWASP ASVS 5.0 level 2 review (`docs/ASVS.md`; 47 gaps fixed with tests, 15 recorded).
  - 12.4 dependency audit, secret scan and SBOM in CI, with the process documented.
  - 12.5–12.7 accessibility audit, visual polish and Lighthouse; see PROGRESS.md for the evidence.
  - 12.10 production stacks ready to deploy on approval, and the runbooks.
- **Role management** (#16) and the **admin settings screens** are merged to `main`.
- **Brief §9 documents** are all present. `scripts/test/docs.test.ts` checks them and their links on every verify run.
- **Ready for the AWS phase, but never run against AWS:**
  - `scripts/deploy.mjs` and `scripts/deploy-plan.ts` (the plan is unit-tested).
  - `scripts/smoke-staging.mjs`, which passed end to end against a local UK cell.
  - `scripts/loadtest.mjs` with `loadtest/k6/thapsus.js`; its `smoke` profile passed locally against a 3,000-employee synthetic tenant.
- **`cdk synth`** passes for every stack of `dev`, `staging`, `prod` and `loadtest` on every verify run.
- **Nothing was deployed.** No AWS resource was created, changed or deleted, and no CDK bootstrap was run.

## What is left (AWS phase)

| PROGRESS | Work                                                                                                                          | Where it is described                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 12.9     | Deploy staging in eu-west-2, eu-central-1 and us-east-2 (global stack in eu-west-2), then `pnpm smoke:staging` in each region | `docs/runbooks/deploy.md`; steps 1–4 below                                           |
| 12.1     | `pnpm loadtest --provision` against the temporary `loadtest` environment; results into PERFORMANCE.md §3; teardown            | `docs/runbooks/load-test.md`; step 5 below                                           |
| 12.8     | Backup restore drill and AZ failure drill on staging; results into PERFORMANCE.md §4                                          | `docs/runbooks/backup-restore.md` §5, `docs/runbooks/az-failure.md` §2; step 6 below |
| §10      | Tick 12.1, 12.8, 12.9, Phase 12 and the remaining Definition of done items once the runs pass                                 | `docs/PROGRESS.md`                                                                   |

**Rules that still apply:**

- **Regions:** approved regions are eu-west-2, eu-central-1, us-east-2, eu-west-1 and us-west-1. Never us-east-1 or us-west-2; the planner refuses them.
- **Ask the owner first** before:
  - any production deploy;
  - any deletion of cloud resources or data;
  - any cost beyond `docs/COSTS.md`. The load-test environment is a cost, so it needs the owner's go-ahead too.
- **Credentials:** short-lived SSO or role sessions only; there are no AWS keys.

### Exact commands

Run everything from the repository root on `main`, with Node ≥ 24, pnpm 12.14 and Docker. Every AWS command uses a short-lived SSO session (`aws sso login`).

**0. Prove the tree.**

```sh
pnpm install --frozen-lockfile
pnpm verify                      # every step must PASS
```

**1. One-time account setup** (HUMAN_TODO 1.4 and 1.5; skip anything already done).

```sh
for r in eu-west-2 eu-central-1 us-east-2 eu-west-1 us-west-1; do
  pnpm --filter @thapsus/infra exec cdk bootstrap aws://<account>/$r   # add --cloudformation-execution-policies <scoped policy arn> (HUMAN_TODO 1.5 step 1)
done
AWS_REGION=eu-west-2 node --import tsx scripts/deploy.mjs --env staging --only ci
```

Then set the GitHub variables and environments as in HUMAN_TODO 1.5 steps 3 and 4.

**2. Certificates while there is no domain** (HUMAN_TODO 2.1). Import one self-signed certificate into each region that serves an ALB.

```sh
mkdir -p .deploy   # git-ignored
openssl req -x509 -newkey rsa:2048 -nodes -days 90 -subj "/CN=thapsus-hr-staging" \
  -keyout .deploy/staging.key -out .deploy/staging.crt
for r in eu-west-2 eu-central-1 us-east-2; do
  aws acm import-certificate --region $r --certificate fileb://.deploy/staging.crt --private-key fileb://.deploy/staging.key
done   # note the three CertificateArn values
```

**3. Deploy staging.** Print the plan first, then deploy one target at a time with credentials for that target's region. The global stack needs the cell URLs and the cells need the global URL, so the global stack is deployed twice.

```sh
node --import tsx scripts/deploy.mjs --env staging --only all --dry-run     # prints every step, touches nothing

AWS_REGION=eu-west-1 node --import tsx scripts/deploy.mjs --env staging --only backupcopy   # EU backup copy vault
AWS_REGION=us-west-1 node --import tsx scripts/deploy.mjs --env staging --only backupcopy   # US backup copy vault
AWS_REGION=eu-west-2 node --import tsx scripts/deploy.mjs --env staging --only global --param CertificateArn=<eu-west-2 arn> --self-signed-tls
GLOBAL=https://<AlbDnsName from .deploy/ThapsusHr-staging-global.json>
AWS_REGION=eu-west-2    node --import tsx scripts/deploy.mjs --env staging --only cell-uk --param CertificateArn=<eu-west-2 arn>    --param GlobalBaseUrl=$GLOBAL --self-signed-tls
AWS_REGION=eu-central-1 node --import tsx scripts/deploy.mjs --env staging --only cell-eu --param CertificateArn=<eu-central-1 arn> --param GlobalBaseUrl=$GLOBAL --self-signed-tls
AWS_REGION=us-east-2    node --import tsx scripts/deploy.mjs --env staging --only cell-us --param CertificateArn=<us-east-2 arn>    --param GlobalBaseUrl=$GLOBAL --self-signed-tls
# global again, with each cell's public URL (https://<AlbDnsName> from .deploy/ThapsusHr-staging-cell-<cell>.json)
AWS_REGION=eu-west-2 node --import tsx scripts/deploy.mjs --env staging --only global --param CertificateArn=<eu-west-2 arn> \
  --param ApiUrlUK=<uk> --param AppUrlUK=<uk> --param ApiUrlEU=<eu> --param AppUrlEU=<eu> \
  --param ApiUrlUS=<us> --param AppUrlUS=<us> --self-signed-tls
```

Each cell target:

- deploys the stack and copies the internal token;
- fills the VAPID and mock IdP keys;
- runs the migrator for every database of the cell;
- restarts the services and waits for `/health`.

Once a manual deploy works, put the same parameters into the `DEPLOY_PARAMS_*` variables and set `AUTO_DEPLOY_STAGING=true` (HUMAN_TODO 1.5 step 5).

**4. Staging smoke** (12.9). It reads the URLs from the `.deploy/` outputs, or from `SMOKE_GLOBAL_URL` and `SMOKE_API_URL_UK/EU/US`.

```sh
pnpm smoke:staging --insecure-tls                   # all three regions
pnpm smoke:staging --regions eu --insecure-tls      # one region
```

In each region it:

- signs up a fictional tenant and checks its home region;
- signs in through the staging mock IdP;
- adds an employee, requests leave, clocks in and exports data;
- schedules the tenant's closure.

Record the pass for each region in PROGRESS 12.9.

**5. Load test** (12.1). Run it only with the owner's go-ahead; it costs about $15–40 per run. Use a load generator with at least 8 vCPU and 16 GB RAM, ideally an EC2 instance in eu-west-2.

```sh
pnpm loadtest --provision --insecure-tls --record \
  --param CertificateArn=<eu-west-2 arn> --param GlobalBaseUrl=https://<placeholder>
# it asks before teardown; with --keep the environment stays up until: pnpm loadtest --teardown-only
```

The run:

1. provisions `ThapsusHr-loadtest-global` and `ThapsusHr-loadtest-cell-uk`;
2. generates the 200,000-employee / 50-entity tenant in-region;
3. runs the three scenarios, whose thresholds are the §3 targets;
4. appends the results to PERFORMANCE.md §3;
5. deletes the environment.

Confirm in CloudFormation that both stacks are gone. Then run `pnpm format`, because `--record` appends unformatted tables to PERFORMANCE.md.

**6. Resilience drills** (12.8, staging only).

1. Follow `docs/runbooks/backup-restore.md` §5 and `docs/runbooks/az-failure.md` §2.
2. Fill PERFORMANCE.md §4.
3. Delete the drill's restored cluster afterwards.

**7. Close out.**

1. Tick 12.1, 12.8 and 12.9 in PROGRESS.md with their evidence.
2. Set Phase 12 to `[x]` and tick the remaining Definition of done items.
3. Run `pnpm verify`.
4. Open a pull request from a `phase-12-aws` branch and merge it.

Production is not part of this phase. It waits for the owner's approval (`docs/runbooks/deploy.md` §2).

## Next UI review

The product owner asked for these references to be looked at in the next UI review:

- <https://easyui.site/>, saved on 2026-10-23. It is an open-source collection of React components, including an interactive area chart, a lock input, animated dropdowns and menus, pill navigation, an unfolding accordion and toggles. Before adopting anything from it:
  - check its licence in the linked GitHub repository, because the site does not state one;
  - rebuild what is adopted from the `docs/DESIGN.md` tokens and the `packages/ui` components, not copy its styles;
  - keep WCAG 2.2 AA and `prefers-reduced-motion` support.

## Conventions that bite

- **Route handlers:**
  - Run DB work in `app.tenantTx(req, fn, {readOnly?})`.
  - Write audit entries with `app.audit(tx, req, {...})`.
  - Routes that write their own audit set `config: { selfAudited: true }` and `req.auditWritten = true`.
  - Check access with `requireAuth` / `authorize` / `can`.
  - Every permission key must be in the access catalogue (`@thapsus/core/access`).
- **Tables:**
  - Every new table calls `app.enable_tenant_rls(...)`.
  - Every person column is mapped in the privacy subject map.
  - Every table is classified for sandboxes.
  - The isolation, privacy-coverage and sandbox suites fail otherwise.
- **SECURITY DEFINER functions** must be on the allowlist in `packages/db/test/rls.isolation.test.ts`.
- **Rules** come only from `@thapsus/rules` (`book.resolve` / `tryResolve`), each value with its source URL. Bump a pack's manifest version when its content changes.
- **i18n:**
  - Every string goes in both `en-GB.json` and `en-US.json`.
  - Routes load only their namespaces through `<Messages ns>` (ADR-0150).
  - Counts next to nouns use plural families (ADR-0151).
- **Time** goes through `@thapsus/core/time` only. **Money** is integer minor units plus an ISO 4217 code.
- **Generated files** are regenerated, never edited by hand:
  - OpenAPI document: `pnpm --filter @thapsus/api openapi`
  - SDK types: `pnpm --filter @thapsus/sdk generate`
- **Visual baselines** come from the Playwright container (ADR-0009): `UPDATE_SNAPSHOTS=all node scripts/visual.mjs` regenerates them, and `UPDATE_SNAPSHOTS=1` adds only missing ones. Narrow a run with `VISUAL_PROJECTS=visual-phone-light,...`.
- **Parallel worktrees** each need their own ports (`E2E_WEB_PORT`, `E2E_API_PORT`, `LIGHTHOUSE_WEB_PORT`, `LIGHTHOUSE_API_PORT`) and their own Postgres (`TEST_PG_OWNER_URL`).
