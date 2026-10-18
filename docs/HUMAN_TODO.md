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

## 4. Payments, partners and integrations

- [ ] 4.1 **Stripe:** create the account and enable Stripe Billing and Stripe Tax (UK VAT, EU OSS, US sales tax registrations as advised). Put the test-mode keys in Secrets Manager `thapsus-hr/<env>/stripe`. Switch to live mode only after approval.
- [ ] 4.2 **Microsoft Entra app registration** (multi-tenant) for joiner/leaver automation. Application permissions `User.ReadWrite.All`, `Group.ReadWrite.All`, `Directory.Read.All`; per-customer admin consent. Put the client id and secret in Secrets Manager `thapsus-hr/<env>/m365`.
- [ ] 4.3 **Google Cloud project + OAuth client** for Workspace Admin SDK (domain-wide delegation scopes `admin.directory.user`, `admin.directory.group`). Customers grant consent per domain. Credentials go in `thapsus-hr/<env>/google`.
- [ ] 4.4 **Payroll partner programmes** (stubs exist in code; real access needs agreements): Xero (Xero App Partner, Payroll UK API scopes); ADP Marketplace partner; Workday (Workday Partner Network / customer-sponsored integration system user); UKG partner; Gusto embedded partner; DATEV Marktplatz partner. Record credentials in Secrets Manager `thapsus-hr/<env>/payroll-<partner>`.

## 5. Accounts and access for staff

- [ ] 5.1 Create the first Thapsus back-office super admin in each cell: `pnpm --filter @thapsus/api exec tsx src/cli/create-staff.ts <email> "<name>" super_admin`. Store the printed one-time password and TOTP secret in a password manager.
