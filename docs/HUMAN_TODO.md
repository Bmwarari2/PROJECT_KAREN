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
- [ ] 1.5 **GitHub → AWS deploy roles (OIDC), once per environment account.** There are no AWS keys anywhere; GitHub assumes one role per region.
  1. Bootstrap CDK with a scoped execution policy instead of the default AdministratorAccess. In each of eu-west-2, eu-central-1, us-east-2, eu-west-1 and us-west-1:
     `pnpm --filter @thapsus/infra exec cdk bootstrap aws://<account>/<region> --cloudformation-execution-policies <arn of a policy limited to the services in docs/ARCHITECTURE.md>`.
     The default (AdministratorAccess) also works, but it is broader than needed.
  2. From a workstation, with an administrator SSO session, run:
     `pnpm --filter @thapsus/infra exec cdk deploy ThapsusHr-<env>-ci -c env=<env>`.
     It creates the GitHub OIDC provider and the roles `thapsus-hr-<env>-deploy-<region>`. A role can only be assumed by `repo:Bmwarari2/PROJECT_KAREN:environment:<staging|production>`, and only reaches its own region's CDK bootstrap roles.
     If two environments share one AWS account, deploy the first one, then put its printed `GitHubOidcProviderArn` into the other environment's `infra/config/<env>.json → ci.oidcProviderArn` before deploying that one (one provider per account).
  3. In GitHub → Settings → Secrets and variables → Actions → Variables:
     - add `AWS_ACCOUNT_staging` (and later `AWS_ACCOUNT_prod`) with the account id;
     - optionally add `STAGING_SELF_SIGNED_TLS=true` while staging has no domain;
     - add `DEPLOY_PARAMS_GLOBAL`, `DEPLOY_PARAMS_CELL_UK`, `DEPLOY_PARAMS_CELL_EU` and `DEPLOY_PARAMS_CELL_US` with the CloudFormation parameters, e.g. `CertificateArn=arn:aws:acm:...,GlobalBaseUrl=https://...`. See `infra/README.md → Parameters`.
  4. In GitHub → Settings → Environments, create `staging` and `production`. Give `production` required reviewers (you) so every production deploy needs manual approval.
  5. When the first manual staging deploy has worked, set the repository variable `AUTO_DEPLOY_STAGING=true`. From then on every green CI run on `main` deploys staging. Until then the Deploy workflow only runs when started by hand (`workflow_dispatch`).
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
