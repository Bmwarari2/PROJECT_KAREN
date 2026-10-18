# Human-only steps

Things only a person with the right accounts or authority can do. The build runs against mocks or test mode until each is done. Steps are exact and numbered; tick them off here.

## 1. AWS organisation and regions

- [x] 1.1 Relax SCP `p-muwhpaps` so the staging account can use eu-west-2, eu-central-1, us-east-2, eu-west-1 and us-west-1. (Done by the product owner on 2026-10-18.)
- [ ] 1.2 **CloudFront in front of the marketing site (optional).** CloudFront needs its ACM certificate in **us-east-1**, which the SCP reserves for global services. Deploying stacks there is not allowed (ADR-0001), so to put the public marketing site behind CloudFront:
  1. Sign in to the management account (or ask whoever owns SCP `p-muwhpaps`) and decide whether to allow `acm:RequestCertificate`, `acm:DescribeCertificate` and `acm:DeleteCertificate` in us-east-1 for the staging and production accounts.
  2. If allowed: in the AWS console, region **N. Virginia (us-east-1)**, open ACM → Request certificate → public → `www.<domain>` and `<domain>` → DNS validation → create the records in Route 53.
  3. Copy the certificate ARN into `infra/config/<env>.json` as `marketingCloudFrontCertArn` and redeploy the global stack. Until then the marketing site is served by the eu-west-2 regional ALB (no CDN). Authenticated app and API hosts never use a CDN in either case.
- [ ] 1.3 **CloudFront-scoped WAF.** Same constraint as 1.2: a WAF web ACL for CloudFront must be created in us-east-1. It is only needed if 1.2 is done. Regional ALBs already have regional WAF web ACLs.
- [ ] 1.4 **Activate the `cell` cost-allocation tag** so the per-cell AWS Budgets filters work: Billing console → Cost allocation tags → find `cell` (user-defined) → Activate. It takes up to 24 hours to apply.
- [ ] 1.5 **GitHub → AWS deploy roles (OIDC).** For each environment account:
  1. Deploy the CI stack once from a workstation: `pnpm --filter @thapsus/infra cdk deploy ThapsusHr-<env>-ci -c env=<env>`. It creates the GitHub OIDC provider and the deploy role, limited to `repo:Bmwarari2/PROJECT_KAREN`.
  2. In GitHub → Settings → Secrets and variables → Actions → Variables, add `AWS_DEPLOY_ROLE_staging` (and later `AWS_DEPLOY_ROLE_prod`) with the role ARN printed by the stack.
  3. In GitHub → Settings → Environments, create `staging` and `production`. Give `production` required reviewers (you) so production deploys need manual approval.
- [ ] 1.6 **Separate AWS accounts per environment (recommended).** Create `hr-dev` and `hr-prod` accounts in the organisation, apply the same SCP region allow-list, add SSO access, and put their account ids in `infra/config/dev.json` and `infra/config/prod.json` (currently both use the staging account id as a placeholder).

## 2. Domain, TLS and email

- [ ] 2.1 **Choose and register the product domain.** Set `THAPSUS_HR_DOMAIN` (infra config `domain`) and add the Route 53 hosted zone id to `infra/config/<env>.json`. Until then staging uses the load balancer DNS names with an imported self-signed certificate. Browsers will warn; the smoke test accepts it explicitly.
- [ ] 2.2 **Request ACM certificates** in eu-west-2, eu-central-1 and us-east-2 for `app.<cell>.<domain>` and `api.<cell>.<domain>` (DNS validation in Route 53), plus eu-west-2 for the apex and `www`. Put the ARNs in `infra/config/<env>.json → certificateArns`.
- [ ] 2.3 **Amazon SES production access** in each cell region (eu-west-2, eu-central-1, us-east-2):
  1. SES console → Identities → verify the domain (DKIM CNAME records in Route 53) and set a custom MAIL FROM subdomain.
  2. Account dashboard → Request production access. Use case: transactional HR notifications only (sign-in links, approvals, reminders). Expected volume: a few thousand a day.
  3. Set `MAIL_FROM` (for example `no-reply@<domain>`) in the cell config.
- [ ] 2.4 Publish SPF, DMARC (`p=quarantine`) and the DKIM records for the domain.

## 3. Legal review (all drafts are marked "for legal review")

- [ ] 3.1 Review every jurisdiction pack value (`packages/rules/packs/**`, reviewer `research-agent (pending legal review)`), especially:
  - the UK Employment Rights Act 2025 commencement items (SSP from 6 April 2026; unfair dismissal 6 months from 1 January 2027, applied by effective date of termination);
  - the status of the vacated 2024 US exempt salary rule;
  - the EU Pay Transparency transposition statuses;
  - Massachusetts values that could only be confirmed through search results.
  
  Replace the reviewer field via a back-office rule version when confirmed.
- [ ] 3.2 Fill the coverage gaps listed in `docs/COVERAGE.md` (for example Romania and Lithuania holidays and leave, Cyprus holidays, German state holidays, Italian sick pay). Their official portals block automated fetching, so a person must check them manually.
- [ ] 3.3 Review the DPA, privacy notice templates, DPIA template, records of processing, sub-processor notice period and retention defaults in `docs/legal/`.

## 4. Payments, partners and integrations

- [ ] 4.1 **Stripe:** create the account and enable Stripe Billing and Stripe Tax (UK VAT, EU OSS, US sales tax registrations as advised). Put the test-mode keys in Secrets Manager `thapsus-hr/<env>/stripe`. Switch to live mode only after approval.
- [ ] 4.2 **Microsoft Entra app registration** (multi-tenant) for joiner/leaver automation. Application permissions `User.ReadWrite.All`, `Group.ReadWrite.All`, `Directory.Read.All`; per-customer admin consent. Put the client id and secret in Secrets Manager `thapsus-hr/<env>/m365`.
- [ ] 4.3 **Google Cloud project + OAuth client** for Workspace Admin SDK (domain-wide delegation scopes `admin.directory.user`, `admin.directory.group`). Customers grant consent per domain. Credentials go in `thapsus-hr/<env>/google`.
- [ ] 4.4 **Payroll partner programmes** (stubs exist in code; real access needs agreements): Xero (Xero App Partner, Payroll UK API scopes); ADP Marketplace partner; Workday (Workday Partner Network / customer-sponsored integration system user); UKG partner; Gusto embedded partner; DATEV Marktplatz partner. Record credentials in Secrets Manager `thapsus-hr/<env>/payroll-<partner>`.

## 5. Accounts and access for staff

- [ ] 5.1 Create the first Thapsus back-office super admin in each cell: `pnpm --filter @thapsus/api exec tsx src/cli/create-staff.ts <email> "<name>" super_admin`. Store the printed one-time password and TOTP secret in a password manager.

## 6. Enterprise platform (Phase 9)

- [ ] 6.1 **Outbound egress for webhooks and audit streams.** Customer destinations are called from the cell's worker tasks, which need internet egress (NAT gateways, already in the cell config).
  1. If you publish a list of egress IPs for customers' allow-lists, allocate Elastic IPs for the NAT gateways in each cell: eu-west-2, eu-central-1, us-east-2.
  2. Record them on the trust page.
- [ ] 6.2 **IAM for S3 audit streaming.** Grant the cell worker task role `sts:AssumeRole` on `arn:aws:iam::*:role/*` with the condition `sts:ExternalId` present (`StringLike: thapsus-*`). Review this against your least-privilege policy before production.
  1. Publish the customer trust-policy template in the admin guide. Principal = the cell task role ARN; condition `sts:ExternalId` = the value shown when the stream is created.
- [ ] 6.3 **Publish the SDK** (optional). Create the `@thapsus` organisation on npmjs.com and add an automation token to GitHub Actions secrets (`NPM_TOKEN`).
  1. Remove `"private"` handling from `packages/sdk/package.json` (it has none today) and add a publish job.
  2. Until then, customers use the OpenAPI document at `/openapi.json`.
- [ ] 6.4 **Plan → rate-limit mapping.** Confirm the per-plan API limits in `apps/api/src/modules/platform/config.ts`: trial 120, starter 300, growth 600, enterprise 3,000 requests a minute. Change them per environment with `API_PLATFORM_CONFIG`. Phase 10 billing will write the tenant's plan.
- [ ] 6.5 **Legal review:**
  - the sandbox data classification (`apps/api/src/modules/platform/sandbox-tables.ts`), which confirms that no personal data is copied;
  - the wording that customer-configured destinations are not sub-processors (`docs/SUBPROCESSORS.md`).

## 7. Ask HR assistant (Phase 11)

Ask HR is off by default and can only be enabled in the UK cell (ADR-0110). It costs nothing until it is used. Bedrock is billed per token through AWS Marketplace, so ask the product owner before enabling it for customers in staging or production (CLAUDE.md, recurring cost).

- [ ] 7.1 **Enable model access in the UK cell account.** In the AWS console, region **Europe (London) eu-west-2**:
  1. Open Amazon Bedrock → Model catalog → Anthropic → **Claude Opus 5.5**.
  2. Anthropic models need a one-time use-case form per account: submit the company details and describe the use case. Suggested wording: "HR policy Q&A for employees; answers only from the customer's policy documents; no automated employment decisions".
  3. Accept the Anthropic end-user licence and AWS third-party model terms (https://aws.amazon.com/legal/bedrock/third-party-models/). The first call subscribes the account to the model in AWS Marketplace, so the principal doing this must hold `aws-marketplace:Subscribe`, `aws-marketplace:ViewSubscriptions` and `aws-marketplace:Unsubscribe` (an admin, not the task role).
  4. Do **not** enable cross-Region inference profiles. Do **not** request model access in eu-central-1 or us-east-2 for Ask HR.
- [ ] 7.2 **Keep Bedrock model invocation logging off** in eu-west-2 (Bedrock → Settings). If it is ever needed, it must log only to an S3 bucket or log group in eu-west-2 encrypted with the cell's KMS key, and SUBPROCESSORS.md and the DPIA must be updated first.
- [ ] 7.3 **Agreements and review:**
  1. Confirm that the AWS DPA and the Bedrock data-privacy terms (prompts and outputs are not used to train models or shared with the model provider) cover this use. Record the result in `docs/legal/`.
  2. Have legal review the AI disclosure wording (`askHr.disclosure` in both catalogues) against the EU AI Act transparency duty (Article 50) and UK and US guidance.
  3. Have legal confirm that refusing employment decisions keeps the feature out of the AI Act's high-risk employment uses.
  4. Add Ask HR to the DPIA and the records of processing.
  5. Send customers the 30-day sub-processor notice (SUBPROCESSORS.md) before the first customer is enabled.
- [ ] 7.4 **Live evaluation of the red-team suite against the real model** (before the first customer is enabled, and again after any model or prompt change):
  1. From a workstation with credentials for the UK cell account, after step 7.1: `AWS_PROFILE=<uk-cell-profile> node --import tsx scripts/ai-live-eval.ts --confirm-cost --out .verify/ai-live-eval.json`.
  2. Each run sends about 90 short requests of fictional text, a few US dollars at list prices.
  3. Every item must pass. For a failure, read the `raw` output in the report, then tighten the guard or the system prompt and add the prompt to `apps/api/test/fixtures/ai-red-team.json`.
  4. Keep the report with the release evidence.
- [ ] 7.5 **Re-check in-region availability every quarter** on https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html, for eu-central-1 and us-east-2 on `bedrock-runtime`. When a current Claude model appears In-Region there:
  1. Update `packages/core/src/ai-models.ts` (model id, source URL, verified-on date).
  2. Run the residency and infra tests.
  3. Update SUBPROCESSORS.md and give customers 30 days' notice.
- [ ] 7.6 **Entitle a workspace** (after 7.1–7.4): the back office, `PUT /v1/backoffice/tenants/{tenantId}/features/aiAssistant` with `{ "enabled": true }` as a super admin. The customer's owner then turns Ask HR on in Settings → Ask HR and chooses the policy folders.

