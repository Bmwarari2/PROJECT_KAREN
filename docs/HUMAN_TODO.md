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
  - Massachusetts values that could only be confirmed through search results;
  - Colorado 2026 exempt salary ($57,784): the adopted 2026 PAY CALC Order says "effective February 1, 2026" while the pack applies it from 1 January 2026 (CDLE INFO #1) — decide which date applies;
  - the UK nation extents (ADR-0022): each GB rule's `regions`, and the new Northern Ireland pack `packages/rules/packs/gb/gb-nir.json`;
  - the New York City Protected Time Off rule (`packages/rules/packs/us/localities/us-ny-nyc.json`), which is modelled from 22 February 2026 only.
  
  Replace the reviewer field via a back-office rule version when confirmed.
- [ ] 3.2 Fill the coverage gaps listed in `docs/COVERAGE.md` (for example German state holidays, Italian sick pay). Their official portals block automated fetching, so a person must check them manually. These were re-tried on 2026-10-18 and still need a person:
  1. **Lithuania holidays.** Open the Labour Code (Darbo kodeksas) consolidated text on https://www.e-tar.lt (the agent got HTTP 403) or https://e-seimas.lrs.lt (JavaScript only). Copy the list in art. 123(1) and the date of the current wording, then add them as holiday definitions in `packages/rules/packs/eu/lt.json` with that URL, plus a holiday vector in `packages/rules/goldens/eu-b.json`. Check in particular whether 2 November (All Souls' Day) is still listed; the EURES page has two lists that disagree.
  2. **Lithuania annual leave.** In the same text check art. 126(1): the pack uses the EURES summary (20 working days on a 5-day week, 24 on a 6-day week). If it matches, add a back-office rule version with the e-tar.lt URL and the date that wording took effect.
  3. **Romania holidays.** Open Codul muncii (Legea 53/2003, republished) on https://legislatie.just.ro (refused connections from the agent). Copy art. 139(1) (the agent saw secondary reports that 6 and 7 January were added; EURES omits them) and note which Easter/Pentecost dates follow the Orthodox calendar. Add them to `packages/rules/packs/eu/ro.json` (`"calendar": "orthodox"` for those) with a holiday vector.
  4. **Romania annual leave.** Check Codul muncii art. 145(1) (EURES says at least 20 working days) and art. 147 (3 additional days); confirm or correct the pack value through a back-office rule version.
  5. **Cyprus holidays.** Ask the Department of Labour Relations (https://www.mlsi.gov.cy/mlsi/dlr/dlr.nsf) whether there is an official public-holiday list for private-sector employment. If there is, add it to `packages/rules/packs/eu/cy.json`; if holidays are only by collective agreement, record that in the pack's coverage note.
  6. **Colorado and other CDLE documents.** cdle.colorado.gov returned HTTP 403 to automated fetches without a browser user agent; when updating Colorado values, download the current INFO #1 and PAY CALC Order manually.
- [ ] 3.3 Review the DPA, privacy notice templates, DPIA template, records of processing, sub-processor notice period and retention defaults in `docs/legal/`.
- [ ] 3.4 **Northern Ireland family leave and pay.** NI maternity, paternity and irregular-hours rules and an NI gender pay gap duty are not modelled, so `GB-NIR` lookups for them fail on purpose (COVERAGE.md "Subdivision extent — GB"). A reviewer should:
  1. Check the Maternity and Parental Leave etc. Regulations (Northern Ireland) 1999, the Paternity and Adoption Leave Regulations (Northern Ireland) 2002 and the NI SMP/SPP rates on https://www.legislation.gov.uk and https://www.nidirect.gov.uk.
  2. Add the verified versions to `packages/rules/packs/gb/gb-nir.json` (bump `version`, run `pnpm --filter @thapsus/rules manifest -- --write` and `coverage-doc`), with a golden vector each.
  3. Confirm whether the 2025-26 NI Statutory Sick Pay version (£118.75, three waiting days, lower earnings limit) should be added, and the NI lower earnings limit amount.

- [ ] 3.5 **Italy: notice and sick pay (phase 5).** `packages/rules/packs/eu/it.json` takes notice from EURES (normattiva.it reset the connection) and sick pay from the INPS information page:
  1. Open Civil Code art. 2118 on https://www.normattiva.it (search "codice civile art. 2118") and confirm that notice is set by collective agreements with no statutory minimum. If so, add a back-office rule version with the normattiva URL and the in-force date; if not, correct the value.
  2. On https://www.inps.it check the INPS indemnity bands (50% days 4-20, 66.66% days 21-180, 180 days a year) and the fixed-term and sector exceptions; confirm `effectiveFrom` (set to the verification date 2026-10-18).
- [ ] 3.6 **Gender pay gap: which sex/gender classification to record.** GOV.UK "Making your calculations" (updated 21 May 2026) gives no rule. Decide what the `PUT /v1/compliance/demographics/{employeeId}` value should represent for UK reporting and EU pay transparency, and update the help text (`compliance.gpg.intro`) and SECURITY/privacy notices accordingly.
- [ ] 3.7 **EEO-1 instructions.** The current Component 1 instruction booklet is on eeocdata.org (not an allow-listed domain). Confirm the ten job categories, seven race/ethnicity categories, male/female columns and the 1 October-31 December workforce snapshot in `packages/rules/packs/us/us.json` (`reporting.eeo1`), and whether observer identification should be offered when an employee declines. Track the outcome of the EEOC's July 2026 proposal to rescind EEO-1 reporting.
- [ ] 3.8 **Right to work (phase 5 additions).** Check the document catalogue ids and follow-up rules added to `right_to_work.document_rules` (List A, List B Groups 1 and 2, online results) against the Employer's guide of 1 October 2026, in particular that a List B Group 2 follow-up is due the day before six months from the PVN date and that pre-settled EUSS status needs no follow-up.
- [ ] 3.9 **US exemptions.** Confirm the California exempt salary rule (two times the state minimum wage for 40 hours, applied from 2024-01-01 in `us-ca.json`) on https://leginfo.legislature.ca.gov (Labor Code 515(a),(c); the agent got HTTP 403), and the duties-test summaries in `overtime.exempt_duties_tests` (DOL Fact Sheet #17A). Add teachers, practitioners of law or medicine (no salary test) and the New York exempt thresholds when reviewed.
- [ ] 3.10 **EU Pay Transparency interpretations (ADR-0055).** Confirm, per member state as each transposes the Directive: whether the gap in complementary or variable components is over all workers or recipients, how quartile remainders are allocated, and the categories of workers. Re-check the transposition statuses on the EUR-Lex national-measures page (it needs a browser; the agent could not re-read it on 2026-10-18) and update the member-state packs.
- [ ] 3.11 **Compliance defaults (ADR-0051).** Review the default reminder lead times (90/30/7/0 days for right to work and I-9, 60/30/7/0 for the matrix, 14 days for probation, 30 days for the unfair dismissal qualifying date) and the EEO-1 small-cell threshold of 5.
- [ ] 3.12 Review the Phase 4 working-time rules and how they are used (ADR-0035):
  - Spain `working_time.time_recording` (Estatuto de los Trabajadores art. 34.9 via RDL 8/2019, from 12 May 2019).
  - Germany `working_time.time_recording` (BAG 13 September 2022, 1 ABR 22/21). Re-read § 3 ArbSchG on gesetze-im-internet.de, which returned HTTP 503 during research, and check whether an ArbZG amendment on recording has since come into force.
  - Whether other member states should keep resolving to the EU baseline (CJEU C-55/18) until national rules are researched.
  - The GB opt-out notice cap (WTR reg. 5(3)).
  
  Confirm by adding a back-office rule version with your name as reviewer.
- [ ] 3.13 Review the default geofence notice wording guidance and add a DPIA section for location at clock-in and out (ADR-0037). Each customer writes their own notice per country before they can enable geofencing. Check against the ICO monitoring-workers guidance and the works-council co-determination rights of EU employees (e.g. § 87(1) no. 6 BetrVG in Germany).
- [ ] 3.14 **Holiday liability method (ADR-0073).** Ask finance and an employment lawyer to confirm the valuation used by the Holiday liability report (accrued-to-date leave less leave taken, at contractual basic pay ÷ (52 × working days per week), rounded once per person, negative when over-taken, no employer on-costs or variable pay) is acceptable for each market's accounting practice, and whether variable pay should be included for UK workers (holiday pay rules). Record the outcome in ADR-0073.

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
- [ ] 4.5 **Customer data-export roles (ADR-0077, docs/guides/data-export.md).**
  1. For each environment and cell, note the AWS account id that runs the cell's API and worker and publish it to customers (replace `<THAPSUS_HR_ACCOUNT_ID>` guidance in docs/guides/data-export.md, for example with a per-region table on the help site).
  2. Optionally tighten the documented trust policy with an `aws:PrincipalArn` condition naming the cell's API and worker task role ARNs (printed by `cdk deploy` of the cell stack).
  3. Have a customer-facing reviewer try the guide end to end against a test AWS account in each home region (eu-west-2, eu-central-1, us-east-2): create the `thapsus-hr-export-*` role, add the destination, press Test connection, run Send now and confirm the file and the delivery log.

## 5. Accounts and access for staff

- [ ] 5.1 Create the first Thapsus back-office super admin in each cell: `pnpm --filter @thapsus/api exec tsx src/cli/create-staff.ts <email> "<name>" super_admin`. Store the printed one-time password and TOTP secret in a password manager.
