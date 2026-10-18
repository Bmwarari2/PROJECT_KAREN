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
- [ ] 3.4 Review the Phase 4 working-time rules and how they are used (ADR-0035):
  - Spain `working_time.time_recording` (Estatuto de los Trabajadores art. 34.9 via RDL 8/2019, from 12 May 2019).
  - Germany `working_time.time_recording` (BAG 13 September 2022, 1 ABR 22/21). Re-read § 3 ArbSchG on gesetze-im-internet.de, which returned HTTP 503 during research, and check whether an ArbZG amendment on recording has since come into force.
  - Whether other member states should keep resolving to the EU baseline (CJEU C-55/18) until national rules are researched.
  - The GB opt-out notice cap (WTR reg. 5(3)).
  
  Confirm by adding a back-office rule version with your name as reviewer.
- [ ] 3.5 Review the default geofence notice wording guidance and add a DPIA section for location at clock-in and out (ADR-0037). Each customer writes their own notice per country before they can enable geofencing. Check against the ICO monitoring-workers guidance and the works-council co-determination rights of EU employees (e.g. § 87(1) no. 6 BetrVG in Germany).

## 4. Payments, partners and integrations

- [ ] 4.1 **Stripe:** create the account and enable Stripe Billing and Stripe Tax (UK VAT, EU OSS, US sales tax registrations as advised). Put the test-mode keys in Secrets Manager `thapsus-hr/<env>/stripe`. Switch to live mode only after approval.
- [ ] 4.2 **Microsoft Entra app registration** (multi-tenant) for joiner/leaver automation (docs/integrations.md#microsoft-365).
  1. Entra admin centre (Thapsus tenant) → App registrations → New registration → "Thapsus-HR directory automation", supported account types "Accounts in any organisational directory (multitenant)".
  2. Redirect URI (Web): `https://app.<cell>.<domain>/v1/integrations/it/microsoft365/consent-callback` for each cell (uk, eu, us).
  3. API permissions → Microsoft Graph → **Application** permissions, exactly: `User.Create`, `User.Read.All`, `User.EnableDisableAccount.All`, `User.RevokeSessions.All`, `LicenseAssignment.ReadWrite.All`, `GroupMember.ReadWrite.All`. Do not add `Directory.ReadWrite.All` or `User.ReadWrite.All`.
  4. Certificates & secrets → New client secret (12 months). Put the client id and secret in Secrets Manager `thapsus-hr/<env>/m365` in each cell region, exposed to the API as `MS_GRAPH_CLIENT_ID` / `MS_GRAPH_CLIENT_SECRET`.
  5. Complete Microsoft Partner Center publisher verification for the app, so customers' admins see a verified publisher on the consent screen.
  6. Customers grant consent per tenant from /app/integrations. Customers that want privileged users disabled must also assign the app an Entra role themselves; this is documented and never requested by default.
- [ ] 4.3 **Google Cloud project and service account** for Workspace Admin SDK automation (docs/integrations.md#google-workspace).
  1. Create a Google Cloud project per environment.
  2. Enable the Admin SDK API and the Enterprise License Manager API.
  3. Create a service account "thapsus-hr-directory" with no project roles, and note its OAuth client id.
  4. Customers either use their own service account (they paste its JSON key on /app/integrations), or Thapsus issues a key per customer from this project. Never reuse one key across customers.
  5. Each customer's super admin goes to Admin console → Security → API controls → Domain-wide delegation, adds the client id with exactly these scopes, and names an admin for Thapsus-HR to act as:
     - `https://www.googleapis.com/auth/admin.directory.user`
     - `https://www.googleapis.com/auth/admin.directory.user.security`
     - `https://www.googleapis.com/auth/admin.directory.group.member`
     - `https://www.googleapis.com/auth/apps.licensing`
- [ ] 4.4 **Payroll partner programmes.** Stubs exist in code (`apps/api/src/modules/payroll/connectors/stubs.ts`, docs/integrations.md). Real access needs agreements. Record every credential in Secrets Manager `thapsus-hr/<env>/payroll-<partner>`. Before switching a connector from stub to available, add it to docs/SUBPROCESSORS.md with its locations per region.
  1. **Xero** (live connector; needs the app registration):
     - developer.xero.com → My Apps → New app ("Web app").
     - Redirect URI `https://app.uk.<domain>/v1/payroll/xero/callback`.
     - Request the Payroll UK scopes `payroll.timesheets payroll.employees` and `offline_access`.
     - Put the client id and secret in `thapsus-hr/<env>/xero` (env `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET`, UK cell only).
     - Apply to the Xero App Partner programme (certification is needed beyond 25 connected organisations).
     - Confirm Xero's data hosting location for UK organisations and record it in SUBPROCESSORS.md (currently "reported as AWS in the United States").
  2. **ADP**: apply at the ADP Marketplace partner programme (developers.adp.com). Sign the partner agreement, obtain sandbox API credentials and the mutual-TLS certificate, and request the Payroll Input / Worker Time APIs for Workforce Now (US) and iHCM (UK/EU).
  3. **Workday**: join the Workday Partner Network (Software Partner), or, per customer, ask the customer to create an Integration System User with a security group granting Payroll Input web services. Obtain a tenant-specific endpoint and an OAuth client (API client for integrations).
  4. **UKG**: apply to the UKG Partner Network. Request UKG Pro (and UKG Ready) developer access for the time and pay import APIs, plus sandbox tenants.
  5. **Gusto**: apply to Gusto Embedded / the Gusto developer partner programme. Get sandbox OAuth credentials and production approval for the payroll and time-off endpoints (US tenants only).
  6. **DATEV**: apply to the DATEV Marktplatz partner programme (DATEV eG). Sign the partner agreement and get access to the DATEVconnect / LODAS import interfaces (EU tenants with German entities only).

## 5. Accounts and access for staff

- [ ] 5.1 Create the first Thapsus back-office super admin in each cell: `pnpm --filter @thapsus/api exec tsx src/cli/create-staff.ts <email> "<name>" super_admin`. Store the printed one-time password and TOTP secret in a password manager.
